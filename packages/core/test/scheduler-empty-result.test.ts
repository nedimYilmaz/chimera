import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { GateExecFn } from "@chimera/core/scheduler";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// EMPTY-RESULT-NOT-DONE follow-ups. The guard added in settle() (a "done" agent with empty text
// and no structured output fails its task) shipped with two defects this file pins down:
//   1. it disagreed with finalizeDeadWorkflowAgent, so a gate-certified workflow landed done or
//      failed purely on whether the agent was still alive when its last gate passed;
//   2. it used markFailed (cascade-fails every dependent, no retry) for what is a TRANSIENT
//      symptom, so one truncated round-trip doomed a whole dependency subtree.

const EMPTY = (): FakeStep[] => [{ end: { resultText: "", costUsd: 0.01 } }];
const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.01 } }];
const DEV_TEAM = (maxConcurrent: number) => ({
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent, queue: "work",
});

// One-shot: turn_complete + result fire back-to-back with nothing in between, so the agent is
// already DEAD by the time a real (async) gate resolves — the finalizeDeadWorkflowAgent path.
const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];
// Still ALIVE at its step boundary: a turn ends, the gate runs against a live session, the
// scheduler calls closeInput, and only THEN does the (empty) result arrive — the settle() path.
const ALIVE_THEN_EMPTY: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: {} },
  { awaitClose: { resultText: "" } },
];

// A gate that resolves via a macrotask, like the real execFile-backed one — enough of a gap for
// a one-shot agent's own terminal event to land first.
const delayedPass: GateExecFn = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, message: "" }), 5));

function singleStepWorkflow(rig: ReturnType<typeof makeCoordination>) {
  rig.workflows.create({
    name: "wf",
    steps: [{ id: "s0", title: "build", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "dev" }],
  });
}

describe("EMPTY-RESULT-NOT-DONE agrees across the dead-agent and live-agent orderings", () => {
  it("a gate-certified workflow whose LAST step's agent returned empty text lands done — agent already DEAD when the gate passed", async () => {
    const rig = makeCoordination([ONE_SHOT("")], undefined, { gateExec: delayedPass });
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    singleStepWorkflow(rig);
    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state !== "in_progress", 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory.at(-1)!.outcome).toBe("passed");
    expect(rig.fake.spawns).toHaveLength(1);                // no failure, so no retry respawn
  });

  it("the SAME workflow lands done when the agent was still ALIVE when the gate passed (settle() path, not finalizeDeadWorkflowAgent)", async () => {
    const rig = makeCoordination([ALIVE_THEN_EMPTY], undefined, { gateExec: delayedPass });
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    singleStepWorkflow(rig);
    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state !== "in_progress", 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");                       // NOT "failed" — the gate certified the work
    expect(final.stepHistory.at(-1)!.outcome).toBe("passed");
    // Load-bearing: without the exemption this task is failed-and-retried, and the retry's fresh
    // agent (a non-empty default result) would ALSO reach "done" — only the spawn count shows it.
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("a NON-workflow task with an empty result still fails — the exemption is gate-certification, not workflow-ness alone", async () => {
    const rig = makeCoordination([EMPTY()]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create(DEV_TEAM(1));
    const task = rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "failed");
    expect(rig.queues.getTask(task.taskId).error).toBe("agent produced no result");
  });
});

describe("an empty result is a RETRYABLE attempt, not an instant cascade failure", () => {
  it("retries on the queue's retryLimit and only fails once exhausted", async () => {
    const rig = makeCoordination([EMPTY(), EMPTY(), EMPTY()]);
    rig.queues.create({ name: "work", retryLimit: 2 });
    rig.teams.create(DEV_TEAM(1));
    const task = rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "failed", 5000);

    expect(rig.fake.spawns).toHaveLength(3);                // first attempt + 2 retries
    expect(rig.queues.getTask(task.taskId).attempts).toBe(3);
  });

  it("a transient empty result recovers on the retry instead of failing the task", async () => {
    const rig = makeCoordination([EMPTY(), HAPPY("recovered")]);
    rig.queues.create({ name: "work", retryLimit: 2 });
    rig.teams.create(DEV_TEAM(1));
    const task = rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "done", 5000);
    expect(rig.queues.getTask(task.taskId).resultText).toBe("recovered");
  });

  it("does NOT cascade-fail dependents while retries remain (markFailed would have doomed the subtree on round one)", async () => {
    const rig = makeCoordination([EMPTY(), HAPPY("recovered"), HAPPY("dependent ran")]);
    rig.queues.create({ name: "work", retryLimit: 2 });
    rig.teams.create(DEV_TEAM(1));
    const first = rig.queues.push("work", { prompt: "t1" });
    const dependent = rig.queues.push("work", { prompt: "t2", dependsOn: [first.taskId] });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(dependent.taskId).state === "done", 5000);

    expect(rig.queues.getTask(first.taskId).state).toBe("done");
    expect(rig.queues.getTask(dependent.taskId).resultText).toBe("dependent ran");
  });
});

describe("structured permission denial is not task completion", () => {
  it("rejects polished blocked prose and never dispatches its dependent", async () => {
    const blocked: FakeStep[] = [
      { askPermission: { toolName: "Bash", input: { command: "rm -rf build" } } },
      { end: { resultText: "I could not make the requested change because permission was declined." } },
    ];
    const rig = makeCoordination([blocked, HAPPY("dependent must not run")]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create(DEV_TEAM(1));
    const implementation = rig.queues.push("work", { prompt: "implement it" });
    const dependent = rig.queues.push("work", { prompt: "use the implementation", dependsOn: [implementation.taskId] });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(implementation.taskId).state === "failed", 5000);

    expect(rig.queues.getTask(implementation.taskId).error).toContain("permission request was declined");
    expect(rig.queues.getTask(dependent.taskId).state).toBe("failed");
    expect(rig.fake.spawns).toHaveLength(1);
  });
});

describe("provider background tasks are part of queued task completion", () => {
  it("does not mark an implementation done or spawn its dependent when a late notification kills the background task", async () => {
    const implementation: FakeStep[] = [
      { task: { taskId: "bg-1", status: "running", isBackgrounded: true } },
      { end: { resultText: "I'll wait for the background task notification." } },
      // The provider may deliver this after turn_complete/result; it must still win settlement.
      { task: { taskId: "bg-1", status: "killed" } },
    ];
    const rig = makeCoordination([implementation, HAPPY("dependent must not run")]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create(DEV_TEAM(1));
    const first = rig.queues.push("work", { prompt: "implement it" });
    const dependent = rig.queues.push("work", { prompt: "verify it", dependsOn: [first.taskId] });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(first.taskId).state === "failed", 5000);

    expect(rig.queues.getTask(first.taskId).error).toContain("background task bg-1 killed");
    expect(rig.queues.getTask(dependent.taskId).state).not.toBe("done");
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("settles only after background success is followed by a newer final result", async () => {
    const implementation: FakeStep[] = [
      { task: { taskId: "bg-2", status: "running", isBackgrounded: true } },
      { end: { resultText: "waiting" } },
      { task: { taskId: "bg-2", status: "completed" } },
      { end: { resultText: "tests passed and work landed" } },
    ];
    const rig = makeCoordination([implementation]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    const task = rig.queues.push("work", { prompt: "implement it" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "done", 5000);

    expect(rig.queues.getTask(task.taskId).resultText).toBe("tests passed and work landed");
  });

  it("leaves ordinary prose-only work eligible for immediate completion", async () => {
    const rig = makeCoordination([HAPPY("read-only analysis complete")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    const task = rig.queues.push("work", { prompt: "analyze only" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "done", 5000);
    expect(rig.queues.getTask(task.taskId).resultText).toBe("read-only analysis complete");
  });
});

// TRUNCATION-SURFACE: the persistent-pool branch settles a bound task on turn_complete WITHOUT
// the worker going terminal, so it never reaches settle()'s empty-result guard at all. A turn the
// provider cut off at the output ceiling therefore used to mark its task "done" on a
// half-generated (usually empty) turn — the exact incident class, on the one path the original
// fix did not cover.
describe("a truncated turn on a PERSISTENT worker fails the task's attempt but keeps the worker", () => {
  const PERSISTENT_TEAM = {
    name: "crew",
    roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } },
    maxConcurrent: 1, queue: "work",
  };
  // A live session's truncated turn, exactly as backends/generic.ts emits it: a role:"system"
  // transcript notice, then a turn_complete flagged `truncated` — no terminal `error` event.
  const TRUNCATED_THEN_OK: FakeStep[] = [
    { emit: { kind: "agent_started", data: {} } },
    { emit: { kind: "message_complete", data: { text: "output truncated at 32768 tokens", role: "system" } } },
    { emit: { kind: "turn_complete", data: { truncated: true } } },
    { awaitSend: true },
    { turn: { text: "second try" } },
  ];

  it("retries the task on the SAME still-alive worker instead of marking it done on the cut-off turn", async () => {
    const rig = makeCoordination([TRUNCATED_THEN_OK]);
    rig.queues.create({ name: "work", retryLimit: 2 });
    rig.teams.create(PERSISTENT_TEAM);
    const task = rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "done", 5000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.attempts).toBe(1);                          // the truncated turn burned one attempt...
    expect(rig.fake.spawns).toHaveLength(1);                 // ...but the worker itself survived it
    expect(rig.sup.status(rig.fake.spawns[0]!.agentId).state).toBe("running");
  });

  it("an ordinary (non-truncated) turn on a persistent worker still marks its task done", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM);
    const task = rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "done");
    expect(rig.queues.getTask(task.taskId).attempts).toBe(0);
  });
});
