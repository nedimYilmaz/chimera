import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import {
  reduce,
  initialState,
  failureBadge,
  failureNeedsOperator,
  needsOperatorAgentIds,
  filterOrderForNeedsOperator,
  type UiState,
} from "@chimera/ui-state";

// F08.UI: "needs operator" is defined by the four disposition BOOLEANS being all-false — never by
// the cause string — so an unknown cause from a newer daemon still buckets correctly. These tests
// lock that definition, the ancestor-preserving row filter, and the selection snap.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("failureNeedsOperator (F08.UI)", () => {
  it("all four disposition booleans false ⇒ needs operator", () => {
    expect(failureNeedsOperator({ cause: "credential", retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false })).toBe(true);
  });
  it("any remedy left ⇒ the engine owns it, not the operator", () => {
    expect(failureNeedsOperator({ cause: "account-cap", retryable: false, failoverAccount: true, holdForReset: true, restartInPlace: false })).toBe(false);
  });
  it("booleans win over the cause: an UNKNOWN cause with no remedy still needs an operator", () => {
    expect(failureNeedsOperator({ cause: "brand-new-cause" as never, retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false })).toBe(true);
  });
  it("older daemon (no booleans on the wire) falls back to the cause table", () => {
    expect(failureNeedsOperator({ cause: "bad-request" })).toBe(true);
    expect(failureNeedsOperator({ cause: "provider-rate-limit" })).toBe(false);
  });
  it("the badge says whose move is next", () => {
    expect(failureBadge({ cause: "credential" })).toBe("⚠ credential rejected · needs you");
    expect(failureBadge({ cause: "account-cap" })).toBe("⚠ account capped · retries spent");
  });
});

const failedFleet = (): UiState => {
  let st = feed(initialState, [
    ev("boss", "agent_started", { model: "m", depth: 0, treeId: "t1" }),
    ev("worker", "agent_started", { model: "m", depth: 1, treeId: "t1", originConductorId: "boss" }),
    ev("other", "agent_started", { model: "m", depth: 0, treeId: "t2" }),
  ]);
  st = feed(st, [ev("worker", "status", { state: "failed", failure: { cause: "credential", retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false } })]);
  // A death the engine can still act on must NOT show up in the needs-you view.
  st = feed(st, [ev("other", "status", { state: "failed", failure: { cause: "provider-rate-limit", retryable: true, failoverAccount: true, holdForReset: false, restartInPlace: false } })]);
  return st;
};

describe("needs-operator fleet filter (F08.UI)", () => {
  it("counts only the deaths the engine has no move for", () => {
    expect(needsOperatorAgentIds(failedFleet())).toEqual(["worker"]);
  });
  it("keeps a deep worker's ancestors so the filter never orphans the row it exists to surface", () => {
    const st = failedFleet();
    expect(filterOrderForNeedsOperator(st, st.agentOrder)).toEqual(["boss", "worker"]);
  });
  it("turning the filter on snaps a now-hidden selection onto a visible row", () => {
    const st = { ...failedFleet(), selectedAgentId: "other" };
    const next = reduce(st, { type: "agentsNeedsOperatorOnly", only: true });
    expect(next.needsOperatorOnly).toBe(true);
    expect(filterOrderForNeedsOperator(next, next.agentOrder)).not.toContain("other");
    expect(next.selectedAgentId).toBe("worker");
  });
  it("turning it off restores the full order", () => {
    const st = { ...failedFleet(), needsOperatorOnly: true };
    expect(reduce(st, { type: "agentsNeedsOperatorOnly", only: false }).needsOperatorOnly).toBe(false);
  });
});

describe("the disposition transcript line (F08.UI)", () => {
  const last = (st: UiState, id: string) => st.agents[id]!.transcript.at(-1)!;

  it("markFailed's status writes ONE system line at the moment the disposition is decided", () => {
    const st = feed(initialState, [
      ev("a", "agent_started", { model: "m" }),
      ev("a", "status", { state: "failed", failure: { cause: "credential", evidence: "A20-auth", retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false } }),
    ]);
    expect(last(st, "a").role).toBe("system");
    expect(last(st, "a").text).toContain("⚠ failed — credential rejected");
    expect(last(st, "a").text).toContain("(rule: A20-auth)");
  });

  it("recovery leaves the trace the (correctly transient) badge cannot", () => {
    let st = feed(initialState, [
      ev("a", "agent_started", { model: "m" }),
      ev("a", "status", { state: "failed", failure: { cause: "credential", retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false } }),
    ]);
    st = feed(st, [ev("a", "agent_started", { model: "m" })]);
    expect(st.agents["a"]!.failure).toBeUndefined();
    expect(last(st, "a").text).toContain('✓ running again after "credential rejected"');
  });

  it("a normal spawn with no prior failure stays silent", () => {
    const st = feed(initialState, [ev("a", "agent_started", { model: "m" })]);
    expect(st.agents["a"]!.transcript.some((t) => t.text.includes("running again after"))).toBe(false);
  });
});
