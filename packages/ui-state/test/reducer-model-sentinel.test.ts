import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

// MODEL-SENTINEL-GUARD: the Claude Agent SDK stamps system-injected assistant
// notices (e.g. the "/model" confirmation text, weekly-limit notices) with
// model:"<synthetic>" — a placeholder, not a real model id. MODEL-LIVE folds
// message_complete.model (and agent_started.model) into agent.model
// authoritative-when-present, so without a guard the sentinel would latch
// onto the transcript header / AgentList model chip until the next real
// assistant turn overwrote it. Any string starting with "<" is rejected.
describe("reducer: model fold rejects SDK sentinel placeholders", () => {
  it("message_complete with a real model id updates agent.model", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "message_complete", data: { model: "claude-opus-4-8" } },
    });
    expect(st.agents["a"]!.model).toBe("claude-opus-4-8");
  });

  it("a later message_complete carrying model:\"<synthetic>\" does NOT clobber a previously-folded real model", () => {
    const real = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "message_complete", data: { model: "claude-opus-4-8" } },
    });
    const st = reduce(real, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "message_complete", data: { model: "<synthetic>" } },
    });
    expect(st.agents["a"]!.model).toBe("claude-opus-4-8");
  });

  it("agent_started with model:\"<synthetic>\" never sets agent.model in the first place", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { model: "<synthetic>" } },
    });
    expect(st.agents["a"]!.model).toBeUndefined();
  });

  it("agent_started with a real model id still sets agent.model", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { model: "claude-sonnet-5" } },
    });
    expect(st.agents["a"]!.model).toBe("claude-sonnet-5");
  });
});
