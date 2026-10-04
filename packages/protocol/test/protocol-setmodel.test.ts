import { describe, it, expect } from "vitest";
import { SetModelParams } from "@chimera/protocol";

// Task MDL-a: agent.setModel — respawn-with-resume under the SAME agentId to
// change a running agent's model (spec's TDD test 3/4 need SetModelParams to
// validate the RPC's params the same way every other agent.* param schema does).

describe("SetModelParams", () => {
  it("parses a valid {agentId, model}", () => {
    const parsed = SetModelParams.parse({ agentId: "a1", model: "claude-sonnet-5" });
    expect(parsed).toEqual({ agentId: "a1", model: "claude-sonnet-5" });
  });

  it("rejects an empty agentId", () => {
    expect(() => SetModelParams.parse({ agentId: "", model: "claude-sonnet-5" })).toThrow();
  });

  it("rejects an empty model", () => {
    expect(() => SetModelParams.parse({ agentId: "a1", model: "" })).toThrow();
  });

  it("rejects a missing agentId", () => {
    expect(() => SetModelParams.parse({ model: "claude-sonnet-5" })).toThrow();
  });

  it("rejects a missing model", () => {
    expect(() => SetModelParams.parse({ agentId: "a1" })).toThrow();
  });

  it("rejects an unknown extra key (strict)", () => {
    expect(() => SetModelParams.parse({ agentId: "a1", model: "claude-sonnet-5", bogus: true })).toThrow();
  });
});
