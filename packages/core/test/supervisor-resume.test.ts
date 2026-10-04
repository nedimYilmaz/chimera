import { describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { ResumeRefusedError, UnknownAgentError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// AGENT-RESUME-TOOLS: agent.resume recovers a TERMINAL agent in its existing worktree + SDK
// session with a fresh continuation brief. Unlike setModel/setEffort (which respawn a LIVE
// agent under the SAME agentId), this is a FRESH spawn re-entering the dead agent's worktree
// dir with isolation:"none" (worktree already exists) and resume=its sessionId.

// A scenario that reports a sessionId then parks — the fake never calls ensureWorkdir, so an
// isolation:"worktree" spawn touches no git; we materialize the worktree dir by hand below.
const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor.resume", () => {
  it("refuses a still-running agent (interrupt/kill it first)", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await expect(sup.resume(rec.agentId, { prompt: "keep going" })).rejects.toBeInstanceOf(ResumeRefusedError);
  });

  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.resume("ghost", { prompt: "go" })).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("refuses a terminal worktree agent whose worktree dir is gone (spawn fresh instead)", async () => {
    const { sup, dir } = makeSupervisor([RUNNING_WITH_SESSION]);
    // cwd=dir but we never create dir/.chimera/worktrees/dead-1, so the worktree is "gone".
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "dead-1" });
    await sup.kill("dead-1");
    await expect(sup.resume("dead-1", { prompt: "keep going" })).rejects.toBeInstanceOf(ResumeRefusedError);
  });

  it("builds the right spec for a terminal worktree agent: existing worktree dir, isolation none, resumed session, inherited profile/model", async () => {
    const { sup, fake, dir } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn(
      { prompt: "original brief", cwd: dir, isolation: "worktree", model: "claude-opus-4-8", permissionProfile: "full" },
      { agentId: "dead-1", treeId: "tree-x", depth: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle
    expect(rec.sessionId).toBe("sess-1");
    await sup.kill("dead-1");
    // Materialize the worktree the dead agent "left behind" so the existence check passes.
    const worktree = join(dir, ".chimera", "worktrees", "dead-1");
    mkdirSync(worktree, { recursive: true });

    const resumed = await sup.resume("dead-1", { prompt: "continue the work" });

    // Fresh agent (new id), but tree/depth lineage preserved.
    expect(resumed.agentId).not.toBe("dead-1");
    expect(resumed.treeId).toBe("tree-x");
    expect(resumed.depth).toBe(1);

    const spawned = fake.spawns[1]!;
    expect(spawned.prompt).toBe("continue the work");     // the continuation brief, not the original
    expect(spawned.cwd).toBe(worktree);                   // re-enters the existing worktree dir
    expect(spawned.isolation).toBe("none");               // worktree already exists — don't re-add
    expect(spawned.resume).toBe("sess-1");                // resumes the captured session
    expect(spawned.resumeOnly).toBe(false);               // DO push the continuation prompt
    expect(spawned.turnLimitPolicy).toBe("soft");         // default: don't re-fail at the old cap
    expect(spawned.model).toBe("claude-opus-4-8");        // inherited
    expect(spawned.permissionProfile).toBe("full");       // inherited
  });

  it("applies maxTurns/turnLimitPolicy/deliverTo overrides when given", async () => {
    const { sup, fake, dir } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    await sup.spawn(
      { prompt: "x", cwd: dir, isolation: "worktree" },
      { agentId: "dead-2" },
    );
    await new Promise((r) => setTimeout(r, 20));
    await sup.kill("dead-2");
    mkdirSync(join(dir, ".chimera", "worktrees", "dead-2"), { recursive: true });

    await sup.resume("dead-2", { prompt: "go", maxTurns: 200, turnLimitPolicy: "fail", deliverTo: "conductor" });

    const spawned = fake.spawns[1]!;
    expect(spawned.maxTurns).toBe(200);
    expect(spawned.turnLimitPolicy).toBe("fail");
    expect(spawned.deliverTo).toBe("conductor");
  });

  it("resumes an isolation:none terminal agent from its own cwd (no worktree indirection)", async () => {
    const { sup, fake, dir } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none" }, { agentId: "dead-3" });
    await new Promise((r) => setTimeout(r, 20));
    await sup.kill("dead-3");

    await sup.resume("dead-3", { prompt: "go" });

    const spawned = fake.spawns[1]!;
    expect(spawned.cwd).toBe(dir);                // its own cwd, no .chimera/worktrees indirection
    expect(spawned.isolation).toBe("none");
    expect(spawned.resume).toBe("sess-1");
  });
});
