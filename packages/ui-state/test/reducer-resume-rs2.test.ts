import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

// Task RS2: an `agent_started` event carrying `data.sessionId` (the backend already
// emits this on agent_started; RS1 landed daemon-side resume, this is the TUI-side
// capture) must be projected onto AgentView.sessionId so the self-heal respawn path
// (store.ts) can later thread it into a `resume:<sessionId>` spawn spec.
describe("reducer: agent_started captures sessionId (RS2)", () => {
  it("sets AgentView.sessionId from data.sessionId on agent_started", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { model: "m1", sessionId: "sess-1" } },
    });
    expect(st.agents["a"]!.sessionId).toBe("sess-1");
    expect(st.agents["a"]!.model).toBe("m1");   // pre-existing field capture is untouched
  });

  it("leaves sessionId undefined when agent_started carries no sessionId", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { model: "m1" } },
    });
    expect(st.agents["a"]!.sessionId).toBeUndefined();
  });

  it("ignores a non-string data.sessionId (defensive: malformed/loosely-typed event data)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { sessionId: 42 } },
    });
    expect(st.agents["a"]!.sessionId).toBeUndefined();
  });

  it("a later agent_started WITHOUT sessionId does not clear a previously-captured sessionId (no regression case in the brief, but the reducer's if-guard never assigns undefined over a set value)", () => {
    const withSession = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { sessionId: "sess-1" } },
    });
    const st = reduce(withSession, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.sessionId).toBe("sess-1");
  });

  it("a second agent_started with a DIFFERENT sessionId overwrites (latest-wins)", () => {
    const withSession = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { sessionId: "sess-1" } },
    });
    const st = reduce(withSession, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: { sessionId: "sess-2" } },
    });
    expect(st.agents["a"]!.sessionId).toBe("sess-2");
  });
});
