import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, COORD_CFG, waitUntil } from "./coord-helpers.js";

// TOKEN-OPT-P5: cheap-model routing for trivial workflow steps.
//   1) a workflow step's own `model` override wins for that step's fresh spawn
//      (step 0 via spawnForTask/assignPersistent, later steps via spawnStepAgent).
//   2) the handoff-summary turn (scheduler.ts's beginHandoff) routes to the
//      configured caps.fastModel[provider] BY DEFAULT — no step/role opt-in needed.
//   3) with no caps.fastModel configured (today's default), behavior is unchanged:
//      no extra spawn, no model swap, exactly the pre-P5 handoff flow.

const FAST_MODEL_CFG = ChimeraConfigSchema.parse({
  accounts: COORD_CFG.accounts,
  autoOrder: COORD_CFG.autoOrder,
  caps: { maxAgentsTotal: 10, perAccount: {}, fastModel: { claude: "claude-haiku-fast" } },
});

const HANDOFF_STEPS = [
  { id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner" },
  { id: "s1", title: "build", gate: { kind: "none" as const }, role: "builder" },
];
const HANDOFF_TEAM = {
  name: "crew",
  roles: {
    planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
    builder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
  },
  maxConcurrent: 2, queue: "work",
};

describe("TOKEN-OPT-P5: workflow step model override", () => {
  it("a step 0 model override wins over the role template's model for the initial (ephemeral) spawn", async () => {
    const PLANNER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done" } }];
    const rig = makeCoordination([PLANNER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "solo",
      roles: { planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, model: "role-default-model" } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.workflows.create({
      name: "wf-step-model",
      steps: [{ id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner", model: "cheap-model" }],
    });
    rig.queues.push("work", { prompt: "go", workflow: "wf-step-model" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(1);
    expect(rig.fake.spawns[0]!.model).toBe("cheap-model");
  });

  it("a step 0 model override wins for a PERSISTENT role's initial pool spawn too", async () => {
    const PLANNER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const rig = makeCoordination([PLANNER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "solo-persist",
      roles: { planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, persistent: true, model: "role-default-model" } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.workflows.create({
      name: "wf-step-model-persist",
      steps: [{ id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner", model: "cheap-model" }],
    });
    rig.queues.push("work", { prompt: "go", workflow: "wf-step-model-persist" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.fake.spawns.length === 1, 5000);

    expect(rig.fake.spawns[0]!.model).toBe("cheap-model");
  });

  it("a step-2 model override wins for the role-switch spawn (spawnStepAgent)", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { awaitSend: true },
      { turn: { text: "planned" } },
    ];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({
      name: "wf-step2-model",
      steps: [HANDOFF_STEPS[0]!, { ...HANDOFF_STEPS[1]!, model: "cheap-build-model" }],
    });
    rig.queues.push("work", { prompt: "ship it", workflow: "wf-step2-model" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    expect(rig.fake.spawns[0]!.model).toBeUndefined();          // step 0: no override
    expect(rig.fake.spawns[1]!.model).toBe("cheap-build-model"); // step 1: step-level override applied
  });
});

describe("TOKEN-OPT-P5: handoff-summary turn routed to caps.fastModel by default", () => {
  it("routes the summarize turn to the configured fast model (session resumed, full context kept) when caps.fastModel is configured", async () => {
    // TWO scenario entries for the "planner" identity: the fast-model swap is a REAL
    // kill()+respawn under the same agentId (setModel), so FakeAgentBackend sees TWO
    // separate spawn() calls for it — one for the original step-0 turn, one for the
    // resumed (resumeOnly, idle-until-send) session that receives the summarize prompt.
    const PLANNER_STEP0: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-planner-1" } } },
      { turn: {} },   // s0 gate passes -> beginHandoff triggers the fast-model swap
    ];
    const PLANNER_RESUMED: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },   // the respawn's own agent_started (resumeOnly, starts idle)
      { awaitSend: true },
      { turn: { text: "Did the planning. Touched plan.md." } },
    ];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const rig = makeCoordination([PLANNER_STEP0, PLANNER_RESUMED, BUILDER], FAST_MODEL_CFG);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf-fast-handoff", steps: HANDOFF_STEPS });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-fast-handoff" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    // 3 spawns: planner (step 0), planner respawn-with-resume under the fast model
    // (beginHandoff's swap), builder (step 1).
    expect(rig.fake.spawns).toHaveLength(3);
    const respawn = rig.fake.spawns[1]!;
    expect(respawn.model).toBe("claude-haiku-fast");
    expect(respawn.resume).toBe("sess-planner-1");
    expect(respawn.resumeOnly).toBe(true);
    expect(respawn.agentId).toBe(rig.fake.spawns[0]!.agentId);   // SAME agentId — transcript/identity continuity

    // the swap is otherwise invisible to the workflow: summary still captured and handed off.
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory[0]!.handoffSummary).toBe("Did the planning. Touched plan.md.");
    const builderInstructions = rig.fake.spawns[2]!.instructions!;
    expect(builderInstructions).toContain("Did the planning. Touched plan.md.");
  });

  it("fast-model swap of an ephemeral team worker starts idle — it never re-seeds the finished task's prompt", async () => {
    // Since 6a4cb20c a plain setModel resumes an ephemeral team worker's TASK (resumeOnly:false,
    // spec.prompt re-seeded). The handoff swap must opt out: its step turn already completed, so a
    // re-seed would replay the task on the fast model and its turn_complete would be captured as
    // the "summary". The operator-facing setModel contract is pinned in scheduler-settings-resume.
    const rig = makeCoordination([
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-eph" } } }, { awaitSend: true }],
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }],
    ], FAST_MODEL_CFG);
    const a = await rig.sup.spawn({ prompt: "original task", cwd: "/tmp", isolation: "none" },
      { membership: { team: "crew", role: "planner" } });
    try {
      await waitUntil(() => rig.sup.status(a.agentId).sessionId === "sess-eph");
      expect(await rig.sup.trySwitchToFastModel(a.agentId)).toBe(true);
      expect(rig.fake.spawns).toHaveLength(2);
      expect(rig.fake.spawns[1]).toMatchObject({
        model: "claude-haiku-fast", resume: "sess-eph", resumeOnly: true, agentId: a.agentId,
      });
    } finally { await rig.sup.kill(a.agentId); }
  });

  it("default path unchanged: with no caps.fastModel configured, the handoff runs exactly as before (no extra spawn)", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-planner-2" } } },
      { turn: {} },
      { awaitSend: true },
      { turn: { text: "Did the planning." } },
    ];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const rig = makeCoordination([PLANNER, BUILDER], COORD_CFG);   // COORD_CFG has no caps.fastModel entries
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf-no-fast-handoff", steps: HANDOFF_STEPS });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-no-fast-handoff" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    // exactly planner + builder — no fast-model respawn ever attempted.
    expect(rig.fake.spawns).toHaveLength(2);
    expect(rig.fake.spawns[0]!.model).toBeUndefined();
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory[0]!.handoffSummary).toBe("Did the planning.");
  });

  it("no-op when the outgoing agent has no captured sessionId (never attempts a resume that would lose context)", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },   // no sessionId in this scenario
      { turn: {} },
      { awaitSend: true },
      { turn: { text: "Did the planning." } },
    ];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const rig = makeCoordination([PLANNER, BUILDER], FAST_MODEL_CFG);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf-no-session-handoff", steps: HANDOFF_STEPS });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-no-session-handoff" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);   // no respawn attempted
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory[0]!.handoffSummary).toBe("Did the planning.");
  });
});
