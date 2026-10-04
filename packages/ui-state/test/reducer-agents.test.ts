import { describe, it, expect } from "vitest";
import { initialState, reduce, type AgentRecordLite } from "@chimera/ui-state";

// F22.2: AgentView.worktreeLeaseHeld/worktreeLeaseDenied/lastWorktreeLeaseDenial — projected
// from the agent.list/listSummary snapshot's AgentRecordLite fields of the same name.
// worktreeLeaseHeld is authoritative-when-present (a released/handed-off lease must clear the
// chip on the very next snapshot); worktreeLeaseDenied/lastWorktreeLeaseDenial are sticky,
// mirroring toolPolicyDenied, so the refusal stays visible even if a later poll races ahead of
// the event that caused it.

const rec = (over: Partial<AgentRecordLite> & { agentId: string }): AgentRecordLite =>
  ({ state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over });

describe("AgentView worktree lease chips — agent.list snapshot fold (F22.2)", () => {
  it("projects worktreeLeaseHeld:true from a snapshot", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseHeld: true })],
    });
    expect(st.agents["a1"]!.worktreeLeaseHeld).toBe(true);
  });

  it("worktreeLeaseHeld is authoritative-when-present: a later snapshot reporting false clears it", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseHeld: true })],
    });
    const st = reduce(first, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseHeld: false })],
    });
    expect(st.agents["a1"]!.worktreeLeaseHeld).toBe(false);
  });

  it("worktreeLeaseHeld keeps the prior value when a later snapshot omits the field (older daemon)", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseHeld: true })],
    });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.worktreeLeaseHeld).toBe(true);
  });

  it("worktreeLeaseDenied is sticky: once a snapshot reports it, a later omission keeps it true", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseDenied: true })],
    });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.worktreeLeaseDenied).toBe(true);
  });

  it("lastWorktreeLeaseDenial overwrites-when-present, and is kept when a later snapshot omits it", () => {
    const denial = { workdirKey: "task-1", owner: "b2", ownerState: "active" as const, at: 111 };
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseDenied: true, lastWorktreeLeaseDenial: denial })],
    });
    expect(first.agents["a1"]!.lastWorktreeLeaseDenial).toEqual(denial);

    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.lastWorktreeLeaseDenial).toEqual(denial);
  });

  it("a fresh denial detail overwrites the prior one", () => {
    const denial1 = { workdirKey: "task-1", owner: "b2", ownerState: "active" as const, at: 111 };
    const denial2 = { workdirKey: "task-1", owner: "b3", ownerState: "retained" as const, at: 222 };
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseDenied: true, lastWorktreeLeaseDenial: denial1 })],
    });
    const st = reduce(first, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", worktreeLeaseDenied: true, lastWorktreeLeaseDenial: denial2 })],
    });
    expect(st.agents["a1"]!.lastWorktreeLeaseDenial).toEqual(denial2);
  });
});
