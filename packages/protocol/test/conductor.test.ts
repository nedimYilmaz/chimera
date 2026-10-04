import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";

describe("AgentSpec conductor flag (Phase 3)", () => {
  it("defaults to false", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(spec.conductor).toBe(false);
  });
  it("accepts true for hosted conductor sessions", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: true });
    expect(spec.conductor).toBe(true);
  });
  it("rejects non-boolean values", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: "yes" })).toThrow();
  });
  it("accepts an optional custom display label without overloading the execution account", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", account: "main", displayLabel: "  release captain  " });
    expect(spec.displayLabel).toBe("release captain");
    expect(spec.account).toBe("main");
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t" }).displayLabel).toBeUndefined();
  });

  // --- extra edge/branch coverage beyond the brief's three example cases ---

  it("accepts explicit false (distinguishing set-false from unset-default)", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: false });
    expect(spec.conductor).toBe(false);
  });

  it("rejects a numeric value", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: 1 })).toThrow();
  });

  it("rejects null", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: null })).toThrow();
  });

  it("rejects an object value", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: {} })).toThrow();
  });

  it("composes with Phase 2's maxBudgetUsd field in either order without interference", () => {
    const specA = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxBudgetUsd: 5, conductor: true });
    expect(specA.maxBudgetUsd).toBe(5);
    expect(specA.conductor).toBe(true);

    const specB = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: true, maxBudgetUsd: 5 });
    expect(specB.maxBudgetUsd).toBe(5);
    expect(specB.conductor).toBe(true);

    // both still default independently when neither is supplied
    const specC = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(specC.maxBudgetUsd).toBeNull();
    expect(specC.conductor).toBe(false);
  });
});
