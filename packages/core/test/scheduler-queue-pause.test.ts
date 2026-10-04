import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held-done", costUsd: 0.01 } }];
const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.01 } }];
const DEV_TEAM = (maxConcurrent: number) => ({
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent, queue: "work",
});

// QUEUE-PAUSE: the scheduler-side half of durable per-queue pause — a paused queue's
// nextPending() is never reached, so no NEW agent spawns/drains from it. Already-running/
// tracked agents are entirely untouched (they finish naturally); pending tasks stay pending.
// queues-pause.test.ts covers QueueStore.pause()/resume()'s own persistence + event half.
describe("QueueScheduler drain — QUEUE-PAUSE", () => {
  it("a paused queue drains no new tasks; a running agent finishes its task normally", async () => {
    const rig = makeCoordination([HOLD, HAPPY("never")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();
    expect(rig.queues.status("work").counts.in_progress).toBe(1);   // t1 already picked up

    rig.queues.pause("work");
    const [agentId] = rig.scheduler.agentsFor("crew");
    await rig.sup.send(agentId!, "go");                              // let the ALREADY-RUNNING agent finish naturally
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    await rig.scheduler.tick();                                      // a further tick must NOT pick up t2 while paused
    expect(rig.queues.status("work").counts).toEqual({ pending: 1, in_progress: 0, done: 1, failed: 0, blocked: 0, dead_letter: 0 });
    expect(rig.fake.spawns).toHaveLength(1);                         // only t1 was ever spawned
  });

  it("pausing an idle queue (nothing running yet) spawns nothing on tick; tasks stay pending", async () => {
    const rig = makeCoordination([HAPPY("a"), HAPPY("b")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(2));
    rig.queues.pause("work");
    rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();

    expect(rig.queues.status("work").counts).toEqual({ pending: 2, in_progress: 0, done: 0, failed: 0, blocked: 0, dead_letter: 0 });
    expect(rig.fake.spawns).toHaveLength(0);
  });

  it("resuming a paused queue re-drains pending work immediately", async () => {
    const rig = makeCoordination([HAPPY("a"), HAPPY("b")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(2));
    rig.queues.pause("work");
    rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(0);                         // still paused: nothing spawned

    rig.queues.resume("work");
    await rig.scheduler.tick();                                      // mirrors engine.ts's queue.resume handler ticking immediately
    await waitUntil(() => rig.queues.status("work").counts.done === 2);
    expect(rig.fake.spawns).toHaveLength(2);
  });

  it("pausing one queue does not affect a sibling team's unpaused queue", async () => {
    const rig = makeCoordination([HAPPY("a"), HAPPY("b")]);
    rig.queues.create({ name: "work" });
    rig.queues.create({ name: "other" });
    rig.teams.create(DEV_TEAM(1));
    rig.teams.create({ name: "crew2", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "other" });
    rig.queues.pause("work");
    rig.queues.push("work", { prompt: "paused-task" });
    rig.queues.push("other", { prompt: "unpaused-task" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("other").counts.done === 1);

    expect(rig.queues.status("work").counts.pending).toBe(1);
    expect(rig.queues.status("other").counts.done).toBe(1);
  });
});
