import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore, DuplicateQueueError, UnknownQueueError, UnknownTaskError, TaskNotDeadLetteredError } from "@chimera/core/queues";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore", () => {
  it("creates queues, pushes tasks with defaults, orders by priority then FIFO", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t0 = q.push("work", { prompt: "low" });
    const t5 = q.push("work", { prompt: "urgent", priority: 5 });
    const t1 = q.push("work", { prompt: "mid", priority: 1 });
    const t5b = q.push("work", { prompt: "urgent-later", priority: 5 });
    expect(t0.state).toBe("pending");
    expect(t0.attempts).toBe(0);
    expect(q.nextPending("work")!.taskId).toBe(t5.taskId);
    q.markInProgress(t5.taskId, "ag-1");
    expect(q.nextPending("work")!.taskId).toBe(t5b.taskId);      // FIFO within priority 5
    q.markInProgress(t5b.taskId, "ag-2");
    expect(q.nextPending("work")!.taskId).toBe(t1.taskId);
  });

  it("done/failed transitions honor the retry budget (failover attempts included)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 2 });
    const t = q.push("work", { prompt: "flaky" });
    q.markInProgress(t.taskId, "ag-1");
    let r = q.markFailedAttempt(t.taskId, 2, "agent failed (rate-limit)");   // one run that failed over = 2 attempts
    expect(r.state).toBe("pending");
    expect(r.attempts).toBe(2);
    expect(r.agentId).toBeNull();
    q.markInProgress(t.taskId, "ag-2");
    r = q.markFailedAttempt(t.taskId, 1, "agent failed");
    expect(r.state).toBe("failed");                                          // 3 > retryLimit 2
    expect(r.error).toContain("agent failed");

    const t2 = q.push("work", { prompt: "fine" });
    q.markInProgress(t2.taskId, "ag-3");
    expect(q.markDone(t2.taskId, "result text").resultText).toBe("result text");
    expect(q.status("work").counts).toEqual({ pending: 0, in_progress: 0, done: 1, failed: 1, blocked: 0, dead_letter: 0 });
  });

  it("FEATURE-9: emitted status events carry error + subject so a client never needs a queue.status round-trip", () => {
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const longPrompt = "x".repeat(100);
    const t = q.push("work", { prompt: longPrompt });
    q.markInProgress(t.taskId, "ag-1");

    // a retrying attempt (state stays "pending") also carries the reason + subject. HOOK-1: each
    // transition now ALSO appends a task_state_changed event for the same agentId, so filter to
    // "status" specifically rather than grabbing the tail's very last event.
    const lastStatus = (taskId: string) => events.tail(`task:${taskId}`, 10).filter((e) => e.kind === "status").at(-1)!;
    q.markFailedAttempt(t.taskId, 1, "flaky rate-limit");
    expect(lastStatus(t.taskId).data).toMatchObject({ state: "pending", error: "flaky rate-limit", subject: `${"x".repeat(80)}…` });

    q.markInProgress(t.taskId, "ag-2");
    q.markFailedAttempt(t.taskId, 1, "terminal failure");   // 2 > retryLimit 1 -> markFailed
    expect(lastStatus(t.taskId).data).toMatchObject({ state: "failed", error: "terminal failure", subject: `${"x".repeat(80)}…` });

    // a task that never failed carries error: null (always-present, never a shape surprise)
    const ok = q.push("work", { prompt: "short" });
    q.markInProgress(ok.taskId, "ag-3");
    q.markDone(ok.taskId, "done");
    expect(lastStatus(ok.taskId).data).toMatchObject({ state: "done", error: null, subject: "short" });
  });

  it("HOOK-1: every t.state transition also emits task_state_changed with prevState, and queue_drained fires when the last active task leaves", () => {
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "solo" });
    const changesFor = (taskId: string) => events.tail(`task:${taskId}`, 10).filter((e) => e.kind === "task_state_changed");
    expect(changesFor(t.taskId).at(-1)!.data).toMatchObject({ queue: "work", taskId: t.taskId, state: "pending", prevState: null });

    q.markInProgress(t.taskId, "ag-1");
    expect(changesFor(t.taskId).at(-1)!.data).toMatchObject({ state: "in_progress", prevState: "pending" });

    // the last active task in the queue reaching "done" drains it — resultPreview rides alongside.
    q.markDone(t.taskId, "the result");
    expect(changesFor(t.taskId).at(-1)!.data).toMatchObject({ state: "done", prevState: "in_progress", resultPreview: "the result" });
    const drained = events.tail("queue:work", 10).filter((e) => e.kind === "queue_drained");
    expect(drained).toHaveLength(1);
    expect(drained[0]!.data).toEqual({ queue: "work" });
  });

  it("HOOK-1: queue_drained does NOT fire while another task is still active, and dead_letter doesn't block it", () => {
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 0, retryPolicy: { maxAttempts: 1 } });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b" });
    q.markInProgress(a.taskId, "ag-1");
    q.markInProgress(b.taskId, "ag-2");
    q.markDone(a.taskId, "a done");   // b still in_progress -> no drain yet
    expect(events.tail("queue:work", 20).filter((e) => e.kind === "queue_drained")).toHaveLength(0);

    q.markFailedAttempt(b.taskId, 1, "poison");   // maxAttempts:1 -> dead_letter, not "failed"
    const bChange = events.tail(`task:${b.taskId}`, 10).filter((e) => e.kind === "task_state_changed").at(-1)!;
    expect(bChange.data).toMatchObject({ state: "dead_letter", prevState: "in_progress" });
    // dead_letter tasks don't count as "active" — the queue is now considered drained.
    const drained = events.tail("queue:work", 20).filter((e) => e.kind === "queue_drained");
    expect(drained).toHaveLength(1);
  });

  it("cancel only affects pending tasks and lands them in failed/cancelled", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const a = q.push("work", { prompt: "a" });
    const b = q.push("work", { prompt: "b" });
    q.markInProgress(b.taskId, "ag-1");
    expect(q.cancel(a.taskId)).toBe(true);
    expect(q.cancel(b.taskId)).toBe(false);
    const st = q.status("work");
    expect(st.counts.failed).toBe(1);
    expect(st.tasks.find((x) => x.taskId === a.taskId)!.error).toBe("cancelled");
    expect(() => q.cancel("ghost")).toThrow(UnknownTaskError);
  });

  it("persists and reverts in_progress → pending on restart, emitting a status event", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "interrupted" });
    q.markInProgress(t.taskId, "ag-1");

    const q2 = new QueueStore(dir, events);                  // simulated daemon restart
    const revived = q2.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(revived.state).toBe("pending");
    expect(revived.agentId).toBeNull();
    expect(revived.attempts).toBe(0);                        // a restart consumes no retry budget
    // HOOK-1: the restart revert now ALSO emits task_state_changed (prevState "in_progress") for
    // the same agentId — filter to "status" for the pre-existing assertion.
    const tail = events.tail(`task:${t.taskId}`, 10);
    const ev = tail.filter((e) => e.kind === "status").at(-1)!;
    expect(ev.kind).toBe("status");
    expect(ev.data).toMatchObject({ state: "pending", reason: "daemon-restart" });
    const change = tail.filter((e) => e.kind === "task_state_changed").at(-1)!;
    expect(change.data).toMatchObject({ state: "pending", prevState: "in_progress" });
  });

  it("typed errors for unknown queues and duplicates", () => {
    const { q } = rig();
    q.create({ name: "work" });
    expect(() => q.create({ name: "work" })).toThrow(DuplicateQueueError);
    expect(() => q.push("ghost", { prompt: "x" })).toThrow(UnknownQueueError);
    expect(() => q.status("ghost")).toThrow(UnknownQueueError);
  });

  it("typed coordination errors report their own class name (not 'Error') for log readability", () => {
    expect.assertions(3);
    const { q } = rig();
    q.create({ name: "work" });
    try { q.create({ name: "work" }); } catch (e) { expect((e as Error).name).toBe("DuplicateQueueError"); }
    try { q.get("ghost"); } catch (e) { expect((e as Error).name).toBe("UnknownQueueError"); }
    try { q.cancel("ghost-task"); } catch (e) { expect((e as Error).name).toBe("UnknownTaskError"); }
  });

  it("quarantines a corrupt queues.json and boots with an empty store instead of crashing", () => {
    const { dir, events } = rig();
    const file = join(dir, "queues.json");
    writeFileSync(file, "{ truncated");
    const q2 = new QueueStore(dir, events);
    expect(q2.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);          // original preserved only under the quarantine name
    const quarantined = readdirSync(dir).find((f) => f.startsWith("queues.json.corrupt-"));
    expect(quarantined).toBeTruthy();
    expect(readFileSync(join(dir, quarantined!), "utf8")).toBe("{ truncated");
  });

  it("a queues.json persisted before F16.1 Phase 2 (tasks with no stepHistory key at all) parses with a sparse [] default", () => {
    const { dir, events } = rig();
    const legacyTask = {
      taskId: "t-legacy", queue: "work", prompt: "x", state: "pending", createdAt: 1700000000000,
    };
    writeFileSync(join(dir, "queues.json"), JSON.stringify({ queues: [{ name: "work", retryLimit: 0 }], tasks: [legacyTask] }, null, 2));
    const q2 = new QueueStore(dir, events);
    expect(q2.getTask("t-legacy").stepHistory).toEqual([]);
  });

  it("startStep opens an entry, closeStep closes the most recently opened one with an outcome/reason", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "x" });
    expect(t.stepHistory).toEqual([]);

    q.startStep(t.taskId, 0, "s0", "ag-1");
    let r = q.getTask(t.taskId);
    expect(r.stepHistory).toHaveLength(1);
    expect(r.stepHistory[0]).toMatchObject({ stepIndex: 0, stepId: "s0", agentId: "ag-1", endedAt: null, outcome: null });

    q.closeStep(t.taskId, "retried", "gate failed: exit 1");
    r = q.getTask(t.taskId);
    expect(r.stepHistory[0]!.outcome).toBe("retried");
    expect(r.stepHistory[0]!.reason).toBe("gate failed: exit 1");
    expect(r.stepHistory[0]!.endedAt).not.toBeNull();

    // a second attempt at the SAME step opens a NEW entry — the first stays closed.
    q.startStep(t.taskId, 0, "s0", "ag-1");
    q.closeStep(t.taskId, "passed");
    r = q.getTask(t.taskId);
    expect(r.stepHistory).toHaveLength(2);
    expect(r.stepHistory[0]!.outcome).toBe("retried");   // untouched
    expect(r.stepHistory[1]!.outcome).toBe("passed");
    expect(r.stepHistory[1]!.reason).toBeUndefined();

    // closeStep is a no-op when there's no open entry (e.g. called twice by mistake).
    q.closeStep(t.taskId, "failed", "should not apply");
    r = q.getTask(t.taskId);
    expect(r.stepHistory).toHaveLength(2);
    expect(r.stepHistory[1]!.outcome).toBe("passed");
  });

  it("evicts terminal tasks beyond the retention cap, never pending ones", () => {
    const { q } = rig();
    q.create({ name: "work" });
    for (let i = 0; i < 205; i++) {
      const t = q.push("work", { prompt: `t${i}` });
      q.markInProgress(t.taskId, "ag");
      q.markDone(t.taskId, "ok");
    }
    const keeper = q.push("work", { prompt: "still-pending" });
    const st = q.status("work");
    expect(st.counts.done).toBe(200);                            // 5 oldest terminal tasks evicted on save
    expect(st.tasks.some((t) => t.taskId === keeper.taskId)).toBe(true);
  }, 15000);   // 205 synchronous saves — generous headroom under concurrent test-file contention

  describe("RETRY-BACKOFF", () => {
    it("markFailedAttempt with NO retryPolicy is byte-identical to today (pending revert, cascade fail on exhaustion)", () => {
      const { q } = rig();
      q.create({ name: "work", retryLimit: 1 });
      const t = q.push("work", { prompt: "flaky" });
      q.markInProgress(t.taskId, "ag-1");
      let r = q.markFailedAttempt(t.taskId, 1, "boom");
      expect(r.state).toBe("pending");                            // instant revert, no parking
      q.markInProgress(t.taskId, "ag-2");
      r = q.markFailedAttempt(t.taskId, 1, "boom again");
      expect(r.state).toBe("failed");                             // exhaustion -> failed, not dead_letter
    });

    it("markFailedAttempt WITH a retryPolicy parks (in_progress, no agent) instead of reverting to pending", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 3 } });
      const t = q.push("work", { prompt: "flaky" });
      q.markInProgress(t.taskId, "ag-1");
      const r = q.markFailedAttempt(t.taskId, 1, "boom");
      expect(r.state).toBe("in_progress");                        // PARKED, not "pending"
      expect(r.agentId).toBeNull();
      expect(r.attempts).toBe(1);
    });

    it("code-review A1: a parked retry (in_progress → in_progress) emits its status event but NO task_state_changed", () => {
      const { q, events } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 3 } });
      const t = q.push("work", { prompt: "flaky" });
      q.markInProgress(t.taskId, "ag-1");

      const changesBefore = events.tail(`task:${t.taskId}`, 20).filter((e) => e.kind === "task_state_changed");
      // push (pending, prevState null) + markInProgress (in_progress, prevState pending) = 2 real transitions
      expect(changesBefore).toHaveLength(2);
      expect(changesBefore.at(-1)!.data).toMatchObject({ state: "in_progress", prevState: "pending" });

      const r = q.markFailedAttempt(t.taskId, 1, "boom");
      expect(r.state).toBe("in_progress");   // PARKED — same state it was already in

      // The park still emits a `status` event (retrying + parked) so a client sees the attempt...
      const lastStatus = events.tail(`task:${t.taskId}`, 20).filter((e) => e.kind === "status").at(-1)!;
      expect(lastStatus.data).toMatchObject({ state: "in_progress", error: "boom", retrying: true, parked: true });

      // ...but NO task_state_changed fires: prevState === t.state (in_progress → in_progress) is a
      // no-op transition, so a subscriber never sees a "transition" that didn't transition.
      const changesAfter = events.tail(`task:${t.taskId}`, 20).filter((e) => e.kind === "task_state_changed");
      expect(changesAfter).toHaveLength(2);   // unchanged from before the park
    });

    it("exhausting maxAttempts dead-letters instead of failing, and does NOT cascade to dependents", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 2 } });
      const a = q.push("work", { prompt: "poison" });
      const b = q.push("work", { prompt: "downstream", dependsOn: [a.taskId] });
      expect(b.state).toBe("blocked");

      q.markInProgress(a.taskId, "ag-1");
      let r = q.markFailedAttempt(a.taskId, 1, "boom");
      expect(r.state).toBe("in_progress");                        // 1st failure: still parked
      q.releaseForRetry(a.taskId);
      q.markInProgress(a.taskId, "ag-2");
      r = q.markFailedAttempt(a.taskId, 1, "boom again");
      expect(r.state).toBe("dead_letter");                        // 2nd failure: exhausted -> dead_letter
      expect(r.error).toBe("boom again");

      const bAfter = q.getTask(b.taskId);
      expect(bAfter.state).toBe("blocked");                       // untouched — no cascade fired
    });

    it("retryableClasses: a non-retryable errorClass dead-letters immediately, short-circuiting maxAttempts", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 5, retryableClasses: ["backend-crash"] } });
      const t = q.push("work", { prompt: "poisoned" });
      q.markInProgress(t.taskId, "ag-1");
      const r = q.markFailedAttempt(t.taskId, 1, "invalid api key", "credential");
      expect(r.state).toBe("dead_letter");                        // FIRST failure, despite maxAttempts:5
    });

    it("retryableClasses: a retryable errorClass parks normally", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 5, retryableClasses: ["backend-crash"] } });
      const t = q.push("work", { prompt: "flaky" });
      q.markInProgress(t.taskId, "ag-1");
      const r = q.markFailedAttempt(t.taskId, 1, "process exited", "backend-crash");
      expect(r.state).toBe("in_progress");                        // allow-listed class -> normal park
    });

    it("releaseForRetry revives a parked task, and is idempotent (a second call is a no-op)", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 3 } });
      const t = q.push("work", { prompt: "x" });
      q.markInProgress(t.taskId, "ag-1");
      q.markFailedAttempt(t.taskId, 1, "boom");
      const released = q.releaseForRetry(t.taskId);
      expect(released.state).toBe("pending");
      expect(released.agentId).toBeNull();

      // already "pending" (not "in_progress") -> the guard makes a second call a pure no-op,
      // so a stale/duplicate timer firing twice for the same taskId can never double-release.
      const noop = q.releaseForRetry(t.taskId);
      expect(noop.state).toBe("pending");
    });

    it("requeue replays a dead-lettered task: resets attempts/stepAttempts, reverts to pending", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 1 } });
      const t = q.push("work", { prompt: "poison" });
      q.markInProgress(t.taskId, "ag-1");
      q.markFailedAttempt(t.taskId, 1, "boom");                   // maxAttempts:1 -> dead_letter on first failure
      expect(q.getTask(t.taskId).state).toBe("dead_letter");

      const revived = q.requeue(t.taskId);
      expect(revived.state).toBe("pending");
      expect(revived.agentId).toBeNull();
      expect(revived.error).toBeNull();
      expect(revived.attempts).toBe(0);
      expect(revived.stepAttempts).toBe(0);
    });

    it("requeue throws TaskNotDeadLetteredError on a task that isn't dead-lettered", () => {
      const { q } = rig();
      q.create({ name: "work" });
      const t = q.push("work", { prompt: "fine" });
      expect(() => q.requeue(t.taskId)).toThrow(TaskNotDeadLetteredError);
    });

    it("dead_letter is never pruned/evicted by the terminal-task retention cap", () => {
      const { q } = rig();
      q.create({ name: "work", retryPolicy: { maxAttempts: 1 } });
      for (let i = 0; i < 205; i++) {
        const t = q.push("work", { prompt: `t${i}` });
        q.markInProgress(t.taskId, "ag");
        q.markDone(t.taskId, "ok");
      }
      const poison = q.push("work", { prompt: "poison" });
      q.markInProgress(poison.taskId, "ag");
      q.markFailedAttempt(poison.taskId, 1, "boom");              // dead-letters immediately (maxAttempts:1)
      const st = q.status("work");
      expect(st.counts.done).toBe(200);                           // eviction still applies to done
      expect(st.tasks.some((t) => t.taskId === poison.taskId && t.state === "dead_letter")).toBe(true);
    }, 15000);   // 205 synchronous saves — generous headroom under concurrent test-file contention
  });
});
