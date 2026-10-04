import { describe, it, expect } from "vitest";
import { initialState, reduce, type AgentRecordLite } from "@chimera/ui-state";

// R2 (ctx meter effective-limit): AgentView.effectiveContextLimit — projected from agent.list's
// per-record effectiveContextLimit (the supervisor's launch()-time stamp), authoritative-when-
// present like gitBranch/treeId/membership (reducer-remote-branch-wd.test.ts's own gitBranch
// suite is the precedent this file mirrors, field-for-field the same contract).

const rec = (over: Partial<AgentRecordLite> & { agentId: string }): AgentRecordLite =>
  ({ state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over });

describe("AgentView.effectiveContextLimit (R2 ctx meter)", () => {
  it("projects a record's effectiveContextLimit onto the view", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: 90_000 })] });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(90_000);
  });

  it("a later snapshot WITHOUT the field keeps the prior value (older daemon, or a snapshot that raced ahead of the stamp)", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: 90_000 })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(90_000);
  });

  it("a snapshot carrying a DIFFERENT value overwrites (authoritative-when-present, e.g. after a config.patch changed compactionThreshold)", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: 90_000 })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: 200_000 })] });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(200_000);
  });

  it("a malformed (non-number) wire value never clobbers a valid prior projection", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: 90_000 })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1", effectiveContextLimit: "90000" as unknown as number })] });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(90_000);
  });

  it("absent on a fresh agent when no snapshot has ever carried it", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.effectiveContextLimit).toBeUndefined();
  });

  // CTX-METER-LIVE-FORWARD: the desktop app never re-fetches agent.list after its one-shot
  // bootstrap snapshot (createStore.ts), so a live model change (agent.setModel, or an in-session
  // /model command) previously left this denominator stuck on the pre-change value forever even
  // though agent.model (the chip right next to the meter) DID update live — see MODEL-LIVE and
  // reducer-model-sentinel.test.ts's identical contract for `model`, which this mirrors.
  it("agent_started carrying effectiveContextLimit projects it, same as a snapshot would", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_started", data: { model: "claude-opus-4-8", effectiveContextLimit: 200_000 } },
    });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(200_000);
  });

  it("a later message_complete carrying a NEW effectiveContextLimit (in-session /model change) overwrites the stale one, in lockstep with agent.model", () => {
    const started = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_started", data: { model: "claude-opus-4-8", effectiveContextLimit: 200_000 } },
    });
    const st = reduce(started, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a1", kind: "message_complete", data: { model: "gpt-5.6-sol", effectiveContextLimit: 1_050_000 } },
    });
    expect(st.agents["a1"]!.model).toBe("gpt-5.6-sol");
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(1_050_000);
  });

  it("a message_complete with NO effectiveContextLimit field leaves the prior value untouched (older daemon, or nothing changed this turn)", () => {
    const started = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_started", data: { model: "claude-opus-4-8", effectiveContextLimit: 200_000 } },
    });
    const st = reduce(started, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a1", kind: "message_complete", data: { model: "claude-opus-4-8" } },
    });
    expect(st.agents["a1"]!.effectiveContextLimit).toBe(200_000);
  });
});


it("keeps Codex capacity metadata across reconnects and updates without discarding context usage", () => {
  const limits = { source: "codex" as const, maxWindow: 872000, sessionWindow: 258400, compactAt: 120000 };
  let state = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", provider: "codex", contextLimits: limits })] });
  expect(state.agents.a1!.contextLimits).toEqual(limits);
  state = reduce(state, { type: "event", event: { ts: 1, seq: 1, agentId: "a1", kind: "usage", data: { contextOnly: true, contextUsage: { input_tokens: 100, output_tokens: 20 } } } });
  const usage = state.agents.a1!.ctxUsage;
  state = reduce(state, { type: "event", event: { ts: 2, seq: 2, agentId: "a1", kind: "usage", data: { contextOnly: true, contextLimits: { ...limits, maxWindow: 1050000 } } } });
  expect(state.agents.a1!.ctxUsage).toEqual(usage);
  expect(state.agents.a1!.contextLimits?.maxWindow).toBe(1050000);
  state = reduce(state, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
  expect(state.agents.a1!.contextLimits?.sessionWindow).toBe(258400);
});
