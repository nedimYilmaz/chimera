import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// WORKFLOW-STEP-SURVIVES-AGENT-EXIT: a ONE-SHOT backend (e.g. GENERIC/zai-coding) closes its
// own session the instant its turn ends with no queued follow-up — unlike claude/codex, whose
// SDK session stays open across turns. Its terminal "done" event can therefore race ahead of
// the scheduler's own async gate evaluation (kicked off by the PRECEDING turn_complete event),
// which the FakeAgentBackend's `{ end }` step reproduces exactly: turn_complete and result fire
// back-to-back, synchronously, with nothing in between. A `command` gate backed by a REAL async
// exec (here: a gateExec that resolves via a macrotask, like the real execFile-based one) lets
// settle()'s terminal-event handling for the (by-then-dead) agent run BEFORE the gate resolves —
// exactly the ordering that produced the live bug (task marked "done" at stepIndex 0 of 3).
function delayedGate(sequence: Array<boolean>): GateExecFn {
  let call = 0;
  return () => new Promise((resolve) => {
    const ok = sequence[Math.min(call, sequence.length - 1)]!;
    call++;
    setTimeout(() => resolve({ ok, message: ok ? "" : "not yet" }), 5);
  });
}

const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },   // one-shot: turn_complete + result fire back-to-back, no live session left
];

describe("QueueScheduler workflow step boundary survives a one-shot agent's exit (WORKFLOW-STEP-SURVIVES-AGENT-EXIT)", () => {
  it("a 3-step/3-role workflow where every step's agent is one-shot still walks all 3 steps to done", async () => {
    const rig = makeCoordination(
      [ONE_SHOT("alpha done"), ONE_SHOT("beta done"), ONE_SHOT("gamma done")],
      undefined,
      { gateExec: delayedGate([true]) },
    );
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        alpha: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        beta: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        gamma: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
      },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "alpha" },
        { id: "s1", title: "build", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "beta" },
        { id: "s2", title: "ship", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "gamma" },
      ],
    });

    const advanced: number[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push((ev.data as { stepIndex: number }).stepIndex); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(3);            // alpha, beta, gamma — every step actually ran
    expect(advanced).toEqual([0, 1, 2]);                // never stalled at step 0

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepIndex).toBe(2);
    expect(final.stepHistory.map((h) => h.stepId)).toEqual(["s0", "s1", "s2"]);
    expect(final.stepHistory.every((h) => h.outcome === "passed")).toBe(true);
    // each step's history entry is bound to the FRESH agent actually spawned for it, not the
    // (already-dead) previous step's agent.
    expect(final.stepHistory[0]!.agentId).toBe(rig.fake.spawns[0]!.agentId);
    expect(final.stepHistory[1]!.agentId).toBe(rig.fake.spawns[1]!.agentId);
    expect(final.stepHistory[2]!.agentId).toBe(rig.fake.spawns[2]!.agentId);
  });

  it("a gate-failure retry on a one-shot agent respawns a fresh agent for the SAME step, not a stuck task", async () => {
    const rig = makeCoordination(
      [ONE_SHOT("attempt 1"), ONE_SHOT("attempt 2")],
      undefined,
      { gateExec: delayedGate([false, true]) },   // fails once, passes on the retry
    );
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { solo: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        {
          id: "s0", title: "work", role: "solo",
          gate: { kind: "command", spec: { command: "gate", args: [] } },
          onFail: "retry", retryLimit: 1,
        },
      ],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);   // the failed attempt + the fresh retry respawn
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepAttempts).toBe(1);        // the retry was consumed exactly once (not reset by a stray advanceStep)
    const s0Entries = final.stepHistory.filter((h) => h.stepId === "s0");
    expect(s0Entries.map((h) => h.outcome)).toEqual(["retried", "passed"]);
    expect(s0Entries[0]!.agentId).toBe(rig.fake.spawns[0]!.agentId);
    expect(s0Entries[1]!.agentId).toBe(rig.fake.spawns[1]!.agentId);   // the retry's OWN fresh agent, not a duplicate/dangling entry
  });
});
