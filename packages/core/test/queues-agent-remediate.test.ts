import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore, RemediationRequestInvalidError } from "@chimera/core/queues";

// AGENT-INITIATED-REMEDIATION: QueueStore-level unit tests for the structural guards
// setPendingRemediationRequest enforces on its own (task-shape only — no WorkflowStore lookup;
// engine.ts's queue.requestRemediation handler is where the workflow-SHAPE checks live, covered
// by engine-agent-remediate.test.ts). Direct QueueStore construction (no scheduler) — mirrors
// queues.test.ts's own rig().
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-remediate-"));
  const events = new EventLog(dir);
  return { q: new QueueStore(dir, events) };
}

describe("QueueStore.setPendingRemediationRequest / clearPendingRemediationRequest (AGENT-INITIATED-REMEDIATION)", () => {
  it("rejects a task that isn't workflow-bound", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "plain" });
    q.markInProgress(t.taskId, "ag-1");
    expect(() => q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "x", requestedBy: "ag-1" }))
      .toThrow(RemediationRequestInvalidError);
  });

  it("rejects a task that isn't in_progress (e.g. a fan-out PARENT parked/blocked on its children, agentId null)", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "task" });
    // simulate a workflow-bound, blocked (fan-out parent) task — QueueStore has no direct API to
    // set task.workflow/state (that's the scheduler's job at pickup/fan-out time); getTask
    // returns the LIVE record (shared-by-reference, same assumption scheduler.ts's own comments
    // rely on), so mutating it directly here is the narrowest way to pin this specific shape.
    const live = q.getTask(t.taskId);
    (live as { workflow: unknown }).workflow = { name: "wf", version: 1 };
    (live as { state: string }).state = "blocked";
    (live as { agentId: string | null }).agentId = null;
    expect(() => q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "x", requestedBy: null }))
      .toThrow(RemediationRequestInvalidError);
    expect(() => q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "x", requestedBy: null }))
      .toThrow(/not in_progress/);
  });

  it("rejects a requestedBy that doesn't match the task's current agent", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "task" });
    (q.getTask(t.taskId) as { workflow: unknown }).workflow = { name: "wf", version: 1 };
    q.markInProgress(t.taskId, "ag-real");
    expect(() => q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "x", requestedBy: "ag-impostor" }))
      .toThrow(/current step agent/);
  });

  it("a null requestedBy (direct/operator call) bypasses the current-agent check", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "task" });
    (q.getTask(t.taskId) as { workflow: unknown }).workflow = { name: "wf", version: 1 };
    q.markInProgress(t.taskId, "ag-real");
    const updated = q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "operator note", requestedBy: null });
    expect(updated.pendingRemediationRequest).toEqual({ targetStepId: "s0", brief: "operator note", requestedBy: null });
  });

  it("records the request, and clearPendingRemediationRequest resets it to null (idempotently)", () => {
    const { q } = rig();
    q.create({ name: "work" });
    const t = q.push("work", { prompt: "task" });
    (q.getTask(t.taskId) as { workflow: unknown }).workflow = { name: "wf", version: 1 };
    q.markInProgress(t.taskId, "ag-1");
    q.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "found it", requestedBy: "ag-1" });
    expect(q.getTask(t.taskId).pendingRemediationRequest).toEqual({ targetStepId: "s0", brief: "found it", requestedBy: "ag-1" });

    q.clearPendingRemediationRequest(t.taskId);
    expect(q.getTask(t.taskId).pendingRemediationRequest).toBeNull();
    q.clearPendingRemediationRequest(t.taskId);   // no-op the second time, must not throw
    expect(q.getTask(t.taskId).pendingRemediationRequest).toBeNull();
  });
});
