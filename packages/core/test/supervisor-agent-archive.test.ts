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
import { CFG, fakeExec } from "./helpers.js";

// MEMORY-BOUNDED-DISK-COMPLETE: AgentSupervisor's in-memory hot set is bounded to the most
// recent MAX_TERMINAL_AGENTS_PERSISTED terminal records (archiveColdTerminalAgents, triggered
// via snapshotAgents — see supervisor.ts); everything older is durably archived to disk
// (AgentArchiveStore) and "lightened" in memory (heavy fields stripped, AgentRecord.archived ===
// true), then transparently rehydrated on the next status()/result()/resume() call.

function makeSup(dir: string, opts?: { withArchive?: boolean }) {
  const agentArchive = opts?.withArchive === false ? undefined : new AgentArchiveStore(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(agentArchive ? { agentArchive } : {}),
  });
  return { sup, agentArchive };
}

// Builds a terminal AgentRecord directly (bypassing spawn — this suite tests the hot-set/
// archive contract, not spawn mechanics), mirroring reattach.test.ts's priorAgent() shape.
function terminalRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a", spec: { prompt: "the real brief", instructions: "the real instructions", cwd: "/tmp", isolation: "none", account: "auto", permissionProfile: "acceptEdits", autonomy: "ask" } as AgentRecord["spec"],
    accountName: "main", provider: "claude", state: "done", depth: 0, treeId: "a", createdAt: Date.now(),
    principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    resultText: "the real result text", sessionId: "sess-1",
    ...over,
  };
}

describe("AgentSupervisor + AgentArchiveStore (MEMORY-BOUNDED-DISK-COMPLETE)", () => {
  it("bounds the hot set: terminal records beyond MAX_TERMINAL_AGENTS_PERSISTED are lightened (heavy fields dropped from memory) after a snapshot sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const { sup } = makeSup(dir);
    const now = Date.now();
    const n = MAX_TERMINAL_AGENTS_PERSISTED + 5;
    for (let i = 0; i < n; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i, resultText: `result ${i}` }));
    }

    const before = sup.list().filter((a) => a.agentId.startsWith("d"));
    expect(before.every((a) => a.archived === undefined)).toBe(true); // nothing lightened yet — no sweep has run

    sup.snapshotAgents(); // triggers archiveColdTerminalAgents

    const after = sup.list().filter((a) => a.agentId.startsWith("d"));
    expect(after).toHaveLength(n); // disk-complete: still present, none evicted from the roster
    const lightened = after.filter((a) => a.archived === true);
    const hot = after.filter((a) => a.archived !== true);
    expect(lightened).toHaveLength(5); // the 5 oldest, beyond the cap
    expect(hot).toHaveLength(MAX_TERMINAL_AGENTS_PERSISTED);
    for (const a of lightened) {
      expect(a.spec.prompt).toBe(""); // heavy field dropped from the resident copy
      expect(a.resultText).toBeUndefined();
      expect(a.state).toBe("done"); // identity/status fields still accurate
    }
    for (const a of hot) {
      expect(a.spec.prompt).toBe("the real brief"); // still full — within the hot cap
      expect(a.resultText).toMatch(/^result /);
    }
  });

  it("read-through: status() transparently rehydrates a lightened record's full spec/resultText from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const { sup, agentArchive } = makeSup(dir);
    const now = Date.now();
    for (let i = 0; i < MAX_TERMINAL_AGENTS_PERSISTED + 1; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i }));
    }
    sup.snapshotAgents();
    // sanity: the oldest was lightened. Checked via list() (not status()) — status() itself
    // rehydrates as a side effect, so calling it here would already defeat this check.
    expect(sup.list().find((a) => a.agentId === "d0")?.archived).toBe(true);

    const rehydrated = sup.status("d0");
    expect(rehydrated.archived).toBeUndefined(); // rehydrate() promotes the record back to full
    expect(rehydrated.spec.prompt).toBe("the real brief");
    expect(rehydrated.spec.instructions).toBe("the real instructions");
    expect(rehydrated.resultText).toBe("the real result text");
    // and the promotion is durable in memory — a second read never touches disk again.
    expect(sup.list().find((a) => a.agentId === "d0")?.archived).toBeUndefined();
    // the archive itself is directly readable too (the actual persistence mechanism).
    expect(agentArchive?.read("d0")?.spec.prompt).toBe("the real brief");
  });

  it("agent.result (result()) also rehydrates — it reads resultText via the same status() path", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const { sup } = makeSup(dir);
    const now = Date.now();
    for (let i = 0; i < MAX_TERMINAL_AGENTS_PERSISTED + 1; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i }));
    }
    sup.snapshotAgents();
    const r = sup.result("d0");
    expect(r.text).toBe("the real result text");
  });

  it("agent_resume against an offloaded (lightened) record: resume() reads through status() and respawns with the FULL inherited spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const fake = new FakeAgentBackend([]);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(CFG),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake as AgentBackend]]),
      events: new EventLog(dir),
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
      agentArchive: new AgentArchiveStore(dir),
    });
    const cwd = mkdtempSync(join(tmpdir(), "chimera-archive-cwd-"));
    const now = Date.now();
    for (let i = 0; i < MAX_TERMINAL_AGENTS_PERSISTED + 1; i++) {
      sup.reattachTerminal(terminalRecord({
        agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i,
        spec: { prompt: "original brief", cwd, isolation: "none", account: "auto", permissionProfile: "acceptEdits", autonomy: "ask" } as AgentRecord["spec"],
      }));
    }
    sup.snapshotAgents();
    // sanity via list() — see the read-through test's comment on why status() can't be used here.
    expect(sup.list().find((a) => a.agentId === "d0")?.archived).toBe(true);

    const resumed = await sup.resume("d0", { prompt: "continue the work" });
    expect(resumed.state).toBe("running");
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.prompt).toBe("continue the work");
    expect(fake.spawns[0]?.cwd).toBe(cwd); // inherited from the rehydrated (not empty/lightened) spec
  });

  it("running/paused agents are never lightened, even when the terminal count is far past the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const { sup } = makeSup(dir);
    const now = Date.now();
    sup.reattachTerminal(terminalRecord({ agentId: "running-1", state: "running", createdAt: now - 1_000_000 }));
    sup.reattachPaused(terminalRecord({ agentId: "paused-1", state: "done", createdAt: now - 1_000_000, resumeAt: now + 60_000 }));
    for (let i = 0; i < MAX_TERMINAL_AGENTS_PERSISTED + 10; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i }));
    }

    sup.snapshotAgents();

    expect(sup.list().find((a) => a.agentId === "running-1")?.archived).toBeUndefined();
    expect(sup.list().find((a) => a.agentId === "running-1")?.spec.prompt).toBe("the real brief");
    expect(sup.list().find((a) => a.agentId === "paused-1")?.archived).toBeUndefined();
    expect(sup.list().find((a) => a.agentId === "paused-1")?.spec.prompt).toBe("the real brief");
  });

  it("byte-identical without agentArchive wired: terminal records stay full forever, never lightened (every pre-existing test/deployment)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-"));
    const { sup } = makeSup(dir, { withArchive: false });
    const now = Date.now();
    for (let i = 0; i < MAX_TERMINAL_AGENTS_PERSISTED + 5; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i }));
    }
    sup.snapshotAgents();
    const rows = sup.list().filter((a) => a.agentId.startsWith("d"));
    expect(rows).toHaveLength(MAX_TERMINAL_AGENTS_PERSISTED + 5);
    expect(rows.every((a) => a.archived === undefined)).toBe(true);
    expect(rows.every((a) => a.spec.prompt === "the real brief")).toBe(true);
  });

  it("AgentArchiveStore: write/read round trip, and a missing/corrupt file degrades to undefined rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-archive-unit-"));
    const store = new AgentArchiveStore(dir);
    const rec = terminalRecord({ agentId: "x1" });
    expect(store.has("x1")).toBe(false);
    expect(store.read("x1")).toBeUndefined();
    store.write(rec);
    expect(store.has("x1")).toBe(true);
    expect(store.read("x1")?.spec.prompt).toBe("the real brief");
    expect(store.read("nope-never-written")).toBeUndefined();
  });
});
