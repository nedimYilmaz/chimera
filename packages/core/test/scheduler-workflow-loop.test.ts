import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// Bounded conditional loops (iterate-until gate, FEATURE): a `loopBack` edge lets a workflow
// re-run a prior phase, guarded by a mandatory maxIterations cap and an artifactValue route
// condition. Mirrors scheduler-workflow-graph.test.ts's conventions (makeCoordination/waitUntil/
// events.subscribe-driven scenario), using a "head" -> "work" -> "done" shape throughout: "head"
// has no `next` (implicit fallthrough to "work"); "work" either loops back to "head" or falls
// through to "done" depending on a test-side counter artifact re-registered each time "work" is
// (re-)entered.

// A same-role, single-conductor chain of N step-executions that ENDS successfully — (N-1)
// turn+awaitSend pairs (each step-transition needs a fresh send()) then a final `end`.
const sameRoleChain = (n: number, resultText: string): FakeStep[] => {
  const steps: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }];
  for (let i = 0; i < n - 1; i++) { steps.push({ turn: {} }); steps.push({ awaitSend: true }); }
  steps.push({ end: { resultText } });
  return steps;
};

// Same shape, but the LAST step-execution's gate evaluation FAILS the task (unrouted) rather
// than terminating gracefully — no trailing `end`/`awaitSend`, just a bare final `turn` (the
// scheduler tears the still-alive agent down itself via finishWorkflowTask, not via the script).
const sameRoleChainToFailure = (n: number): FakeStep[] => {
  const steps: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }];
  for (let i = 0; i < n; i++) { steps.push({ turn: {} }); if (i < n - 1) steps.push({ awaitSend: true }); }
  return steps;
};

function setupTeamAndQueue(rig: ReturnType<typeof makeCoordination>, opts: { retryLimit?: number; onFail?: "halt" | "retry" } = {}) {
  rig.queues.create({ name: "work", ...(opts.retryLimit !== undefined ? { retryLimit: opts.retryLimit } : {}) });
  rig.teams.create({
    name: "crew",
    roles: { loop: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
    maxConcurrent: 3, queue: "work",
  });
}

// Registers a "counter" file artifact for the task every time "work" is (re-)entered
// (task_step_advanced with stepId==="work"), content decided by `valueForRound(round)` (round
// starts at 1 on the FIRST entry into "work"). Synchronous — ArtifactStore.add snapshots the
// file's CURRENT bytes at call time, so by the time "work"'s gate is evaluated (later, driven by
// the fake backend's own scripted turn), the artifact already reflects this round's value.
function driveCounterArtifact(rig: ReturnType<typeof makeCoordination>, taskId: string, valueForRound: (round: number) => string): void {
  let round = 0;
  const file = join(rig.dir, "counter.txt");
  rig.events.subscribe((ev) => {
    if (ev.kind === "task_step_advanced" && (ev.data as { stepId: string }).stepId === "work") {
      round++;
      writeFileSync(file, valueForRound(round));
      rig.artifacts.add({ kind: "file", path: file, label: "counter", agentId: null, taskId });
    }
  });
}

describe("QueueScheduler — bounded conditional loops (iterate-until gate)", () => {
  it("loop-iterates-until-condition-met: loops back while the artifact reads 'continue', falls through once it reads 'done'", async () => {
    // head(1) -> work(2, continue, loop) -> head(3) -> work(4, continue, loop) -> head(5) ->
    // work(6, done, fallthrough) -> done(7): 7 step-executions.
    const rig = makeCoordination([sameRoleChain(7, "finished")]);
    setupTeamAndQueue(rig);
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "head", title: "head", gate: { kind: "none" }, role: "loop" },
        {
          id: "work", title: "work", gate: { kind: "none" }, role: "loop",
          next: [
            { to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 5 } },
            { to: "done" },
          ],
        },
        { id: "done", title: "done", gate: { kind: "none" }, role: "loop", next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "iterate", workflow: "wf" });
    driveCounterArtifact(rig, task.taskId, (round) => (round >= 3 ? "done" : "continue"));
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.loopIterations).toEqual({ work: 2 });
    const ids = final.stepHistory.map((h) => h.stepId);
    expect(ids.filter((id) => id === "head")).toHaveLength(3);
    expect(ids.filter((id) => id === "work")).toHaveLength(3);
    expect(ids.filter((id) => id === "done")).toHaveLength(1);
    // one role for head/work/done throughout — the SAME conductor agent handles every round,
    // never torn down/respawned by the loop-back.
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("maxIterations-cap-stops-an-always-true-condition: with no fallback edge, an exhausted cap fails the task instead of looping forever", async () => {
    // head(1) -> work(2, loop->1) -> head(3) -> work(4, loop->2, cap reached) -> head(5) ->
    // work(6, cap exceeded, unrouted -> FAILS): 6 step-executions.
    const rig = makeCoordination([sameRoleChainToFailure(6)]);
    setupTeamAndQueue(rig);
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "head", title: "head", gate: { kind: "none" }, role: "loop" },
        {
          id: "work", title: "work", gate: { kind: "none" }, role: "loop",
          next: [{ to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 2 } }],
        },
      ],
    });

    const task = rig.queues.push("work", { prompt: "iterate forever", workflow: "wf" });
    driveCounterArtifact(rig, task.taskId, () => "continue");   // never satisfies the exit condition
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain('no "next" condition matched');
    // cap reached exactly, never exceeded — the 3rd "work" entry is the one that DISCOVERS the
    // exhausted cap (its own gate still passes; the failure is a routing failure, not a gate one).
    expect(final.loopIterations).toEqual({ work: 2 });
    expect(final.stepHistory.filter((h) => h.stepId === "work")).toHaveLength(3);
  });

  it("maxIterations-cap-falls-through-to-fallback-edge: an exhausted cap with a fallback edge advances instead of failing", async () => {
    const rig = makeCoordination([sameRoleChain(7, "gave up gracefully")]);
    setupTeamAndQueue(rig);
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "head", title: "head", gate: { kind: "none" }, role: "loop" },
        {
          id: "work", title: "work", gate: { kind: "none" }, role: "loop",
          next: [
            { to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 2 } },
            { to: "done" },
          ],
        },
        { id: "done", title: "done", gate: { kind: "none" }, role: "loop", next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "iterate then give up", workflow: "wf" });
    driveCounterArtifact(rig, task.taskId, () => "continue");
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.loopIterations).toEqual({ work: 2 });
    expect(final.stepHistory.filter((h) => h.stepId === "work")).toHaveLength(3);
    expect(final.stepHistory.filter((h) => h.stepId === "done")).toHaveLength(1);
  });

  it("single-conductor-across-a-loop-round: one loop-back and one fallthrough never respawn the same-role agent", async () => {
    // head(1) -> work(2, continue, loop->1) -> head(3) -> work(4, done, fallthrough) -> done(5).
    const rig = makeCoordination([sameRoleChain(5, "ok")]);
    setupTeamAndQueue(rig);
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "head", title: "head", gate: { kind: "none" }, role: "loop" },
        {
          id: "work", title: "work", gate: { kind: "none" }, role: "loop",
          next: [
            { to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 5 } },
            { to: "done" },
          ],
        },
        { id: "done", title: "done", gate: { kind: "none" }, role: "loop", next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "one loop then stop", workflow: "wf" });
    driveCounterArtifact(rig, task.taskId, (round) => (round >= 2 ? "done" : "continue"));
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.queues.getTask(task.taskId).loopIterations).toEqual({ work: 1 });
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("loop-back-vs-gate-retry-counters-are-orthogonal: a gate-failure retry within a round never touches loopIterations, and stepAttempts resets clean on the next round", async () => {
    // work's gate is a "command" gate whose FIRST-ever evaluation fails (retryLimit:1 at the
    // workflow level), every later evaluation passes — proves a within-round retry is invisible
    // to loopIterations, and the NEXT round's fresh "work" entry needs no retry of its own
    // (stepAttempts correctly reset by the ordinary advanceStep path, unmodified by this feature).
    let gateCalls = 0;
    const gateExec: GateExecFn = () => {
      gateCalls++;
      const ok = gateCalls !== 1;
      return Promise.resolve({ ok, message: ok ? "" : "not ready yet" });
    };
    // head(1,turn) -> work(2,attempt1,fails,retry) -> work(3,attempt2,passes,loop->1) ->
    // head(4) -> work(5,attempt1,passes,done,fallthrough) -> done(6): 6 step-executions.
    const rig = makeCoordination([sameRoleChain(6, "resolved")], undefined, { gateExec });
    setupTeamAndQueue(rig, { retryLimit: 1, onFail: "retry" });
    rig.workflows.create({
      name: "wf",
      onFail: "retry",
      retryLimit: 1,
      steps: [
        { id: "head", title: "head", gate: { kind: "none" }, role: "loop" },
        {
          id: "work", title: "work", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "loop",
          next: [
            { to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 5 } },
            { to: "done" },
          ],
        },
        { id: "done", title: "done", gate: { kind: "none" }, role: "loop", next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "retry then loop then stop", workflow: "wf" });
    driveCounterArtifact(rig, task.taskId, (round) => (round >= 2 ? "done" : "continue"));
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    // exactly ONE genuine loop-back, despite TWO "work" gate evaluations in round 1 (attempt +
    // retry) — a consumed retry never increments loopIterations.
    expect(final.loopIterations).toEqual({ work: 1 });
    const workEntries = final.stepHistory.filter((h) => h.stepId === "work");
    expect(workEntries).toHaveLength(3);   // round1-attempt1(retried), round1-attempt2(passed), round2-attempt1(passed)
    expect(workEntries.map((h) => h.outcome)).toEqual(["retried", "passed", "passed"]);
  });
});
