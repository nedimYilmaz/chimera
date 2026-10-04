import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// EFFORT-ESCALATE-NOOP: escalatedEffort(template.effort) at scheduler.ts's retry-respawn site
// only ever escalates a role with an EXPLICIT spec.effort. A role that instead relies on
// effort-policy.ts's name-heuristic default (e.g. "fixer") has template.effort === undefined,
// so escalatedEffort short-circuits to undefined on every gate-triggered retry — exactly the
// roles ESCALATE-ON-EVIDENCE was built for never escalate. Mirrors the one-shot-agent
// gate-retry-respawn shape from scheduler-workflow-dead-agent.test.ts (a fresh spawn is the
// only way to observe the effort actually assigned).
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
  { end: { resultText } },
];

describe("EFFORT-ESCALATE-NOOP: gate-retry-respawn effort escalation", () => {
  it("a name-heuristic role (fixer, no explicit effort) escalates on a gate-triggered retry respawn", async () => {
    const rig = makeCoordination(
      [ONE_SHOT("attempt 1"), ONE_SHOT("attempt 2")],
      undefined,
      { gateExec: delayedGate([false, true]) },   // fails once, passes on the retry
    );
    rig.queues.create({ name: "work" });
    // no explicit effort on "fixer" — relies entirely on effort-policy.ts's name heuristic
    rig.teams.create({
      name: "crew",
      roles: { fixer: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [{
        id: "s0", title: "work", role: "fixer",
        gate: { kind: "command", spec: { command: "gate", args: [] } },
        onFail: "retry", retryLimit: 1,
      }],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    expect(rig.fake.spawns[0]!.effort).toBe("low");     // heuristic baseline applied at spawn time
    expect(rig.fake.spawns[1]!.effort).toBe("medium");  // escalated exactly one tier on the gate-triggered retry
    expect(rig.queues.getTask(task.taskId).state).toBe("done");
  });

  it("a role with an explicit effort still escalates exactly as before (unchanged behavior)", async () => {
    const rig = makeCoordination(
      [ONE_SHOT("attempt 1"), ONE_SHOT("attempt 2")],
      undefined,
      { gateExec: delayedGate([false, true]) },
    );
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, effort: "medium" as const } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [{
        id: "s0", title: "work", role: "dev",
        gate: { kind: "command", spec: { command: "gate", args: [] } },
        onFail: "retry", retryLimit: 1,
      }],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    expect(rig.fake.spawns[0]!.effort).toBe("medium");
    expect(rig.fake.spawns[1]!.effort).toBe("high");    // escalated one tier above the explicit baseline
    expect(rig.queues.getTask(task.taskId).state).toBe("done");
  });
});
