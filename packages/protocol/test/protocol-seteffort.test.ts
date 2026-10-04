import { describe, it, expect } from "vitest";
import { SetEffortParams } from "@chimera/protocol";

// R2 EFFORT: agent.setEffort — mirrors agent.setModel's own protocol-setmodel.test.ts (Task
// MDL-a) exactly, except `effort` validates against the closed EffortLevelSchema enum instead
// of model's open z.string().min(1) catalog.

describe("SetEffortParams", () => {
  it("parses a valid {agentId, effort}", () => {
    const parsed = SetEffortParams.parse({ agentId: "a1", effort: "high" });
    expect(parsed).toEqual({ agentId: "a1", effort: "high" });
  });

  it("accepts each of the six valid effort levels", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(SetEffortParams.parse({ agentId: "a1", effort }).effort).toBe(effort);
    }
  });

  it("rejects an empty agentId", () => {
    expect(() => SetEffortParams.parse({ agentId: "", effort: "high" })).toThrow();
  });

  it("rejects a value outside the closed vocabulary", () => {
    expect(() => SetEffortParams.parse({ agentId: "a1", effort: "ultra" })).toThrow();
  });

  it("rejects a missing agentId", () => {
    expect(() => SetEffortParams.parse({ effort: "high" })).toThrow();
  });

  it("rejects a missing effort", () => {
    expect(() => SetEffortParams.parse({ agentId: "a1" })).toThrow();
  });

  it("rejects an unknown extra key (strict)", () => {
    expect(() => SetEffortParams.parse({ agentId: "a1", effort: "high", bogus: true })).toThrow();
  });
});
