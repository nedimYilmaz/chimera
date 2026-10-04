import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// Dynamic Planner: a `plan`-gated step's agent registers a structured plan artifact
// (a "file"-kind artifact, mirroring scheduler-step-handoff.test.ts's own real-tmp-file
// pattern). Chimera compiles it into an ephemeral WorkflowRecord and dispatches it as a
// single nested child task via the SAME blockOnChildren join beginFanOut already uses —
// mirrors scheduler-workflow-graph.test.ts / budget-governor.test.ts conventions.

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

function registerPlanArtifact(rig: ReturnType<typeof makeCoordination>, taskId: string, stepIndex: number, content: unknown, fileName = "plan.json"): void {
  const path = join(rig.dir, `${taskId}-${fileName}`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  rig.artifacts.add({ kind: "file", path, label: "plan", agentId: null, taskId, stepIndex });
}

describe("QueueScheduler — Dynamic Planner (`plan` gate)", () => {
  it("compiles a registered plan artifact into an ephemeral workflow, runs it as a nested child task, and joins", async () => {
    const rig = makeCoordination([ONE_SHOT("planned"), ONE_SHOT("did it"), ONE_SHOT("joined")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-plan",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "join" } } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    let dispatched: Record<string, unknown> | null = null;
    rig.events.subscribe((ev) => { if (ev.kind === "task_plan_dispatched") dispatched = ev.data as never; });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-plan" });
    registerPlanArtifact(rig, task.taskId, 0, { steps: [{ id: "do", title: "do it", gate: noneGate }] });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 5000);   // parent + 1 compiled-plan child

    const parent = rig.queues.getTask(task.taskId);
    expect(parent.state).toBe("done");
    expect(dispatched).not.toBeNull();
    const childTaskId = (dispatched as unknown as { childTaskId: string }).childTaskId;
    const child = rig.queues.getTask(childTaskId);
    expect(child.state).toBe("done");
    expect(child.workflow?.name).toMatch(/^plan-/);
    expect(child.stepHistory.map((h) => h.stepId)).toEqual(["do"]);

    // join step's agent received the compiled child's outcome via the reused mergeSummaryText
    const joinSpawn = rig.fake.spawns[2]!;
    expect(joinSpawn.instructions).toContain("fan-out results: 1 branch(es)");
    expect(joinSpawn.instructions).toContain("did it");
  });

  it("rejects a plan artifact that isn't valid JSON — flows through the ordinary onFail policy", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-plan-badjson",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "join" } } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-plan-badjson" });
    registerPlanArtifact(rig, task.taskId, 0, "not { valid json");
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.error).toContain("not valid JSON");
    expect(rig.fake.spawns).toHaveLength(1);   // planner only — no child was ever dispatched
  });

  it("rejects a plan whose own steps form a cycle — reuses validateWorkflowGraph", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-plan-cycle",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "join" } } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-plan-cycle" });
    registerPlanArtifact(rig, task.taskId, 0, {
      steps: [
        { id: "a", title: "a", gate: noneGate, next: [{ to: "b" }] },
        { id: "b", title: "b", gate: noneGate, next: [{ to: "a" }] },
      ],
    });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.error).toContain("cycle");
    expect(rig.fake.spawns).toHaveLength(1);
  });

  it("rejects when no plan artifact was registered — mirrors the artifact gate's own message shape", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-plan-missing",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "join" } } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-plan-missing" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.error).toContain("no plan artifact registered");
  });

  it("budget escapes are prevented: a plan-dispatched child's spawn is denied once the parent's budget node is exhausted", async () => {
    const PLANNER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "planned", costUsd: 0.02 } }];
    const CHILD: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "never reached" } }];
    const rig = makeCoordination([PLANNER, CHILD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TEAM);
    rig.workflows.create({
      name: "wf-plan-budget",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "join" } } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-plan-budget", overrides: { maxBudgetUsd: 0.01 } });
    registerPlanArtifact(rig, task.taskId, 0, { steps: [{ id: "do", title: "do it", gate: noneGate }] });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).state === "failed", 5000);

    expect(rig.sup.treePaused(task.taskId)).toBe(true);      // the planner's 0.02 spend exhausted the parent's 0.01 ceiling
    expect(rig.fake.spawns).toHaveLength(1);                  // planner only — the child's spawn was denied pre-flight

    const parent = rig.queues.getTask(task.taskId);
    expect(parent.error).toContain("dependency");             // cascade-failed via the child, mirrors branch-failure-cascades
    const childId = parent.branchChildren[0]!;
    expect(rig.queues.getTask(childId).error).toMatch(/budget/i);   // the child's OWN denial — budgetParentId climbed to the exhausted parent node
  });
});
