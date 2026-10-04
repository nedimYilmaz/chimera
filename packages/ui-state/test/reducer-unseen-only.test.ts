import { describe, expect, it } from "vitest";
import { emptyAgent, filterOrderForUnseen, initialState, reduce, type UiState } from "../src/index.js";

// F47.UI: `unseenOnly` is shared state precisely so ↑/↓ (selectDelta, which walks
// visibleAgentOrder) can never land on a row the filtered list does not draw.

function fleet(): UiState {
  const agents = {
    a: { ...emptyAgent("a"), attentionAt: 500 },                    // unseen
    b: { ...emptyAgent("b"), attentionAt: 500, reviewedAt: 900 },   // read
    c: { ...emptyAgent("c"), attentionAt: 500 },                    // unseen
  };
  return { ...initialState, agents, agentOrder: ["a", "b", "c"], selectedAgentId: "a" };
}

describe("unseenOnly (shared state)", () => {
  it("↑/↓ steps over the read agent while the filter is on", () => {
    const on = reduce(fleet(), { type: "agentsUnseenOnly", only: true });
    expect(reduce(on, { type: "selectDelta", delta: 1 }).selectedAgentId).toBe("c");
  });

  it("↑/↓ walks every agent again once the filter is off", () => {
    expect(reduce(fleet(), { type: "selectDelta", delta: 1 }).selectedAgentId).toBe("b");
  });

  it("defaults to off, so an untouched session is unchanged", () => {
    expect(initialState.unseenOnly).toBe(false);
  });

  it("keeps an unseen agent's ancestors so a deep worker is never orphaned", () => {
    const state: UiState = {
      ...initialState,
      agents: {
        root: { ...emptyAgent("root"), depth: 0, treeId: "t" },
        mid: { ...emptyAgent("mid"), depth: 1, treeId: "t", originConductorId: "root" },
        leaf: { ...emptyAgent("leaf"), depth: 2, treeId: "t", originConductorId: "mid", attentionAt: 7 },
      },
      agentOrder: ["root", "mid", "leaf"],
    };
    expect(filterOrderForUnseen(state, state.agentOrder)).toEqual(["root", "mid", "leaf"]);
  });

  it("returns nothing at all when the fleet is fully read", () => {
    const state = { ...initialState, agents: { a: emptyAgent("a") }, agentOrder: ["a"] };
    expect(filterOrderForUnseen(state, state.agentOrder)).toEqual([]);
  });
});

// F47.QA2: the same invariant, but for the OTHER way a row leaves the attention-only view —
// its own reviewedAt moves (bare `m` / the app's mark-read affordances) instead of the operator
// toggling the filter. `agentsUnseenOnly` snapped the selection; the live status fold did not.
function ev(agentId: string, data: Record<string, unknown>) {
  return { type: "event" as const, event: { agentId, kind: "status", ts: 1000, seq: 1, data } as never };
}

describe("unseenOnly — selection after a mark-seen fold", () => {
  it("moves the selection off the agent that was just marked read", () => {
    const on = reduce(fleet(), { type: "agentsUnseenOnly", only: true });
    expect(on.selectedAgentId).toBe("a");
    const after = reduce(on, ev("a", { state: "idle", reviewedAt: 500 }));
    expect(after.selectedAgentId).toBe("c");
    // and ↑/↓ from there stays inside the drawn rows instead of teleporting to the top
    expect(reduce(after, { type: "selectDelta", delta: -1 }).selectedAgentId).toBe("c");
  });

  it("keeps a marked ancestor selected while a descendant is still unseen", () => {
    const state: UiState = {
      ...initialState,
      unseenOnly: true,
      agents: {
        root: { ...emptyAgent("root"), depth: 0, treeId: "t", attentionAt: 500 },
        leaf: { ...emptyAgent("leaf"), depth: 1, treeId: "t", originConductorId: "root", attentionAt: 700 },
      },
      agentOrder: ["root", "leaf"],
      selectedAgentId: "root",
    };
    expect(reduce(state, ev("root", { state: "idle", reviewedAt: 500 })).selectedAgentId).toBe("root");
  });

  it("leaves the selection alone while the filter is off", () => {
    const after = reduce(fleet(), ev("a", { state: "idle", reviewedAt: 500 }));
    expect(after.selectedAgentId).toBe("a");
  });

  it("leaves the selection alone for a status that carries no reviewedAt", () => {
    const on = reduce(fleet(), { type: "agentsUnseenOnly", only: true });
    expect(reduce(on, ev("a", { state: "running" })).selectedAgentId).toBe("a");
  });
});
