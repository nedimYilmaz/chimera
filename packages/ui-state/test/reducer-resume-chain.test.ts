import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";
import type { UiState } from "@chimera/ui-state";

// RESUMED-AGENT-TRANSCRIPT-CONTINUITY: a respawn-with-resume mints a brand-new agentId whose
// own event log starts empty even though the provider session (sessionId) it resumes carries
// the model's real memory over whole. These tests cover the reducer-level fix that seeds the
// new AgentView's transcript/tools/usage/costUsd from whichever OTHER agents-map entry shares
// its sessionId, so the transcript pane and ctx meter read correctly from the very first render
// instead of looking amnesiac -- see reducer.ts's "agent_started" case for the full rationale.

function withMessage(st: UiState, agentId: string, seq: number, text: string): UiState {
  return reduce(st, {
    type: "event",
    event: { ts: seq, seq, agentId, kind: "message_complete", data: { text } },
  });
}

describe("reducer: resumed-agent transcript continuity", () => {
  it("a brand-new agentId with NO sessionId match behaves exactly as before (no predecessor found)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "solo", kind: "agent_started", data: { sessionId: "sess-solo" } },
    });
    expect(st.agents["solo"]!.transcript).toEqual([]);
    expect(st.agents["solo"]!.resumedFrom).toBeUndefined();
    expect(st.agents["solo"]!.usage).toBeNull();
    expect(st.agents["solo"]!.costUsd).toBe(0);
  });

  it("an agent_started carrying NO sessionId at all leaves transcript/usage untouched (degrades cleanly)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "nosess", kind: "agent_started", data: {} },
    });
    expect(st.agents["nosess"]!.transcript).toEqual([]);
    expect(st.agents["nosess"]!.sessionId).toBeUndefined();
    expect(st.agents["nosess"]!.resumedFrom).toBeUndefined();
  });

  it("TWO-generation chain: a resumed agentId inherits its predecessor's transcript/usage/cost plus a boundary banner", () => {
    let st = initialState;
    st = reduce(st, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "gen1", kind: "agent_started", data: { sessionId: "sess-A" } },
    });
    st = withMessage(st, "gen1", 2, "hello from gen1");
    st = reduce(st, {
      type: "event",
      event: { ts: 3, seq: 3, agentId: "gen1", kind: "turn_complete", data: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, turnCostUsd: 0.01 } },
    });

    // gen1 dies; the daemon (or an operator) respawns against sess-A under a NEW agentId.
    st = reduce(st, {
      type: "event",
      event: { ts: 4, seq: 4, agentId: "gen2", kind: "agent_started", data: { sessionId: "sess-A" } },
    });

    const gen2 = st.agents["gen2"]!;
    expect(gen2.resumedFrom).toEqual(["gen1"]);
    // predecessor's real message plus one boundary banner appended after it.
    expect(gen2.transcript.length).toBe(st.agents["gen1"]!.transcript.length + 1);
    expect(gen2.transcript[0]).toEqual(st.agents["gen1"]!.transcript[0]);
    const banner = gen2.transcript[gen2.transcript.length - 1]!;
    expect(banner.role).toBe("system");
    expect(banner.role === "system" && banner.text).toContain("resumed session from gen1");
    // ctx meter basis: seeded from the predecessor instead of reading 0.
    expect(gen2.usage).toEqual(st.agents["gen1"]!.usage);
    expect(gen2.costUsd).toBe(st.agents["gen1"]!.costUsd);
    // gen1's OWN transcript/usage is untouched -- this is additive projection, not a rebind.
    expect(st.agents["gen1"]!.transcript.some((i) => i.role === "system")).toBe(false);
  });

  it("THREE-generation chain (the real failover case): gen3 carries the FULL chain, gen1+gen2+2 boundary banners", () => {
    let st = initialState;
    st = reduce(st, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "g1", kind: "agent_started", data: { sessionId: "sess-B" } },
    });
    st = withMessage(st, "g1", 2, "g1 says hi");
    st = reduce(st, {
      type: "event",
      event: { ts: 3, seq: 3, agentId: "g2", kind: "agent_started", data: { sessionId: "sess-B" } },
    });
    st = withMessage(st, "g2", 4, "g2 continues");
    st = reduce(st, {
      type: "event",
      event: { ts: 5, seq: 5, agentId: "g3", kind: "agent_started", data: { sessionId: "sess-B" } },
    });

    const g3 = st.agents["g3"]!;
    // ordered oldest-first, both ancestors present, no cycle/hang.
    expect(g3.resumedFrom).toEqual(["g1", "g2"]);
    const systemBanners = g3.transcript.filter((i) => i.role === "system");
    expect(systemBanners.length).toBe(2);
    // g3's predecessor resolves to g2 (the longest/most-recent chain tip), not g1 directly --
    // g2's own transcript already folded g1's content in, so g3 inherits both transitively.
    const assistantTexts = g3.transcript.filter((i) => i.role === "assistant").map((i) => i.text);
    expect(assistantTexts).toEqual(["g1 says hi", "g2 continues"]);
  });

  it("a duplicate/replayed agent_started for an ALREADY-resumed agentId does not re-merge (no duplicate banners)", () => {
    let st = initialState;
    st = reduce(st, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "p1", kind: "agent_started", data: { sessionId: "sess-C" } },
    });
    st = reduce(st, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "p2", kind: "agent_started", data: { sessionId: "sess-C" } },
    });
    const firstMerge = st.agents["p2"]!.transcript.length;
    // A second agent_started for p2 with the SAME sessionId (e.g. a stray daemon replay at a
    // later seq) must not merge p1's content in again -- prev.sessionId is already "sess-C".
    st = reduce(st, {
      type: "event",
      event: { ts: 3, seq: 3, agentId: "p2", kind: "agent_started", data: { sessionId: "sess-C" } },
    });
    expect(st.agents["p2"]!.transcript.length).toBe(firstMerge);
  });

  it("an agent with no sessionId at all is completely unaffected by chain resolution", () => {
    let st = initialState;
    st = reduce(st, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "plain", kind: "agent_started", data: { model: "m1" } },
    });
    st = withMessage(st, "plain", 2, "just a normal agent");
    expect(st.agents["plain"]!.resumedFrom).toBeUndefined();
    expect(st.agents["plain"]!.sessionId).toBeUndefined();
    expect(st.agents["plain"]!.transcript.length).toBe(1);
    expect(st.agents["plain"]!.transcript.every((i) => i.role !== "system")).toBe(true);
  });
});
