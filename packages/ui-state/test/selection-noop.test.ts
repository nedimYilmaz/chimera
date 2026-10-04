import { describe, it, expect } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";

// NO-OP-DISPATCH-IS-A-NO-OP: selecting what is already selected produced a NEW state object, so
// every subscriber saw a fresh snapshot for a change that never happened. That is what let
// AgentList's selection-clamp effect spin — it re-dispatched the same fallback id, the store
// handed back a new state, the effect re-ran on it, and round it went. Reported as the UI looping
// when a paste landed in the search box.

describe("selectAgent", () => {
  it("returns the SAME state object when the selection does not change", () => {
    const once = reduce(initialState, { type: "selectAgent", agentId: "a1" });
    const twice = reduce(once, { type: "selectAgent", agentId: "a1" });
    expect(twice).toBe(once);            // identity, not just equality — that is what subscribers key on
  });

  it("still produces a new state when the selection really changes", () => {
    const a = reduce(initialState, { type: "selectAgent", agentId: "a1" });
    const b = reduce(a, { type: "selectAgent", agentId: "a2" });
    expect(b).not.toBe(a);
    expect(b.selectedAgentId).toBe("a2");
  });

  it("treats clearing the selection as a real change, and clearing twice as a no-op", () => {
    const a = reduce(initialState, { type: "selectAgent", agentId: "a1" });
    const cleared = reduce(a, { type: "selectAgent", agentId: null });
    expect(cleared).not.toBe(a);
    expect(reduce(cleared, { type: "selectAgent", agentId: null })).toBe(cleared);
  });
});
