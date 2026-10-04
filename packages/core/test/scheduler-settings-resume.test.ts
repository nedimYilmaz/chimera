import { describe, expect, it } from "vitest";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { makeSupervisor } from "./helpers.js";
import type { AgentSupervisor } from "@chimera/core/supervisor";

const changes: Array<[string, (sup: AgentSupervisor, id: string) => Promise<unknown>]> = [
  ["reconfigure", (sup, id) => sup.reconfigure(id, { loadSettings: false, compactionThreshold: 500000 })],
  ["model", (sup, id) => sup.setModel(id, "new-model")],
  ["effort", (sup, id) => sup.setEffort(id, "high")],
  ["turn limit", (sup, id) => sup.setTurnLimit(id, { maxTurns: 200 })],
  ["account", (sup, id) => sup.setAccount(id, "second")],
];

describe("settings changes keep ephemeral queue workers moving", () => {
  it.each(changes)("%s resumes the task with its existing session", async (_name, change) => {
    const rig = makeCoordination([
      [{ emit: { kind: "agent_started", data: { sessionId: "task-session" } } }, { awaitSend: true }],
      [{ awaitSend: true }, { end: { resultText: "task complete" } }],
    ]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", queue: "work", maxConcurrent: 1,
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } } });
    const task = rig.queues.push("work", { prompt: "finish the assigned work" });
    try {
      await rig.scheduler.tick();
      const id = rig.queues.getTask(task.taskId).agentId!;
      await waitUntil(() => rig.sup.status(id).sessionId === "task-session");
      await change(rig.sup, id);
      expect(rig.fake.spawns[1]).toMatchObject({ resume: "task-session", resumeOnly: false, session: false });
      expect(rig.fake.spawns[1]!.prompt).toContain("finish the assigned work");
      await rig.scheduler.tick();
      expect(rig.queues.getTask(task.taskId).state).toBe("in_progress");
      // FakeBackend doesn't seed spec.prompt itself; deliver the seed the real backend sends.
      await rig.sup.send(id, rig.fake.spawns[1]!.prompt!);
      await waitUntil(() => rig.queues.getTask(task.taskId).state === "done");
      expect(rig.fake.spawns).toHaveLength(2);
    } finally { rig.scheduler.detach(); }
  });

  it("keeps persistent team sessions idle on a settings change", async () => {
    const { sup, fake } = makeSupervisor([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const r = await sup.spawn({ prompt: "session", cwd: "/tmp", isolation: "none", session: true },
      { membership: { team: "crew", role: "dev" } });
    try {
      await sup.reconfigure(r.agentId, { loadSettings: false });
      expect(fake.spawns[1]!.resumeOnly).toBe(true);
    } finally { await sup.kill(r.agentId); }
  });

  it("recovers a legacy idle ephemeral worker without repeating the empty resume", async () => {
    const { sup, fake } = makeSupervisor([
      [{ awaitSend: true }], [{ awaitSend: true }],
    ], undefined, { crashLoopPolicy: { maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 10 } });
    const r = await sup.spawn({ prompt: "unfinished task", cwd: "/tmp", isolation: "none",
      resume: "existing-session", resumeOnly: true }, { membership: { team: "crew", role: "dev" } });
    try {
      sup.reportUnresponsive(r.agentId, 900001, 900000);
      await waitUntil(() => fake.spawns.length === 2);
      expect(fake.spawns[1]).toMatchObject({ resume: "existing-session", resumeOnly: false, prompt: "unfinished task" });
    } finally { await sup.kill(r.agentId); }
  });
});
