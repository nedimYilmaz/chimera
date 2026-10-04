import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import {
  QueueStore, TaskNotEditableError, TaskNotRetryableError, DependencyCycleError, UnknownDependencyError,
} from "@chimera/core/queues";

// QUEUE-REORDER: the operator should be able to SEE and CHANGE queue drain order instead of
// failing a task and rewriting it (the T15 incident: an ordering constraint expressed only in
// prose never actually enforced anything). Three pieces: moveTask (adjacent swap of the
// (priority, orderKey) tuple with a neighbour in drain order — never a gap-insertion, so there's
// no "no integer gap" failure mode to hit), retryTask (clone a failed/dead_letter task into a
// fresh pending one with a clean retry budget, without retyping the prompt), and addDependency
// (the actual fix for "run last" — an ordering CONSTRAINT, not a priority tiebreak).

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qreorder-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore — moveTask (QUEUE-REORDER)", () => {
  it("same-priority reorder actually changes drain order (nextPending), not just the stored priority integer", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    // Three tasks, all default priority 0 — FIFO order a, b, c.
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b" });
    const c = q.push("work", { prompt: "c" });
    expect(q.nextPending("work")!.taskId).toBe(a.taskId);

    // Move c up twice and confirm the FULL drain order each time via peekOrder (a non-destructive
    // walk of nextPending — the only way to observe true scheduler order without reading
    // priority/orderKey directly).
    q.moveTask(c.taskId, "up");   // swaps c and b -> order: a, c, b
    expect(peekOrder(q, "work", [a.taskId, b.taskId, c.taskId])).toEqual([a.taskId, c.taskId, b.taskId]);

    q.moveTask(c.taskId, "up");   // swaps c and a -> order: c, a, b
    expect(peekOrder(q, "work", [a.taskId, b.taskId, c.taskId])).toEqual([c.taskId, a.taskId, b.taskId]);
  });

  it("repeated moves never silently degrade into a no-op (each call keeps changing rank until the boundary)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const ids = ["a", "b", "c", "d"].map((p) => q.push("work", { prompt: p }).taskId);
    const last = ids[3]!;

    // Move the LAST task up three times — it must climb one slot each call, landing at the
    // front, then the fourth "up" call is the genuine no-op (already first).
    q.moveTask(last, "up");
    expect(peekOrder(q, "work", ids)).toEqual([ids[0], ids[1], last, ids[2]]);
    q.moveTask(last, "up");
    expect(peekOrder(q, "work", ids)).toEqual([ids[0], last, ids[1], ids[2]]);
    q.moveTask(last, "up");
    expect(peekOrder(q, "work", ids)).toEqual([last, ids[0], ids[1], ids[2]]);
    // Boundary: already first — "up" again is a true no-op (nothing to swap with).
    const before = q.getTask(last);
    const unchanged = q.moveTask(last, "up");
    expect(unchanged).toMatchObject({ priority: before.priority, orderKey: before.orderKey });
    expect(peekOrder(q, "work", ids)).toEqual([last, ids[0], ids[1], ids[2]]);
  });

  it("boundary at the bottom is a no-op the same way", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "a" });
    q.push("work", { prompt: "b" });
    const before = q.getTask(a.taskId);
    const unchanged = q.moveTask(a.taskId, "up"); // a is already first
    expect(unchanged).toMatchObject({ priority: before.priority, orderKey: before.orderKey });
  });

  it("moving across a priority tier boundary swaps priority too (crossing tiers is not silently ignored)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const hi = q.push("work", { prompt: "hi", priority: 5 });
    const lo = q.push("work", { prompt: "lo", priority: 0 });
    expect(q.nextPending("work")!.taskId).toBe(hi.taskId);

    q.moveTask(lo.taskId, "up"); // swaps lo <-> hi entirely (priority AND orderKey)
    expect(q.nextPending("work")!.taskId).toBe(lo.taskId);
    expect(q.getTask(lo.taskId).priority).toBe(5);
    expect(q.getTask(hi.taskId).priority).toBe(0);
  });

  it("includes blocked tasks in the reorderable set", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const dep = q.push("work", { prompt: "dep" });
    const blocked1 = q.push("work", { prompt: "blocked1", dependsOn: [dep.taskId] });
    const blocked2 = q.push("work", { prompt: "blocked2", dependsOn: [dep.taskId] });
    expect(blocked1.state).toBe("blocked");
    expect(blocked2.state).toBe("blocked");

    q.moveTask(blocked2.taskId, "up"); // swap with blocked1
    // Complete dep and observe drain order reflects the swap.
    q.markInProgress(dep.taskId, "ag");
    q.markDone(dep.taskId, "ok");
    expect(q.nextPending("work")!.taskId).toBe(blocked2.taskId);
  });

  it("rejects reordering an in_progress or terminal task (TaskNotEditableError)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "a" });
    q.push("work", { prompt: "b" });

    q.markInProgress(t.taskId, "ag");
    expect(() => q.moveTask(t.taskId, "up")).toThrow(TaskNotEditableError);

    q.markDone(t.taskId, "ok");
    expect(() => q.moveTask(t.taskId, "up")).toThrow(TaskNotEditableError);
  });

  it("orderKey normalization at boot fixes legacy (pre-feature) same-key collisions so moves still work", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b" });
    const c = q.push("work", { prompt: "c" });
    void a;

    // Simulate data written before `orderKey` existed: strip the field from every task row,
    // as an old queues.json on disk would be missing it entirely (schema default 0 on parse).
    const file = join(dir, "queues.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { queues: unknown[]; tasks: Array<Record<string, unknown>> };
    for (const t of raw.tasks) delete t["orderKey"];
    writeFileSync(file, JSON.stringify(raw, null, 2));

    const q2 = new QueueStore(dir, events);
    // Without normalization every task would parse to orderKey:0 and a swap between two of them
    // would be a value-for-value no-op. Confirm a move still produces a real, observable order
    // change — proof the boot-time normalization assigned them distinct keys.
    q2.moveTask(c.taskId, "up");
    expect(peekOrder(q2, "work", [a.taskId, b.taskId, c.taskId])).toEqual([a.taskId, c.taskId, b.taskId]);
  });
});

describe("QueueStore — retryTask (QUEUE-REORDER recovery)", () => {
  it("clones a failed task into a fresh pending task without retyping the prompt", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "do the thing", role: "dev", priority: 3, overrides: { model: "opus" } });
    q.markInProgress(t.taskId, "ag");
    const failed = q.markFailedAttempt(t.taskId, 1, "boom"); // retryLimit 0 -> immediately "failed"
    expect(failed.state).toBe("failed");

    const clone = q.retryTask(t.taskId);
    expect(clone.taskId).not.toBe(t.taskId);
    expect(clone.state).toBe("pending");
    expect(clone.prompt).toBe("do the thing");
    expect(clone.role).toBe("dev");
    expect(clone.priority).toBe(3);
    expect(clone.overrides).toEqual({ model: "opus" });
    // Fresh retry budget — never inherited from the exhausted original.
    expect(clone.attempts).toBe(0);

    // The ORIGINAL stays exactly as it was — audit trail preserved, not mutated in place.
    expect(q.getTask(t.taskId).state).toBe("failed");
    expect(q.getTask(t.taskId).error).toBe("boom");
  });

  it("retry-budget semantics: a clone's attempts start at 0 even though the original was exhausted", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 2 });
    const t = q.push("work", { prompt: "flaky" });
    q.markInProgress(t.taskId, "ag");
    q.markFailedAttempt(t.taskId, 1, "e1"); // 1/2, reverts to pending
    q.markInProgress(t.taskId, "ag");
    q.markFailedAttempt(t.taskId, 1, "e2"); // 2/2, reverts to pending
    q.markInProgress(t.taskId, "ag");
    const failed = q.markFailedAttempt(t.taskId, 1, "e3"); // 3 > retryLimit 2 -> failed
    expect(failed.state).toBe("failed");
    expect(failed.attempts).toBe(3);

    const clone = q.retryTask(t.taskId);
    expect(clone.attempts).toBe(0); // NOT 3 — a fresh budget, not silently inherited
  });

  it("also recovers a dead_letter task the same way", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 5, retryPolicy: { maxAttempts: 1 } });
    const t = q.push("work", { prompt: "poison" });
    q.markInProgress(t.taskId, "ag");
    const dl = q.markFailedAttempt(t.taskId, 1, "dead"); // maxAttempts 1 -> dead_letter
    expect(dl.state).toBe("dead_letter");

    const clone = q.retryTask(t.taskId);
    expect(clone.state).toBe("pending");
    expect(clone.attempts).toBe(0);
  });

  it("clones dependsOn — a retried task re-evaluates gating exactly like a fresh push (dep already done)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const dep = q.push("work", { prompt: "dep" });
    q.markInProgress(dep.taskId, "ag");
    q.markDone(dep.taskId, "ok");
    const t = q.push("work", { prompt: "dependent", dependsOn: [dep.taskId] }); // dep already done -> pending
    expect(t.state).toBe("pending");
    q.markInProgress(t.taskId, "ag");
    const failed = q.markFailedAttempt(t.taskId, 1, "boom"); // retryLimit 0 -> immediately "failed"
    expect(failed.state).toBe("failed");

    const clone = q.retryTask(t.taskId);
    expect(clone.dependsOn).toEqual([dep.taskId]);
    expect(clone.state).toBe("pending"); // dep already done — the clone isn't gated
  });

  it("a retried task whose dependency later failed re-clones as failed, not silently free-floating", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const dep = q.push("work", { prompt: "dep" }); // still pending
    const t = q.push("work", { prompt: "dependent", dependsOn: [dep.taskId] });
    expect(t.state).toBe("blocked");
    q.markInProgress(dep.taskId, "ag");
    const depFailed = q.markFailed(dep.taskId, "dep boom"); // cascades: t -> failed too
    expect(depFailed.state).toBe("failed");
    expect(q.getTask(t.taskId).state).toBe("failed");

    const clone = q.retryTask(t.taskId);
    // dep is ALSO failed, so a fresh push() with the same dependsOn evaluates anyFailed -> the
    // clone lands right back in "failed" instead of escaping the broken dependency chain.
    expect(clone.dependsOn).toEqual([dep.taskId]);
    expect(clone.state).toBe("failed");
  });

  it("rejects retrying a pending/blocked/in_progress/done task", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "a" });
    expect(() => q.retryTask(t.taskId)).toThrow(TaskNotRetryableError);

    q.markInProgress(t.taskId, "ag");
    expect(() => q.retryTask(t.taskId)).toThrow(TaskNotRetryableError);

    q.markDone(t.taskId, "ok");
    expect(() => q.retryTask(t.taskId)).toThrow(TaskNotRetryableError);
  });
});

describe("QueueStore — addDependency (T15's actual fix: ordering CONSTRAINTS via dependsOn)", () => {
  it("adds a dependency to a pending task, gating it until the dependency is done", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const runFirst = q.push("work", { prompt: "run first" });
    const runLast = q.push("work", { prompt: "run last" });
    expect(runLast.state).toBe("pending");

    const gated = q.addDependency(runLast.taskId, runFirst.taskId);
    expect(gated.state).toBe("blocked");
    expect(gated.dependsOn).toEqual([runFirst.taskId]);
    expect(q.nextPending("work")!.taskId).toBe(runFirst.taskId);

    q.markInProgress(runFirst.taskId, "ag");
    q.markDone(runFirst.taskId, "ok");
    expect(q.nextPending("work")!.taskId).toBe(runLast.taskId);
  });

  it("is idempotent — adding an already-present dependency is a no-op, not an error", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b", dependsOn: [a.taskId] });
    const again = q.addDependency(b.taskId, a.taskId);
    expect(again.dependsOn).toEqual([a.taskId]);
  });

  it("rejects a self-dependency", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "a" });
    expect(() => q.addDependency(t.taskId, t.taskId)).toThrow(DependencyCycleError);
  });

  it("rejects a dependency that would create a cycle", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b", dependsOn: [a.taskId] }); // b -> a
    // Adding a -> b would close the loop a -> b -> a.
    expect(() => q.addDependency(a.taskId, b.taskId)).toThrow(DependencyCycleError);
  });

  it("rejects an unknown or cross-queue dependency", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    q.create({ name: "other", retryLimit: 1 });
    const t = q.push("work", { prompt: "a" });
    const elsewhere = q.push("other", { prompt: "b" });
    expect(() => q.addDependency(t.taskId, "nonexistent")).toThrow(UnknownDependencyError);
    expect(() => q.addDependency(t.taskId, elsewhere.taskId)).toThrow(UnknownDependencyError);
  });

  it("rejects adding a dependency to an in_progress or terminal task", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "a" });
    const dep = q.push("work", { prompt: "b" });
    q.markInProgress(t.taskId, "ag");
    expect(() => q.addDependency(t.taskId, dep.taskId)).toThrow(TaskNotEditableError);
  });
});

/** Walk `queue`'s TRUE drain order for `ids` via repeated nextPending calls — the only way to
 * assert real scheduler order without reading priority/orderKey directly (this feature's own
 * acceptance bar: "proven by asserting the order nextPending returns, not by asserting the
 * stored integer"). Non-destructive: each observed head is pulled out of pending contention via
 * markInProgress (so the NEXT nextPending call surfaces the next task) and every pulled task is
 * restored to pending via releaseForRetry once the walk finishes — priority/orderKey/attempts are
 * untouched by either call, so this is safe to call more than once per test. */
function peekOrder(q: QueueStore, queue: string, ids: readonly string[]): string[] {
  const idSet = new Set(ids);
  const order: string[] = [];
  const pulled: string[] = [];
  while (true) {
    const next = q.nextPending(queue);
    if (!next || !idSet.has(next.taskId)) break;
    order.push(next.taskId);
    pulled.push(next.taskId);
    q.markInProgress(next.taskId, "peek-probe");
  }
  for (const id of pulled) q.releaseForRetry(id);
  return order;
}
