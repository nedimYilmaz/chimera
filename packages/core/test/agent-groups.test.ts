import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor, MAX_TERMINAL_AGENTS_PERSISTED, type AgentRecord } from "@chimera/core/supervisor";
import { AgentArchiveStore } from "@chimera/core/agent-archive";
import type { AgentBackend } from "@chimera/core/backend";
import { CFG, fakeExec, makeSupervisor } from "./helpers.js";

// AGENT-GROUPS Phase 1: mirrors supervisor-session-marker.test.ts's renameAgent suite (the
// status-event re-emit contract) and supervisor-agent-archive.test.ts's lightening/reattach
// contracts, applied to setAgentGroups/AgentRecord.groups instead of displayLabel.

describe("agent.setGroups / AgentSupervisor.setAgentGroups", () => {
  it("spawn stamps spec.groups onto the record", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", groups: ["sprint"] });
    expect(sup.status(rec.agentId).groups).toEqual(["sprint"]);
  });

  it("omits groups entirely for a plain spawn with no groups — byte-identical to today", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp" });
    expect(sup.status(rec.agentId).groups).toBeUndefined();
  });

  it("setAgentGroups replaces membership wholesale, dedupes, and re-emits a status event carrying the new value", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp" });
    await sup.setAgentGroups(rec.agentId, ["sprint", "sprint", "daily"]);
    expect(sup.status(rec.agentId).groups).toEqual(["sprint", "daily"]);
    const tail = events.tail(rec.agentId, 20);
    expect(tail.some((e) => e.kind === "status" && JSON.stringify(e.data["groups"]) === JSON.stringify(["sprint", "daily"]))).toBe(true);

    await sup.setAgentGroups(rec.agentId, []);
    expect(sup.status(rec.agentId).groups).toEqual([]);
  });

  it("throws UnknownAgentError for a ghost agentId", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    await expect(sup.setAgentGroups("nope-never-spawned", ["sprint"])).rejects.toThrow();
  });
});

function makeSup(dir: string) {
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    agentArchive: new AgentArchiveStore(dir),
  });
  return sup;
}

function terminalRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a", spec: { prompt: "the real brief", cwd: "/tmp", isolation: "none", account: "auto", permissionProfile: "acceptEdits", autonomy: "ask", groups: [] } as unknown as AgentRecord["spec"],
    accountName: "main", provider: "claude", state: "done", depth: 0, treeId: "a", createdAt: Date.now(),
    principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    resultText: "the real result text",
    ...over,
  };
}

describe("AgentRecord.groups survives lightening and reattach", () => {
  it("a lightened terminal record retains its groups (not among the fields lightenAgentRecord strips)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-groups-archive-"));
    const sup = makeSup(dir);
    const now = Date.now();
    const n = MAX_TERMINAL_AGENTS_PERSISTED + 1;
    for (let i = 0; i < n; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i, groups: ["sprint"] }));
    }
    sup.snapshotAgents();
    const lightened = sup.list().find((a) => a.agentId === "d0");
    expect(lightened?.archived).toBe(true);
    expect(lightened?.groups).toEqual(["sprint"]);
  });

  it.each([{ groups: ["daily"] }, { groups: [] }])("groups $groups survive a reattach restart round-trip", ({ groups }) => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-groups-reattach-"));
    const sup = makeSup(dir);
    sup.reattachTerminal(terminalRecord({ agentId: "r1", treeId: "r1", groups }));
    expect(sup.status("r1").groups).toEqual(groups);
  });
});
