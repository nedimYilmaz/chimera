import { describe, it, expect } from "vitest";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, AgentNotRunningError } from "@chimera/core/supervisor";
import { UnknownTeamError } from "@chimera/core/teams";
import { SchedulerError } from "@chimera/core/scheduler";
import { Engine } from "@chimera/core/engine";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { makeEngineHome } from "./helpers.js";

// mirrors scheduler-persistent.test.ts's PERSISTENT_TEAM rig
const PERSISTENT_TEAM = (maxConcurrent: number, poolSize?: number) => ({
  name: "crew",
  roles: {
    worker: { role: "blank", overrides: {
      cwd: "/tmp", account: "main", isolation: "none",
      persistent: true, ...(poolSize !== undefined ? { poolSize } : {}),
    } },
  },
  maxConcurrent, queue: "work",
});

describe("QueueScheduler.assign — direct assignment (Task C1)", () => {
  it("agentId target: delivers the prompt straight into the agent's mailbox, returns {delivered:true, agentId}", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "boot" } },   // idle but running
      { awaitSend: true },          // will echo whatever `send` delivers next
    ];
    const rig = makeCoordination([WORKER]);
    const rec = await rig.sup.spawn({ prompt: "boot", cwd: "/tmp", account: "main", isolation: "none", persistent: true });
    await waitUntil(() => rig.sup.status(rec.agentId).state === "running");

    const result = await rig.scheduler.assign({ agentId: rec.agentId }, "hello direct");
    expect(result).toEqual({ delivered: true, agentId: rec.agentId });

    // the prompt actually reached the agent: FakeAgentBackend's awaitSend step
    // echoes `echo:${text}` via message_complete once handle.send() fires. The
    // mailbox layer prefixes every delivered message with "[from <from>] "
    // (AgentSupervisor.deliverBatch) — "assign" is the `from` scheduler.assign passes.
    await waitUntil(() => rig.events.tail(rec.agentId, 50)
      .some((e) => e.kind === "message_complete" && e.data["text"] === "echo:hello direct"));
  });

  it("team target (idle reuse): pushes onto the team's queue and routes to the already-idle persistent worker — no new spawn", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "w1" } },
      { awaitSend: true },
      { turn: { text: "w2" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "seed-task" });   // spawns the one worker, then it goes idle
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(rig.fake.spawns.length).toBe(1);

    const result = await rig.scheduler.assign({ team: "crew", role: "worker" }, "assigned-task", 3);
    // TaskRecord shape (not the {delivered} shape)
    expect((result as { delivered?: true }).delivered).toBeUndefined();
    const task = result as { taskId: string; queue: string; priority: number };
    expect(task.queue).toBe("work");
    expect(task.priority).toBe(3);

    await waitUntil(() => rig.queues.status("work").counts.done === 2);
    expect(rig.fake.spawns.length).toBe(1);   // reused the idle worker, no 2nd spawn
  });

  it("team target (spawn under cap): empty pool — assign spawns a fresh worker", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "w1" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));

    const task = await rig.scheduler.assign({ team: "crew" }, "first-task");
    expect((task as { queue: string }).queue).toBe("work");
    expect((task as { role: string | null }).role).toBeNull();   // role omitted → null (team's first role at drain time)

    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(rig.fake.spawns.length).toBe(1);
  });

  it("no-queue team: throws SchedulerError with code 'protocol'", async () => {
    expect.assertions(3);
    const rig = makeCoordination([]);
    rig.teams.create({
      name: "noqueue",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 1, queue: null,
    });
    try {
      await rig.scheduler.assign({ team: "noqueue" }, "x");
      throw new Error("expected assign to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchedulerError);
      expect((err as { code?: string }).code).toBe("protocol");
      expect((err as Error).message).toContain("noqueue");
    }
  });

  it("unknown team target: propagates UnknownTeamError", async () => {
    expect.assertions(1);
    const rig = makeCoordination([]);
    await expect(rig.scheduler.assign({ team: "ghost-team" }, "x")).rejects.toBeInstanceOf(UnknownTeamError);
  });

  it("unknown agentId target: propagates UnknownAgentError", async () => {
    expect.assertions(1);
    const rig = makeCoordination([]);
    await expect(rig.scheduler.assign({ agentId: "ghost-agent" }, "x")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("agentId target on a non-running (dead) agent: propagates AgentNotRunningError", async () => {
    expect.assertions(1);
    const rig = makeCoordination([[{ end: { resultText: "done", costUsd: 0 } }]]);
    const rec = await rig.sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await waitUntil(() => rig.sup.status(rec.agentId).state === "done");
    await expect(rig.scheduler.assign({ agentId: rec.agentId }, "too late")).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("priority defaults to 0 when omitted on a team assign", async () => {
    const rig = makeCoordination([]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 1, queue: "work",
    });
    const task = await rig.scheduler.assign({ team: "crew" }, "x") as { priority: number };
    expect(task.priority).toBe(0);
  });

  it("team assign always uses empty overrides ({}), even though a role was specified", async () => {
    const rig = makeCoordination([]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 1, queue: "work",
    });
    const task = await rig.scheduler.assign({ team: "crew", role: "dev" }, "x") as { overrides: Record<string, unknown>; role: string | null };
    expect(task.overrides).toEqual({});
    expect(task.role).toBe("dev");
  });
});

describe("Engine 'assign' RPC (Task C1)", () => {
  it("agentId target: dispatches to scheduler.assign and returns {delivered:true, agentId}", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "boot" } },
      { awaitSend: true },
    ];
    const fake = new FakeAgentBackend([WORKER]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    const rec = await e.handle("agent.spawn", { spec: { prompt: "boot", cwd: "/tmp", account: "main", isolation: "none", persistent: true } }) as { agentId: string };
    await waitUntil(() => e.supervisor.status(rec.agentId).state === "running");

    const result = await e.handle("assign", { target: { agentId: rec.agentId }, prompt: "via-engine" });
    expect(result).toEqual({ delivered: true, agentId: rec.agentId });
  });

  it("team target: dispatches to scheduler.assign and returns the TaskRecord", async () => {
    const fake = new FakeAgentBackend([[{ end: { resultText: "ok", costUsd: 0 } }]]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: {
      name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work",
    } });
    const task = await e.handle("assign", { target: { team: "crew" }, prompt: "via-engine-team", priority: 7 }) as { queue: string; priority: number };
    expect(task.queue).toBe("work");
    expect(task.priority).toBe(7);
  });

  it("malformed params (blank prompt) surface as a protocol RPC error", async () => {
    expect.assertions(1);
    const fake = new FakeAgentBackend([]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    try {
      await e.handle("assign", { target: { agentId: "a1" }, prompt: "" });
      throw new Error("expected handle('assign', ...) to throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("protocol");
    }
  });

  it("unknown team surfaces as a protocol RPC error via the engine dispatch", async () => {
    expect.assertions(1);
    const fake = new FakeAgentBackend([]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    try {
      await e.handle("assign", { target: { team: "ghost" }, prompt: "x" });
      throw new Error("expected handle('assign', ...) to throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("protocol");
    }
  });
});
