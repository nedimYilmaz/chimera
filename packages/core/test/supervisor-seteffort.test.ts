import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// R2 EFFORT: agent.setEffort — mirrors supervisor-setmodel.test.ts (Task MDL-a) exactly.
// Respawn-with-resume under the SAME agentId: kill the running query, then respawn
// { ...spec, effort, resume: sessionId, resumeOnly: true } under the SAME agentId.

const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor.setEffort", () => {
  it("respawns under the SAME agentId with the new effort, resuming the old sessionId (resumeOnly)", async () => {
    const { sup, fake } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", effort: "low" });
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle
    expect(rec.sessionId).toBe("sess-1");

    const updated = await sup.setEffort(rec.agentId, "xhigh");

    expect(updated.agentId).toBe(rec.agentId);          // SAME agentId (CR1 continuity)
    expect(updated.spec.effort).toBe("xhigh");
    expect(updated.state).toBe("running");

    expect(fake.spawns).toHaveLength(2);                 // original spawn + respawn
    const respawned = fake.spawns[1];
    expect(respawned?.effort).toBe("xhigh");
    expect(respawned?.resume).toBe("sess-1");
    expect(respawned?.resumeOnly).toBe(true);
  });

  it("kills the old query before respawning (killed status event precedes the respawn's agent_started)", async () => {
    const { sup, events } = makeSupervisor([RUNNING_WITH_SESSION, RUNNING_WITH_SESSION]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    await sup.setEffort(rec.agentId, "high");
    await new Promise((r) => setTimeout(r, 20));   // let the respawn's fire-and-forget agent_started settle

    const tail = events.tail(rec.agentId, 50);
    const killedIdx = tail.findIndex((e) => e.kind === "status" && e.data["state"] === "killed");
    const startedIdx = tail.findIndex((e, i) => e.kind === "agent_started" && i > killedIdx);
    expect(killedIdx).toBeGreaterThanOrEqual(0);
    expect(startedIdx).toBeGreaterThan(killedIdx);        // respawn's agent_started comes AFTER the kill
  });

  it("respawns with resume:null (still resumeOnly/idle) when the prior agent never reported a sessionId", async () => {
    const { sup, fake } = makeSupervisor([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect(rec.sessionId).toBeUndefined();

    await sup.setEffort(rec.agentId, "high");

    const respawned = fake.spawns[1];
    expect(respawned?.resume).toBeNull();
    expect(respawned?.resumeOnly).toBe(true);
  });

  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.setEffort("ghost-id", "high")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("preserves treeId, depth, and conductor across the respawn", async () => {
    const { sup, fake } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true },
      { agentId: "cond-1", treeId: "tree-x", depth: 2 },
    );
    expect(rec.treeId).toBe("tree-x");
    expect(rec.depth).toBe(2);
    expect(rec.spec.conductor).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await sup.setEffort("cond-1", "high");

    expect(updated.agentId).toBe("cond-1");
    expect(updated.treeId).toBe("tree-x");
    expect(updated.depth).toBe(2);
    expect(updated.spec.conductor).toBe(true);
  });
});
