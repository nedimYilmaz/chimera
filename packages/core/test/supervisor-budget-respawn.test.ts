import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// QA-sweep BUG (high): supervisor.spawn's tree-budget init ran on EVERY spawn for a root
// (treeId === agentId), so an in-place respawn under the SAME agentId — agent.setModel
// (MDL-a) AND daemon conductor re-attach (CR2) — RE-REGISTERED the tree budget with
// totalCostUsd: 0, wiping accumulated spend. Fix: only initialize the meter when none
// exists yet (`!this.treeBudgets.has(treeId)`), so an in-place respawn preserves spend.
//
// These tests detect the bug BEHAVIORALLY (no private-field access): drive the tree just
// under budget, respawn in-place, then drive a second slice of cost that only breaches
// the ceiling if the pre-respawn spend survived. If the meter were wiped on respawn, the
// second slice alone would stay under budget and the tree would never pause.

const COST = (usd: number): FakeStep[] => [{ end: { resultText: "ok", costUsd: usd } }];

describe("AgentSupervisor tree budget survives an in-place respawn", () => {
  it("setModel (MDL-a respawn) preserves accumulated totalCostUsd — does not reset the meter", async () => {
    const { sup } = makeSupervisor([COST(0.04), COST(0.02)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);              // tree total: 0.04 — under budget
    expect(sup.treePaused(root.agentId)).toBe(false);

    const updated = await sup.setModel(root.agentId, "claude-sonnet-5");
    expect(updated.agentId).toBe(root.agentId);          // SAME agentId (CR1 continuity)
    await sup.waitFor(updated.agentId, 1000);            // respawn adds 0.02 more

    // 0.04 (pre-respawn) + 0.02 (post-respawn) = 0.06 > 0.05 → breach.
    // A reset-to-0 bug would leave the tree at only 0.02 < 0.05 — never paused.
    expect(sup.treePaused(root.agentId)).toBe(true);
  });

  // R2 EFFORT: setEffort shares the exact same respawn path as setModel — same invariant applies.
  it("setEffort respawn preserves accumulated totalCostUsd — does not reset the meter", async () => {
    const { sup } = makeSupervisor([COST(0.04), COST(0.02)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);              // tree total: 0.04 — under budget
    expect(sup.treePaused(root.agentId)).toBe(false);

    const updated = await sup.setEffort(root.agentId, "xhigh");
    expect(updated.agentId).toBe(root.agentId);          // SAME agentId (CR1 continuity)
    await sup.waitFor(updated.agentId, 1000);            // respawn adds 0.02 more

    expect(sup.treePaused(root.agentId)).toBe(true);
  });

  it("a CR2-style re-attach (second spawn, same agentId/treeId) does not reset the meter", async () => {
    const { sup } = makeSupervisor([COST(0.04), COST(0.02)]);
    const root = await sup.spawn(
      { prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 },
      { agentId: "root-1" },
    );
    expect(root.treeId).toBe("root-1");
    await sup.waitFor(root.agentId, 1000);              // tree total: 0.04 — under budget
    expect(sup.treePaused("root-1")).toBe(false);

    // Simulate a daemon-restart conductor re-attach: a second spawn under the SAME
    // agentId/treeId, without an explicit setModel/kill in between.
    const reattached = await sup.spawn(
      { prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 },
      { agentId: "root-1" },
    );
    expect(reattached.treeId).toBe("root-1");
    await sup.waitFor(reattached.agentId, 1000);        // re-attach adds 0.02 more

    // 0.04 (pre-reattach) + 0.02 (post-reattach) = 0.06 > 0.05 → breach.
    expect(sup.treePaused("root-1")).toBe(true);
  });

  it("regression: a genuine FIRST spawn of a new root still initializes the meter at totalCostUsd 0", async () => {
    const { sup } = makeSupervisor([COST(0.01)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);
    // 0 (fresh init) + 0.01 = 0.01 < 0.05 — proves the meter started at 0, not some stale
    // or uninitialized value that would have already breached.
    expect(sup.treePaused(root.agentId)).toBe(false);
  });
});
