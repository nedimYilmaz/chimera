import { describe, expect, it } from "vitest";
import {
  BUDGET_PAUSE_SCOPE,
  budgetMeasuredUsd,
  budgetResumeEffect,
  budgetResumeToast,
  budgetSpendSplit,
  budgetStatusLine,
  fmtBudgetUsd,
  reduce,
  initialState,
  type UiState,
} from "../src/index.js";

// F50.UI: the ONE vocabulary the app banner, the tui band, both confirm gates and the
// transcript line read from. A drift here is an operator reading two different stories
// about one pause, so the wording facts are pinned, not just the numbers.
describe("shared budget wording", () => {
  it("derives the provider-reported share as total − estimated, clamped at zero", () => {
    expect(budgetMeasuredUsd({ totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 })).toBeCloseTo(0.47, 5);
    // estimatedUsd is a SUBSET of totalCostUsd, but a racing snapshot must never print a negative.
    expect(budgetMeasuredUsd({ totalCostUsd: 1, estimatedUsd: 4, maxBudgetUsd: 2 })).toBe(0);
  });

  it("names both shares when any spend is estimated, and says so plainly when none is", () => {
    const split = budgetSpendSplit({ totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 });
    expect(split).toContain("$2.37 spent of the $2.00 cap");
    expect(split).toContain("$0.47 reported by the provider");
    expect(split).toContain("~$1.90 estimated from token counts");
    expect(budgetSpendSplit({ totalCostUsd: 2.37, estimatedUsd: 0, maxBudgetUsd: 2 }))
      .toContain("all of it reported by the provider");
  });

  it("states that releasing does not raise the cap and where it re-pauses", () => {
    const effect = budgetResumeEffect({ totalCostUsd: 2.37, estimatedUsd: 0, maxBudgetUsd: 2 });
    expect(effect).toContain("does not raise the $2.00 cap");
    expect(effect).toContain("past $2.37");
  });

  it("fmtBudgetUsd survives a missing/garbage figure rather than printing NaN", () => {
    expect(fmtBudgetUsd(undefined)).toBe("$0.00");
    expect(fmtBudgetUsd("x")).toBe("$0.00");
  });
});

describe("budgetResumeToast", () => {
  const note = "released — the tree is under its cap and stays runnable.";

  it("surfaces the daemon's note verbatim", () => {
    expect(budgetResumeToast({ resumed: true, maxBudgetUsd: 2, blockedByAncestorNodeId: null, note })).toBe(note);
  });

  it("adds the fact the note omits: an ancestor still budget-paused keeps this tree blocked", () => {
    const t = budgetResumeToast({ resumed: true, maxBudgetUsd: 2, blockedByAncestorNodeId: "abcdef1234", note });
    expect(t).toContain("abcdef12");
    expect(t).toContain("still budget-paused");
  });

  it("explains a resumed:false on a registered tree as 'nothing was paused'", () => {
    expect(budgetResumeToast({ resumed: false, maxBudgetUsd: 2, blockedByAncestorNodeId: null, note: "not paused" }))
      .toContain("nothing was paused");
  });

  it("leaves the engine's unknown-node reply alone (its note already says it)", () => {
    const unknown = 'no budget node "t9" is registered — nothing to resume';
    expect(budgetResumeToast({ resumed: false, maxBudgetUsd: 0, blockedByAncestorNodeId: null, note: unknown })).toBe(unknown);
  });
});

// BUDGET-EVENTS-INVISIBLE: all four supervisor budget events used to reach ONLY the
// pause banner, which renders current state — so a self-clearing pause or an operator
// release left no readable trace afterwards.
describe("budgetStatusLine", () => {
  it("ignores non-budget status events", () => {
    expect(budgetStatusLine({ paused: true, reason: "hold" })).toBeNull();
  });

  it("a booked pause states the split and the blast radius", () => {
    const line = budgetStatusLine({ paused: true, reason: "budget", totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 })!;
    expect(line).toContain("budget pause");
    expect(line).toContain("~$1.90 estimated from token counts");
    expect(line).toContain(BUDGET_PAUSE_SCOPE);
  });

  it("a live-estimate pause never claims a booked/estimated split (nothing has booked yet)", () => {
    const line = budgetStatusLine({ paused: true, reason: "budget", live: true, totalCostUsd: 1.2, maxBudgetUsd: 2 })!;
    expect(line).toContain("in-flight turn");
    expect(line).not.toContain("reported by the provider");
  });

  it("marks a re-pause after an operator resume", () => {
    const line = budgetStatusLine({ paused: true, reason: "budget", afterResume: true, totalCostUsd: 3, estimatedUsd: 0, maxBudgetUsd: 2 })!;
    expect(line).toContain("Re-paused after an operator resume");
  });

  it("an operator release says the cap is unchanged and the watermark re-arms", () => {
    const line = budgetStatusLine({ paused: false, reason: "budget", resumed: true, totalCostUsd: 3, maxBudgetUsd: 2 })!;
    expect(line).toContain("budget resumed by the operator");
    expect(line).toContain("does not raise the $2.00 cap");
  });

  it("an auto-reconcile back under the cap is reported as cleared, not as an operator action", () => {
    const line = budgetStatusLine({ paused: false, reason: "budget", totalCostUsd: 1, maxBudgetUsd: 2 })!;
    expect(line).toContain("budget pause cleared");
    expect(line).not.toContain("operator");
  });

  it("reaches the agent's system transcript through the reducer", () => {
    let s: UiState = initialState;
    s = reduce(s, {
      type: "event",
      event: {
        seq: 1, ts: 1, agentId: "a1", kind: "status",
        data: { paused: true, reason: "budget", treeId: "a1", totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 },
      },
    });
    const t = s.agents["a1"]!.transcript;
    expect(t.some((m) => m.role === "system" && m.text.includes("budget pause"))).toBe(true);
  });
});
