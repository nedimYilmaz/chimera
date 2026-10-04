import { describe, expect, it } from "vitest";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { makeSupervisor } from "./helpers.js";

describe("queue failure diagnostics", () => {
  it("scrubs credentials before persisting a terminal reason", async () => {
    const { sup } = makeSupervisor([[{ fail: { message: "cannot read receipt using tok-second" } }]]);
    const r = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", account: "second" });
    const final = await sup.waitFor(r.agentId, 2000);
    expect(final.failureMessage).toContain("cannot read receipt");
    expect(final.failureMessage).not.toContain("tok-second");
    expect(JSON.stringify(sup.snapshotAgents())).not.toContain("tok-second");
  });

  it("retains the terminal reason on the task and through agent persistence", async () => {
    const reason = "worker stopped: cannot read the task receipt";
    const rig = makeCoordination([[{ fail: { message: reason } }]]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", queue: "work", maxConcurrent: 1,
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } } });
    const task = rig.queues.push("work", { prompt: "work" });
    try {
      await rig.scheduler.tick();
      await waitUntil(() => rig.queues.getTask(task.taskId).state === "failed");
      expect(rig.queues.getTask(task.taskId).error).toContain(reason);
      const saved = JSON.parse(JSON.stringify(rig.sup.snapshotAgents()))[0];
      const { sup } = makeSupervisor([]);
      sup.reattachTerminal(saved);
      expect(sup.status(saved.agentId).failureMessage).toBe(reason);
    } finally { rig.scheduler.detach(); }
  });
});
