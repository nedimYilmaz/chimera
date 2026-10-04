import { describe, it, expect } from "vitest";
import { reduce, emptyAgent, isUnseen, unseenAgentIds } from "@chimera/ui-state";
import { initialState, type NormalizedEvent } from "@chimera/ui-state";

// F47: event-only drive style (same as reducer-agent-groups.test.ts) — the desktop app never
// takes an agent.list snapshot after bootstrap, so the live folds are the ones that must hold.
// Every `ts` here is EXPLICIT: isAgentUnseen compares `attentionAt > (reviewedAt ?? 0)`, so a
// stamp at ts 0 would read as "seen" and a shared auto-incrementing counter would make these
// assertions depend on test ordering.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: 1000, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

const ATTENTION = ["result", "error", "turn_timeout", "permission_request", "agent_question"] as const;

describe("F47 — attentionAt live stamping (A10)", () => {
  for (const kind of ATTENTION) {
    it(`stamps attentionAt = e.ts for ${kind}`, () => {
      const s = reduce(initialState, ev({ agentId: "a1", kind: kind as NormalizedEvent["kind"], ts: 4242 }));
      expect(s.agents["a1"]?.attentionAt).toBe(4242);
    });
  }

  for (const kind of ["message_complete", "tool_call", "tool_result", "status", "agent_started"] as const) {
    it(`leaves attentionAt untouched for ${kind}`, () => {
      const s = reduce(initialState, ev({ agentId: "a1", kind: kind as NormalizedEvent["kind"], ts: 4242, data: { state: "running" } }));
      expect(s.agents["a1"]?.attentionAt).toBeUndefined();
    });
  }

  it("keeps the LATEST attention timestamp", () => {
    let s = reduce(initialState, ev({ agentId: "a1", kind: "result", ts: 1000 }));
    s = reduce(s, ev({ agentId: "a1", kind: "error", ts: 2000 }));
    expect(s.agents["a1"]?.attentionAt).toBe(2000);
  });

  // F47 deviation from the plan text: the daemon's noteAttention skips `r.shadow === true`
  // ("a sub-agent is not a fleet row an operator triages"), and markSeen cannot clear a shadow
  // row, so an unguarded client stamp would strand it as permanently unseen.
  it("never stamps a shadow row", () => {
    const s = reduce(initialState, ev({ agentId: "shadow:a1:1", kind: "result", ts: 4242 }));
    expect(s.agents["shadow:a1:1"]?.attentionAt).toBeUndefined();
  });
});

describe("F47 — reviewedAt live fold (A11)", () => {
  it("folds agent.markSeen's bare status{state, reviewedAt} with no snapshot and no `registered`", () => {
    let s = reduce(initialState, ev({ agentId: "a1", kind: "result", ts: 1000 }));
    expect(isUnseen(s.agents["a1"])).toBe(true);

    s = reduce(s, ev({ agentId: "a1", kind: "status", ts: 1001, data: { state: "idle", reviewedAt: 1000 } }));
    expect(s.agents["a1"]?.reviewedAt).toBe(1000);
    // attentionAt === reviewedAt is SEEN.
    expect(isUnseen(s.agents["a1"])).toBe(false);

    s = reduce(s, ev({ agentId: "a1", kind: "result", ts: 2000 }));
    expect(isUnseen(s.agents["a1"])).toBe(true);
  });

  it("a status carrying no reviewedAt leaves the prior value alone", () => {
    let s = reduce(initialState, ev({ agentId: "a1", kind: "status", ts: 1001, data: { state: "idle", reviewedAt: 900 } }));
    s = reduce(s, ev({ agentId: "a1", kind: "status", ts: 1002, data: { state: "running" } }));
    expect(s.agents["a1"]?.reviewedAt).toBe(900);
  });
});

describe("F47 — agent.list snapshot fold", () => {
  const rec = (over: Record<string, unknown>) => ({ agentId: "a1", state: "running", accountName: "claude", provider: "claude", costUsd: 0, createdAt: 1, spec: {}, ...over });

  it("is authoritative when present", () => {
    const s = reduce(initialState, { type: "agentRecords", records: [rec({ attentionAt: 5000, reviewedAt: 4000 })] } as never);
    expect(s.agents["a1"]?.attentionAt).toBe(5000);
    expect(s.agents["a1"]?.reviewedAt).toBe(4000);
    expect(isUnseen(s.agents["a1"])).toBe(true);
  });

  it("keeps prev when absent (older daemon shape)", () => {
    let s = reduce(initialState, { type: "agentRecords", records: [rec({ attentionAt: 5000, reviewedAt: 4000 })] } as never);
    s = reduce(s, { type: "agentRecords", records: [rec({})] } as never);
    expect(s.agents["a1"]?.attentionAt).toBe(5000);
    expect(s.agents["a1"]?.reviewedAt).toBe(4000);
  });
});

describe("F47 — isUnseen / unseenAgentIds", () => {
  it("handles a mixed roster and an unknown id", () => {
    let s = reduce(initialState, ev({ agentId: "a1", kind: "result", ts: 1000 }));
    s = reduce(s, ev({ agentId: "a2", kind: "error", ts: 1000 }));
    s = reduce(s, ev({ agentId: "a2", kind: "status", ts: 1001, data: { state: "idle", reviewedAt: 1000 } }));
    s = reduce(s, ev({ agentId: "a3", kind: "message_complete", ts: 1000 }));

    expect(unseenAgentIds(s)).toEqual(["a1"]);
    expect(isUnseen(s.agents["nope"])).toBe(false);
    expect(isUnseen(undefined)).toBe(false);
  });
});

describe("F47 — emptyAgent", () => {
  it("carries both keys explicitly undefined", () => {
    const a = emptyAgent("x");
    expect(a).toHaveProperty("attentionAt");
    expect(a).toHaveProperty("reviewedAt");
    expect(a.attentionAt).toBeUndefined();
    expect(a.reviewedAt).toBeUndefined();
  });
});
