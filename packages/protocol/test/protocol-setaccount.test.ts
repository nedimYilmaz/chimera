import { describe, it, expect } from "vitest";
import { SetAccountParams } from "@chimera/protocol";

// ACCOUNT-SWITCH-LIVE: agent.setAccount — mirrors agent.setModel's own params schema test.

describe("SetAccountParams", () => {
  it("parses a valid {agentId, account}", () => {
    const parsed = SetAccountParams.parse({ agentId: "a1", account: "second" });
    expect(parsed).toEqual({ agentId: "a1", account: "second" });
  });

  it("rejects an empty agentId", () => {
    expect(() => SetAccountParams.parse({ agentId: "", account: "second" })).toThrow();
  });

  it("rejects an empty account", () => {
    expect(() => SetAccountParams.parse({ agentId: "a1", account: "" })).toThrow();
  });

  it("rejects a missing agentId", () => {
    expect(() => SetAccountParams.parse({ account: "second" })).toThrow();
  });

  it("rejects a missing account", () => {
    expect(() => SetAccountParams.parse({ agentId: "a1" })).toThrow();
  });

  it("rejects an unknown extra key (strict)", () => {
    expect(() => SetAccountParams.parse({ agentId: "a1", account: "second", bogus: true })).toThrow();
  });
});
