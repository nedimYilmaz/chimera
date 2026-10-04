import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { QueueScheduler, type GateExecFn } from "@chimera/core/scheduler";
import { branchNameFor } from "@chimera/core/workdir";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";
import { fakeExec } from "./helpers.js";

// FEATURE-2 (durable checkpoint-resume + idempotency): scheduler-level wiring proof. The
// deeper real-git "a crash-recovered respawn reuses the same worktree/commit" proof lives in
// workdir.test.ts (FakeAgentBackend never calls ensureWorkdir, so no real worktree materializes
// here) — these tests cover the scheduler's OWN behavior: workdirKey stability, checkpoint
// capture, idempotency-key determinism, and resume-notice threading.

// CORE-SUITE-BASELINE: scheduler coordination under this machine's concurrent-agent load
// can exceed vitest's 5000ms default even with fake backends (event-loop scheduling
// itself gets delayed); widened alongside the waitUntil deadlines above.
vi.setConfig({ testTimeout: 20_000 });

const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];

describe("QueueScheduler durable checkpoint-resume (FEATURE-2)", () => {
  it("workdirKey-widened-for-plain-workflow: a single-role, no-critic-gate workflow now shares the task-stable workdirKey from step 0", async () => {
    const rig = makeCoordination([ONE_SHOT("done")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "one", gate: { kind: "none" } },
        { id: "s1", title: "two", gate: { kind: "none" } },
      ],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();

    expect(rig.fake.spawns).toHaveLength(1);
    // previously undefined for a plain single-role/no-critic-gate workflow — this IS the fix.
    expect(rig.fake.spawns[0]!.workdirKey).toBe(`task-${task.taskId}`);
  });

  it("checkpoint-captured-on-fresh-spawn: the first fresh spawn persists a checkpoint at stepIndex 0 with a deterministic idempotency key", async () => {
    const rig = makeCoordination([ONE_SHOT("done")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "worktree" as const } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: [{ id: "s0", title: "one", gate: { kind: "none" } }] });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();

    const checkpoint = rig.queues.getTask(task.taskId).checkpoint;
    const workdirKey = `task-${task.taskId}`;
    expect(checkpoint).not.toBeNull();
    expect(checkpoint).toMatchObject({
      stepIndex: 0,
      idempotencyKey: `${task.taskId}:step-0`,
      workdirKey,
      branch: branchNameFor(workdirKey),
      gateAttempts: 0,
      // REVIEW-ROOM-UNBOUND-TASKS: a worktree task captures the land-target repo (spec.cwd) so
      // EvidenceStore can derive a landed diff after the agent is gone — the "worktree"→cwd arm.
      mainRepo: "/tmp",
    });
  });

  it("idempotency-key-changes-on-step-advance: a role-switch step boundary captures a FRESH checkpoint with a different key than the previous step's", async () => {
    const rig = makeCoordination([
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "planned" } }],
      ONE_SHOT("built"),
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        builder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "none" }, role: "planner" },
        { id: "s1", title: "build", gate: { kind: "none" }, role: "builder", context: "none" as const },
      ],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(2);   // planner, then a genuine role-switch respawn for builder
    // the FINAL checkpoint reflects the LAST fresh-spawn boundary (step 1's), not step 0's —
    // each fresh spawn re-baselines it. A same-role LIVE advance (no respawn) ALSO re-baselines
    // it now (advanceToIndex's live-continuation branch captures its own checkpoint too) — see
    // "live-same-role-advance-checkpoints-so-a-crash-restart-at-step-1-gets-a-resume-notice"
    // below for that case.
    const finalCheckpoint = rig.queues.getTask(task.taskId).checkpoint!;
    expect(finalCheckpoint.stepIndex).toBe(1);
    expect(finalCheckpoint.idempotencyKey).toBe(`${task.taskId}:step-1`);
    expect(finalCheckpoint.idempotencyKey).not.toBe(`${task.taskId}:step-0`);
  });

  it("live-same-role-advance-checkpoints-so-a-crash-restart-at-step-1-gets-a-resume-notice", async () => {
    // Regression for the stale-checkpoint bug: a live same-role advance (advanceToIndex's
    // agentAlive-and-same-role branch) used to move the step cursor WITHOUT capturing a new
    // checkpoint, so checkpoint.stepIndex stayed pinned at the last fresh-spawn step. A
    // crash-restart re-dispatch of the already-advanced step then failed maybeResumeNotice's
    // exact stepIndex match and silently redid step 1's side effects.
    const dir = mkdtempSync(join(tmpdir(), "chimera-checkpoint-live-advance-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "one", gate: { kind: "none" } },
        { id: "s1", title: "two", gate: { kind: "none" } },
      ],
    });

    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const task = queues1.push("work", { prompt: "go", workflow: "wf" });

    const teams1 = new TeamManager(dir, events);
    const roles1 = new RoleStore(dir);
    teams1.create({ name: "crew", roles: { solo: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "worktree" as const } } }, maxConcurrent: 1, queue: "work" });
    const artifacts1 = new ArtifactStore(dir, events);
    // step 0's turn_complete passes its gate (kind:"none") and drives a LIVE same-role
    // advance into step 1 — the session then stays alive (no further steps), simulating a
    // crash while step 1 is still in flight, mid-conversation.
    const fake1 = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: {} } }, { turn: {} }]]);
    const sup1 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake1]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler1 = new QueueScheduler({ teams: teams1, queues: queues1, supervisor: sup1, events, workflows, artifacts: artifacts1, roles: roles1 });
    scheduler1.attach();
    await scheduler1.tick();
    await waitUntil(() => queues1.getTask(task.taskId).stepIndex === 1, 15000);

    const cp1 = queues1.getTask(task.taskId).checkpoint;
    expect(cp1).not.toBeNull();
    // this IS the fix: the live advance re-baselines the checkpoint at the new stepIndex,
    // instead of leaving it stale at step 0.
    expect(cp1!.stepIndex).toBe(1);
    expect(cp1!.idempotencyKey).toBe(`${task.taskId}:step-1`);

    // simulate a daemon restart: reopen the queue store over the SAME home dir — this reverts
    // the still-in_progress task back to pending at its CURRENT stepIndex (1).
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(task.taskId);
    expect(recovered.state).toBe("pending");
    expect(recovered.stepIndex).toBe(1);
    expect(recovered.checkpoint).toEqual(cp1);

    const teams2 = new TeamManager(dir, events);
    const roles2 = new RoleStore(dir);
    const artifacts2 = new ArtifactStore(dir, events);
    const fake2 = new FakeAgentBackend([ONE_SHOT("done")]);   // a FRESH agent identity this time
    const sup2 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake2]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler2 = new QueueScheduler({ teams: teams2, queues: queues2, supervisor: sup2, events, workflows, artifacts: artifacts2, roles: roles2 });
    scheduler2.attach();
    await scheduler2.tick();   // re-dispatch of step 1, through spawnForTask

    expect(fake2.spawns).toHaveLength(1);
    // the resumed step-1 agent MUST be told a previous attempt already ran here — without the
    // fix, maybeResumeNotice(task, 1) sees checkpoint.stepIndex===0 !== 1 and stays silent,
    // so the fresh agent has no idea it might be redoing step 1's work.
    expect(fake2.spawns[0]!.instructions).toContain("resume notice");
    expect(fake2.spawns[0]!.instructions).toContain(`${task.taskId}:step-1`);
  });

  it("idempotency-key-stable-and-workdirKey-reused-across-a-simulated-daemon-restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-checkpoint-restart-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    workflows.create({ name: "wf", steps: [{ id: "s0", title: "one", gate: { kind: "none" } }] });

    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const task = queues1.push("work", { prompt: "go", workflow: "wf" });

    const teams1 = new TeamManager(dir, events);
    const roles1 = new RoleStore(dir);
    teams1.create({ name: "crew", roles: { solo: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "worktree" as const } } }, maxConcurrent: 1, queue: "work" });
    const artifacts1 = new ArtifactStore(dir, events);
    // parks right after spawn (never completes the turn) — simulates a crash mid-step, before
    // the gate ever evaluated.
    const fake1 = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]]);
    const sup1 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake1]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler1 = new QueueScheduler({ teams: teams1, queues: queues1, supervisor: sup1, events, workflows, artifacts: artifacts1, roles: roles1 });
    scheduler1.attach();
    await scheduler1.tick();

    const cp1 = queues1.getTask(task.taskId).checkpoint;
    expect(cp1).not.toBeNull();
    expect(cp1!.stepIndex).toBe(0);
    expect(cp1!.workdirKey).toBe(`task-${task.taskId}`);   // isolation:"worktree" — non-null

    // simulate a daemon restart: reopen the queue store over the SAME home dir (this reverts
    // the still-in_progress task back to pending, per the pre-existing constructor contract).
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(task.taskId);
    expect(recovered.state).toBe("pending");
    expect(recovered.agentId).toBeNull();
    expect(recovered.checkpoint).toEqual(cp1);   // the pre-crash checkpoint survives the restart

    const teams2 = new TeamManager(dir, events);
    const roles2 = new RoleStore(dir);
    const artifacts2 = new ArtifactStore(dir, events);
    const fake2 = new FakeAgentBackend([ONE_SHOT("done")]);   // a FRESH agent identity this time
    const sup2 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake2]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler2 = new QueueScheduler({ teams: teams2, queues: queues2, supervisor: sup2, events, workflows, artifacts: artifacts2, roles: roles2 });
    scheduler2.attach();
    await scheduler2.tick();   // re-dispatch, through spawnForTask's fresh-spawn checkpoint capture

    expect(fake2.spawns).toHaveLength(1);
    expect(fake2.spawns[0]!.agentId).not.toBe(fake1.spawns[0]!.agentId);   // genuinely a new agent
    expect(fake2.spawns[0]!.workdirKey).toBe(cp1!.workdirKey);              // same shared worktree key

    const cp2 = queues2.getTask(task.taskId).checkpoint!;
    // idempotency: SAME (taskId, stepIndex) -> SAME key, across the crash/restart boundary.
    expect(cp2.idempotencyKey).toBe(cp1!.idempotencyKey);
    expect(cp2.workdirKey).toBe(cp1!.workdirKey);
    expect(cp2.branch).toBe(cp1!.branch);
  });

  it("resume-notice-injected-only-once-a-checkpoint-already-exists-for-this-step: a same-step dead-agent retry sees it, the first attempt never does", async () => {
    const delayedGate = (sequence: boolean[]): GateExecFn => {
      let call = 0;
      return () => new Promise((resolve) => {
        const ok = sequence[Math.min(call, sequence.length - 1)]!;
        call++;
        setTimeout(() => resolve({ ok, message: ok ? "" : "not yet" }), 5);
      });
    };
    const rig = makeCoordination(
      [ONE_SHOT("attempt 1"), ONE_SHOT("attempt 2")],
      undefined,
      { gateExec: delayedGate([false, true]) },   // fails once, passes on the retry
    );
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { solo: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } }, maxConcurrent: 2, queue: "work" });
    rig.workflows.create({
      name: "wf",
      steps: [{
        id: "s0", title: "work", role: "solo",
        gate: { kind: "command", spec: { command: "gate", args: [] } },
        onFail: "retry", retryLimit: 1,
      }],
    });

    const task = rig.queues.push("work", { prompt: "go", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 15000);

    expect(rig.fake.spawns).toHaveLength(2);
    // first attempt: no checkpoint existed yet at stepIndex 0 — no resume notice fabricated.
    expect(rig.fake.spawns[0]!.instructions).not.toContain("resume notice");
    // the retry respawn: a checkpoint from attempt 1 already exists at this exact stepIndex —
    // the resumed agent is told about it, carrying the idempotency key.
    expect(rig.fake.spawns[1]!.instructions).toContain("resume notice");
    expect(rig.fake.spawns[1]!.instructions).toContain(`${task.taskId}:step-0`);
  });

  it("fan-out-branch-tasks-get-a-git-field-free-checkpoint: a plain (non-workflow-bound) branch task on isolation:\"none\" still gets stepIndex/idempotencyKey bookkeeping, but no worktree info", async () => {
    const rig = makeCoordination([
      ONE_SHOT("planned"),
      ONE_SHOT("branch done"),
      ONE_SHOT("joined"),
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } }, maxConcurrent: 10, queue: "work" });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["only"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    let branchTaskIds: string[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => branchTaskIds.length === 1, 15000);
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 15000);

    const branch = rig.queues.getTask(branchTaskIds[0]!);
    expect(branch.workflow).toBeNull();       // confirms it's a plain, non-workflow-bound task
    // FEATURE-10 fix: captureStepCheckpoint is now unconditional (not gated on `if (wf)`) —
    // EvidenceStore needs a per-task marker for plain tasks too (see evidence.ts). isolation:
    // "none" has no worktree to read, so workdirKey/branch/commitSha still come back null —
    // only the durable-resume bookkeeping (stepIndex/idempotencyKey/capturedAt) is populated.
    // the "none"→null arm: isolation:"none" has no branch to land, so mainRepo stays null too
    // (alongside workdirKey/branch/commitSha) — nothing for EvidenceStore to diff against.
    expect(branch.checkpoint).toMatchObject({ stepIndex: 0, workdirKey: null, branch: null, commitSha: null, mainRepo: null });
  });
});
