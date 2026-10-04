import { describe, it, expect, vi } from "vitest";
import { WorkflowGateSchema, type WorkflowGate } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// A two-step workflow: s0 carries the critic gate under test, s1 ("ship") is a
// trivial "none" gate that closes the conductor session — mirrors
// scheduler-gate-exec.test.ts's WF_STEPS/TWO_STEP_SCENARIO shape.
const WF_STEPS = (gate: Extract<WorkflowGate, { kind: "critic" }>, role?: string) => [
  { id: "s0", title: "work", gate, ...(role ? { role } : {}) },
  { id: "s1", title: "ship", gate: { kind: "none" as const } },
];

// Worker script: ONE step0 attempt, then the scheduler's advance-send unblocks
// step1, which closes out via the SAME `end` idiom TWO_STEP_SCENARIO uses (a plain
// `turn` for the final step immediately followed by `end` — no separate closeInput
// wait needed).
const WORKER_PASSES_ROUND_1: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { end: { resultText: "done" } },
];

// Worker script: step0 fails its first critic round, the scheduler auto-resends
// the critic's feedback as a retry (unblocking the FIRST awaitSend below with no
// test-side send() needed — see handleWorkflowTurn's willRetry branch), attempt 2
// passes, then step1 closes out exactly like WORKER_PASSES_ROUND_1.
const WORKER_PASSES_ROUND_2: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { end: { resultText: "done" } },
];

// Worker script for a critic that never approves: two attempts, no further send
// arrives once maxRounds is exhausted — finishWorkflowTask kills the still-alive
// agent (supervisor.kill sets state:"killed" directly; the fake's own run() loop
// hanging on its ran-out-of-steps tail is harmless).
const WORKER_NEVER_SATISFIED: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
];

const CRITIC_PASS: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "GATE: PASS" } }];
const criticRevise = (feedback: string): FakeStep[] =>
  [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: `GATE: REVISE\n${feedback}` } }];

const TEAM = { cwd: "/tmp", account: "main", isolation: "none" as const };

describe("QueueScheduler critic gate (FEATURE-3: evaluator-optimizer loop)", () => {
  it("pass-first-try: one critic round, no revision, task ends done", async () => {
    const rig = makeCoordination([WORKER_PASSES_ROUND_1, CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct" } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns.length).toBe(2);   // worker + exactly one critic round
    const task = rig.queues.getTask(t.taskId);
    expect(task.resultText).toBe("done");
    expect(task.stepHistory.filter((h) => h.stepIndex === 0)).toHaveLength(1);   // no retry entry
  });

  it("one-revision-then-pass: critic revises once, worker resumes with the feedback, then passes", async () => {
    const rig = makeCoordination([WORKER_PASSES_ROUND_2, criticRevise("Add error handling for the null case."), CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct", maxRounds: 3 } }) });
    const sendSpy = vi.spyOn(rig.sup, "send");

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns.length).toBe(3);   // worker + 2 critic rounds

    // the SAME worker resumes its worktree with the critic's feedback (the shared-
    // worktree continuation seam) — the retry-send carries it verbatim.
    const schedulerSends = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    expect(schedulerSends[0]).toContain("did not pass its gate");
    expect(schedulerSends[0]).toContain("Add error handling for the null case.");

    const task = rig.queues.getTask(t.taskId);
    expect(task.stepAttempts).toBe(0);   // reset on advance past step0
    const s0History = task.stepHistory.filter((h) => h.stepIndex === 0);
    expect(s0History).toHaveLength(2);
    expect(s0History[0]).toMatchObject({ outcome: "retried", reason: expect.stringContaining("Add error handling") });
    expect(s0History[1]).toMatchObject({ outcome: "passed" });
  });

  it("never-satisfied: critic always revises, task fails once maxRounds is exhausted", async () => {
    const rig = makeCoordination([WORKER_NEVER_SATISFIED, criticRevise("still missing tests"), criticRevise("still missing tests")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct", maxRounds: 2 } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);

    expect(rig.fake.spawns.length).toBe(3);   // worker + exactly maxRounds(2) critic rounds, no third
    const task = rig.queues.getTask(t.taskId);
    expect(task.error).toContain("still missing tests");
    const s0History = task.stepHistory.filter((h) => h.stepIndex === 0);
    expect(s0History).toHaveLength(2);
    expect(s0History.every((h) => h.outcome === "retried" || h.outcome === "failed")).toBe(true);
    expect(s0History[1]!.outcome).toBe("failed");
  });

  it("shares the worker's worktree even when the workflow declares no per-step roles (hasCriticGate widening)", async () => {
    const rig = makeCoordination([WORKER_PASSES_ROUND_1, CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    // No step declares `role` — hasStepRoles(wf) is false, so ONLY hasCriticGate can be
    // forcing the shared workdirKey here.
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct" } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    void t;

    expect(rig.fake.spawns.length).toBe(2);
    const [workerSpec, criticSpec] = rig.fake.spawns;
    expect(workerSpec!.workdirKey).toBeDefined();
    expect(criticSpec!.workdirKey).toBe(workerSpec!.workdirKey);
  });

  it("criticRole defaulting: an unset criticRole falls back to the step's own role, not the team's first-declared role", async () => {
    // "qa" is declared FIRST — if the fallback chain incorrectly used the team's first
    // role instead of the step's, the critic would wrongly spawn as "qa".
    const rig = makeCoordination([WORKER_PASSES_ROUND_1, CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { qa: { role: "blank", overrides: TEAM }, dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct" } }, "dev") });

    rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const criticAgentId = rig.fake.spawns[1]!.agentId;
    expect(rig.sup.status(criticAgentId).membership).toEqual({ team: "crew", role: "dev" });
  });

  it("explicit criticRole spawns the critic under that declared role, not the worker's", async () => {
    const rig = makeCoordination([WORKER_PASSES_ROUND_1, CRITIC_PASS]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { qa: { role: "blank", overrides: TEAM }, dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct", criticRole: "qa" } }, "dev") });

    rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const criticAgentId = rig.fake.spawns[1]!.agentId;
    expect(rig.sup.status(criticAgentId).membership).toEqual({ team: "crew", role: "qa" });
  });

  // BUG (dead-agent gate-retry drops retry reason): a ONE-SHOT worker (e.g. GENERIC/zai-
  // coding) closes its own session the instant its turn ends — unlike WORKER_PASSES_ROUND_2
  // above, there is no live session left for the scheduler to `send()` the critic's REVISE
  // feedback to, so handleWorkflowTurn's dead-agent branch (replaceStepAgent → spawnStepAgent)
  // must fold the feedback into the respawned worker's OWN instructions/prompt instead.
  // No `agent_started` emit (unlike ONE_SHOT elsewhere): with one emitted, ALL of
  // agent_started/turn_complete/result fire synchronously in the same tick, so turn_complete's
  // deferred dispatch and settle()'s own "already-terminal, evaluate the open step" fallback
  // (armed by the agent_started dispatch landing first) can each independently invoke
  // handleWorkflowTurn for the same turn — a pre-existing pipeline race harmless here but
  // orthogonal to what this test targets. Dropping the emit leaves turn_complete first in the
  // queue, so its own handleWorkflowTurn call claims stepTransitioning before settle() runs.
  const ONE_SHOT_ATTEMPT = (resultText: string): FakeStep[] => [{ end: { resultText } }];

  it("dead-agent retry on a one-shot worker: the respawned worker still receives the critic's REVISE feedback", async () => {
    const rig = makeCoordination([
      ONE_SHOT_ATTEMPT("attempt 1"),
      criticRevise("Add null handling for the empty-list case."),
      ONE_SHOT_ATTEMPT("attempt 2"),
      CRITIC_PASS,
      ONE_SHOT_ATTEMPT("shipped"),
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 3, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct", maxRounds: 3 } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns.length).toBe(5);   // worker attempt 1, critic round 1, worker attempt 2, critic round 2, worker for s1
    // the FRESH respawned worker (attempt 2) is a brand-new agent — nothing was ever sent
    // to the dead attempt-1 agent, so the feedback can only have reached it via its own
    // spawn spec (instructions or prompt), which is exactly what this bug drops.
    const respawn = rig.fake.spawns[2]!;
    const carriesReason = (respawn.instructions ?? "").includes("Add null handling for the empty-list case.")
      || (respawn.prompt ?? "").includes("Add null handling for the empty-list case.");
    expect(carriesReason).toBe(true);

    const task = rig.queues.getTask(t.taskId);
    expect(task.state).toBe("done");
    const s0History = task.stepHistory.filter((h) => h.stepIndex === 0);
    expect(s0History.map((h) => h.outcome)).toEqual(["retried", "passed"]);
  });

  it("fails closed to a revise round on an unparseable critic verdict, rather than hanging or throwing", async () => {
    const rig = makeCoordination([WORKER_NEVER_SATISFIED, [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "Looks fine to me." } }]]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: TEAM } }, maxConcurrent: 2, queue: "work" });
    // maxRounds:1 — the single unparseable round immediately exhausts the budget.
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "critic", spec: { criteria: "must be correct", maxRounds: 1 } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);

    const task = rig.queues.getTask(t.taskId);
    expect(task.error).toContain("no parseable verdict");
    expect(task.error).toContain("Looks fine to me.");
  });
});

describe("WorkflowGateSchema critic member (protocol round-trip)", () => {
  it("defaults maxRounds to 3 and leaves criticRole absent", () => {
    const gate = WorkflowGateSchema.parse({ kind: "critic", spec: { criteria: "must be correct" } });
    expect(gate).toEqual({ kind: "critic", spec: { criteria: "must be correct", maxRounds: 3 } });
  });

  it("rejects a missing criteria, and a maxRounds outside [1,20]", () => {
    expect(() => WorkflowGateSchema.parse({ kind: "critic", spec: {} })).toThrow();
    expect(() => WorkflowGateSchema.parse({ kind: "critic", spec: { criteria: "x", maxRounds: 0 } })).toThrow();
    expect(() => WorkflowGateSchema.parse({ kind: "critic", spec: { criteria: "x", maxRounds: 21 } })).toThrow();
  });
});
