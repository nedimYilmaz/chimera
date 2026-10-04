import { describe, it, expect, vi } from "vitest";
import type { WorkflowGate } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";

const TEAM = { cwd: "/tmp", account: "main", isolation: "none" as const };
const commandGate = { kind: "command" as const, spec: { command: "gate", args: [] } };
const noneGate: WorkflowGate = { kind: "none" };

// A stateful gateExec: fails the first `failTimes` calls (with `message` as the captured
// failure text), then always passes. Mirrors scheduler-gate-exec.test.ts's injected-gateExec
// pattern — deterministic without shelling out for real.
function flakyGateExec(failTimes: number, message: string): { exec: GateExecFn; calls: () => number } {
  let calls = 0;
  const exec: GateExecFn = async () => {
    calls += 1;
    return calls <= failTimes ? { ok: false, message } : { ok: true, message: "" };
  };
  return { exec, calls: () => calls };
}

const alwaysFailsGateExec = (message: string): { exec: GateExecFn; calls: () => number } => {
  let calls = 0;
  const exec: GateExecFn = async () => { calls += 1; return { ok: false, message }; };
  return { exec, calls: () => calls };
};

describe("QueueScheduler gate-failure remediation loop (GATE-REMEDIATION-LOOP)", () => {
  it("(a) converges: routes back to the earlier 'implement' step with the gate's failure text, re-advances, and lands done", async () => {
    // plan -> implement -> ship(command gate, onFail:"remediate"). No roles anywhere — a
    // single agent handles every step. ship's gate fails once, remediation bounces back to
    // "implement" (the nearest preceding step whose id is "implement"), then re-advances
    // forward through ship's gate, which now passes.
    const WF_STEPS = [
      { id: "plan", title: "plan", gate: noneGate },
      { id: "implement", title: "implement", gate: noneGate },
      { id: "ship", title: "ship", gate: commandGate, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },       // plan -> advance to implement
      { awaitSend: true },
      { turn: {} },       // implement (1st visit) -> advance to ship
      { awaitSend: true },
      { turn: {} },       // ship (1st attempt) -> gate FAILS -> remediate back to implement
      { awaitSend: true },
      { turn: {} },       // implement (remediation attempt) -> advance to ship again
      { awaitSend: true },
      { turn: {} },       // ship (2nd attempt) -> gate PASSES -> terminal
      { end: { resultText: "done" } },
    ];
    const { exec: gateExec, calls } = flakyGateExec(1, "lint error: unused var");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const sendSpy = vi.spyOn(rig.sup, "send");
    const advanced: Array<{ stepIndex: number; stepId: string }> = [];
    const failedEvents: Array<Record<string, unknown>> = [];
    rig.events.subscribe((ev) => {
      if (ev.kind === "task_step_advanced") advanced.push(ev.data as never);
      if (ev.kind === "task_step_failed") failedEvents.push(ev.data as Record<string, unknown>);
    });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns.length).toBe(1);        // SAME agent throughout — no role switch, no respawn
    expect(calls()).toBe(2);                         // gate ran twice: fail, then pass

    // bounced back to "implement" (stepIndex 1), then re-advanced forward to "ship" (stepIndex 2) again
    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1, 2, 1, 2]);
    expect(advanced.map((a) => a.stepId)).toEqual(["plan", "implement", "ship", "implement", "ship"]);

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ stepId: "ship", willRetry: true, remediate: true });

    // the fix-brief carrying the gate's captured failure text was sent to the SAME agent
    const schedulerSends = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    const fixBriefSend = schedulerSends.find((s) => s.includes("lint error: unused var"));
    expect(fixBriefSend).toBeDefined();
    expect(fixBriefSend).toContain('The "ship" gate failed with');

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
    expect(task.error).toBeNull();
    // the anchor clears once the anchored gate step itself finally passes
    expect(task.remediationRounds).toBe(0);
    expect(task.remediationGateStep).toBeNull();
  });

  it("(b) exhausts: never converges -> exhausts maxRounds -> workflow fails (bounded, not infinite)", async () => {
    const WF_STEPS = [
      { id: "plan", title: "plan", gate: noneGate },
      { id: "implement", title: "implement", gate: noneGate },
      { id: "ship", title: "ship", gate: commandGate, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },       // plan
      { awaitSend: true },
      { turn: {} },       // implement (1st visit)
      { awaitSend: true },
      { turn: {} },       // ship (round 1, FAIL)
      { awaitSend: true },
      { turn: {} },       // implement (remediation 1)
      { awaitSend: true },
      { turn: {} },       // ship (round 2, FAIL)
      { awaitSend: true },
      { turn: {} },       // implement (remediation 2)
      { awaitSend: true },
      { turn: {} },       // ship (round 3, FAIL -> maxRounds exhausted)
    ];
    const { exec: gateExec, calls } = alwaysFailsGateExec("still broken");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const failedEvents: Array<Record<string, unknown>> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failedEvents.push(ev.data as Record<string, unknown>); });

    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    // exactly maxRounds(3) gate evaluations — the round counter survived TWO full bounces
    // through "implement" (proving it's not silently reset by advanceStep the way stepAttempts
    // would be), then stopped instead of looping forever.
    expect(calls()).toBe(3);
    expect(failedEvents).toHaveLength(3);
    expect(failedEvents[0]).toMatchObject({ willRetry: true, remediate: true });
    expect(failedEvents[1]).toMatchObject({ willRetry: true, remediate: true });
    expect(failedEvents[2]).toMatchObject({ willRetry: false, remediate: true });

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toContain("still broken");
    expect(task.error).toContain("3 remediation round(s)");
  });

  it("(c) single-agent bounce-to-self: step 0's own gate fails with no earlier step to route to — resends the SAME agent", async () => {
    const WF_STEPS = [
      { id: "work", title: "work", gate: commandGate, onFail: "remediate" as const, remediate: { maxRounds: 3 } },
      { id: "ship", title: "ship", gate: noneGate },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },       // work (1st attempt) -> gate FAILS -> bounce to self (no earlier step exists)
      { awaitSend: true },
      { turn: {} },       // work (bounce-to-self resend) -> gate PASSES -> advance to ship
      { awaitSend: true },
      { turn: {} },       // ship -> terminal
      { end: { resultText: "done" } },
    ];
    const { exec: gateExec } = flakyGateExec(1, "flaky check failed");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const sendSpy = vi.spyOn(rig.sup, "send");
    const advanced: Array<{ stepIndex: number }> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns.length).toBe(1);
    // the bounce-to-self resend does NOT call advanceStep/emitStepAdvanced (stepIndex never
    // moves) — the only task_step_advanced is the ordinary work -> ship advance once work's
    // gate finally passes.
    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1]);

    const agentId = rig.fake.spawns[0]!.agentId;
    const schedulerSends = sendSpy.mock.calls.filter((c) => c[2] === "scheduler");
    expect(schedulerSends.every((c) => c[0] === agentId)).toBe(true);   // always the SAME agent
    expect(schedulerSends.some((c) => (c[1] as string).includes("flaky check failed"))).toBe(true);

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
  });

  it("(d-i) onFail:'retry' is unaffected — still resends the SAME step, no remediation routing", async () => {
    const WF_STEPS = [
      { id: "s0", title: "test", gate: commandGate, onFail: "retry" as const, retryLimit: 2 },
      { id: "s1", title: "ship", gate: noneGate },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { awaitSend: true },
      { turn: {} },
      { awaitSend: true },
      { turn: {} },
      { end: { resultText: "done" } },
    ];
    const { exec: gateExec } = flakyGateExec(1, "transient failure");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const advanced: Array<{ stepIndex: number }> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns.length).toBe(1);
    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1]);   // no bounce — s0 was resent in place
    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
    expect(task.remediationRounds).toBe(0);
    expect(task.remediationGateStep).toBeNull();
  });

  it("(d-ii) a critic gate keeps its OWN independent maxRounds loop even with onFail:'remediate' set — remediation never engages", async () => {
    const WF_STEPS = [
      {
        id: "s0", title: "work",
        gate: { kind: "critic" as const, spec: { criteria: "must be correct", maxRounds: 3 } },
        onFail: "remediate" as const, remediate: { maxRounds: 2 },   // set but must be ignored for a critic gate
      },
      { id: "s1", title: "ship", gate: noneGate },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { awaitSend: true },
      { turn: {} },
      { awaitSend: true },
      { turn: {} },
      { end: { resultText: "done" } },
    ];
    const CRITIC_PASS: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "GATE: PASS" } }];
    const criticRevise = (feedback: string): FakeStep[] =>
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: `GATE: REVISE\n${feedback}` } }];

    const rig = makeCoordination([WORKER, criticRevise("needs a null check"), CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns.length).toBe(3);   // worker + 2 critic rounds — the critic's OWN loop, untouched
    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
    // remediation machinery never engaged for a critic gate, regardless of onFail
    expect(task.remediationRounds).toBe(0);
    expect(task.remediationGateStep).toBeNull();
  });

  it("(d-iii) onFail:'halt' (default) is unaffected — fails immediately on the first gate miss, no remediation attempted", async () => {
    const WF_STEPS = [
      { id: "s0", title: "test", gate: commandGate },   // onFail defaults to "halt"
      { id: "s1", title: "ship", gate: noneGate },
    ];
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ];
    const { exec: gateExec, calls } = alwaysFailsGateExec("permanent failure");
    const rig = makeCoordination([WORKER], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    expect(calls()).toBe(1);   // exactly one gate evaluation — no retry, no remediation
    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toContain("permanent failure");
  });
});
