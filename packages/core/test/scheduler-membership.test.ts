import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// Persistent single-role team, mirroring scheduler-persistent.test.ts's PERSISTENT_TEAM.
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

describe("QueueScheduler — membership injection (Task B1)", () => {
  it("env injection: a persistent worker's resolved env carries CHIMERA_TEAM/CHIMERA_ROLE alongside CHIMERA_AGENT_ID", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns[0]!.env["CHIMERA_TEAM"]).toBe("crew");
    expect(rig.fake.spawns[0]!.env["CHIMERA_ROLE"]).toBe("worker");
    expect(rig.fake.spawns[0]!.env["CHIMERA_AGENT_ID"]).toBeTruthy();
  });

  it("keeps tasks verbatim and membership separate without snapshotting teammates", async () => {
    const WORKER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];
    const rig = makeCoordination([WORKER, WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(2, 2));
    rig.queues.push("work", { prompt: "task1" });
    rig.queues.push("work", { prompt: "task2" });
    await rig.scheduler.tick();

    expect(rig.fake.spawns.length).toBe(2);
    expect(rig.fake.spawns[0]!.instructions).toContain("crew");
    expect(rig.fake.spawns[0]!.instructions).toContain("worker");
    expect(rig.fake.spawns[0]!.prompt).toBe("task1");
    expect(rig.fake.spawns[1]!.prompt).toBe("task2");
    expect(rig.fake.spawns[1]!.instructions).not.toContain(rig.fake.spawns[0]!.agentId.slice(0, 8));
    expect(rig.fake.spawns[1]!.instructions).toBe(rig.fake.spawns[0]!.instructions);
  });

  it("keeps team purpose in session instructions, not in task bodies", async () => {
    const WORKER: FakeStep[] = [{ end: { resultText: "ok", costUsd: 0 } }];
    const rig = makeCoordination([WORKER, WORKER]);
    rig.queues.create({ name: "workA" });
    rig.queues.create({ name: "workB" });
    rig.teams.create({
      name: "crew-a", purpose: "ship the payments migration",
      roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 1, queue: "workA",
    });
    rig.teams.create({
      name: "crew-a2", purpose: "audit the auth service",   // different team, different purpose — SAME role name
      roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 1, queue: "workB",
    });
    rig.queues.push("workA", { prompt: "task1" });
    rig.queues.push("workB", { prompt: "task2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("workA").counts.done === 1 && rig.queues.status("workB").counts.done === 1);

    expect(rig.fake.spawns[0]!.prompt).toBe("task1");
    expect(rig.fake.spawns[1]!.prompt).toBe("task2");
    expect(rig.fake.spawns[0]!.instructions).toContain("ship the payments migration");
    expect(rig.fake.spawns[1]!.instructions).toContain("audit the auth service");
  });

  it("original instructions are preserved: the roster block is prepended, not replacing custom instructions", async () => {
    const WORKER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "t1" } }];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        worker: { role: "blank", overrides: {
          cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1,
          instructions: "Custom original instructions here.",
        } },
      },
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "task1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const instructions = rig.fake.spawns[0]!.instructions!;
    expect(instructions).toContain("Custom original instructions here.");
    expect(instructions).toContain("crew");
    // roster block comes first, original instructions follow
    expect(instructions.indexOf("crew")).toBeLessThan(instructions.indexOf("Custom original instructions here."));
  });

  it("a per-task instructions OVERRIDE is preserved after the roster (not silently dropped)", async () => {
    const WORKER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "t1" } }];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(PERSISTENT_TEAM(1, 1));
    rig.queues.push("work", { prompt: "task1", overrides: { instructions: "per-task override instructions" } });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const instructions = rig.fake.spawns[0]!.instructions!;
    expect(instructions).toContain("per-task override instructions");   // override kept, not dropped
    expect(instructions).toContain("crew");                             // roster header still prepended
    expect(instructions.indexOf("crew")).toBeLessThan(instructions.indexOf("per-task override instructions"));
  });

  it("ephemeral path: a spawned ephemeral-role agent also gets CHIMERA_TEAM/CHIMERA_ROLE env + a roster in instructions", async () => {
    const rig = makeCoordination([
      [{ end: { resultText: "e1", costUsd: 0 } }],
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } },
      maxConcurrent: 2, queue: "work",
    });
    rig.queues.push("work", { prompt: "e1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns[0]!.env["CHIMERA_TEAM"]).toBe("crew");
    expect(rig.fake.spawns[0]!.env["CHIMERA_ROLE"]).toBe("dev");
    expect(rig.fake.spawns[0]!.instructions).toContain("crew");
    expect(rig.fake.spawns[0]!.instructions).toContain("dev");
  });

  it("mixed teams retain membership without prefixing tasks with a roster", async () => {
    const rig = makeCoordination([
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }],          // persistent worker: stays busy
      [{ end: { resultText: "ew", costUsd: 0 } }],                                    // ephemeral dev
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
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns.length).toBe(2);
    expect(rig.fake.spawns[0]!.prompt).toBe("p1");
    expect(rig.fake.spawns[1]!.prompt).toBe("d1");
    expect(rig.fake.spawns[1]!.env["CHIMERA_TEAM"]).toBe("crew");
    expect(rig.fake.spawns[1]!.env["CHIMERA_ROLE"]).toBe("dev");
  });

  it("non-team spawn unchanged: a direct supervisor.spawn(spec) with no membership opt has NO CHIMERA_TEAM/CHIMERA_ROLE in resolved env", async () => {
    const rig = makeCoordination([[{ end: { resultText: "solo", costUsd: 0 } }]]);
    await rig.sup.spawn({ prompt: "solo", cwd: "/tmp", account: "main", isolation: "none" });

    expect(rig.fake.spawns[0]!.env["CHIMERA_AGENT_ID"]).toBeTruthy();
    expect(rig.fake.spawns[0]!.env["CHIMERA_TEAM"]).toBeUndefined();
    expect(rig.fake.spawns[0]!.env["CHIMERA_ROLE"]).toBeUndefined();
    expect("CHIMERA_TEAM" in rig.fake.spawns[0]!.env).toBe(false);
    expect("CHIMERA_ROLE" in rig.fake.spawns[0]!.env).toBe(false);
  });
});
