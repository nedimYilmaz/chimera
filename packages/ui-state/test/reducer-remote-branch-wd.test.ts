import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce, type AgentRecordLite, type UiState } from "@chimera/ui-state";

// WD Stage 1 (coverage B2 + B12): two additive AgentView fields, both DERIVED —
//   * engine: the origin engine of a remote agent, stamped from a non-"local" event
//     engineId (projectEvent) or parsed off a qualified "<engineId>/<localId>"
//     record id (agentRecords) — the daemon adds no field, remote identity already
//     rides the wire in both places;
//   * gitBranch: projected from agent.list's per-record gitBranch (the supervisor's
//     async spawn-time stamp), authoritative-when-present like treeId/membership.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, engineId?: string): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data, ...(engineId ? { engineId } : {}) });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);
const rec = (over: Partial<AgentRecordLite> & { agentId: string }): AgentRecordLite =>
  ({ state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over });

describe("AgentView.engine (WD Stage 1, coverage B2)", () => {
  it("a remote event stamps its engineId onto the (qualified-keyed) agent view", () => {
    const st = feed(initialState, [ev("w1", "agent_started", {}, "studio")]);
    expect(st.agents["studio/w1"]!.engine).toBe("studio");
  });

  it("a local event leaves engine absent (engineId 'local' or missing)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {}, "local"), ev("a2", "agent_started", {})]);
    expect(st.agents["a1"]!.engine).toBeUndefined();
    expect(st.agents["a2"]!.engine).toBeUndefined();
  });

  it("agentRecords derives engine from a qualified record id; a bare id keeps the prior value", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [
      rec({ agentId: "studio/w1" }),
      rec({ agentId: "local-agent" }),
    ] });
    expect(st.agents["studio/w1"]!.engine).toBe("studio");
    expect(st.agents["local-agent"]!.engine).toBeUndefined();
  });

  it("a later bare-keyed snapshot never blanks an event-stamped engine (prev-preserving merge)", () => {
    const withEvent = feed(initialState, [ev("w1", "agent_started", {}, "studio")]);
    const st = reduce(withEvent, { type: "agentRecords", records: [rec({ agentId: "studio/w1" })] });
    expect(st.agents["studio/w1"]!.engine).toBe("studio");
  });
});

describe("AgentView.gitBranch (WD Stage 1, coverage B12)", () => {
  it("projects a record's gitBranch onto the view", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: "main" })] });
    expect(st.agents["a1"]!.gitBranch).toBe("main");
  });

  it("a later snapshot WITHOUT the field keeps the prior branch (probe hasn't landed / older daemon)", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: "main" })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.gitBranch).toBe("main");
  });

  it("a snapshot carrying a NEW branch overwrites (authoritative-when-present, e.g. after a checkout)", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: "main" })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: "release-1" })] });
    expect(st.agents["a1"]!.gitBranch).toBe("release-1");
  });

  it("a malformed (non-string) wire value never clobbers a valid prior projection", () => {
    const first = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: "main" })] });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1", gitBranch: 42 as unknown as string })] });
    expect(st.agents["a1"]!.gitBranch).toBe("main");
  });
});
