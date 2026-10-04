import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { RoleStore } from "@chimera/core/roles-store";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";
import { fakeExec } from "./helpers.js";

// F16.1 Phase 3 (WF-9): a 2-role/2-step workflow — s0 (planner) -> s1 (builder), the
// switch that scheduler-step-handoff.test.ts exercises. `context` defaults to
// "handoff" (unset here on purpose — these tests exist to cover that default).
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

describe("QueueScheduler step-role handoff (F16.1 Phase 3, WF-9)", () => {
  it("captures the outgoing agent's summary and injects it into the incoming agent's prompt, alongside the artifact list", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },                                        // s0 gate passes -> role switch -> beginHandoff sends a summarize turn
      { awaitSend: true },                                  // blocks until the summarize prompt actually arrives
      { turn: { text: "Did the planning. Touched plan.md. Worktree clean." } },
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf", steps: HANDOFF_STEPS });

    const handoffEvents: Array<Record<string, unknown>> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_handoff") handoffEvents.push(ev.data as never); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    const artifactPath = join(rig.dir, "plan.md");
    writeFileSync(artifactPath, "the plan");
    rig.artifacts.add({ kind: "file", path: artifactPath, label: "plan snapshot", agentId: null, taskId: task.taskId, stepIndex: 0 });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    const builderInstructions = rig.fake.spawns[1]!.instructions!;
    expect(builderInstructions).toContain('[handoff from step 1 (planner)]: Did the planning. Touched plan.md. Worktree clean.');
    expect(builderInstructions).toContain("plan snapshot");   // the artifact list

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory[0]!.handoffSummary).toBe("Did the planning. Touched plan.md. Worktree clean.");

    expect(handoffEvents).toHaveLength(1);
    expect(handoffEvents[0]).toMatchObject({
      taskId: task.taskId, fromStepIndex: 0, toStepIndex: 1, role: "builder",
      fromAgentId: rig.fake.spawns[0]!.agentId, toAgentId: rig.fake.spawns[1]!.agentId,
    });
    expect(handoffEvents[0]!.summaryBytes).toBeGreaterThan(0);
  });

  // STEP-AGENT-ENDS-DONE: the outgoing step agent's gate PASSED and its handoff was
  // delivered — its own terminal state must read "done" (it finished honorably), not
  // "killed" (which reads as an operator abort). The teardown is closeInput, so the
  // agent's own natural completion (a real backend: input ends -> one final result) races
  // the task's own advance to step 2 — verify that race never double-advances or re-marks
  // the (already-advanced) task.
  it("STEP-AGENT-ENDS-DONE: the outgoing agent settles \"done\" (not killed) after a handoff switch, and its own later done-settle is a no-op (no double-advance)", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },                                        // s0 gate passes -> beginHandoff sends a summarize turn
      { awaitSend: true },
      { turn: { text: "Did the planning." } },              // summarize turn's turn_complete -> completeHandoff -> switch
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf", steps: HANDOFF_STEPS });

    const killSpy = vi.spyOn(rig.sup, "kill");
    const closeInputSpy = vi.spyOn(rig.sup, "closeInput");
    const advanced: Array<{ stepIndex: number; stepId: string }> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    const plannerAgentId = rig.fake.spawns[0]!.agentId;
    expect(closeInputSpy).toHaveBeenCalledWith(plannerAgentId);
    expect(killSpy).not.toHaveBeenCalled();

    // the outgoing planner's OWN session settles "done" — its terminal state never reads
    // "killed", even though the task itself already moved on to the builder.
    await waitUntil(() => rig.sup.status(plannerAgentId).state === "done", 5000);

    // idempotence: the planner's own (later) done-settle must be a no-op for the task —
    // exactly ONE task_step_advanced per step, no re-evaluation/duplicate advance.
    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1]);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.error).toBeNull();
    expect(final.agentId).toBe(rig.fake.spawns[1]!.agentId);   // bound to the builder, not the retired planner
    expect(final.stepHistory).toHaveLength(2);
    expect(final.stepHistory.every((h) => h.outcome === "passed")).toBe(true);
  });

  it("context:\"none\" skips the whole handoff package — no summarize turn, no handoff text in the incoming prompt", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },   // s0 gate passes -> role switch, context:"none" -> switches immediately, no summarize turn
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({
      name: "wf",
      steps: [HANDOFF_STEPS[0]!, { ...HANDOFF_STEPS[1]!, context: "none" as const }],
    });
    const sendSpy = vi.spyOn(rig.sup, "send");
    const handoffEvents: Array<Record<string, unknown>> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_handoff") handoffEvents.push(ev.data as never); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(sendSpy.mock.calls.filter((c) => c[2] === "scheduler")).toHaveLength(0);   // no summarize send at all
    const builderInstructions = rig.fake.spawns[1]!.instructions!;
    expect(builderInstructions).not.toContain("[handoff from step");
    const final = rig.queues.getTask(task.taskId);
    expect(final.stepHistory[0]!.handoffSummary).toBeUndefined();

    // still emitted (design: "her switch'te emit"), just with a zero-byte summary
    expect(handoffEvents).toHaveLength(1);
    expect(handoffEvents[0]!.summaryBytes).toBe(0);
  });

  it("the summarize turn's own turn_complete does NOT advance the step or re-evaluate the gate", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { awaitSend: true },
      { turn: { text: "summary text" } },
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf", steps: HANDOFF_STEPS });

    const advanced: Array<{ stepIndex: number }> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    // exactly ONE advance per step (0 then 1) — the summarize turn's turn_complete never
    // triggered a second gate evaluation / a spurious extra advance.
    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1]);
    const final = rig.queues.getTask(task.taskId);
    expect(final.stepHistory.filter((h) => h.stepIndex === 0)).toHaveLength(1);   // no duplicate attempt at step 0
  });

  it("a summarize-turn timeout falls back to an artifacts-only handoff without wedging the workflow", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },   // s0 gate passes -> beginHandoff sends the summarize turn, but the script never answers it
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER], COORD_CFG, { handoffTimeoutMs: 30 });
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf", steps: HANDOFF_STEPS });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    const builderInstructions = rig.fake.spawns[1]!.instructions!;
    expect(builderInstructions).toContain("no summary was captured — proceeding with artifacts only");
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory[0]!.handoffSummary).toBeUndefined();   // never captured — timed out
  });

  it("a summarize-turn send() failure (agent already gone) falls back to an artifacts-only handoff", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([PLANNER, BUILDER], COORD_CFG, { handoffTimeoutMs: 60_000 });
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf", steps: HANDOFF_STEPS });
    vi.spyOn(rig.sup, "send").mockImplementation(async (agentId: string, text: string, source?: string) => {
      if (source === "scheduler" && text.startsWith("Step 1")) throw new Error("agent gone");
      return undefined as never;
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(2);
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
  });

  it("a daemon restart mid-summarize recovers (never wedges) — the in-flight handoff is lost, the just-passed step is redone by a fresh agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-wf-handoff-restart-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    workflows.create({ name: "wf", steps: HANDOFF_STEPS });

    // Round 1: a live scheduler drives the task up to (but not through) the handoff —
    // the PLANNER never answers the summarize turn, simulating a daemon crash mid-summarize.
    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const teams1 = new TeamManager(dir, events);
    const roles1 = new RoleStore(dir);
    teams1.create(HANDOFF_TEAM);
    const artifacts1 = new ArtifactStore(dir, events);
    const PLANNER_HANG: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const fake1 = new FakeAgentBackend([PLANNER_HANG]);
    const sup1 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake1]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    // a very long timeout — round 1 never lets it fire; the "restart" happens first
    const scheduler1 = new QueueScheduler({ teams: teams1, queues: queues1, supervisor: sup1, events, workflows, artifacts: artifacts1, roles: roles1, handoffTimeoutMs: 60_000 });
    scheduler1.attach();
    const task = queues1.push("work", { prompt: "ship it", workflow: "wf" });
    await scheduler1.tick();
    await waitUntil(() => queues1.getTask(task.taskId).stepHistory.some((h) => h.stepIndex === 0 && h.outcome === "passed"), 5000);

    // mid-summarize: the task is still in_progress, still at stepIndex 0 (advanceStep hasn't
    // run yet — see completeHandoff), step 0's history entry is already closed "passed".
    const midFlight = queues1.getTask(task.taskId);
    expect(midFlight.state).toBe("in_progress");
    expect(midFlight.stepIndex).toBe(0);
    scheduler1.detach();

    // "restart": reopen the SAME on-disk state fresh.
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(task.taskId);
    expect(recovered.state).toBe("pending");   // in_progress reverts on restart
    expect(recovered.stepIndex).toBe(0);       // the cursor never advanced — never wedged mid-switch

    // TeamManager (unlike QueueStore) needs no restart-revert semantics — reuse teams1,
    // which already persisted "crew" to disk (re-creating it here would collide).
    const artifacts2 = new ArtifactStore(dir, events);
    const PLANNER2: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { awaitSend: true },
      { turn: { text: "redone summary" } },
    ];
    const BUILDER2: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const fake2 = new FakeAgentBackend([PLANNER2, BUILDER2]);
    const sup2 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake2]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler2 = new QueueScheduler({ teams: teams1, queues: queues2, supervisor: sup2, events, workflows, artifacts: artifacts2, roles: roles1 });
    scheduler2.attach();
    await scheduler2.tick();
    await waitUntil(() => queues2.getTask(task.taskId).state === "done", 5000);

    const final = queues2.getTask(task.taskId);
    expect(final.state).toBe("done");   // recovered — never stuck
    expect(final.stepHistory.some((h) => h.handoffSummary === "redone summary")).toBe(true);
  });
});
