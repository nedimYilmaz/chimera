import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// AGENT-INITIATED-REMEDIATION: the queue.requestRemediation RPC handler (engine.ts) — the
// workflow-SHAPE validation (policy configured, target step exists/earlier/not-a-dispatch-node)
// that only this handler can do (it alone has WorkflowStore access; queues.ts's
// setPendingRemediationRequest only checks task-shape). scheduler-agent-remediate.test.ts covers
// the SAME validation re-run at turn-complete time plus the actual jump/budget/priority-over-gate
// behavior — this file is deliberately narrower: does the RPC accept/reject the right requests
// and report an accurate preview, nothing about what happens once the turn ends.

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const role = { cwd: "/tmp/dev", account: "main", isolation: "none" as const };
const noneGate = { kind: "none" as const };

// Parks a fresh agent at stepIndex 2 of a 3-step workflow (s0 -> s1 -> s2), having completed s0
// and s1's own turns via a scripted `{turn:{}}` x2 with no further script steps — the agent stays
// "running" (never got a result/end), so it's a live, in_progress, agent-bound task exactly like
// a step agent mid-turn would be.
async function parkedAtStep2(wfSteps: unknown[]) {
  const fake = new FakeAgentBackend([[{ turn: {} }, { turn: {} }]]);
  const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
  await e.handle("queue.create", { spec: { name: "work" } });
  await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role } }, maxConcurrent: 2, queue: "work" } });
  await e.handle("workflow.create", { spec: { name: "wf", steps: wfSteps } });
  const task = await e.handle("queue.push", { queue: "work", prompt: "go", workflow: "wf" }) as { taskId: string };
  await waitUntil(() => (e.queues.getTask(task.taskId)).stepIndex === 2);
  const agentId = e.scheduler.agentsFor("crew")[0]!;
  return { e, agentId, taskId: task.taskId };
}

describe("Engine queue.requestRemediation — RPC-time structural validation (AGENT-INITIATED-REMEDIATION)", () => {
  it("rejects an unknown task", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("queue.requestRemediation", { taskId: "ghost", targetStepId: "s0", brief: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a task that isn't workflow-bound", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role } }, maxConcurrent: 2, queue: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "plain task" }) as { taskId: string };
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    await expect(e.handle("queue.requestRemediation", { taskId: task.taskId, targetStepId: "s0", brief: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a step with no configured remediate policy (onFail defaults to halt)", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate },   // onFail defaults to "halt" — no policy at all
    ];
    const { e, agentId, taskId } = await parkedAtStep2(WF_STEPS);
    let msg = "";
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "s0", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("no configured remediate policy");
  });

  it("rejects a critic-gate current step even with onFail:'remediate' set (critic gates are exempt, mirrors the gate-triggered path)", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      {
        id: "s2", title: "ship",
        gate: { kind: "critic" as const, spec: { criteria: "must be correct", maxRounds: 3 } },
        onFail: "remediate" as const, remediate: { maxRounds: 2 },
      },
    ];
    const { e, agentId, taskId } = await parkedAtStep2(WF_STEPS);
    let msg = "";
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "s0", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("no configured remediate policy");
  });

  it("rejects an unknown target step id", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
    ];
    const { e, agentId, taskId } = await parkedAtStep2(WF_STEPS);
    let msg = "";
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "ghost-step", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("unknown step id");
  });

  it("rejects a forward jump (target step index >= current stepIndex)", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
      { id: "s3", title: "release", gate: noneGate },
    ];
    const { e, agentId, taskId } = await parkedAtStep2(WF_STEPS);
    let msg = "";
    // self (s2, same index as current)
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "s2", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("strictly earlier");
    // forward (s3, a later step)
    msg = "";
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "s3", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("strictly earlier");
  });

  it("rejects a target step that is a fan-out dispatch node (no agent ever runs for it)", async () => {
    // s0 routes DIRECTLY to s2 via an explicit `next` edge, so the fan-out at s1 is never
    // actually executed by this test — it only needs to be a STRUCTURALLY valid fan-out step for
    // workflow.create's validateWorkflowGraph to accept the spec; s2 (reached via s0's edge)
    // requests remediation back to s1, which must be rejected regardless of whether it was ever
    // run.
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s2" }] },
      { id: "s1", title: "fan", gate: noneGate, fanOut: { source: { kind: "list", items: ["x"] }, joinStep: "s3" } },
      { id: "s2", title: "implement", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
      { id: "s3", title: "ship", gate: noneGate },
    ];
    const fake = new FakeAgentBackend([[{ turn: {} }]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role } }, maxConcurrent: 2, queue: "work" } });
    await e.handle("workflow.create", { spec: { name: "wf", steps: WF_STEPS } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "go", workflow: "wf" }) as { taskId: string };
    await waitUntil(() => e.queues.getTask(task.taskId).stepIndex === 2);
    const agentId = e.scheduler.agentsFor("crew")[0]!;

    let msg = "";
    await e.handle("queue.requestRemediation", { taskId: task.taskId, targetStepId: "s1", brief: "x", requestedBy: agentId }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("fan-out/sub-workflow dispatch step");
  });

  it("rejects a request from an agent that isn't this task's current step agent", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
    ];
    const { e, taskId } = await parkedAtStep2(WF_STEPS);
    let msg = "";
    await e.handle("queue.requestRemediation", { taskId, targetStepId: "s0", brief: "x", requestedBy: "some-other-agent" }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain("current step agent");
  });

  it("a null/absent requestedBy (direct/operator call) is exempt from the current-step-agent check", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
    ];
    const { e, taskId } = await parkedAtStep2(WF_STEPS);
    const res = await e.handle("queue.requestRemediation", { taskId, targetStepId: "s0", brief: "operator override" }) as { recorded: boolean };
    expect(res.recorded).toBe(true);
  });

  it("accepts a valid request and returns an accurate roundsSoFar/maxRounds preview", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
    ];
    const { e, agentId, taskId } = await parkedAtStep2(WF_STEPS);
    const res = await e.handle("queue.requestRemediation", { taskId, targetStepId: "s0", brief: "found the real bug in s0", requestedBy: agentId }) as {
      recorded: boolean; targetStepId: string; targetStepTitle: string; roundsSoFar: number; maxRounds: number; note: string;
    };
    expect(res).toMatchObject({ recorded: true, targetStepId: "s0", targetStepTitle: "plan", roundsSoFar: 0, maxRounds: 3 });
    expect(res.note).toContain("ship");

    // the request is now recorded on the live TaskRecord, ready for handleWorkflowTurn to consume
    const task = e.queues.getTask(taskId);
    expect(task.pendingRemediationRequest).toEqual({ targetStepId: "s0", brief: "found the real bug in s0", requestedBy: agentId });
  });
});
