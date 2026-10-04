import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";

// DENIED-TOOL-CALL-INVISIBLE (Failure 2): "a task marked done can have landed nothing" —
// markDone's new opts.toolPolicyDenied param (threaded by every scheduler.ts call site from the
// terminal AgentRecord.toolPolicyDenied) stamps TaskRecord/TaskSummary so a `done` task whose
// agent actually gave up after a policy denial is flagged as DATA, not left to a downstream
// reader parsing resultText. Deliberately does NOT fail the task or change its state — a
// legitimate no-op (no policy call made) never gets this flag; only a task whose agent actually
// hit a deny does, regardless of whether the task's own outcome was otherwise a real success.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qtpd-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore.markDone toolPolicyDenied propagation (Failure 2)", () => {
  it("stamps TaskRecord.toolPolicyDenied when the terminal agent hit a policy deny", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "do the thing" });
    q.markInProgress(t.taskId, "agent-1");
    const done = q.markDone(t.taskId, "I hit a policy denial and stopped.", { toolPolicyDenied: true });
    expect(done.toolPolicyDenied).toBe(true);
    expect(done.state).toBe("done");   // NOT failed — a warning flag, not a verdict
    expect(q.getTask(t.taskId).toolPolicyDenied).toBe(true);
  });

  it("does NOT stamp a legitimate no-op task (no denial happened)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "scout for X" });
    q.markInProgress(t.taskId, "agent-1");
    const done = q.markDone(t.taskId, "NO-OP: found nothing, nothing changed.");
    expect(done.toolPolicyDenied).toBeUndefined();
  });

  it("rides queue.statusSummary's TaskSummary projection, omitted when absent (exact-key-set safe)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const clean = q.push("work", { prompt: "clean task" });
    q.markInProgress(clean.taskId, "agent-1");
    q.markDone(clean.taskId, "done cleanly");
    const flagged = q.push("work", { prompt: "flagged task" });
    q.markInProgress(flagged.taskId, "agent-2");
    q.markDone(flagged.taskId, "gave up after a deny", { toolPolicyDenied: true });

    const summary = q.summary("work");
    const cleanSummary = summary.tasks.find((s) => s.id === clean.taskId)!;
    const flaggedSummary = summary.tasks.find((s) => s.id === flagged.taskId)!;
    expect(Object.keys(cleanSummary).sort()).toEqual(["id", "state", "subject"]);
    expect(Object.keys(flaggedSummary).sort()).toEqual(["id", "state", "subject", "toolPolicyDenied"]);
    expect(flaggedSummary.toolPolicyDenied).toBe(true);
  });
});
