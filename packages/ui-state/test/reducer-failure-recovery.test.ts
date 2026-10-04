import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce, initialState, failureCauseLabel, type AgentRecordLite, type UiState } from "@chimera/ui-state";

// F08.QA: the daemon CLEARS the disposition on recovery — supervisor.ts's agent_started handler
// does `delete record.failure` right next to `record.crashCount = 0`. Neither F08 fold could
// represent that clear (the live fold only ever assigns; the snapshot fold was `r.failure ??
// prev.failure`), so a recovered agent kept its old badge in the view and a LATER death that
// carried no disposition — which is most of them: only onError and the crash-loop breaker pass
// `failure`, the other ten markFailed sites do not — was labelled with the previous incident's
// cause. Same hazard, same shape, as the F09 promptStall fold below it in the same object.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);
const record = (over: Partial<AgentRecordLite>): AgentRecordLite => ({
  agentId: "a1", state: "failed", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over,
});

describe("reducer: a recovered agent drops its stale failure badge (F08.QA)", () => {
  it("agent_started clears the disposition, mirroring supervisor.ts's own reset-on-recovery", () => {
    const failed = feed(initialState, [
      ev("a1", "agent_started", {}),
      ev("a1", "status", { state: "failed", error: "429", failure: { cause: "account-cap", evidence: "e", at: 1 } }),
    ]);
    expect(failed.agents["a1"]!.failure?.cause).toBe("account-cap");

    const restarted = feed(failed, [ev("a1", "agent_started", {})]);
    expect(restarted.agents["a1"]!.failure).toBeUndefined();
  });

  it("a second death that carries NO disposition is not labelled with the first one's cause", () => {
    // The exact operator-visible lie: resume/handoff/rebind failures reach markFailed with no
    // `failure` key at all, so the row would otherwise still read "⚠ account capped".
    const st = feed(initialState, [
      ev("a1", "agent_started", {}),
      ev("a1", "status", { state: "failed", error: "429", failure: { cause: "account-cap", evidence: "e", at: 1 } }),
      ev("a1", "agent_started", {}),
      ev("a1", "status", { state: "failed", error: "resume failed: worktree gone" }),
    ]);
    expect(st.agents["a1"]!.failure).toBeUndefined();
  });

  it("an agent.list snapshot of a RUNNING record clears a disposition the daemon already deleted", () => {
    const failed = reduce(initialState, { type: "agentRecords", records: [record({ failure: { cause: "credential" } })] });
    const running = reduce(failed, { type: "agentRecords", records: [record({ state: "running" })] });
    expect(running.agents["a1"]!.failure).toBeUndefined();
  });

  // The one case where `prev` must still win: createStore.ts subscribes BEFORE it fetches
  // agent.list, so a disposition folded live from the death event can arrive while the snapshot
  // is still in flight. That older snapshot still says "failed" — it must not erase the cause.
  it("...but a still-FAILED record with no `failure` key keeps prev (the connect race)", () => {
    const failed = reduce(initialState, { type: "agentRecords", records: [record({ failure: { cause: "credential" } })] });
    const still = reduce(failed, { type: "agentRecords", records: [record({})] });
    expect(still.agents["a1"]!.failure).toEqual({ cause: "credential" });
  });
});

describe("failureCauseLabel: forward compatibility (F08.QA)", () => {
  it("degrades an unmapped cause to the raw wire value instead of rendering `undefined`", () => {
    // The reducer's live fold admits ANY string cause, so a newer daemon's seventh cause reaches
    // an older client's label table; the TUI badge is a bare template literal (AgentList.tsx's
    // `⚠ ${failureCauseLabel(...)}`), so a missing entry printed the word "undefined" at the
    // operator.
    expect(failureCauseLabel("quota-exhausted" as never)).toBe("quota-exhausted");
    expect(failureCauseLabel(undefined)).toBe("unknown cause");
    expect(failureCauseLabel("unclassified")).toBe("unclassified failure");
  });
});
