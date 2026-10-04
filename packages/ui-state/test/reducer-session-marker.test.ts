import { describe, expect, it } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

describe("session marker projection", () => {
  it("defaults to false for a fresh view", () => {
    const state = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "acc", provider: "claude", costUsd: 0, createdAt: 0 }],
    });
    expect(state.agents["a1"]?.session).toBe(false);
  });

  it("projects true when the record's spec.session is true", () => {
    const state = reduce(initialState, {
      type: "agentRecords",
      records: [{
        agentId: "a1", state: "running", accountName: "acc", provider: "claude", costUsd: 0, createdAt: 0,
        spec: { session: true },
      }],
    });
    expect(state.agents["a1"]?.session).toBe(true);
  });
});
