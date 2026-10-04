import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

// R2 EFFORT: agent_started's data.effort (spec-sourced, see backends/claude.ts, codex.ts) folds
// onto AgentView.effort, mirroring the model stamp in reducer-model-sentinel.test.ts — minus the
// sentinel-placeholder guard, which is model-only (the SDK's "/model" confirmation notice can
// carry model:"<synthetic>"; effort is never SDK-echoed, so no such placeholder exists for it).
describe("reducer: agent_started folds data.effort onto agent.effort", () => {
  it("agent_started with an effort level sets agent.effort", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { effort: "xhigh" } },
    });
    expect(st.agents["a"]!.effort).toBe("xhigh");
  });

  it("agent_started with no effort key leaves agent.effort undefined (byte-identical to today)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.effort).toBeUndefined();
  });

  it("a later agent_started with no effort key does not clobber a previously-folded effort", () => {
    const first = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { effort: "low" } },
    });
    const st = reduce(first, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.effort).toBe("low");
  });
});
