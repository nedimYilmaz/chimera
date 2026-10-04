import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// Nested sub-workflows: a `subWorkflow` step resolves a named recipe (WorkflowStore.
// instantiateRecipe — binds inputs against the recipe's own declared params, interpolates
// them into its steps) and dispatches it as a single nested child task via the SAME
// blockOnChildren join beginFanOut/beginPlanDispatch already use — mirrors
// scheduler-dynamic-planner.test.ts's conventions.

const noneGate = { kind: "none" as const };
const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];

const TEAM = {
  name: "crew",
  roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
  maxConcurrent: 5, queue: "work",
};

describe("QueueScheduler — Nested sub-workflows (`subWorkflow` step)", () => {
  it("resolves a recipe with inputs, dispatches it as a nested child task, and joins", async () => {
    const rig = makeCoordination([ONE_SHOT("kicked off"), ONE_SHOT("deployed"), ONE_SHOT("joined")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "deploy-recipe",
      params: [{ name: "env" }],
      steps: [{ id: "do", title: "deploy to ${env}", gate: noneGate }],
    });
    rig.workflows.create({
      name: "wf-sub",
      steps: [
        { id: "s0", title: "kickoff", gate: noneGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "deploy-recipe", inputs: { env: "prod" }, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    let dispatched: Record<string, unknown> | null = null;
    rig.events.subscribe((ev) => { if (ev.kind === "task_sub_workflow_dispatched") dispatched = ev.data as never; });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-sub" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 5000);   // parent + 1 dispatched child

    const parent = rig.queues.getTask(task.taskId);
    expect(parent.state).toBe("done");
    expect(dispatched).not.toBeNull();
    const d = dispatched as unknown as { childTaskId: string; recipeName: string; childWorkflow: string };
    expect(d.recipeName).toBe("deploy-recipe");
    expect(d.childWorkflow).toMatch(/^recipe-deploy-recipe-/);

    const child = rig.queues.getTask(d.childTaskId);
    expect(child.state).toBe("done");
    expect(child.workflow?.name).toMatch(/^recipe-deploy-recipe-/);
    expect(child.stepHistory.map((h) => h.stepId)).toEqual(["do"]);

    // interpolation reached the spawned agent (not just the stored record) — the child's
    // own step title "deploy to ${env}" is rendered into workflowInstructions' step plan.
    const childSpawn = rig.fake.spawns[1]!;
    expect(childSpawn.instructions).toContain("deploy to prod");

    // join step's agent received the child's outcome via the reused mergeSummaryText
    const joinSpawn = rig.fake.spawns[2]!;
    expect(joinSpawn.instructions).toContain("fan-out results: 1 branch(es)");
    expect(joinSpawn.instructions).toContain("deployed");
  });

  it("a missing required param fails the task via the ordinary onFail policy — no child ever spawned", async () => {
    const rig = makeCoordination([ONE_SHOT("kicked off")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "needs-env",
      params: [{ name: "env" }],
      steps: [{ id: "do", title: "deploy to ${env}", gate: noneGate }],
    });
    rig.workflows.create({
      name: "wf-sub-missing-param",
      steps: [
        { id: "s0", title: "kickoff", gate: noneGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "needs-env", joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-sub-missing-param" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.error).toContain("missing required param");
    expect(rig.fake.spawns).toHaveLength(1);   // s0 only — no child was ever dispatched
  });

  it("an unknown recipe name fails the task permanently", async () => {
    const rig = makeCoordination([ONE_SHOT("kicked off")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-sub-unknown-recipe",
      steps: [
        { id: "s0", title: "kickoff", gate: noneGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "ghost-recipe", joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-sub-unknown-recipe" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.error).toContain("unknown workflow");
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("subWorkflow.version pins an older recipe version even after it's been update()'d", async () => {
    const rig = makeCoordination([ONE_SHOT("kicked off"), ONE_SHOT("deployed v1"), ONE_SHOT("joined")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "pinned-recipe",
      params: [{ name: "env", default: "v1-value" }],
      steps: [{ id: "do", title: "deploy to ${env}", gate: noneGate }],
    });
    rig.workflows.update("pinned-recipe", { params: [{ name: "env", default: "v2-value" }] });
    rig.workflows.create({
      name: "wf-sub-versioned",
      steps: [
        { id: "s0", title: "kickoff", gate: noneGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "pinned-recipe", version: 1, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-sub-versioned" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 5000);

    const childSpawn = rig.fake.spawns[1]!;
    expect(childSpawn.instructions).toContain("deploy to v1-value");
    expect(childSpawn.instructions).not.toContain("v2-value");
    expect(rig.queues.getTask(task.taskId).state).toBe("done");
  });

  it("budget escapes are prevented: a subWorkflow child's spawn is denied once the parent's budget node is exhausted", async () => {
    const S0: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "kicked off", costUsd: 0.02 } }];
    const CHILD: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "never reached" } }];
    const rig = makeCoordination([S0, CHILD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "budget-recipe",
      params: [{ name: "env", default: "prod" }],
      steps: [{ id: "do", title: "deploy to ${env}", gate: noneGate }],
    });
    rig.workflows.create({
      name: "wf-sub-budget",
      steps: [
        { id: "s0", title: "kickoff", gate: noneGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "budget-recipe", joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-sub-budget", overrides: { maxBudgetUsd: 0.01 } });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "failed", 5000);

    expect(rig.sup.treePaused(task.taskId)).toBe(true);      // s0's 0.02 spend exhausted the parent's 0.01 ceiling
    expect(rig.fake.spawns).toHaveLength(1);                  // s0 only — the child's spawn was denied pre-flight

    const parent = rig.queues.getTask(task.taskId);
    expect(parent.error).toContain("dependency");             // cascade-failed via the child
    const childId = parent.branchChildren[0]!;
    expect(rig.queues.getTask(childId).error).toMatch(/budget/i);   // the child's OWN denial — budgetParentId climbed to the exhausted parent node
  });
});
