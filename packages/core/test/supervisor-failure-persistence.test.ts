import { describe, it, expect } from "vitest";
import { AgentSpecSchema, type FailureDisposition } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { MAX_TERMINAL_AGENTS_PERSISTED, type AgentRecord } from "@chimera/core/supervisor";
import { makeSupervisor, makeEngineHome } from "./helpers.js";

// F08 task 1, A12: `failure` is persisted state, not just an in-memory field. state.json is
// written by JSON.stringify(snapshotAgents()) and read back by a plain cast in reattach.ts (no
// zod on either leg), so an optional object rides for free — these tests are what keeps that
// "for free" honest if the persistence path ever grows a schema or a field allowlist.

const DISPOSITION: FailureDisposition = {
  cause: "account-cap", errorClass: "rate-limit", evidence: "parsed reset time",
  retryable: false, failoverAccount: true, holdForReset: true, restartInPlace: false, at: 1_700_000_000_000,
};

function terminalRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a", spec: AgentSpecSchema.parse({ prompt: "hello", cwd: "/tmp", isolation: "none" }),
    accountName: "main", provider: "claude", state: "failed", depth: 0, treeId: "a",
    createdAt: Date.now(), principal: "local", attempts: [], costUsd: 0, parentId: null,
    projectId: null,
    ...over,
  };
}

describe("F08 A12: the disposition survives the state.json round-trip", () => {
  it("snapshotAgents -> JSON -> reattachTerminal preserves every disposition field", () => {
    const { sup } = makeSupervisor([]);
    sup.reattachTerminal(terminalRecord({ agentId: "p1", treeId: "p1", failure: DISPOSITION }));

    const onDisk = JSON.parse(JSON.stringify({ agents: sup.snapshotAgents() })) as { agents: AgentRecord[] };
    const row = onDisk.agents.find((a) => a.agentId === "p1")!;
    expect(row.failure).toEqual(DISPOSITION);

    const { sup: sup2 } = makeSupervisor([]);
    sup2.reattachTerminal(row);
    expect(sup2.status("p1").failure).toEqual(DISPOSITION);
  });

  it("lightenAgentRecord archives the prompt away but keeps the disposition", () => {
    // Engine rig, not makeSupervisor: archiveColdTerminalAgents is a no-op without a
    // deps.agentArchive, which only the Engine wires up.
    const sup = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
    }).supervisor;
    const now = Date.now();
    const n = MAX_TERMINAL_AGENTS_PERSISTED + 3;
    for (let i = 0; i < n; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `f${i}`, treeId: `f${i}`, createdAt: now + i, failure: DISPOSITION }));
    }

    const lightened = sup.snapshotAgents().filter((a) => a.archived === true);
    expect(lightened.length).toBeGreaterThan(0);
    for (const a of lightened) {
      expect(a.spec.prompt).toBe("");                  // genuinely lightened
      expect(a.failure).toEqual(DISPOSITION);          // ...but the cheap disposition rides along
    }
  });
});
