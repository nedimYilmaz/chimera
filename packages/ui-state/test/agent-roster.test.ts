import { describe, expect, it } from "vitest";
import { initialState, reduce, type AgentRecordLite, type UiState } from "@chimera/ui-state";

const record = (agentId: string, state: AgentRecordLite["state"] = "paused"): AgentRecordLite =>
  ({ agentId, state, accountName: "codex", provider: "codex", costUsd: 0, createdAt: 1 });
const seed = () => reduce(initialState, { type: "agentRecords", records: [record("gone", "done"), record("paused")] });
const started = (state: UiState, agentId: string, seq: number) => reduce(state, { type: "event", event: { agentId, seq, ts: seq, kind: "agent_started", data: {} } });

describe("authoritative agent roster", () => {
  it("removes vanished agents and associated UI targets while keeping paused agents", () => {
    const state = { ...seed(), selectedAgentId: "gone", markedAgentIds: ["gone", "paused"], liveboardLanes: [{ agentId: "gone", follow: true, unread: 0 }] };
    const next = reduce(state, { type: "agentRecords", records: [record("paused")] });
    expect(Object.keys(next.agents)).toEqual(["paused"]);
    expect(next.agents.paused?.state).toBe("paused");
    expect(next.selectedAgentId).toBe("paused");
    expect(next.markedAgentIds).toEqual(["paused"]);
    expect(next.liveboardLanes).toEqual([]);
  });

  it("does not resurrect removed agents from delayed events or detail/history replies", () => {
    const pruned = reduce(seed(), { type: "agentRecords", records: [record("paused")] });
    const event = { agentId: "gone", seq: 10, ts: 10, kind: "agent_started" as const, data: {} };
    const next = reduce(pruned, { type: "event", event });
    expect(next.agents.gone).toBeUndefined();
    expect(next.lastSeq).toBe(10);
    expect(reduce(next, { type: "backfillHistory", agentId: "gone", events: [event] })).toBe(next);
    expect(reduce(next, { type: "historyLoadFailed", agentId: "gone", message: "unknown agent" })).toBe(next);
    expect(reduce(next, { type: "agentResult", agentId: "gone", detail: {} })).toBe(next);
  });

  it("retains new live agents that arrive during a roster request", () => {
    const before = started(seed(), "gone", 10);
    const during = started(before, "new", 11);
    const next = reduce(during, { type: "agentRecords", records: [record("paused")], sinceSeq: 10 });
    expect(next.agentOrder).toEqual(["paused", "new"]);
    expect(next.agents.gone).toBeUndefined();
    expect(next.agents.new?.state).toBe("running");
  });

  it.each(["forget", "purge"])("removes daemon-deleted rows immediately on %s events", kind => {
    const next = reduce(seed(), { type: "event", event: { agentId: kind === "forget" ? "eventlog" : "supervisor", seq: 20, ts: 20, kind: "status",
      data: { agentIds: ["gone"], ...(kind === "forget" ? { forgotten: 1 } : { state: "purged_terminal_sessions", count: 1 }) } } });
    expect(next.agentOrder).toEqual(["paused"]);
    const staleReply = reduce(next, { type: "agentRecords", records: [record("gone"), record("paused")], sinceSeq: 19 });
    expect(staleReply.agents.gone).toBeUndefined();
    const confirmedLater = reduce(staleReply, { type: "agentRecords", records: [record("gone"), record("paused")], sinceSeq: 20 });
    expect(confirmedLater.agents.gone).toBeDefined();
  });
});
