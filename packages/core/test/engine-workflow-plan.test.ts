import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// FEATURE WORKFLOW-RUN-P2: workflow.plan — "plan-and-run". The caller supplies only a
// `goal`; WorkflowRpc synthesizes a two-step ephemeral workflow whose step 0 ("design") is
// `plan`-gated (the SAME Dynamic Planner gate scheduler-dynamic-planner.test.ts already
// exercises for a hand-authored workflow) so an agent designs the real work, then step 1
// ("done") is where the parent resumes once the compiled plan's child task joins.

function engineOn(home: string, backend?: FakeAgentBackend): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", backend ?? new FakeAgentBackend([])]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-wfplan-")); }

const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];

// Mirrors scheduler-dynamic-planner.test.ts's registerPlanArtifact: the design step's agent
// registers a "file"-kind artifact holding the PlanArtifact JSON. The fake backend schedules
// its scripted turn via setTimeout(0) (a macrotask) — calling this synchronously right after
// workflow.plan's handle() resolves (which only awaits microtask-based scheduler work) always
// wins the race, landing the artifact before the design step's gate ever evaluates.
function registerPlanArtifact(e: Engine, taskId: string, stepIndex: number, content: unknown): void {
  const path = join(makeDir(), "plan.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  e.artifacts.add({ kind: "file", path, label: "plan", agentId: null, taskId, stepIndex });
}

describe("workflow.plan (FEATURE WORKFLOW-RUN-P2)", () => {
  it("compiles the design step's registered plan into a nested child workflow and runs it to completion", async () => {
    const fake = new FakeAgentBackend([ONE_SHOT("designed"), ONE_SHOT("did it"), ONE_SHOT("wrapped up")]);
    const e = engineOn(makeEngineHome(), fake);
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, queue: "work" } });

    const pushed = await e.handle("workflow.plan", { goal: "ship the thing", queue: "work" }) as { taskId: string; plannedWorkflowName?: string };
    expect(pushed.plannedWorkflowName).toBeUndefined();   // not resolvable synchronously — see WorkflowPlanResponseSchema

    let dispatched: Record<string, unknown> | null = null;
    e.events.subscribe((ev) => { if (ev.kind === "task_plan_dispatched") dispatched = ev.data as never; });

    registerPlanArtifact(e, pushed.taskId, 0, { steps: [{ id: "do", title: "do it", gate: { kind: "none" } }] });
    await waitUntil(() => e.queues.getTask(pushed.taskId).state === "done", 5000);

    const parent = e.queues.getTask(pushed.taskId);
    expect(parent.workflow?.name).toMatch(/^run-/);        // the synthesized 2-step scaffold, not the compiled plan
    expect(parent.stepHistory.map((h) => h.stepId)).toEqual(["design", "done"]);
    expect(dispatched).not.toBeNull();
    const childTaskId = (dispatched as unknown as { childTaskId: string }).childTaskId;
    const child = e.queues.getTask(childTaskId);
    expect(child.state).toBe("done");
    expect(child.workflow?.name).toMatch(/^plan-/);         // the agent-designed plan itself
    expect(child.stepHistory.map((h) => h.stepId)).toEqual(["do"]);
  });

  it("a fanOut step inside the agent-designed plan runs branches in parallel, joins, and leaves workflow.list clean", async () => {
    // Mirrors the functional-verify scenario: an agent plans "fan out across N items, then
    // summarize" — the compiled plan's OWN fanOut/join runs exactly like a hand-authored
    // workflow's (engine-workflow-run.test.ts's identical fixture, one level deeper).
    const fake = new FakeAgentBackend([
      ONE_SHOT("designed"), ONE_SHOT("planned"), ONE_SHOT("branch a done"), ONE_SHOT("branch b done"),
      ONE_SHOT("branch c done"), ONE_SHOT("joined"), ONE_SHOT("wrapped up"),
    ]);
    const e = engineOn(makeEngineHome(), fake);
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, maxConcurrent: 10, queue: "work" } });

    const pushed = await e.handle("workflow.plan", { goal: "count three files' lines in parallel, then summarize", queue: "work" }) as { taskId: string };
    registerPlanArtifact(e, pushed.taskId, 0, {
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["a", "b", "c"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });
    await waitUntil(() => e.queues.getTask(pushed.taskId).state === "done", 5000);

    const parent = e.queues.getTask(pushed.taskId);
    expect(parent.resultText).toBe("wrapped up");
    expect((await e.handle("workflow.list", {})) as unknown[]).toEqual([]);   // both ephemeral records stay hidden
  });

  it("an invalid plan artifact fails the plan gate via the ordinary onFail policy — no orphan child ever spawned", async () => {
    const fake = new FakeAgentBackend([ONE_SHOT("designed")]);
    const e = engineOn(makeEngineHome(), fake);
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, queue: "work" } });

    const pushed = await e.handle("workflow.plan", { goal: "ship the thing", queue: "work" }) as { taskId: string };
    registerPlanArtifact(e, pushed.taskId, 0, "not { valid json");
    await waitUntil(() => e.queues.getTask(pushed.taskId).state === "failed", 5000);

    const failed = e.queues.getTask(pushed.taskId);
    expect(failed.error).toContain("not valid JSON");
    expect(fake.spawns).toHaveLength(1);   // the design step only — no child was ever dispatched
    expect((await e.handle("workflow.list", {})) as unknown[]).toEqual([]);   // no orphan ephemeral record leaked into the authoring list
  });

  it("queue resolution is shared with workflow_run: no explicit/resolvable queue and provision unset -> a protocol error, nothing persisted", async () => {
    const e = engineOn(makeEngineHome());
    await expect(e.handle("workflow.plan", { goal: "ship the thing" }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(await e.handle("workflow.list", {})).toEqual([]);
    expect(await e.handle("queue.list", {})).toEqual([]);
  });

  it("provision:true auto-creates a scratch queue+team and runs the design step there", async () => {
    const fake = new FakeAgentBackend([ONE_SHOT("designed"), ONE_SHOT("did it"), ONE_SHOT("wrapped up")]);
    const e = engineOn(makeEngineHome(), fake);
    const cwd = makeDir();
    const spawned = await e.handle("agent.spawn", { spec: { prompt: "x", cwd, isolation: "none" } }) as { agentId: string };

    const pushed = await e.handle("workflow.plan", { goal: "ship it", provision: true, agentId: spawned.agentId }) as { taskId: string };
    const parentBefore = e.queues.getTask(pushed.taskId);
    expect(parentBefore.queue).toMatch(/^wfrun-/);

    registerPlanArtifact(e, pushed.taskId, 0, { steps: [{ id: "do", title: "do it", gate: { kind: "none" } }] });
    await waitUntil(() => e.queues.getTask(pushed.taskId).state === "done", 5000);

    const teams = await e.handle("team.list", {}) as Array<{ name: string; queue: string | null }>;
    expect(teams.some((t) => t.queue === parentBefore.queue && t.name.startsWith("wfrun-team-"))).toBe(true);
  });

  it("plannerOverrides.model lands on the design step's spawn; account/permissionProfile fold into task-level overrides", async () => {
    const fake = new FakeAgentBackend([ONE_SHOT("designed"), ONE_SHOT("did it"), ONE_SHOT("wrapped up")]);
    const e = engineOn(makeEngineHome(), fake);
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, queue: "work" } });

    const pushed = await e.handle("workflow.plan", {
      goal: "ship the thing", queue: "work",
      plannerOverrides: { model: "opus", permissionProfile: "readOnly" },
    }) as { taskId: string };
    registerPlanArtifact(e, pushed.taskId, 0, { steps: [{ id: "do", title: "do it", gate: { kind: "none" } }] });
    await waitUntil(() => e.queues.getTask(pushed.taskId).state === "done", 5000);

    expect(fake.spawns[0]?.model).toBe("opus");
    expect(fake.spawns[0]?.permissionProfile).toBe("readOnly");
  });
});
