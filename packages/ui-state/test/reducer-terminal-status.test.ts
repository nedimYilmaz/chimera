import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// Coverage B2/A2 (shared-reducer terminal-state projection): a real daemon
// `status{state:"killed"|"failed"|"interrupted"}` event (emitted by
// supervisor.ts / reattach.ts) must set the agent's final AgentView.state and
// clear busy — else a killed/failed agent renders "running"/busy forever and the
// fleet ◐/⊘ counts never move. Non-terminal status states (paused/running,
// session-limit HOLD + resume) must NOT clobber a live projection.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

// Each terminal daemon status.state mapped to the AgentView.state it must produce.
const TERMINAL_CASES: Array<[string, string]> = [
  ["killed", "killed"],
  ["failed", "failed"],
  ["interrupted", "failed"], // AgentView has no "interrupted" member — maps to "failed"
];

describe("reducer: terminal daemon status events project state + busy (coverage B2/A2)", () => {
  for (const [statusState, expectedState] of TERMINAL_CASES) {
    it(`status{state:'${statusState}'} sets state '${expectedState}' and clears busy on a working agent`, () => {
      const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" })]);
      expect(working.agents["a1"]!.state).toBe("running");
      expect(working.agents["a1"]!.busy).toBe(true);

      const st = feed(working, [ev("a1", "status", { state: statusState })]);
      expect(st.agents["a1"]!.state).toBe(expectedState);
      expect(st.agents["a1"]!.busy).toBe(false);
    });

    it(`status{state:'${statusState}'} clears a pending question and dialog banner`, () => {
      const withPending = feed(initialState, [
        ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" }),
        ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
        ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation", payload: {} }),
      ]);
      expect(withPending.agents["a1"]!.pendingQuestion).not.toBeNull();
      expect(withPending.agents["a1"]!.pendingDialog).not.toBeNull();

      const st = feed(withPending, [ev("a1", "status", { state: statusState })]);
      expect(st.agents["a1"]!.pendingQuestion).toBeNull();
      expect(st.agents["a1"]!.pendingDialog).toBeNull();
    });
  }

  it("status{state:'killed'} on an agent that reported 'running' via agent_started flips it to killed", () => {
    // The exact B2 bug: a real daemon kill event was previously dropped, leaving
    // the AgentView stuck at the running state the agent_started projected.
    const running = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    expect(running.agents["a1"]!.state).toBe("running");

    const st = feed(running, [ev("a1", "status", { state: "killed" })]);
    expect(st.agents["a1"]!.state).toBe("killed");
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("a combined status event (denied + killed together) still records the denial AND goes terminal", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Bash" }),
      ev("a1", "status", { denied: true, toolName: "Bash", state: "killed" }),
    ]);
    expect(st.agents["a1"]!.state).toBe("killed");
    expect(st.agents["a1"]!.busy).toBe(false);
    // the denial is still projected as a denied tool transcript item
    expect(st.agents["a1"]!.transcript.some((t) => t.role === "tool" && t.status === "denied")).toBe(true);
  });
});

describe("reducer: NON-terminal daemon status states leave the live projection intact (coverage B2/A2)", () => {
  for (const nonTerminal of ["paused", "running"] as const) {
    it(`status{state:'${nonTerminal}'} does NOT clobber a busy running agent's state or busy`, () => {
      const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" })]);
      const st = feed(working, [ev("a1", "status", { state: nonTerminal })]);
      expect(st.agents["a1"]!.state).toBe("running");
      expect(st.agents["a1"]!.busy).toBe(true);
    });

    it(`status{state:'${nonTerminal}'} does NOT clear a pending question banner`, () => {
      const withQuestion = feed(initialState, [
        ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" }),
        ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
      ]);
      const st = feed(withQuestion, [ev("a1", "status", { state: nonTerminal })]);
      expect(st.agents["a1"]!.pendingQuestion).not.toBeNull();
    });
  }

  it("a status event with an unrecognized state string is a harmless no-op", () => {
    const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" })]);
    const st = feed(working, [ev("a1", "status", { state: "somethingElse" })]);
    expect(st.agents["a1"]!.state).toBe("running");
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a status event with no state field at all is a harmless no-op on state/busy", () => {
    const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" })]);
    const st = feed(working, [ev("a1", "status", { delivered: true, from: "mcp", text: "hi" })]);
    expect(st.agents["a1"]!.state).toBe("running");
    expect(st.agents["a1"]!.busy).toBe(true);
  });
});

// AGENT-DONE-STATE-STALE-UI: "done" is the ONE terminal transition that arrives via
// the `result` event (not a `status` event — see STATUS_TERMINAL_STATE), and it was
// the ONLY terminal fold that failed to clear pendingQuestion/pendingDialog. Because
// derivedState (app selectors.ts / TUI AgentList) renders "waiting" whenever a banner
// is set REGARDLESS of state, a question/dialog still outstanding when the agent
// completed masked "done" as "waiting" forever (the desktop app never re-polls).
describe("reducer: `result` (done) terminal fold clears stale question/dialog banners (AGENT-DONE-STATE-STALE-UI)", () => {
  it("a `result` event sets state 'done' AND clears a pending question + dialog", () => {
    const withPending = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" }),
      ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation", payload: {} }),
    ]);
    expect(withPending.agents["a1"]!.pendingQuestion).not.toBeNull();
    expect(withPending.agents["a1"]!.pendingDialog).not.toBeNull();

    const st = feed(withPending, [ev("a1", "result", { text: "all done" })]);
    expect(st.agents["a1"]!.state).toBe("done");
    expect(st.agents["a1"]!.busy).toBe(false);
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
    expect(st.agents["a1"]!.pendingDialog).toBeNull();
  });

  it("regression for the exact replay sequence (message_complete → turn_complete → result) with a stranded question", () => {
    // Mirrors agent aedd5f25's terminal seq 25913→25915→25917: a question set on an
    // earlier turn was still stranded when the final turn completed via `result`, so
    // the state cell derived "waiting" minutes after the agent reached "done".
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "claude-opus-4-8" }),
      ev("a1", "agent_question", { questionId: "q1", prompt: "which fix?" }), // stranded from a prior turn
      ev("a1", "message_complete", { text: "Landed and cleaned up." }),
      ev("a1", "turn_complete", { turnCostUsd: 9.6 }),
      ev("a1", "result", { text: "Landed and cleaned up.", costUsd: 9.6 }),
    ]);
    expect(st.agents["a1"]!.state).toBe("done");
    // The projected banner is what derivedState reads to override state with "waiting";
    // cleared here means the state cell now renders "done", not "waiting".
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
    expect(st.agents["a1"]!.pendingDialog).toBeNull();
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("a `result` event on an agent with NO pending banner leaves them null (harmless)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_complete", { text: "hi" }),
      ev("a1", "result", { text: "hi" }),
    ]);
    expect(st.agents["a1"]!.state).toBe("done");
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
    expect(st.agents["a1"]!.pendingDialog).toBeNull();
  });
});

// The reconnect half of the same bug: the app re-fetches agent.list only on connect,
// and agent.list carries NO pending* fields, so a terminal snapshot merged over a
// projection that had a stranded banner would otherwise leave it in place via ...prev.
describe("reducer: a terminal agent.list snapshot clears stale banners; a non-terminal one preserves them (AGENT-DONE-STATE-STALE-UI)", () => {
  for (const terminal of ["done", "killed", "failed"] as const) {
    it(`a '${terminal}' snapshot clears a previously-stranded pending question + dialog`, () => {
      const withPending = feed(initialState, [
        ev("a1", "agent_started", { model: "m1" }),
        ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
        ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation", payload: {} }),
      ]);
      const st = reduce(withPending, {
        type: "agentRecords",
        records: [{ agentId: "a1", state: terminal, accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      expect(st.agents["a1"]!.state).toBe(terminal);
      expect(st.agents["a1"]!.pendingQuestion).toBeNull();
      expect(st.agents["a1"]!.pendingDialog).toBeNull();
    });
  }

  it("a 'running' snapshot does NOT clear a live pending question (agent.list omits pending*, so ...prev must win)", () => {
    const withPending = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
    ]);
    const st = reduce(withPending, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.pendingQuestion).not.toBeNull();
  });
});
