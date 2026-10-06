import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { RoleStore } from "@chimera/core/roles-store";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler } from "@chimera/core/scheduler";
import type { TaskRecord } from "@chimera/protocol";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";
import { fakeExec } from "./helpers.js";

// F16.1 Phase 3 (WF-8): a 2-role/3-step workflow — s0/s1 share the "planner" role
// (consecutive same-role steps must NOT respawn), s2 switches to "builder".
// context:"none" on the switching step keeps these tests focused on pure switch
// mechanics (spawn/kill counts, workdirKey sharing, parked recovery) — the data-handoff
// package itself (default context:"handoff") is covered by scheduler-step-handoff.test.ts
// (F16.1 Phase 3, WF-9).

// CORE-SUITE-BASELINE: the isolation:"worktree" scenario shells out to real `git worktree`,
// and scheduler coordination in general can exceed vitest's 5000ms default under this
// machine's concurrent-agent load; widened alongside the waitUntil deadlines above.
vi.setConfig({ testTimeout: 20_000 });

const TWO_ROLE_STEPS = [
  { id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner" },
  { id: "s1", title: "plan more", gate: { kind: "none" as const }, role: "planner" },
  { id: "s2", title: "build", gate: { kind: "none" as const }, role: "builder", context: "none" as const },
];

const TWO_ROLE_TEAM = {
  name: "crew",
  roles: {
    planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
    builder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
  },
  maxConcurrent: 2, queue: "work",
};

describe("QueueScheduler step-role switch (F16.1 Phase 3, WF-8)", () => {
  it("2-role/3-step happy path: same-role steps share ONE agent (one send), the role switch spawns a SECOND agent sharing the task workdirKey", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },          // s0 gate passes -> SAME role (s1) -> send(), no respawn
      { awaitSend: true },
      { turn: {} },          // s1 gate passes -> DIFFERENT role (builder) -> switch: closeInput planner (STEP-AGENT-ENDS-DONE)
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },   // s2 is the LAST step -> closeInput (no-op) then natural settle
    ];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(TWO_ROLE_TEAM);
    rig.workflows.create({ name: "wf", steps: TWO_ROLE_STEPS });

    const sendSpy = vi.spyOn(rig.sup, "send");
    const killSpy = vi.spyOn(rig.sup, "kill");
    const closeInputSpy = vi.spyOn(rig.sup, "closeInput");
    const advanced: Array<{ stepIndex: number; stepId: string }> = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(2);                          // planner + builder — exactly two spawns
    expect(sendSpy.mock.calls.filter((c) => c[2] === "scheduler")).toHaveLength(1);   // ONE step-advance send (s0->s1, same role)
    // STEP-AGENT-ENDS-DONE: the planner's gate PASSED — its teardown at the switch is a
    // graceful closeInput (settles "done"), never a hard kill().
    expect(closeInputSpy).toHaveBeenCalledWith(rig.fake.spawns[0]!.agentId);
    expect(killSpy).not.toHaveBeenCalled();

    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1, 2]);
    expect(advanced.map((a) => a.stepId)).toEqual(["s0", "s1", "s2"]);

    // shared task-worktree (design §3.2): BOTH spawns key on the task, from step 0.
    const sharedKey = `task-${task.taskId}`;
    expect(rig.fake.spawns[0]!.workdirKey).toBe(sharedKey);
    expect(rig.fake.spawns[1]!.workdirKey).toBe(sharedKey);

    // the outgoing planner settles "done" (not "killed") — it finished its step honorably.
    await waitUntil(() => rig.sup.status(rig.fake.spawns[0]!.agentId).state === "done", 15000);

    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.error).toBeNull();                                   // no stray "agent killed" from a double-finalize
    expect(final.agentId).toBe(rig.fake.spawns[1]!.agentId);           // ends bound to the builder, not the (retired) planner
    expect(final.stepHistory.map((h) => h.stepId)).toEqual(["s0", "s1", "s2"]);
    expect(final.stepHistory.every((h) => h.outcome === "passed")).toBe(true);
    expect(final.stepHistory[0]!.agentId).toBe(rig.fake.spawns[0]!.agentId);
    expect(final.stepHistory[1]!.agentId).toBe(rig.fake.spawns[0]!.agentId);
    expect(final.stepHistory[2]!.agentId).toBe(rig.fake.spawns[1]!.agentId);
  });

  it("an unknown step role fails the task (the outgoing agent is still torn down gracefully, not killed)", async () => {
    const DEV: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },   // s0 passes -> next step names role "ghost", not in the team
    ];
    const rig = makeCoordination([DEV]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "start", gate: { kind: "none" }, role: "dev" },
        { id: "s1", title: "ghost step", gate: { kind: "none" }, role: "ghost", context: "none" },
      ],
    });
    const killSpy = vi.spyOn(rig.sup, "kill");
    const closeInputSpy = vi.spyOn(rig.sup, "closeInput");

    const task = rig.queues.push("work", { prompt: "x", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(1);                 // never attempted to spawn the unknown role
    // STEP-AGENT-ENDS-DONE: "dev"'s OWN step gate passed — the downstream failure is a
    // misconfigured next role, not dev's fault — its teardown stays graceful (closeInput).
    expect(closeInputSpy).toHaveBeenCalledWith(rig.fake.spawns[0]!.agentId);
    expect(killSpy).not.toHaveBeenCalled();
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain('unknown role "ghost"');
    expect(final.stepIndex).toBe(1);                         // the switch's advanceStep still ran — position preserved
  });

  it("a step-role switch never lets the team exceed maxConcurrent (the outgoing agent is unbound+torn-down before the next spawns)", async () => {
    const PLANNER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ ...TWO_ROLE_TEAM, maxConcurrent: 1 });   // only ONE agent may ever run at a time
    rig.workflows.create({ name: "wf", steps: TWO_ROLE_STEPS.slice(1) });   // s1 (planner) -> s2 (builder), one switch

    const runningAtSpawn: number[] = [];
    const originalSpawn = rig.sup.spawn.bind(rig.sup);
    vi.spyOn(rig.sup, "spawn").mockImplementation(async (...args: Parameters<typeof rig.sup.spawn>) => {
      runningAtSpawn.push(rig.scheduler.runningFor("crew"));
      return originalSpawn(...args);
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    // both spawns observed ZERO other crew members running — the outgoing agent was fully
    // torn down (unbound + closeInput'd) before the next role's agent was ever spawned.
    expect(runningAtSpawn).toEqual([0, 0]);
    expect(rig.queues.getTask(task.taskId).state).toBe("done");
  });

  it("a step-role switch to a persistent role reuses an idle pool worker instead of spawning a fresh one", async () => {
    const REVIEWER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "warmup" } },           // an unrelated task completes in one turn — worker idles, stays alive
      { awaitSend: true },                    // reused for the workflow's step1 (reviewer)
      { end: { resultText: "reviewed" } },    // step1 is the last step -> natural settle
    ];
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },   // step0 gate passes -> switch to the persistent "reviewer" role
    ];
    const rig = makeCoordination([REVIEWER, PLANNER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },
        reviewer: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } },
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "none" }, role: "planner" },
        { id: "s1", title: "review", gate: { kind: "none" }, role: "reviewer", context: "none" },
      ],
    });

    rig.queues.push("work", { prompt: "warmup", role: "reviewer" });   // spawns the persistent worker, then idles
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    const sendSpy = vi.spyOn(rig.sup, "send");
    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 15000);

    expect(rig.fake.spawns).toHaveLength(2);   // the idle reviewer + a fresh planner — NO third spawn (reused, not respawned)
    const reuseSend = sendSpy.mock.calls.find((c) => c[2] === "system" && (c[1] as string).includes("review"));
    expect(reuseSend).toBeDefined();
    expect(rig.queues.getTask(task.taskId).state).toBe("done");
  });

  it("a switch's spawn guardrail parks the task in_progress (never loses the workflow position) and resumes once the account frees up", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "bacct", provider: "claude", auth: { type: "subscription" } },
      ],
      autoOrder: ["main", "bacct"],
      caps: { maxAgentsTotal: 10, perAccount: { bacct: 1 } },
    });
    const BLOCKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { end: { resultText: "blocker-done" } },
    ];
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },   // s0 passes -> switch to "builder" (account bacct) -> guardrail (bacct at cap) -> park
    ];
    const BUILDER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "shipped" } },
    ];
    const rig = makeCoordination([BLOCKER, PLANNER, BUILDER], cfg);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },
        builder: { role: "blank", overrides: { cwd: "/tmp", account: "bacct", isolation: "none" } },
      },
      maxConcurrent: 5, queue: "work",
    });
    rig.workflows.create({ name: "wf", steps: TWO_ROLE_STEPS.slice(1) });   // s1 (planner) -> s2 (builder)

    rig.queues.push("work", { prompt: "blocker", role: "builder" });   // occupies bacct's sole slot, stays busy
    await rig.scheduler.tick();
    const blockerAgentId = rig.fake.spawns[0]!.agentId;

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(task.taskId).stepIndex === 1, 15000);   // the switch's advanceStep ran

    // parked: still in_progress at the new stepIndex, no agent bound, guardrail retried (no crash/lost position)
    let parked = rig.queues.getTask(task.taskId);
    expect(parked.state).toBe("in_progress");
    expect(parked.stepIndex).toBe(1);
    expect(rig.fake.spawns).toHaveLength(2);   // blocker + planner — builder's spawn never got past the guardrail

    await rig.scheduler.tick();   // an extra tick while still blocked must not spawn/lose position either
    parked = rig.queues.getTask(task.taskId);
    expect(parked.state).toBe("in_progress");
    expect(parked.stepIndex).toBe(1);
    expect(rig.fake.spawns).toHaveLength(2);

    await rig.sup.send(blockerAgentId, "go");   // free the bacct slot
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 15000);

    expect(rig.fake.spawns).toHaveLength(3);   // builder finally spawned once the slot freed
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    // the parked attempt's "awaiting step-agent" marker (agentId:null) stays dangling forever,
    // alongside the eventual real attempt that actually closed the step.
    const s1Entries = final.stepHistory.filter((h) => h.stepId === "s2");
    expect(s1Entries.some((h) => h.agentId === null)).toBe(true);
    expect(s1Entries.some((h) => h.outcome === "passed")).toBe(true);
  });

  it("a step-role switch mid-workflow survives a daemon restart: re-pickup targets the CURRENT step's role and the shared workdirKey", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-wf-switch-restart-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    const wf = workflows.create({ name: "rel", steps: TWO_ROLE_STEPS });

    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const task: TaskRecord = queues1.push("work", { prompt: "go" });
    queues1.markInProgress(task.taskId, "planner-agent");
    queues1.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    queues1.startStep(task.taskId, 0, "s0", "planner-agent");
    queues1.closeStep(task.taskId, "passed");
    queues1.startStep(task.taskId, 1, "s1", "planner-agent");
    queues1.closeStep(task.taskId, "passed");
    // simulate a switch that had JUST advanced to step 2 (builder) when the daemon died —
    // no agent ever got bound for it (a park, or a crash mid-spawn).
    queues1.advanceStep(task.taskId, 2);

    // daemon restart: reopen the queue store over the same home dir
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(task.taskId);
    expect(recovered.state).toBe("pending");   // in_progress reverts on restart
    expect(recovered.agentId).toBeNull();
    expect(recovered.stepIndex).toBe(2);       // the step cursor (builder's step) survives

    // drive a live scheduler over this SAME persisted state — confirms re-pickup routes to
    // the CURRENT step's role (builder), not the task's own (unset) role, sharing the workdirKey.
    const teams = new TeamManager(dir, events);
    const roles = new RoleStore(dir);
    teams.create({
      name: "crew",
      roles: {
        planner: { role: "blank", overrides: { cwd: "/tmp/planner", account: "main", isolation: "none" } },
        builder: { role: "blank", overrides: { cwd: "/tmp/builder", account: "main", isolation: "none" } },
      },
      maxConcurrent: 2, queue: "work",
    });
    const artifacts = new ArtifactStore(dir, events);
    const fake = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }]]);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler = new QueueScheduler({ teams, queues: queues2, supervisor: sup, events, workflows, artifacts, roles });
    scheduler.attach();
    await scheduler.tick();
    await waitUntil(() => queues2.getTask(task.taskId).state === "done", 15000);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.cwd).toBe("/tmp/builder");             // routed to the CURRENT step's role, not a default
    expect(fake.spawns[0]!.workdirKey).toBe(`task-${task.taskId}`);   // the shared task worktree, even on re-pickup
  });

  // WORKFLOW-GUARD-SHARED-WORKTREE (staff-PM workflow audit, Task 3b): a workflow's step
  // agents must ALWAYS share the task's own worktree, no matter how many roles or what each
  // role's permissionProfile is. This locks that in against two ways it could silently
  // regress: (1) a future refactor spawning step agents into per-agent worktrees instead of
  // the shared task-${taskId} key, and (2) WORKFLOW-FIX-READONLY-ISOLATION (81f9d046)'s
  // readOnly-permissionProfile-defaults-isolation-to-"none" rule leaking into role-templated
  // step spawns. It doesn't leak: TeamSpecSchema/RoleTemplateSchema parse a role's isolation
  // through AgentSpecSchema's OWN .default("worktree") at team-CREATE time, so by the time a
  // step spawn reaches resolveAgentSpec() the role template's isolation is already an
  // explicit "worktree" value — never the "left unset" case 81f9d046 special-cases. A genuine
  // ad-hoc readOnly helper spawn (bypassing team roles entirely) still gets "none", asserted
  // below for contrast.
  it("a 3-role workflow shares ONE task worktree across every step, and a readOnly role does NOT lose it", async () => {
    const DESIGN: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const IMPLEMENT: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const VERIFY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "reviewed" } }];
    const rig = makeCoordination([DESIGN, IMPLEMENT, VERIFY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        design: { role: "blank", overrides: { cwd: "/tmp", account: "main" } },
        implement: { role: "blank", overrides: { cwd: "/tmp", account: "main" } },
        // permissionProfile:"readOnly" WITHOUT an explicit isolation — the exact shape
        // 81f9d046 special-cases for a bare agent_spawn. Here it arrives through a role
        // template instead, which independently defaults isolation before resolveAgentSpec
        // ever sees it "unset".
        verify: { role: "blank", overrides: { cwd: "/tmp", account: "main", permissionProfile: "readOnly" } },
      },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "design", gate: { kind: "none" }, role: "design" },
        { id: "s1", title: "implement", gate: { kind: "none" }, role: "implement", context: "none" },
        { id: "s2", title: "verify", gate: { kind: "none" }, role: "verify", context: "none" },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(3);
    const sharedKey = `task-${task.taskId}`;
    for (const spawn of rig.fake.spawns) expect(spawn.workdirKey).toBe(sharedKey);

    // all three resolve isolation:"worktree" — including "verify" (readOnly) — because the
    // role template's own schema default fills in isolation BEFORE resolveAgentSpec's
    // "left unset" check ever runs, so it can never flip a step agent to "none".
    for (const spawn of rig.fake.spawns) expect(spawn.isolation).toBe("worktree");

    // contrast: a genuine bare readOnly helper spawn (no team role in the way) DOES resolve
    // to isolation:"none" per 81f9d046 — proving the rule is real, it just never reaches
    // role-templated step agents.
    const helper = await rig.sup.spawn({ prompt: "peek", cwd: "/tmp", account: "main", permissionProfile: "readOnly" });
    expect(rig.sup.status(helper.agentId).spec.isolation).toBe("none");
  });

  // STEP-AGENT-ENDS-DONE: only a GATE-PASSED step-agent's teardown became graceful
  // (closeInput). A step whose own gate FAILED (onFail:"halt", the default — no retry)
  // still finalizes via finishWorkflowTask's pre-existing hard kill() — a failed attempt
  // reading "killed" is acceptable and this path is deliberately unchanged.
  it("a gate-FAILED step (no retry) still hard-kills the agent — unchanged by the graceful-switch teardown", async () => {
    const DEV: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];
    const rig = makeCoordination([DEV], COORD_CFG, {
      gateExec: async () => ({ ok: false, message: "gate script exited non-zero" }),
    });
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [{ id: "s0", title: "start", gate: { kind: "command", spec: { command: "false", args: [] } }, role: "dev" }],
      onFail: "halt",
    });
    const killSpy = vi.spyOn(rig.sup, "kill");
    const closeInputSpy = vi.spyOn(rig.sup, "closeInput");

    const task = rig.queues.push("work", { prompt: "x", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 15000);

    expect(killSpy).toHaveBeenCalledTimes(1);           // the failed-gate agent is still hard-killed
    expect(closeInputSpy).not.toHaveBeenCalled();
    const final = rig.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.stepHistory[0]!.outcome).toBe("failed");
  });
});
