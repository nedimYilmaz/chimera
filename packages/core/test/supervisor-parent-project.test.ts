import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import type { ProjectSpec } from "@chimera/protocol";
import { CFG, fakeExec, makeEngineHome } from "./helpers.js";

// PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: real spawn-lineage (parentId) + projectId on
// AgentRecord — the data foundation for the spawn-lineage UI (P3-T2/P3-T3) and F22's
// exact parent edge. parentId is an EXACT caller-supplied spawner id (never a depth
// heuristic); projectId is either explicit or derived from the spec's cwd via the
// injectable `projectFor` seam (mirrors gitBranch/toolPolicy).

const tick = () => new Promise((r) => setTimeout(r, 20));

function makeSup(projectFor?: (cwd: string) => string | null, scenarios: FakeStep[][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-parentproj-"));
  return new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend(scenarios) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(projectFor ? { projectFor } : {}),
  });
}

const spec = (cwd = "/tmp/proj") => ({ prompt: "job", cwd, isolation: "none" as const });

describe("AgentSupervisor.spawn: parentId (P3-T1)", () => {
  it("stamps conductor ownership without changing real spawn ancestry", async () => {
    const sup = makeSup();
    const rec = await sup.spawn(spec(), { parentId: null, originConductorId: "conductor-1" });
    expect(rec.parentId).toBeNull();
    expect(rec.originConductorId).toBe("conductor-1");
    expect(rec.depth).toBe(0);
    expect(rec.treeId).toBe(rec.agentId);
  });
  it("stamps the exact caller-supplied parentId onto the record", async () => {
    const sup = makeSup();
    const rec = await sup.spawn(spec(), { parentId: "spawner-1" });
    expect(rec.parentId).toBe("spawner-1");
    expect(sup.status(rec.agentId).parentId).toBe("spawner-1");
  });

  it("defaults to null when no parentId is supplied (scheduler/UI/reattach-originated spawns)", async () => {
    const sup = makeSup();
    const rec = await sup.spawn(spec());
    expect(rec.parentId).toBeNull();
  });

  it("explicit null is also honored (never confused with 'derive')", async () => {
    const sup = makeSup();
    const rec = await sup.spawn(spec(), { parentId: null });
    expect(rec.parentId).toBeNull();
  });
});

describe("AgentSupervisor.spawn: projectId (P3-T1)", () => {
  it("derives projectId from cwd via the injectable projectFor seam", async () => {
    const sup = makeSup((cwd) => (cwd === "/tmp/proj-a" ? "alpha" : null));
    const rec = await sup.spawn(spec("/tmp/proj-a"));
    expect(rec.projectId).toBe("alpha");
  });

  it("a cwd matching no project derives null", async () => {
    const sup = makeSup((cwd) => (cwd === "/tmp/proj-a" ? "alpha" : null));
    const rec = await sup.spawn(spec("/tmp/elsewhere"));
    expect(rec.projectId).toBeNull();
  });

  it("an explicit opts.projectId overrides derivation entirely", async () => {
    const sup = makeSup((cwd) => (cwd === "/tmp/proj-a" ? "alpha" : null));
    const rec = await sup.spawn(spec("/tmp/proj-a"), { projectId: "beta" });
    expect(rec.projectId).toBe("beta");
  });

  it("explicit opts.projectId: null forces no project even when projectFor would match", async () => {
    const sup = makeSup((cwd) => (cwd === "/tmp/proj-a" ? "alpha" : null));
    const rec = await sup.spawn(spec("/tmp/proj-a"), { projectId: null });
    expect(rec.projectId).toBeNull();
  });

  it("no projectFor seam configured ⇒ every spawn's projectId is null unless explicit", async () => {
    const sup = makeSup();
    const rec = await sup.spawn(spec("/tmp/proj-a"));
    expect(rec.projectId).toBeNull();
  });
});

describe("AgentSupervisor: shadow rows inherit parentId/projectId (Task N-SHADOW x P3-T1)", () => {
  it("a shadow's parentId is the REAL parent agent (not the parent's own parentId), and projectId is inherited", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", subagentType: "reviewer" } },
      { awaitSend: true },
      { end: { resultText: "ok" } },
    ];
    const sup = makeSup((cwd) => (cwd === "/tmp/proj" ? "chimera" : null), [scenario]);
    const parent = await sup.spawn(spec(), { parentId: "grandparent-1" });
    await tick();

    const shadow = sup.list().find((a) => a.shadow);
    expect(shadow!.parentId).toBe(parent.agentId);        // the real parent, not "grandparent-1"
    expect(shadow!.projectId).toBe("chimera");             // inherited from parent
  });
});

describe("Engine agent.spawn / agent.list: real parent edge + projectId (P3-T1 acceptance)", () => {
  function engineOn(home: string): Engine {
    return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
  }

  it("a child spawned from a known parent shows that EXACT parentId on agent.list — not a depth/createdAt guess", async () => {
    const e = engineOn(makeEngineHome());
    const parent = (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    const child = (await e.handle("agent.spawn", {
      spec: { prompt: "c", cwd: "/tmp", isolation: "none" }, parentId: parent.agentId,
    })) as { agentId: string; parentId: string | null };
    expect(child.parentId).toBe(parent.agentId);

    const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; parentId: string | null }>;
    expect(list.find((a) => a.agentId === child.agentId)?.parentId).toBe(parent.agentId);
    expect(list.find((a) => a.agentId === parent.agentId)?.parentId).toBeNull();   // no spawner of its own
  });

  it("a spawn with no parentId param renders parentId: null (not undefined/absent) on agent.list", async () => {
    const e = engineOn(makeEngineHome());
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; parentId: string | null }>;
    expect(list.find((a) => a.agentId === rec.agentId)?.parentId).toBeNull();
  });

  it("projectId is set for a conductor-rooted tree (cwd under the project's path), auto-derived with no explicit param", async () => {
    const e = engineOn(makeEngineHome());
    const path = mkdtempSync(join(tmpdir(), "chimera-projpath-"));
    await e.handle("project.create", { name: "widgets", path });
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "p", cwd: path, isolation: "none" },
    })) as { agentId: string; projectId: string | null };
    expect(rec.projectId).toBe("widgets");

    const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; projectId: string | null }>;
    expect(list.find((a) => a.agentId === rec.agentId)?.projectId).toBe("widgets");
  });

  it("a cwd NOT under any registered project derives projectId: null", async () => {
    const e = engineOn(makeEngineHome());
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp/not-a-project-dir", isolation: "none" },
    })) as { projectId: string | null };
    expect(rec.projectId).toBeNull();
  });

  it("an explicit projectId param overrides cwd-based derivation", async () => {
    const e = engineOn(makeEngineHome());
    const path = mkdtempSync(join(tmpdir(), "chimera-projpath2-"));
    await e.handle("project.create", { name: "widgets", path }) as ProjectSpec;
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "p", cwd: path, isolation: "none" }, projectId: "override-project",
    })) as { projectId: string | null };
    expect(rec.projectId).toBe("override-project");
  });
});
