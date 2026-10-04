import { describe, it, expect } from "vitest";
import { defaultEffortForRole, escalatedEffort } from "@chimera/core/effort-policy";

describe("defaultEffortForRole", () => {
  it.each([
    ["eng", "low"],
    ["engineer", "low"],
    ["fix", "low"],
    ["fixer", "low"],
    ["hotfix", "low"],
    ["patch", "low"],
    ["implement", "low"],
    ["implementer", "low"],
    ["bug-fixer", "low"],   // word-boundary match on the "fixer" segment
  ])("%s -> %s", (role, expected) => expect(defaultEffortForRole(role)).toBe(expected));

  it.each([
    "planner", "reviewer", "synthesizer", "integrator", "critic", "verifier", "researcher", "orchestrator",
  ])("%s -> undefined (today's backend-default behavior)", (role) => {
    expect(defaultEffortForRole(role)).toBeUndefined();
  });
});

describe("escalatedEffort", () => {
  it("leaves an unset baseline untouched (nothing to escalate)", () => {
    expect(escalatedEffort(undefined)).toBeUndefined();
  });

  it.each([
    ["minimal", "low"],
    ["low", "medium"],
    ["medium", "high"],
    ["high", "xhigh"],
    ["xhigh", "max"],
    ["max", "max"],   // caps at the top tier
  ])("%s -> %s", (base, expected) => expect(escalatedEffort(base as never)).toBe(expected));
});
