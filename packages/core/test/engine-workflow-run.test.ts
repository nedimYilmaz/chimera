import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord, WorkflowRecord, WorkflowStep } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// FEATURE WORKFLOW-RUN-P1: workflow.run — conductors design-and-run an AD-HOC workflow
// (steps compiled straight into a fresh, persisted, ephemeral WorkflowRecord) and push ONE
// task bound to it in a single call, riding the EXACT same gate/checkpoint/budget machinery
// (WorkflowRpc.handlers["workflow.run"] -> WorkflowStore.instantiateAdHoc + queues.push +
// scheduler.tick) a named workflow.create'd one does.

function engineOn(home: string, backend?: FakeAgentBackend): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", backend ?? new FakeAgentBackend([])]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-wfrun-")); }

const ONE_STEP: WorkflowStep[] = [{ id: "s0", title: "run", gate: { kind: "none" } }];

const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];

describe("workflow.run (FEATURE WORKFLOW-RUN-P1)", () => {
  it("compiles an ephemeral workflow (hidden from workflow.list, resolvable by get) and pins {name, version:1} on pickup", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, queue: "work" } });

    const task = await e.handle("workflow.run", { spec: { steps: ONE_STEP }, prompt: "do it", queue: "work" }) as TaskRecord;
    expect(task.workflowOverride).toMatch(/^run-/);

    await waitUntil(() => e.queues.status("work").counts.done === 1, 5000);
    const final = e.queues.getTask(task.taskId);
    expect(final.workflow).toEqual({ name: task.workflowOverride, version: 1 });

    // ephemeral: hidden from workflow.list, but resolvable by get()
    const listed = await e.handle("workflow.list", {}) as WorkflowRecord[];
    expect(listed.find((w) => w.name === task.workflowOverride)).toBeUndefined();
    expect(e.workflows.get(task.workflowOverride!).steps).toMatchObject(ONE_STEP);
  });

  it("rejects an invalid graph (fanOut+next both set) before anything persists or is pushed", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("queue.create", { spec: { name: "work" } });
    const badSteps = [
      { id: "s0", title: "a", gate: { kind: "none" }, next: [{ to: "s1" }], fanOut: { source: { kind: "list", items: ["x"] }, joinStep: "s1" } },
      { id: "s1", title: "b", gate: { kind: "none" } },
    ];
    await expect(e.handle("workflow.run", { spec: { steps: badSteps }, prompt: "go", queue: "work" }))
      .rejects.toMatchObject({ code: "protocol" });

    expect(await e.handle("workflow.list", {})).toEqual([]);
    expect((await e.handle("queue.status", { queue: "work" }) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("queue resolution: an explicit queue wins over the caller's own project queue", async () => {
    const e = engineOn(makeEngineHome());
    const projectPath = makeDir();
    await e.handle("queue.create", { spec: { name: "project-q" } });
    await e.handle("queue.create", { spec: { name: "explicit-q" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: projectPath, account: "main", isolation: "none" } } }, queue: "explicit-q" } });
    await e.handle("project.create", { name: "alpha", path: projectPath, queue: "project-q", autoConductor: false });
    const spawned = await e.handle("agent.spawn", { spec: { prompt: "x", cwd: projectPath, isolation: "none" } }) as { agentId: string };

    const task = await e.handle("workflow.run", { spec: { steps: ONE_STEP }, prompt: "do it", queue: "explicit-q", agentId: spawned.agentId }) as TaskRecord;
    expect(task.queue).toBe("explicit-q");
    expect((await e.handle("queue.status", { queue: "project-q" }) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("queue resolution: falls back to the calling agent's project queue when no explicit queue is given", async () => {
    const e = engineOn(makeEngineHome());
    const projectPath = makeDir();
    await e.handle("queue.create", { spec: { name: "project-q" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: projectPath, account: "main", isolation: "none" } } }, queue: "project-q" } });
    await e.handle("project.create", { name: "alpha", path: projectPath, queue: "project-q", autoConductor: false });
    const spawned = await e.handle("agent.spawn", { spec: { prompt: "x", cwd: projectPath, isolation: "none" } }) as { agentId: string };

    const task = await e.handle("workflow.run", { spec: { steps: ONE_STEP }, prompt: "do it", agentId: spawned.agentId }) as TaskRecord;
    expect(task.queue).toBe("project-q");
  });

  it("queue resolution: no explicit queue + no resolvable project queue + provision unset -> a protocol error, nothing persisted", async () => {
    const e = engineOn(makeEngineHome());
    await expect(e.handle("workflow.run", { spec: { steps: ONE_STEP }, prompt: "do it" }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(await e.handle("workflow.list", {})).toEqual([]);
    expect(await e.handle("queue.list", {})).toEqual([]);
  });

  it("provision:true auto-creates a scratch queue+team and runs the task there", async () => {
    const e = engineOn(makeEngineHome());
    const cwd = makeDir();
    const spawned = await e.handle("agent.spawn", { spec: { prompt: "x", cwd, isolation: "none" } }) as { agentId: string };

    const task = await e.handle("workflow.run", {
      spec: { steps: ONE_STEP }, prompt: "do it", provision: true, agentId: spawned.agentId,
    }) as TaskRecord;
    expect(task.queue).toMatch(/^wfrun-/);

    await waitUntil(() => e.queues.status(task.queue).counts.done === 1, 5000);
    expect(e.queues.getTask(task.taskId).state).toBe("done");

    const teams = await e.handle("team.list", {}) as Array<{ name: string; queue: string | null }>;
    expect(teams.some((t) => t.queue === task.queue && t.name.startsWith("wfrun-team-"))).toBe(true);
  });

  it("a fanOut step in a dynamic workflow fans out branch tasks exactly like a named workflow's", async () => {
    // Mirrors scheduler-workflow-graph.test.ts's "map-reduce-join-gates-on-all-branches"
    // fixture verbatim (5 fresh one-shot spawns: plan, 3 branches, join) — the ONLY
    // difference here is the workflow is compiled ad-hoc via workflow.run instead of
    // workflow.create'd and bound to the queue up front.
    const fake = new FakeAgentBackend([
      ONE_SHOT("planned"), ONE_SHOT("branch a done"), ONE_SHOT("branch b done"), ONE_SHOT("branch c done"), ONE_SHOT("joined"),
    ]);
    const e = engineOn(makeEngineHome(), fake);
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: path, account: "main", isolation: "none" } } }, maxConcurrent: 10, queue: "work" } });

    const steps: WorkflowStep[] = [
      { id: "plan", title: "plan", gate: { kind: "none" } },
      { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["a", "b", "c"] }, joinStep: "join" } },
      { id: "join", title: "join", gate: { kind: "none" } },
    ];

    let branchTaskIds: string[] = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    const task = await e.handle("workflow.run", { spec: { steps }, prompt: "map reduce", queue: "work" }) as TaskRecord;
    await waitUntil(() => branchTaskIds.length === 3, 5000);
    expect(e.queues.getTask(task.taskId).branchChildren).toEqual(branchTaskIds);

    await waitUntil(() => e.queues.getTask(task.taskId).state === "done", 5000);
    expect(e.queues.getTask(task.taskId).resultText).toBe("joined");
  });
});
