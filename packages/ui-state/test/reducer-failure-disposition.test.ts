import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce, failureCauseLabel } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type FailureCause, type UiState } from "@chimera/ui-state";

// F08: markFailed's status{state:"failed", error, failure} is the daemon's only signal for WHY an
// agent died — before this, a failed row looked identical whether the account was capped, the
// provider rate-limited it, or the request was permanently rejected. These tests lock the fold:
// the live event AND the snapshot path both project `failure`, keyed defensively on the object's
// own shape (never the ambiguous bare `state` string) so a partial/synthetic payload can't trigger it.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

const CAUSES: FailureCause[] = ["account-cap", "provider-rate-limit", "provider-capacity", "provider-stream", "transient-network", "bad-request", "credential", "unclassified"];

describe("reducer: a live markFailed status event projects `failure` (F08)", () => {
  for (const cause of CAUSES) {
    it(`status{state:'failed', failure:{cause:'${cause}'}} folds the disposition`, () => {
      const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
      const failed = feed(working, [ev("a1", "status", { state: "failed", error: "boom", failure: { cause, evidence: "e", at: 42 } })]);
      expect(failed.agents["a1"]!.failure).toEqual({ cause, evidence: "e", at: 42 });
    });
  }

  it("a status event with no `failure` key leaves the field untouched", () => {
    const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    const st = feed(working, [ev("a1", "status", { state: "failed", error: "boom" })]);
    expect(st.agents["a1"]!.failure).toBeUndefined();
  });

  it("a `failure` object with no string `cause` is ignored (defensive against a malformed payload)", () => {
    const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    const st = feed(working, [ev("a1", "status", { state: "failed", failure: { evidence: "no cause here" } })]);
    expect(st.agents["a1"]!.failure).toBeUndefined();
  });
});

describe("reducer: an agent.list snapshot projects `failure` (F08)", () => {
  const record = (over: Partial<AgentRecordLite>): AgentRecordLite => ({
    agentId: "a1", state: "failed", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over,
  });

  it("a snapshot carrying `failure` is authoritative", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [record({ failure: { cause: "credential" } })] });
    expect(st.agents["a1"]!.failure).toEqual({ cause: "credential" });
  });

  it("a later snapshot with no `failure` key keeps the previously-projected disposition (JSON drops undefined keys, so this is indistinguishable from an older-daemon snapshot — `prev` is the only safe fallback)", () => {
    const failed = reduce(initialState, { type: "agentRecords", records: [record({ failure: { cause: "credential" } })] });
    expect(failed.agents["a1"]!.failure).toEqual({ cause: "credential" });

    const stillFailed = reduce(failed, { type: "agentRecords", records: [record({})] });
    expect(stillFailed.agents["a1"]!.failure).toEqual({ cause: "credential" });
  });

  it("emptyAgent has `failure: undefined` (reducer-coverage.test.ts's field-list contract)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(st.agents["a1"]).toHaveProperty("failure", undefined);
  });
});

describe("failureCauseLabel (F08)", () => {
  it("returns a distinct, non-empty label per cause", () => {
    const labels = CAUSES.map((c) => failureCauseLabel(c));
    expect(new Set(labels).size).toBe(CAUSES.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it("returns a fallback label for undefined", () => {
    expect(failureCauseLabel(undefined)).toBe("unknown cause");
  });
});
