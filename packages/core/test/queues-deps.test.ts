import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore, UnknownDependencyError } from "@chimera/core/queues";

// Task DEP1: task-to-task dependencies. A task with unsatisfied `dependsOn` is parked
// in "blocked" (not eligible for dequeue) until every dependency is "done"; if any
// dependency reaches terminal "failed", the dependent cascade-fails.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qdep-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore — dependencies (DEP1)", () => {
  it("a task with an unfinished dependency is 'blocked' and is NOT dequeued", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "first" });
    const b = q.push("work", { prompt: "second", dependsOn: [a.taskId], priority: 100 });

    expect(b.state).toBe("blocked");
    // Even at higher priority, b is not eligible while a is pending; a is picked.
    expect(q.nextPending("work")!.taskId).toBe(a.taskId);
  });

  it("completing the dependency promotes the blocked task to 'pending' (eligible)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "first" });
    const b = q.push("work", { prompt: "second", dependsOn: [a.taskId] });

    q.markInProgress(a.taskId, "ag-1");
    q.markDone(a.taskId, "ok");

    expect(q.status("work").tasks.find((t) => t.taskId === b.taskId)!.state).toBe("pending");
    expect(q.nextPending("work")!.taskId).toBe(b.taskId);
  });

  it("with MULTIPLE deps, unblocks only once ALL are done", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b" });
    const c = q.push("work", { prompt: "c", dependsOn: [a.taskId, b.taskId] });

    q.markDone(a.taskId, "ok");
    expect(q.status("work").tasks.find((t) => t.taskId === c.taskId)!.state).toBe("blocked"); // b still pending
    q.markInProgress(b.taskId, "ag-1");
    q.markDone(b.taskId, "ok");
    expect(q.status("work").tasks.find((t) => t.taskId === c.taskId)!.state).toBe("pending");
  });

  it("a FAILED dependency cascade-fails the dependent", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b", dependsOn: [a.taskId] });

    q.markInProgress(a.taskId, "ag-1");
    q.markFailed(a.taskId, "boom");

    const bAfter = q.status("work").tasks.find((t) => t.taskId === b.taskId)!;
    expect(bAfter.state).toBe("failed");
    expect(bAfter.error).toMatch(/dependency .* failed/);
  });

  it("cascade is TRANSITIVE: a→b→c, a fails ⇒ both b and c fail", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b", dependsOn: [a.taskId] });
    const c = q.push("work", { prompt: "c", dependsOn: [b.taskId] });

    q.markInProgress(a.taskId, "ag-1");
    q.markFailed(a.taskId, "boom");

    const s = q.status("work");
    expect(s.tasks.find((t) => t.taskId === b.taskId)!.state).toBe("failed");
    expect(s.tasks.find((t) => t.taskId === c.taskId)!.state).toBe("failed");
  });

  it("pushing with an ALREADY-done dep starts 'pending'; with an already-FAILED dep starts 'failed'", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const done = q.push("work", { prompt: "done" });
    q.markDone(done.taskId, "ok");
    const failed = q.push("work", { prompt: "willfail" });
    q.markFailed(failed.taskId, "boom");

    expect(q.push("work", { prompt: "afterDone", dependsOn: [done.taskId] }).state).toBe("pending");
    const dead = q.push("work", { prompt: "afterFailed", dependsOn: [failed.taskId] });
    expect(dead.state).toBe("failed");
    expect(dead.error).toMatch(/dependency failed/);
  });

  it("rejects an unknown dependency id, and a dependency in a DIFFERENT queue", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    q.create({ name: "other", retryLimit: 0 });
    const inOther = q.push("other", { prompt: "x" });

    expect(() => q.push("work", { prompt: "bad", dependsOn: ["does-not-exist"] })).toThrow(UnknownDependencyError);
    expect(() => q.push("work", { prompt: "cross", dependsOn: [inOther.taskId] })).toThrow(UnknownDependencyError);
  });

  it("cancelling a BLOCKED task succeeds and cascade-fails its dependents", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b", dependsOn: [a.taskId] });
    const c = q.push("work", { prompt: "c", dependsOn: [b.taskId] });

    expect(q.cancel(b.taskId)).toBe(true);               // b is blocked, still cancellable
    const s = q.status("work");
    expect(s.tasks.find((t) => t.taskId === b.taskId)!.state).toBe("failed");
    expect(s.tasks.find((t) => t.taskId === c.taskId)!.state).toBe("failed"); // cascaded
    expect(s.tasks.find((t) => t.taskId === a.taskId)!.state).toBe("pending"); // untouched
  });

  it("status counts include 'blocked'", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const a = q.push("work", { prompt: "a" });
    q.push("work", { prompt: "b", dependsOn: [a.taskId] });

    const counts = q.status("work").counts;
    expect(counts.pending).toBe(1);
    expect(counts.blocked).toBe(1);
  });

  it("no-dependency tasks are unaffected: still pushed 'pending' and dequeued as before", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const a = q.push("work", { prompt: "plain" });
    expect(a.state).toBe("pending");
    expect(a.dependsOn).toEqual([]);
    expect(q.nextPending("work")!.taskId).toBe(a.taskId);
  });

  it("RESTART heals a blocked task whose dep resolved (or failed) while the daemon was down", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-qdep-restart-"));
    const events = new EventLog(dir);
    const base = { queue: "work", role: null, overrides: {}, priority: 0, attempts: 0, createdAt: 1,
      agentId: null, resultText: null, error: null };
    // Hand-craft a persisted state simulating a crash AFTER a dep went terminal but
    // BEFORE its dependents were reconciled: aDone done + bAfterDone still blocked,
    // aFail failed + bAfterFail still blocked.
    writeFileSync(join(dir, "queues.json"), JSON.stringify({
      queues: [{ name: "work", retryLimit: 0 }],
      tasks: [
        { ...base, taskId: "aDone", prompt: "aDone", state: "done", dependsOn: [] },
        { ...base, taskId: "aFail", prompt: "aFail", state: "failed", dependsOn: [] },
        { ...base, taskId: "bAfterDone", prompt: "bAfterDone", state: "blocked", dependsOn: ["aDone"] },
        { ...base, taskId: "bAfterFail", prompt: "bAfterFail", state: "blocked", dependsOn: ["aFail"] },
      ],
    }));

    const q = new QueueStore(dir, events);   // constructor runs the reconcile pass
    const s = q.status("work");
    expect(s.tasks.find((t) => t.taskId === "bAfterDone")!.state).toBe("pending"); // dep done → unblocked
    expect(s.tasks.find((t) => t.taskId === "bAfterFail")!.state).toBe("failed");  // dep failed → cascaded
  });
});
