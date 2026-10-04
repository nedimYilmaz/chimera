import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";

describe("AgentSpec persistent flag (Task A2)", () => {
  it("defaults to false", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(spec.persistent).toBe(false);
  });
  it("accepts true for persistent workers", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: true });
    expect(spec.persistent).toBe(true);
  });
  it("rejects non-boolean values", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: "yes" })).toThrow();
  });

  // --- extra edge/branch coverage beyond the brief's three example cases ---

  it("accepts explicit false (distinguishing set-false from unset-default)", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: false });
    expect(spec.persistent).toBe(false);
  });

  it("rejects a numeric value", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: 1 })).toThrow();
  });

  it("rejects null", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: null })).toThrow();
  });

  it("rejects an object value", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: {} })).toThrow();
  });

  it("composes with conductor independently in either order", () => {
    const specA = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", conductor: true, persistent: true });
    expect(specA.conductor).toBe(true);
    expect(specA.persistent).toBe(true);

    const specB = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", persistent: true, conductor: true });
    expect(specB.conductor).toBe(true);
    expect(specB.persistent).toBe(true);

    // both still default independently when neither is supplied
    const specC = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(specC.conductor).toBe(false);
    expect(specC.persistent).toBe(false);
  });

  it("poolSize is NOT a valid AgentSpec field (strict schema rejects role-only metadata)", () => {
    expect.assertions(1);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", poolSize: 3 })).toThrow();
  });
});
