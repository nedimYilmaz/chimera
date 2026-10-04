import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// F15 QA regression: a persistent role with an IDLE pool worker dispatches through
// assignPersistent's supervisor.send() reuse branch — no supervisor.spawn happens on that path.
// explainTask used to replay the two liveSite:"spawn" predicates anyway and answer
// blockedBy:"supervisorAdmission" for a task the very next tick dispatched fine.
// The global cap is set to 1 so the (irrelevant) spawn admission is guaranteed to be denied.
const CAPPED_CFG = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  caps: { maxAgentsTotal: 1, perAccount: {} },
});

const PERSISTENT_TEAM = {
  name: "crew",
  roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, persistent: true, poolSize: 1 } } },
  maxConcurrent: 1, queue: "work",
};

// one spawn, one finished task, then idle-but-running, then a second task via send()
const WORKER: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: { text: "w1" } },
  { awaitSend: true },
  { turn: { text: "w2" } },
];

describe("F15 QA: explainTask on the persistent idle-reuse branch", () => {
  it("does not blame the spawn-site predicates when an idle worker will be reused", async () => {
    const r = makeCoordination([WORKER], CAPPED_CFG);
    r.queues.create({ name: "work" });
    r.teams.create(PERSISTENT_TEAM);
    r.queues.push("work", { prompt: "seed" });
    await r.scheduler.tick();
    await waitUntil(() => r.queues.status("work").counts.done === 1);
    expect(r.fake.spawns.length).toBe(1);        // global cap is now saturated

    const t = r.queues.push("work", { prompt: "reuse-me" });
    const res = r.scheduler.explainTask(t.taskId);
    const byName = new Map(res.checks.map((c) => [c.name, c]));

    expect(byName.get("workerCapacity")).toMatchObject({ ok: true, skipped: false });
    // "not applicable on this branch" shape — ok:true so it can never block
    expect(byName.get("specValid")).toMatchObject({ ok: true, skipped: true });
    expect(byName.get("supervisorAdmission")).toMatchObject({ ok: true, skipped: true });
    expect(res.admission).toEqual([]);           // nothing was probed: no spawn happens here
    expect(res.blockedBy).toBeNull();
    expect(res.dispatchable).toBe(true);

    // ...and the prediction is true: the next tick dispatches WITHOUT a second spawn
    await r.scheduler.tick();
    await waitUntil(() => r.queues.status("work").counts.done === 2);
    expect(r.fake.spawns.length).toBe(1);
  });

  it("still evaluates the spawn-site predicates for a persistent role with NO idle worker", async () => {
    const r = makeCoordination([[{ emit: { kind: "agent_started", data: {} } }, { turn: { text: "x" } }, { awaitSend: true }]], CAPPED_CFG);
    r.queues.create({ name: "work" });
    r.teams.create(PERSISTENT_TEAM);
    // an unrelated agent saturates maxAgentsTotal; the crew pool stays empty, so dispatch WOULD spawn
    const rec = await r.sup.spawn({ prompt: "hog", cwd: "/tmp", account: "main", isolation: "none", persistent: true });
    await waitUntil(() => r.sup.status(rec.agentId).state === "running");

    const t = r.queues.push("work", { prompt: "needs-a-spawn" });
    const res = r.scheduler.explainTask(t.taskId);
    expect(res.blockedBy).toBe("supervisorAdmission");
    expect(res.admission.find((c) => c.name === "globalCap")).toMatchObject({ ok: false });
    expect(res.dispatchable).toBe(false);
  });
});
