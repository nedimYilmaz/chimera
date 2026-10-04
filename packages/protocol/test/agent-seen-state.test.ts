import { describe, it, expect } from "vitest";
import { AGENT_MARK_SEEN_MAX_IDS, ATTENTION_EVENT_KINDS, AgentMarkSeenParamsSchema, AgentSummarySchema, isAgentUnseen } from "@chimera/protocol";

// F47 (fleet seen-state): the wire contract for attentionAt/reviewedAt/unseen. The predicate
// lives here (not in core) because the TUI, the app and the reducer all badge off the SAME
// comparison — a second copy of `>` vs `>=` somewhere would silently desync the badge from the
// sort order.

const SUMMARY = {
  id: "a1", name: "worker", role: null, status: "running", model: null,
  depth: 0, parentId: null, costUsd: 0, gitBranch: null,
};

describe("isAgentUnseen", () => {
  it("a never-stamped agent is seen", () => {
    expect(isAgentUnseen({})).toBe(false);
    expect(isAgentUnseen({ reviewedAt: 100 })).toBe(false); // marked seen, nothing ever demanded attention
  });

  it("attention with no acknowledgement is unseen", () => {
    expect(isAgentUnseen({ attentionAt: 100 })).toBe(true);
  });

  it("attentionAt === reviewedAt is SEEN — mark-seen is the later action", () => {
    expect(isAgentUnseen({ attentionAt: 100, reviewedAt: 100 })).toBe(false);
  });

  it("acknowledged, then re-unseen by newer attention", () => {
    expect(isAgentUnseen({ attentionAt: 100, reviewedAt: 200 })).toBe(false);
    expect(isAgentUnseen({ attentionAt: 300, reviewedAt: 200 })).toBe(true);
  });
});

describe("ATTENTION_EVENT_KINDS", () => {
  it("is exactly the six kinds that mean a human is needed", () => {
    expect([...ATTENTION_EVENT_KINDS].sort()).toEqual(
      ["agent_prompt_stalled", "agent_question", "error", "permission_request", "result", "turn_timeout"],
    );
  });

  it("excludes the high-frequency streaming kinds (busy is not waiting)", () => {
    for (const k of ["message_delta", "message_complete", "tool_call", "tool_result", "usage", "turn_complete"]) {
      expect(ATTENTION_EVENT_KINDS.has(k)).toBe(false);
    }
  });
});

describe("AgentSummarySchema seen-state fields", () => {
  it("accepts all three", () => {
    const parsed = AgentSummarySchema.parse({ ...SUMMARY, attentionAt: 100, reviewedAt: 50, unseen: true });
    expect(parsed.attentionAt).toBe(100);
    expect(parsed.reviewedAt).toBe(50);
    expect(parsed.unseen).toBe(true);
  });

  it("stays valid with none of them (pre-F47 client parity)", () => {
    const parsed = AgentSummarySchema.parse(SUMMARY);
    expect(parsed.attentionAt).toBeUndefined();
    expect(parsed.reviewedAt).toBeUndefined();
    expect(parsed.unseen).toBeUndefined();
  });
});

describe("AgentMarkSeenParamsSchema", () => {
  it("accepts a non-empty id list", () => {
    expect(AgentMarkSeenParamsSchema.parse({ agentIds: ["a", "b"] }).agentIds).toEqual(["a", "b"]);
  });

  it("rejects an empty list, an empty id, and unknown keys", () => {
    expect(() => AgentMarkSeenParamsSchema.parse({ agentIds: [] })).toThrow();
    expect(() => AgentMarkSeenParamsSchema.parse({ agentIds: [""] })).toThrow();
    expect(() => AgentMarkSeenParamsSchema.parse({ agentIds: ["a"], all: true })).toThrow();
  });
});

describe("the bulk id cap", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `agent-${i}`);

  it("is a named constant the fleet views can chunk against, not a number only zod knows", () => {
    // Callers sweep the whole fleet; they can only stay under the cap if they can READ it.
    expect(AGENT_MARK_SEEN_MAX_IDS).toBe(500);
    expect(AgentMarkSeenParamsSchema.parse({ agentIds: ids(AGENT_MARK_SEEN_MAX_IDS) }).agentIds).toHaveLength(500);
  });

  it("rejects the whole call one id over the cap — nothing partial gets through", () => {
    expect(AgentMarkSeenParamsSchema.safeParse({ agentIds: ids(AGENT_MARK_SEEN_MAX_IDS + 1) }).success).toBe(false);
  });
});
