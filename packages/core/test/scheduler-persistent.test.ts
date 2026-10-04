import { describe, it, expect, vi } from "vitest";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { Engine } from "@chimera/core/engine";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { makeEngineHome } from "./helpers.js";

// A single persistent role team. poolSize defaults to undefined (falls back to
// role.poolSize ?? team.maxConcurrent per the design's concurrency bound).
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

describe("QueueScheduler — persistent-worker pool", () => {
  it("reuses ONE persistent worker across two queued tasks (poolSize 1)", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
      { awaitSend: true },
      { turn: { text: "t2" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "task1" });
    rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();

    // task2 cannot be assigned yet (pool cap 1, worker still busy on task1)
    expect(rig.queues.status("work").counts).toEqual({ pending: 1, in_progress: 1, done: 0, failed: 0, blocked: 0, dead_letter: 0 });

    await waitUntil(() => rig.queues.status("work").counts.done === 2);
    expect(rig.fake.spawns.length).toBe(1);   // exactly one agent spawned — reused, not respawned

    const tasks = rig.queues.status("work").tasks;
    const t1 = tasks.find((t) => t.prompt === "task1")!;
    const t2 = tasks.find((t) => t.prompt === "task2")!;
    expect(t1.agentId).toBe(t2.agentId);      // same worker served both tasks (delivered via scheduler.send)
    expect(t1.resultText).toBe("");           // accepted v1 simplification: no resultText on turn_complete settle
    expect(t2.resultText).toBe("");
  });

  it("applies per-task overrides on a persistent worker's SPAWN (parity with the ephemeral path)", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "task1", overrides: { model: "claude-override-model" } });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    // the override rode onto the spawned worker's resolved spec (not silently dropped)
    expect(rig.fake.spawns[0]!.model).toBe("claude-override-model");
    expect(rig.fake.spawns[0]!.persistent).toBe(true);
  });

  it("pool cap: poolSize 2 caps concurrent workers even when maxConcurrent is higher; the 3rd task waits then reuses", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "w" } },
      { awaitSend: true },
      { turn: { text: "w2" } },
    ];
    const rig = makeCoordination([WORKER, WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(5, 2));   // maxConcurrent 5, poolSize 2 — pool size governs, not maxConcurrent
    rig.queues.push("work", { prompt: "task1" });
    rig.queues.push("work", { prompt: "task2" });
    rig.queues.push("work", { prompt: "task3" });
    await rig.scheduler.tick();

    expect(rig.fake.spawns.length).toBe(2);                       // pool cap 2, NOT 3 (tasks) or 5 (maxConcurrent)
    expect(rig.queues.status("work").counts.pending).toBe(1);     // task3 waits for a free worker

    await waitUntil(() => rig.queues.status("work").counts.done === 3);
    expect(rig.fake.spawns.length).toBe(2);                       // still only 2 workers ever spawned
  });

  it("idleWorker skips a still-busy pool worker and reuses a different idle one", async () => {
    const BUSY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]; // never turn_completes on its own
    const QUICK: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "t2" } }];
    const rig = makeCoordination([BUSY, QUICK]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(2, 2));
    rig.queues.push("work", { prompt: "task1" });   // → worker1 (spawned first, stays busy forever)
    rig.queues.push("work", { prompt: "task2" });   // → worker2 (spawned second, completes immediately)
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(rig.fake.spawns.length).toBe(2);

    const task2 = rig.queues.status("work").tasks.find((t) => t.prompt === "task2")!;

    const t3 = rig.queues.push("work", { prompt: "task3" });
    await rig.scheduler.tick();

    expect(rig.fake.spawns.length).toBe(2);         // no 3rd spawn — worker2 was idle and reused
    const task3 = rig.queues.status("work").tasks.find((t) => t.taskId === t3.taskId)!;
    expect(task3.state).toBe("in_progress");
    expect(task3.agentId).toBe(task2.agentId);       // routed to the IDLE worker, not the still-busy one
  });

  it("settle-on-turn_complete: the task is done, and the worker is idle (untracked) but still running", async () => {
    const rig = makeCoordination([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
    ]]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    const t1 = rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const task = rig.queues.status("work").tasks.find((t) => t.taskId === t1.taskId)!;
    expect(task.state).toBe("done");
    expect(task.resultText).toBe("");
    const agentId = task.agentId!;
    expect(rig.sup.status(agentId).state).toBe("running");        // worker still alive
    expect(rig.scheduler.agentsFor("crew")).not.toContain(agentId); // not tracked (idle)
  });

  it("a persistent worker that dies is removed from the pool; its task fails, and a later task spawns a fresh worker", async () => {
    const DIES: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { fail: { message: "boom" } }];
    const REVIVED: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "ok" } }];
    const rig = makeCoordination([DIES, REVIVED]);
    rig.queues.create({ name: "work", retryLimit: 0 });   // retryLimit 0 → death fails the task permanently, immediately
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    const t1 = rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);

    const failedTask = rig.queues.status("work").tasks.find((t) => t.taskId === t1.taskId)!;
    expect(failedTask.state).toBe("failed");
    expect(rig.fake.spawns.length).toBe(1);

    const t2 = rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns.length).toBe(2);   // the dead worker was removed from the pool — a fresh one was spawned
    const done2 = rig.queues.status("work").tasks.find((t) => t.taskId === t2.taskId)!;
    expect(done2.agentId).not.toBe(failedTask.agentId);
  });

  it("a persistent spawn blocked by a guardrail (maxAgentsTotal) leaves the task pending, not failed", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      caps: { maxAgentsTotal: 1, perAccount: {} },
    });
    const BUSY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];
    const rig = makeCoordination([BUSY], cfg);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(5, 2));   // pool cap (2) allows a 2nd spawn attempt; the account-total guardrail (1) blocks it
    rig.queues.push("work", { prompt: "task1" });
    const t2 = rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();

    expect(rig.fake.spawns.length).toBe(1);                       // guardrail blocked the 2nd spawn attempt
    const task2 = rig.queues.status("work").tasks.find((t) => t.taskId === t2.taskId)!;
    expect(task2.state).toBe("pending");                          // NOT failed — guardrail is retryable
  });

  it("a persistent role naming an unknown account fails the task permanently (non-guardrail spawn error)", async () => {
    const rig = makeCoordination([]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "ghost", isolation: "none", persistent: true, poolSize: 1 } } },
      maxConcurrent: 1, queue: "work",
    });
    const t = rig.queues.push("work", { prompt: "doomed" });
    await rig.scheduler.tick();
    const failed = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("ghost");
    expect(rig.fake.spawns.length).toBe(0);
  });

  it("ephemeral role is unaffected: spawns one agent per task, settles on agent-done (no pooling)", async () => {
    const rig = makeCoordination([
      [{ end: { resultText: "e1", costUsd: 0 } }],
      [{ end: { resultText: "e2", costUsd: 0 } }],
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.queues.push("work", { prompt: "e1" });
    rig.queues.push("work", { prompt: "e2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2);
    expect(rig.fake.spawns.length).toBe(2);   // one agent PER task — no reuse for ephemeral roles
  });

  it("a team with BOTH a persistent role and an ephemeral role drains both correctly in one tick", async () => {
    const rig = makeCoordination([
      [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "pw" } }],
      [{ end: { resultText: "ew", costUsd: 0 } }],
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } },
        dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.queues.push("work", { prompt: "p1", role: "worker" });
    rig.queues.push("work", { prompt: "d1", role: "dev" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2);
    expect(rig.fake.spawns.length).toBe(2);
  });
});

describe("QueueScheduler — retirement + idle-worker-death (Task A4)", () => {
  it("retire: gracefully closes input and de-registers a dissolved team's persistent workers from the pool (busy worker keeps running — no hard-kill)", async () => {
    const BUSY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]; // never turn_completes on its own
    const rig = makeCoordination([BUSY]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);

    const agentId = rig.queues.status("work").tasks[0]!.agentId!;
    const closeSpy = vi.spyOn(rig.sup, "closeInput");

    rig.teams.dissolve("crew");
    rig.scheduler.retire("crew");

    expect(closeSpy).toHaveBeenCalledWith(agentId);
    // graceful: closeInput on FakeAgentBackend is a no-op (no close()) — the busy
    // worker is NOT hard-killed, it just keeps running, de-registered from the pool.
    expect(rig.sup.status(agentId).state).toBe("running");

    // pool was emptied (not merely marked) — recreating the same-named team and
    // pushing a task spawns a FRESH worker; the retired one is never reused.
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    const t2 = rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns.length).toBe(2);
    const task2 = rig.queues.status("work").tasks.find((t) => t.taskId === t2.taskId)!;
    expect(task2.agentId).not.toBe(agentId);
  });

  it("retire: is a safe no-op for an unknown/never-pooled team", () => {
    const rig = makeCoordination([]);
    expect(() => rig.scheduler.retire("ghost-team")).not.toThrow();
  });

  it("retire: is a safe no-op for a team with no persistent role ever spawned (pool has no entry for it)", async () => {
    const rig = makeCoordination([[{ end: { resultText: "e1", costUsd: 0 } }]]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },   // ephemeral only — never touches `pool`
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "e1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(() => rig.scheduler.retire("crew")).not.toThrow();
  });

  it("engine wiring: team.dissolve retires the team's persistent workers (scheduler.retire runs AFTER teams.dissolve)", async () => {
    const BUSY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];
    const fake = new FakeAgentBackend([BUSY]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: PERSISTENT_TEAM(1, 1) });
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);

    const agentId = e.queues.status("work").tasks[0]!.agentId!;
    const closeSpy = vi.spyOn(e.supervisor, "closeInput");

    expect(await e.handle("team.dissolve", { name: "crew" })).toEqual({ ok: true });

    expect(closeSpy).toHaveBeenCalledWith(agentId);          // scheduler.retire ran and closed the worker's input
    expect(e.supervisor.status(agentId).state).toBe("running");   // graceful — not hard-killed

    await e.handle("team.create", { spec: PERSISTENT_TEAM(1, 1) });   // fresh pool under the recreated team
    await e.handle("queue.push", { queue: "work", prompt: "task2" });
    await waitUntil(() => fake.spawns.length === 2);
    expect(fake.spawns.length).toBe(2);   // no reuse of the retired worker
  });

  it("idle-worker-death: a persistent worker that dies WHILE IDLE (unbound after turn_complete) is removed from the pool; a later task spawns a fresh worker", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    const t1 = rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const agentId = rig.queues.status("work").tasks.find((t) => t.taskId === t1.taskId)!.agentId!;
    expect(rig.sup.status(agentId).state).toBe("running");            // idle but alive
    expect(rig.scheduler.agentsFor("crew")).not.toContain(agentId);   // untracked (idle)

    // The worker dies WHILE IDLE (unbound, no in-flight task) — simulated via
    // kill(), a real terminal-state transition + event that is scheduled
    // separately from task1's turn_complete. (A scripted `fail` step placed
    // immediately after `turn` in the SAME fake scenario fires synchronously,
    // in the very same macrotask burst as turn_complete — every deferred
    // scheduler handler in that burst would then observe the already-terminal
    // state, never a genuinely-idle-then-dies transition. kill() gives a
    // separately scheduled, real terminal event on an already-idle worker.)
    await rig.sup.kill(agentId);

    const t2 = rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();                        // may still see the pool as "full" — cleanup is async
    await waitUntil(() => rig.queues.status("work").counts.done === 2);

    expect(rig.fake.spawns.length).toBe(2);             // dead idle worker's slot was freed — a FRESH worker spawned
    const task2 = rig.queues.status("work").tasks.find((t) => t.taskId === t2.taskId)!;
    expect(task2.agentId).not.toBe(agentId);
  });

  it("idle-worker-death: a non-terminal event on an already-idle pool worker is a no-op — the worker stays in the pool and is reused", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
      { emit: { kind: "status", data: { note: "still-alive" } } },   // benign event AFTER going idle — worker keeps running
      { awaitSend: true },
      { turn: { text: "t2" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    const t1 = rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const agentId = rig.queues.status("work").tasks.find((t) => t.taskId === t1.taskId)!.agentId!;
    await waitUntil(() => rig.sup.status(agentId).state === "running");   // still alive after the benign status event

    const t2 = rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 2);

    expect(rig.fake.spawns.length).toBe(1);             // NO respawn — the still-running idle worker was reused
    const task2 = rig.queues.status("work").tasks.find((t) => t.taskId === t2.taskId)!;
    expect(task2.agentId).toBe(agentId);
  });
});
