import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AuditLedgerRecord, AuditVerifyResult } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
// FakeAgentBackend.spawn SHIFTS the scenarios array it was given, so a shared module-level
// literal is drained by the first test and every later one silently runs the default $0 script
// (and never pauses). Fresh per call.
const OVERSPEND = (): FakeStep[][] => [[{ end: { resultText: "ok", costUsd: 0.6 } }]];

// F50 BUDGET-RESUME, engine half: the RPC exists so that releasing the fleet's hardest guardrail
// leaves a record in the NEVER-pruned hash chain — the event log prunes after ~3 days, and "who
// released this cap" has to stay answerable long after that.
// The ledger file only exists once something has been appended, so "no file" and "no records"
// are the same fact here.
const ledgerRecords = (home: string): AuditLedgerRecord[] => {
  if (!existsSync(join(home, "audit", "ledger.jsonl"))) return [];
  return readFileSync(join(home, "audit", "ledger.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditLedgerRecord);
};

async function pausedEngine() {
  const home = makeEngineHome();
  const e = new Engine({ home, backends: backends(new FakeAgentBackend(OVERSPEND())) });
  const root = await e.supervisor.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
  await e.supervisor.waitFor(root.agentId, 2000);
  // waitFor resolves on the agent's exit; the settle that books the cost (and therefore the
  // pause) lands a tick later — poll rather than race it.
  await waitUntil(() => e.supervisor.treePaused(root.agentId));
  return { e, home, treeId: root.agentId };
}

describe("F50: budget.resume RPC (operator-only, audited)", () => {
  it("appends exactly one budget_resumed record and leaves the hash chain valid", async () => {
    const { e, home, treeId } = await pausedEngine();
    const before = ledgerRecords(home).length;

    const res = await e.handle("budget.resume", { treeId, principal: "app", reason: "operator reviewed the overspend" });

    expect(res).toMatchObject({ resumed: true, treeId, maxBudgetUsd: 0.5, overBudget: true, blockedByAncestorNodeId: null });
    expect(e.supervisor.treePaused(treeId)).toBe(false);

    const added = ledgerRecords(home).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      agentId: "operator", action: "budget_resumed", resource: `budget:${treeId}`, decision: "allow",
      reason: "operator reviewed the overspend",
    });
    expect(added[0]!.detail).toMatchObject({ principal: "app", maxBudgetUsd: 0.5, wasPaused: true, overBudget: true });

    const verified = (await e.handle("audit.verify", {})) as AuditVerifyResult;
    expect(verified.ok).toBe(true);
    expect(verified.firstDivergence).toBeNull();
  });

  it("an unknown treeId is a no-op that writes NO audit record", async () => {
    const { e, home } = await pausedEngine();
    const before = ledgerRecords(home).length;

    const res = await e.handle("budget.resume", { treeId: "ghost", principal: "tui" });

    expect(res).toMatchObject({ resumed: false, treeId: "ghost", overBudget: false });
    expect((res as { note: string }).note).toContain("nothing to resume");
    expect(ledgerRecords(home).length).toBe(before);   // an audit trail of no-ops is noise
  });

  it("the note names the remaining overage and states that the budget was NOT raised", async () => {
    const { e, treeId } = await pausedEngine();
    const res = (await e.handle("budget.resume", { treeId, principal: "app" })) as { note: string; maxBudgetUsd: number };
    expect(res.note).toContain("$0.10");                // 0.60 spent against a 0.50 cap — the note is
    expect(res.note).not.toContain(" 0.10");            // shown to the operator VERBATIM, so it must read as money
    expect(res.note).toContain("did not raise the budget");
    expect(res.maxBudgetUsd).toBe(0.5);                 // and the ceiling is byte-identical
  });

  it("rejects a request with no principal — the ledger's answer to \"who\" is not optional", async () => {
    const { e, treeId } = await pausedEngine();
    await expect(e.handle("budget.resume", { treeId })).rejects.toMatchObject({ code: "protocol" });
  });
});
