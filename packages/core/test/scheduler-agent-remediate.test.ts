import { describe, it, expect, vi } from "vitest";
import type { WorkflowGate } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";

// AGENT-INITIATED-REMEDIATION: end-to-end scheduler behavior once a step agent's
// queue.requestRemediation call has already been recorded on the live TaskRecord (simulated here
// via a direct rig.queues.setPendingRemediationRequest call — engine-agent-remediate.test.ts
// covers the RPC handler that would normally record it; queues-agent-remediate.test.ts covers
// the QueueStore-level guards on that call itself). This file is the loop-safety deliverable:
// the pending request PRE-EMPTS the step's own gate (never runs it), draws on the SAME bounded
// remediationRounds/remediationGateStep budget the gate-triggered loop uses (never a second,
// independent counter — scheduler-gate-remediate.test.ts's (a)/(b) pin that machinery itself),
// budget exhaustion terminates with a legible message, and a stale/invalid request never
// silently applies an invalid jump.
//
// Timing note: FakeAgentBackend's script runs eagerly between `awaitSend` boundaries, so to get
// a deterministic window to inject the pending request BEFORE the current step's own turn
// completes, each scenario below parks the agent on an EXTRA `{awaitSend:true}` that nothing
// auto-delivers — the test itself calls `rig.sup.send(agentId, ..., "test")` to unblock it only
// once the injection is done, guaranteeing the pending request is visible before the next
// `{turn:{}}` fires.

const TEAM = { cwd: "/tmp", account: "main", isolation: "none" as const };
const noneGate: WorkflowGate = { kind: "none" };

const alwaysFailsGateExec = (message: string): { exec: GateExecFn; calls: () => number } => {
  let calls = 0;
  const exec: GateExecFn = async () => { calls += 1; return { ok: false, message }; };
  return { exec, calls: () => calls };
};

describe("QueueScheduler agent-initiated remediation (AGENT-INITIATED-REMEDIATION)", () => {
  it("a pending request PRE-EMPTS the step's own gate (never evaluated, even though it would fail), routes to the target step, and consumes the shared remediation budget", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      // a command gate configured to ALWAYS FAIL — if this ever actually runs, the test's own
      // `calls()` assertion below catches it. onFail:"remediate" is required for the request to
      // be honored at all (mirrors the gate-triggered path's own gating).
      { id: "s2", title: "ship", gate: { kind: "command" as const, spec: { command: "gate", args: [] } }, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },        // s0 -> advance to s1
      { awaitSend: true },  // consumes the s1-arrival send
      { turn: {} },        // s1 -> advance to s2
      { awaitSend: true },  // consumes the s2-arrival send
      { awaitSend: true },  // BLOCKS — nothing auto-delivers this; the test unblocks it manually
      { turn: {} },        // s2's OWN turn — handleWorkflowTurn must find the pending request here
    ];
    const { exec: gateExec, calls } = alwaysFailsGateExec("should never run");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const sendSpy = vi.spyOn(rig.sup, "send");
    const failedEvents: Array<Record<string, unknown>> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failedEvents.push(ev.data as Record<string, unknown>); });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 2 && rig.queues.getTask(t.taskId).state === "in_progress");

    const agentId = rig.fake.spawns[0]!.agentId;
    rig.queues.setPendingRemediationRequest(t.taskId, {
      targetStepId: "s0", brief: "the real bug is in plan's assumptions", requestedBy: agentId,
    });
    await rig.sup.send(agentId, "continue", "test");   // unblocks the parked awaitSend, letting s2's turn fire

    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 0);

    expect(calls()).toBe(0);   // the gate that would have ALWAYS failed was never even invoked

    const task = rig.queues.getTask(t.taskId);
    expect(task.pendingRemediationRequest).toBeNull();          // one-shot: consumed, not left dangling
    expect(task.remediationRounds).toBe(1);
    expect(task.remediationGateStep).toBe(2);                    // anchored to the REQUESTING step (s2), same convention as gate-triggered

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ stepId: "s2", willRetry: true, remediate: true, agentInitiated: true });
    expect(failedEvents[0]!["reason"]).toContain("the real bug is in plan's assumptions");

    const schedulerSends = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    const fixBriefSend = schedulerSends.find((s) => s.includes("the real bug is in plan's assumptions"));
    expect(fixBriefSend).toBeDefined();
    expect(fixBriefSend).toContain('Agent-requested correction from step "ship"');
  });

  it("budget exhaustion terminates the task with a legible message naming the requester, target step, and rounds spent — never an immortal loop", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },              // s0 -> s1
      { turn: {} }, { awaitSend: true },              // s1 -> s2
      { awaitSend: true },                            // BLOCK #1 — inject request #1
      { turn: {} },                                    // s2 turn #1: request #1 processed, round 1/2, routes to s0
      { awaitSend: true },                            // consumes the s0-redo send
      { turn: {} }, { awaitSend: true },              // s0 (redo) -> s1
      { turn: {} }, { awaitSend: true },              // s1 -> s2
      { awaitSend: true },                            // BLOCK #2 — inject request #2
      { turn: {} },                                    // s2 turn #2: request #2 processed, round 2/2 EXHAUSTED -> fail
    ];
    const rig = makeCoordination([WORKER], COORD_CFG);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 2 && rig.queues.getTask(t.taskId).state === "in_progress");
    const agentId = rig.fake.spawns[0]!.agentId;

    // round 1: accepted (roundsSoFar 0 -> willRemediate, since 0+1 < 2)
    rig.queues.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "diagnosis one", requestedBy: agentId });
    await rig.sup.send(agentId, "continue", "test");
    await waitUntil(() => rig.queues.getTask(t.taskId).remediationRounds === 1);
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 2 && rig.queues.getTask(t.taskId).state === "in_progress");

    // round 2: rejected (roundsSoFar 1 -> 1+1 == maxRounds(2), NOT < maxRounds) -> exhausted -> fail
    rig.queues.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "diagnosis two", requestedBy: agentId });
    await rig.sup.send(agentId, "continue", "test");
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toContain(agentId);              // WHO requested it
    expect(task.error).toContain("s0");                  // WHAT was requested (target step)
    expect(task.error).toContain("2 remediation round(s)"); // HOW MANY rounds the policy allowed
    // mirrors the gate-triggered exhaustion path exactly: the counter only increments on a round
    // that's actually GRANTED (willRemediate), never on the final exhausting failure itself — so
    // with maxRounds:2, exactly ONE round was granted (the one this test's "round 1" consumed)
    // before round 2 hit the budget wall.
    expect(task.remediationRounds).toBe(1);
    expect(task.remediationGateStep).toBe(2);
  });

  it("a stale/invalid pending request (target no longer strictly earlier) is discarded and falls through to the step's OWN gate — never a silent jump", async () => {
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },   // s0 -> s1
      { turn: {} }, { awaitSend: true },   // s1 -> s2
      { awaitSend: true },                 // BLOCK — inject a STALE request
      { turn: {} },                        // s2's own turn: request is stale -> falls through -> gate (none) passes -> terminal
      { end: { resultText: "done" } },
    ];
    const rig = makeCoordination([WORKER], COORD_CFG);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 2 && rig.queues.getTask(t.taskId).state === "in_progress");
    const agentId = rig.fake.spawns[0]!.agentId;

    // "s2" (the current step itself) is NOT strictly earlier than stepIndex 2 — a stale/invalid
    // target (e.g. the workflow moved, or the agent named its own step by mistake).
    rig.queues.setPendingRemediationRequest(t.taskId, { targetStepId: "s2", brief: "bogus", requestedBy: agentId });
    await rig.sup.send(agentId, "continue", "test");

    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
    expect(task.pendingRemediationRequest).toBeNull();
    // never touched the remediation budget — the stale request was discarded, not "applied"
    expect(task.remediationRounds).toBe(0);
    expect(task.remediationGateStep).toBeNull();
  });

  it("the anchor clears once its OWN step's gate genuinely passes, and a LATER agent-request at a DIFFERENT step starts its own budget from zero — no cross-contamination, no resurrected counter", async () => {
    // s1 and s2 EACH carry their own onFail:"remediate" policy (independent anchors). Round 1
    // bounces s1 -> s0 via an agent request; once s0's redo climbs back to s1 and s1's gate
    // passes FOR REAL (no second request), the anchor (gateStep=1) must clear. Only THEN does a
    // fresh agent request at s2 (a completely different step) get to draw its own budget.
    const WF_STEPS = [
      { id: "s0", title: "plan", gate: noneGate },
      { id: "s1", title: "implement", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
      { id: "s2", title: "ship", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },   // s0 -> s1 (1st arrival)
      { awaitSend: true },                  // BLOCK 1 — inject request #1 (s1 -> s0)
      { turn: {} },                         // s1 turn #1: request #1 processed -> round 1/2, anchor=1, routes to s0
      { awaitSend: true },                  // consumes the s0-redo send
      { turn: {} }, { awaitSend: true },   // s0 (redo) -> s1 (2nd arrival)
      { awaitSend: true },                  // BLOCK 2 — no injection this time; s1's gate passes for real
      { turn: {} },                         // s1 turn #2: gate (none) passes -> anchor(1) === stepIndex(1) -> RESET -> advances to s2
      { awaitSend: true },                  // consumes the s2-arrival send
      { awaitSend: true },                  // BLOCK 3 — inject request #2 (s2 -> s1), on a FRESH (reset) anchor
      { turn: {} },                         // s2 turn: request #2 processed -> fresh anchor=2, round 1/2
    ];
    const rig = makeCoordination([WORKER], COORD_CFG);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 1 && rig.queues.getTask(t.taskId).state === "in_progress");
    const agentId = rig.fake.spawns[0]!.agentId;

    // round 1 at s1: agent-requested jump back to s0.
    rig.queues.setPendingRemediationRequest(t.taskId, { targetStepId: "s0", brief: "req1", requestedBy: agentId });
    await rig.sup.send(agentId, "continue", "test");
    await waitUntil(() => rig.queues.getTask(t.taskId).remediationRounds === 1 && rig.queues.getTask(t.taskId).remediationGateStep === 1);
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 1 && rig.queues.getTask(t.taskId).state === "in_progress");

    // let s1's gate pass FOR REAL this time (no request injected) — the anchor must clear.
    await rig.sup.send(agentId, "continue", "test");
    await waitUntil(() => rig.queues.getTask(t.taskId).remediationGateStep === null);
    await waitUntil(() => rig.queues.getTask(t.taskId).stepIndex === 2 && rig.queues.getTask(t.taskId).state === "in_progress");
    expect(rig.queues.getTask(t.taskId).remediationRounds).toBe(0);   // reset, not just re-anchored

    // round 1 at s2 (a DIFFERENT step): must start its OWN budget at 0, not inherit s1's history.
    rig.queues.setPendingRemediationRequest(t.taskId, { targetStepId: "s1", brief: "req2", requestedBy: agentId });
    await rig.sup.send(agentId, "continue", "test");
    await waitUntil(() => rig.queues.getTask(t.taskId).remediationGateStep === 2);

    const task = rig.queues.getTask(t.taskId);
    expect(task.remediationRounds).toBe(1);       // fresh round 1, not a resurrected/contaminated count
    expect(task.remediationGateStep).toBe(2);      // anchored to s2 now, independent of s1's earlier (cleared) anchor
    expect(task.stepIndex).toBe(1);                 // routed back to s1 per request #2
  });

  it("workflowInstructions mentions queue_request_remediation (with an accurate remaining-round count) ONLY when the spawned step actually has a resolved remediate policy", async () => {
    const rigWith = makeCoordination([[{ awaitSend: true }, { end: { resultText: "done" } }]], COORD_CFG);
    rigWith.queues.create({ name: "work" });
    rigWith.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rigWith.workflows.create({
      name: "wf-remediate",
      steps: [
        { id: "s0", title: "implement", gate: noneGate, onFail: "remediate" as const, remediate: { maxRounds: 2 } },
        { id: "s1", title: "ship", gate: noneGate },
      ],
    });
    rigWith.queues.push("work", { prompt: "go", workflow: "wf-remediate" });
    await rigWith.scheduler.tick();
    await waitUntil(() => rigWith.fake.spawns.length === 1);
    const instructions = rigWith.fake.spawns[0]!.instructions!;
    expect(instructions).toContain("queue_request_remediation");
    expect(instructions).toContain("2 round(s) remain");   // roundsSoFar is 0 on a fresh spawn -> maxRounds(2) - 0 remain

    // the SAME step shape but onFail left at its "halt" default (today's every live workflow,
    // per D12) — the paragraph, and its tool-name token, must be COMPLETELY ABSENT, i.e. zero
    // added spawn-time tokens for a workflow that never opted into remediate.
    const rigWithout = makeCoordination([[{ awaitSend: true }, { end: { resultText: "done" } }]], COORD_CFG);
    rigWithout.queues.create({ name: "work" });
    rigWithout.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rigWithout.workflows.create({
      name: "wf-plain",
      steps: [
        { id: "s0", title: "implement", gate: noneGate },
        { id: "s1", title: "ship", gate: noneGate },
      ],
    });
    rigWithout.queues.push("work", { prompt: "go", workflow: "wf-plain" });
    await rigWithout.scheduler.tick();
    await waitUntil(() => rigWithout.fake.spawns.length === 1);
    expect(rigWithout.fake.spawns[0]!.instructions).not.toContain("queue_request_remediation");
  });
});
