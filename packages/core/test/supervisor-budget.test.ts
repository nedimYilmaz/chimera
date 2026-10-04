import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { EventSink, PermissionDecider, ResolvedAgentSpec } from "@chimera/core/backend";
import { GuardrailError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

const COST = (usd: number): FakeStep[] => [{ end: { resultText: "ok", costUsd: usd } }];

describe("AgentSupervisor tree budget ceiling", () => {
  it("roots default treeId to their own agentId and inject CHIMERA_TREE_ID", async () => {
    const { sup, fake } = makeSupervisor([COST(0.01)]);
    const rec = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none" });
    expect(rec.treeId).toBe(rec.agentId);
    expect(fake.spawns[0]!.env["CHIMERA_TREE_ID"]).toBe(rec.agentId);
    await sup.waitFor(rec.agentId, 1000);
  });

  it("accumulates cost across a tree, pauses on breach, emits the status event, rejects further spawns", async () => {
    const { sup, events } = makeSupervisor([COST(0.03), COST(0.03), COST(0.03)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);                 // tree total: 0.03 — under budget
    expect(sup.treePaused(root.agentId)).toBe(false);

    const child = await sup.spawn({ prompt: "c1", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId });
    expect(child.treeId).toBe(root.agentId);
    await sup.waitFor(child.agentId, 1000);                // tree total: 0.06 > 0.05 → breach

    expect(sup.treePaused(root.agentId)).toBe(true);
    const breach = events.tail(root.agentId, 50).find((e) => e.kind === "status" && e.data["reason"] === "budget");
    expect(breach?.data).toMatchObject({ paused: true, treeId: root.agentId, maxBudgetUsd: 0.05 });
    expect(Number(breach?.data["totalCostUsd"])).toBeCloseTo(0.06);

    await expect(sup.spawn({ prompt: "c2", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId }))
      .rejects.toBeInstanceOf(GuardrailError);
  });

  it("trees without a budget never pause", async () => {
    const { sup } = makeSupervisor([COST(5), COST(5)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(root.agentId, 1000);
    const child = await sup.spawn({ prompt: "c", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId });
    await sup.waitFor(child.agentId, 1000);
    expect(sup.treePaused(root.agentId)).toBe(false);
  });

  it("breach interrupts still-running tree agents (best-effort)", async () => {
    const { sup, fake } = makeSupervisor([
      [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }],   // root: stays running at breach time
      COST(0.06),
    ]);
    let interrupts = 0;
    const origSpawn = fake.spawn.bind(fake);
    fake.spawn = (spec: ResolvedAgentSpec, sink: EventSink, decide: PermissionDecider) => {
      const h = origSpawn(spec, sink, decide);
      const orig = h.interrupt.bind(h);
      h.interrupt = async () => { interrupts++; await orig(); };
      return h;
    };
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    // child on "second" so root+child run CONCURRENTLY — CFG perAccount.main = 1 would reject a 2nd
    // concurrent "main" spawn with GuardrailError before any budget logic runs (global maxAgentsTotal = 2 fits).
    const child = await sup.spawn({ prompt: "burn", cwd: "/tmp", account: "second", isolation: "none" }, { treeId: root.agentId });
    await sup.waitFor(child.agentId, 1000);            // 0.06 > 0.05 → breach while root still runs
    expect(sup.treePaused(root.agentId)).toBe(true);
    expect(interrupts).toBeGreaterThanOrEqual(1);      // the running root got a best-effort interrupt()
  });

  // D14/F18: the "budget ≥80%" default notify rule watches this event.
  it("fires budget_warning ONCE when the tree crosses 80% of its ceiling, well before the 100% pause", async () => {
    const { sup, events } = makeSupervisor([COST(0.041), COST(0.001)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);   // tree total: 0.041 ≥ 0.8*0.05=0.04 → warning, still under the 0.05 ceiling
    expect(sup.treePaused(root.agentId)).toBe(false);
    const warnings = events.tail(root.agentId, 50).filter((e) => e.kind === "budget_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.data).toMatchObject({ treeId: root.agentId, maxBudgetUsd: 0.05 });
    expect(Number(warnings[0]!.data["totalCostUsd"])).toBeCloseTo(0.041);

    const child = await sup.spawn({ prompt: "c", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId });
    await sup.waitFor(child.agentId, 1000);   // tree total: 0.042 — still ≥80%, warning must NOT refire
    expect(events.tail(root.agentId, 50).filter((e) => e.kind === "budget_warning")).toHaveLength(1);
  });

  it("a child's own maxBudgetUsd is silently ignored — only the root registers a budget", async () => {
    const { sup } = makeSupervisor([COST(0.01), COST(9)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none" });   // no budget
    await sup.waitFor(root.agentId, 1000);
    const child = await sup.spawn(
      { prompt: "c", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 },
      { treeId: root.agentId },
    );
    await sup.waitFor(child.agentId, 1000);            // child cost 9 ≫ its own 0.05 — no effect
    expect(sup.treePaused(root.agentId)).toBe(false);
  });

  it("budget/pause state is in-memory only: a fresh supervisor forgets a paused tree (decision 2)", async () => {
    const { sup } = makeSupervisor([COST(0.06)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);
    expect(sup.treePaused(root.agentId)).toBe(true);

    const { sup: sup2 } = makeSupervisor([COST(0.01)]);   // simulated daemon restart
    expect(sup2.treePaused(root.agentId)).toBe(false);
    const revived = await sup2.spawn({ prompt: "again", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId });
    expect(revived.treeId).toBe(root.agentId);            // spawns into the formerly-paused tree succeed again
  });
});
