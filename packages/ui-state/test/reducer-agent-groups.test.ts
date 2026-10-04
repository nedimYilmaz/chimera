import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type NormalizedEvent } from "@chimera/ui-state";

// AGENT-GROUPS Phase 1: mirrors reducer-agent-identity.test.ts's event-only-client drive style —
// no agentRecords seed, since that's exactly the situation the desktop app is always in.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("AgentView.groups folding", () => {
  it("a spawn-time group rides the registration marker (status{registered:true})", () => {
    const s = reduce(initialState, ev({
      agentId: "a1", kind: "status",
      data: { state: "running", registered: true, groups: ["sprint"] },
    }));
    expect(s.agents["a1"]?.groups).toEqual(["sprint"]);
  });

  it("a spawn-time group rides agent_started too", () => {
    const s = reduce(initialState, ev({
      agentId: "a1", kind: "agent_started",
      data: { groups: ["daily"] },
    }));
    expect(s.agents["a1"]?.groups).toEqual(["daily"]);
  });

  it("omits entirely for a plain spawn with no groups — byte-identical to today", () => {
    const s = reduce(initialState, ev({
      agentId: "a1", kind: "agent_started",
      data: {},
    }));
    expect(s.agents["a1"]?.groups).toBeUndefined();
  });

  it("agent.setGroups's LIVE re-emit (a bare status{state, groups}, no `registered` flag) updates the row without a reconnect", () => {
    let s = reduce(initialState, ev({
      agentId: "a1", kind: "agent_started",
      data: { groups: ["sprint"] },
    }));
    expect(s.agents["a1"]?.groups).toEqual(["sprint"]);

    s = reduce(s, ev({
      agentId: "a1", kind: "status",
      data: { state: "running", groups: ["daily"] },
    }));
    expect(s.agents["a1"]?.groups).toEqual(["daily"]);
  });

  it("re-filing into NO groups (an empty array) clears the prior membership live", () => {
    let s = reduce(initialState, ev({
      agentId: "a1", kind: "agent_started",
      data: { groups: ["sprint"] },
    }));
    s = reduce(s, ev({ agentId: "a1", kind: "status", data: { state: "running", groups: [] } }));
    expect(s.agents["a1"]?.groups).toEqual([]);
  });

  it("an agent.list snapshot projects groups the same way jobName does — present wins, absent keeps prior", () => {
    let s = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "claude", provider: "claude", costUsd: 0, createdAt: 1, groups: ["sprint"], spec: {} }],
    });
    expect(s.agents["a1"]?.groups).toEqual(["sprint"]);

    // A later snapshot omitting groups (older-daemon shape, or simply absent on this record)
    // must not clobber the prior projection.
    s = reduce(s, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "claude", provider: "claude", costUsd: 0, createdAt: 1, spec: {} }],
    });
    expect(s.agents["a1"]?.groups).toEqual(["sprint"]);
  });
});
