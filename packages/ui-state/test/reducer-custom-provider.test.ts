import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce } from "@chimera/ui-state";

describe("custom provider identity in live UI state", () => {
  it("preserves opaque provider and discovered model ids from agent_started", () => {
    const event: NormalizedEvent = {
      ts: 1,
      seq: 1,
      agentId: "local-agent",
      kind: "agent_started",
      data: { provider: "ollama-local", model: "qwen3.5:9b-mlx" },
    };
    const state = reduce(initialState, { type: "event", event });
    expect(state.agents["local-agent"]).toMatchObject({
      provider: "ollama-local",
      model: "qwen3.5:9b-mlx",
    });
  });
});
