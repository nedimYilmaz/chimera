import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

// A standalone (non-team) asker that never completes on its own — stays
// "running" for the whole test (ask() doesn't require the asker to be
// running, but this mirrors realistic usage and avoids incidental
// state-machine interference, mirroring D1's PARKED fixture).
const ASKER_SPEC = { prompt: "asker", cwd: "/tmp", account: "main", isolation: "none" } as const;
const PARKED = (): FakeStep[] => [{ awaitSend: true }];

// A persistent pool worker: completes its bound task (turn_complete — the
// scheduler unbinds it from `tracked`, leaving it idle-but-running in the
// pool), then awaitSend's the askTeam-delivered question so it can answer.
const IDLE_THEN_ASK = (): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { turn: { text: "t1" } },
  { awaitSend: true },
];

function persistentTeam(roles: Record<string, { poolSize: number }>, maxConcurrent: number) {
  return {
    name: "crew",
    roles: Object.fromEntries(Object.entries(roles).map(([r, { poolSize }]) => [
      r, { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize } },
    ])),
    maxConcurrent, queue: "work",
  };
}

// Subscribes to message_complete for the given agentIds, parses the delivered
// `[question <id> from <asker>]` marker (D1 format) out of the (echo:-prefixed,
// per the fake backend) text, and immediately answers it. Mirrors D1's test pattern.
function autoAnswer(e: Engine, agentIds: string[], answerFor: (agentId: string) => { text: string }) {
  e.events.subscribe((ev) => {
    if (ev.kind === "message_complete" && agentIds.includes(ev.agentId)) {
      const m = /\[question (\S+) from/.exec(String(ev.data["text"]));
      if (m) e.supervisor.answerQuestion(m[1]!, answerFor(ev.agentId));
    }
  });
}

describe("Engine agent.askTeam — fan-out to a team (spec §17 D2)", () => {
  it("fan-out + collect: asks every running team member concurrently and collects ALL answers", async () => {
    const fake = new FakeAgentBackend([PARKED(), IDLE_THEN_ASK(), IDLE_THEN_ASK()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: persistentTeam({ dev: { poolSize: 2 } }, 2) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await e.handle("queue.push", { queue: "work", prompt: "task2" });
    await waitUntil(() => e.queues.status("work").counts.done === 2);

    const workers = e.scheduler.membersOf("crew", "dev").map((m) => m.agentId);
    expect(workers).toHaveLength(2);
    autoAnswer(e, workers, (agentId) => ({ text: `ans-${agentId}` }));

    const result = (await e.handle("agent.askTeam", {
      agentId: asker.agentId, team: "crew", role: "dev", prompt: "pick one",
    })) as { answers: Array<{ agentId: string; questionId: string; answer: { text: string } }> };

    expect(result.answers).toHaveLength(2);
    expect(result.answers.map((a) => a.agentId).sort()).toEqual([...workers].sort());
    for (const a of result.answers) {
      expect(a.answer).toEqual({ text: `ans-${a.agentId}` });
      expect(a.questionId).toBeTruthy();
    }
  });

  it("excludes the asker: an asker who is itself a team member is not asked (only the other member answers)", async () => {
    const fake = new FakeAgentBackend([IDLE_THEN_ASK(), IDLE_THEN_ASK()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: persistentTeam({ dev: { poolSize: 2 } }, 2) });
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await e.handle("queue.push", { queue: "work", prompt: "task2" });
    await waitUntil(() => e.queues.status("work").counts.done === 2);

    const [askerId, otherId] = e.scheduler.membersOf("crew", "dev").map((m) => m.agentId) as [string, string];
    autoAnswer(e, [otherId], () => ({ text: "from-other" }));

    const result = (await e.handle("agent.askTeam", {
      agentId: askerId, team: "crew", role: "dev", prompt: "x",
    })) as { answers: Array<{ agentId: string }> };

    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]!.agentId).toBe(otherId);
  });

  it("role filter: askTeam with `role` fans out only to that role's members", async () => {
    const fake = new FakeAgentBackend([PARKED(), IDLE_THEN_ASK(), IDLE_THEN_ASK()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: persistentTeam({ dev: { poolSize: 1 }, ops: { poolSize: 1 } }, 2) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    await e.handle("queue.push", { queue: "work", prompt: "task-dev", role: "dev" });
    await e.handle("queue.push", { queue: "work", prompt: "task-ops", role: "ops" });
    await waitUntil(() => e.queues.status("work").counts.done === 2);

    const devWorker = e.scheduler.membersOf("crew", "dev")[0]!.agentId;
    const opsWorker = e.scheduler.membersOf("crew", "ops")[0]!.agentId;
    expect(devWorker).not.toBe(opsWorker);
    autoAnswer(e, [devWorker, opsWorker], () => ({ text: "should-not-be-asked-if-ops" }));

    const result = (await e.handle("agent.askTeam", {
      agentId: asker.agentId, team: "crew", role: "dev", prompt: "x",
    })) as { answers: Array<{ agentId: string }> };

    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]!.agentId).toBe(devWorker);
  });

  it("idle-worker-included: a persistent worker gone idle (untracked) after turn_complete is still a member and IS asked", async () => {
    const fake = new FakeAgentBackend([PARKED(), IDLE_THEN_ASK()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: persistentTeam({ dev: { poolSize: 1 } }, 1) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await waitUntil(() => e.queues.status("work").counts.done === 1);

    const worker = e.scheduler.membersOf("crew", "dev")[0]!.agentId;
    // proves this is the "idle, untracked" case: agentsFor (tracked/busy only) MISSES it.
    expect(e.scheduler.agentsFor("crew")).not.toContain(worker);
    expect(e.supervisor.status(worker).state).toBe("running");
    autoAnswer(e, [worker], () => ({ text: "idle-answer" }));

    const result = (await e.handle("agent.askTeam", {
      agentId: asker.agentId, team: "crew", role: "dev", prompt: "x",
    })) as { answers: Array<{ agentId: string; answer: { text: string } }> };

    expect(result.answers).toEqual([{ agentId: worker, questionId: expect.any(String), answer: { text: "idle-answer" } }]);
  });

  it("no members: a valid team with no currently-running members returns {answers: []} without asking anyone", async () => {
    const fake = new FakeAgentBackend([PARKED()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    // persistent role, but never spawned (no queue push) — pool has no entry for this team at all.
    await e.handle("team.create", {
      spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } }, maxConcurrent: 1, queue: null },
    });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };

    const result = await e.handle("agent.askTeam", { agentId: asker.agentId, team: "crew", prompt: "x" });
    expect(result).toEqual({ answers: [] });
  });

  it("unknown team: rejects with UnknownTeamError (protocol code), asking no one", async () => {
    expect.assertions(1);
    const fake = new FakeAgentBackend([PARKED()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    // message assertion (not just the generic "protocol" code) so this can't false-pass against
    // an unimplemented "agent.askTeam" method, which ALSO rejects with {code:"protocol"}.
    await expect(e.handle("agent.askTeam", { agentId: asker.agentId, team: "ghost", prompt: "x" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining('unknown team "ghost"') });
  });

  it("timeout -> default: a member that never answers resolves to the question's `default` after a short timeoutMs", async () => {
    const fake = new FakeAgentBackend([PARKED(), IDLE_THEN_ASK()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: persistentTeam({ dev: { poolSize: 1 } }, 1) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await waitUntil(() => e.queues.status("work").counts.done === 1);
    const worker = e.scheduler.membersOf("crew", "dev")[0]!.agentId;
    // deliberately no autoAnswer subscription — the member never answers.

    const result = (await e.handle("agent.askTeam", {
      agentId: asker.agentId, team: "crew", role: "dev", prompt: "x",
      timeoutMs: 30, default: { text: "fallback" },
    })) as { answers: Array<{ agentId: string; questionId: string; answer: { text: string } }> };

    expect(result.answers).toEqual([{ agentId: worker, questionId: expect.any(String), answer: { text: "fallback" } }]);
  });

  it("malformed params: missing `team` and missing `prompt` both reject with a zod protocol error (no members contacted)", async () => {
    expect.assertions(2);
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([PARKED()])) });
    const asker = (await e.handle("agent.spawn", { spec: ASKER_SPEC })) as { agentId: string };
    // message assertion rules out the false-positive of matching the generic "unknown method"
    // rejection an unimplemented case would ALSO surface as {code:"protocol"}.
    await expect(e.handle("agent.askTeam", { agentId: asker.agentId, prompt: "x" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.not.stringContaining("unknown method") });
    await expect(e.handle("agent.askTeam", { agentId: asker.agentId, team: "crew" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.not.stringContaining("unknown method") });
  });
});

describe("QueueScheduler.membersOf — direct unit coverage (spec §17 D2)", () => {
  const BUSY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]; // never settles on its own

  it("a team never given a persistent role (no pool entry) and no ephemeral members returns []", () => {
    const rig = makeCoordination([]);
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: null });
    expect(rig.scheduler.membersOf("crew")).toEqual([]);
    expect(rig.scheduler.membersOf("crew", "dev")).toEqual([]);
  });

  it("returns pool workers (idle AND busy) tagged with role, deduping a busy worker present in both pool and tracked", async () => {
    const IDLE: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "t1" } }];
    const rig = makeCoordination([IDLE, BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 2 } } }, maxConcurrent: 2, queue: "work" });
    rig.queues.push("work", { prompt: "t1" });   // will go idle (turn, no further awaitSend)
    rig.queues.push("work", { prompt: "t2" });   // stays busy forever
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);   // only t1 settles

    const members = rig.scheduler.membersOf("crew");
    expect(members).toHaveLength(2);                 // busy worker counted exactly ONCE (pool, not also via tracked)
    expect(new Set(members.map((m) => m.role))).toEqual(new Set(["dev"]));
    expect(rig.fake.spawns.length).toBe(2);
  });

  it("role filter narrows across BOTH the pool loop and the tracked-ephemeral loop", async () => {
    const IDLE: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "t1" } }];
    const rig = makeCoordination([IDLE, [{ end: { resultText: "e", costUsd: 0 } }], BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } },
        support: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },   // ephemeral
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.queues.push("work", { prompt: "p1", role: "dev" });
    rig.queues.push("work", { prompt: "p2", role: "support" });   // finishes fast — not useful for a "still tracked" check
    rig.queues.push("work", { prompt: "p3", role: "support" });   // will stay busy (BUSY scenario)
    await rig.scheduler.tick();
    await waitUntil(() => rig.scheduler.membersOf("crew", "support").length === 1);

    expect(rig.scheduler.membersOf("crew", "dev").map((m) => m.role)).toEqual(["dev"]);
    expect(rig.scheduler.membersOf("crew", "support").map((m) => m.role)).toEqual(["support"]);
    expect(rig.scheduler.membersOf("crew", "ghost-role")).toEqual([]);
    expect(rig.scheduler.membersOf("crew")).toHaveLength(2);
  });

  it("a tracked ephemeral member of a DIFFERENT team is excluded", async () => {
    const rig = makeCoordination([BUSY, BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "teamA", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.teams.create({ name: "teamB", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.queues.push("work", { prompt: "a" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.scheduler.membersOf("teamA").length + rig.scheduler.membersOf("teamB").length === 1);
    // whichever team the single ephemeral task landed on, the OTHER team sees nothing.
    const inA = rig.scheduler.membersOf("teamA").length === 1;
    expect(rig.scheduler.membersOf(inA ? "teamB" : "teamA")).toEqual([]);
  });

  it("race: a pool worker killed but not yet swept by the scheduler's deferred cleanup is excluded (status guard, not map presence)", async () => {
    const rig = makeCoordination([BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } }, maxConcurrent: 1, queue: "work" });
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);
    const agentId = rig.queues.status("work").tasks[0]!.agentId!;

    await rig.sup.kill(agentId);   // status flips to "killed" synchronously; scheduler's cleanup is deferred (setTimeout(0))
    expect(rig.sup.status(agentId).state).toBe("killed");
    expect(rig.scheduler.membersOf("crew")).toEqual([]);   // excluded by membersOf's own running-state guard, not by map cleanup
  });

  // MEMBERS-INCLUDE-DORMANT: every membersOf caller is a delivery path (askTeam, hook notify) and
  // delivering is what revives an idle-reaped / restart-dormant member — so listing only "running"
  // silently cut a parked conductor off from its own team's ask_team.
  it("a member parked by idle-reap is still listed — delivering to it is what wakes it", async () => {
    const rig = makeCoordination([BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } }, maxConcurrent: 1, queue: "work" });
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);
    const agentId = rig.queues.status("work").tasks[0]!.agentId!;

    await rig.sup.parkIdle(agentId, 3_600_000);
    expect(rig.sup.status(agentId)).toMatchObject({ state: "paused", pauseReason: "idle-timeout" });
    expect(rig.scheduler.membersOf("crew").map((m) => m.agentId)).toEqual([agentId]);
  });

  it("a member on a session-limit hold is NOT listed — that hold cannot be woken by delivery", async () => {
    const rig = makeCoordination([BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } }, maxConcurrent: 1, queue: "work" });
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);
    const agentId = rig.queues.status("work").tasks[0]!.agentId!;

    await rig.sup.parkIdle(agentId, 3_600_000);
    (rig.sup as unknown as { agents: Map<string, { pauseReason?: string }> }).agents.get(agentId)!.pauseReason = "session-limit";
    expect(rig.scheduler.membersOf("crew")).toEqual([]);
  });

  it("race: a tracked ephemeral member killed but not yet swept is excluded (status guard, not map presence)", async () => {
    const rig = makeCoordination([BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);
    const agentId = rig.queues.status("work").tasks[0]!.agentId!;

    await rig.sup.kill(agentId);
    expect(rig.sup.status(agentId).state).toBe("killed");
    expect(rig.scheduler.membersOf("crew")).toEqual([]);
  });
});
