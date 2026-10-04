import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { firstPendingDialog, initialState, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: agent_dialog projection (Task DLG3, TDD test 1)", () => {
  it("projects an agent_dialog event into the agent's pendingDialog", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", {
        dialogId: "d1",
        dialogKind: "permission_ask_user_question",
        payload: { questions: [{ question: "deploy?", options: [{ label: "yes" }, { label: "no" }] }] },
        toolUseId: "tu1",
      }),
    ]);
    expect(st.agents["a1"]!.pendingDialog).toEqual({
      dialogId: "d1",
      dialogKind: "permission_ask_user_question",
      payload: { questions: [{ question: "deploy?", options: [{ label: "yes" }, { label: "no" }] }] },
    });
  });

  it("defaults dialogId/dialogKind to empty string and payload to {} when the event omits them", () => {
    const st = feed(initialState, [ev("a1", "agent_dialog", {})]);
    expect(st.agents["a1"]!.pendingDialog).toEqual({ dialogId: "", dialogKind: "", payload: {} });
  });

  it("a second agent_dialog for the same agent replaces the first (no queueing)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: { message: "one" } }),
      ev("a1", "agent_dialog", { dialogId: "d2", dialogKind: "elicitation_dialog", payload: { message: "two" } }),
    ]);
    expect(st.agents["a1"]!.pendingDialog?.dialogId).toBe("d2");
  });

  it("a status{dialogResolved,dialogId} event for the matching dialogId clears pendingDialog (TDD test 1)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: {} }),
    ]);
    expect(st.agents["a1"]!.pendingDialog).not.toBeNull();
    const st2 = feed(st, [ev("a1", "status", { dialogResolved: true, dialogId: "d1", timedOut: true })]);
    expect(st2.agents["a1"]!.pendingDialog).toBeNull();
  });

  it("a dialogResolved status event for a DIFFERENT (stale) dialogId does not clear the current pendingDialog", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
      ev("a1", "agent_dialog", { dialogId: "d2", dialogKind: "elicitation_dialog", payload: {} }),   // replaces d1
    ]);
    const st2 = feed(st, [ev("a1", "status", { dialogResolved: true, dialogId: "d1" })]);   // stale resolution for d1
    expect(st2.agents["a1"]!.pendingDialog?.dialogId).toBe("d2");
  });

  it("a status event without dialogResolved:true does not touch pendingDialog", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = feed(st, [ev("a1", "status", { denied: true, toolName: "Bash" })]);
    expect(st2.agents["a1"]!.pendingDialog?.dialogId).toBe("d1");
  });

  it("dialogAnswered action clears the matching agent's pendingDialog by dialogId alone (no agentId in the action)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = reduce(st, { type: "dialogAnswered", dialogId: "d1" });
    expect(st2.agents["a1"]!.pendingDialog).toBeNull();
  });

  it("dialogAnswered is a no-op when no agent's pendingDialog matches the given dialogId", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = reduce(st, { type: "dialogAnswered", dialogId: "unknown-id" });
    expect(st2.agents["a1"]!.pendingDialog?.dialogId).toBe("d1");
  });

  it("clears pendingDialog on an error event (terminal state)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = feed(st, [ev("a1", "error", { message: "boom" })]);
    expect(st2.agents["a1"]!.pendingDialog).toBeNull();
    expect(st2.agents["a1"]!.state).toBe("failed");
  });

  it("clears pendingDialog on an interrupted status event (terminal state)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = feed(st, [ev("a1", "status", { state: "interrupted" })]);
    expect(st2.agents["a1"]!.pendingDialog).toBeNull();
    expect(st2.agents["a1"]!.state).toBe("failed");
  });

  it("a 'result' event (terminal 'done') clears pendingDialog, mirroring error/interrupted (AGENT-DONE-STATE-STALE-UI)", () => {
    // `result` is emitted ONCE when the agent session terminates (backends/claude.ts:680,
    // after the SDK query loop drains) and the reducer maps it to state "done". A done
    // agent cannot act on a pending dialog, so leaving it set made derivedState render
    // "waiting" for a finished agent (the exact reported bug). Now clears like the other
    // terminal folds — the former "scope boundary: only error/interrupted do" was wrong.
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "d1", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    const st2 = feed(st, [ev("a1", "result", { text: "done", costUsd: 0.1 })]);
    expect(st2.agents["a1"]!.state).toBe("done");
    expect(st2.agents["a1"]!.pendingDialog).toBeNull();
  });
});

describe("firstPendingDialog (Task DLG3)", () => {
  it("returns null when no agent has a pendingDialog", () => {
    expect(firstPendingDialog(initialState)).toBeNull();
  });

  it("aggregates across agents in agentOrder and tags the result with agentId", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", {}),
      ev("a2", "agent_dialog", { dialogId: "d2", dialogKind: "elicitation_dialog", payload: { message: "hi" } }),
    ]);
    expect(firstPendingDialog(st)).toEqual({ dialogId: "d2", dialogKind: "elicitation_dialog", payload: { message: "hi" }, agentId: "a2" });
  });

  it("returns the FIRST agent's dialog (by agentOrder) when multiple agents have one pending", () => {
    const st = feed(initialState, [
      ev("a1", "agent_dialog", { dialogId: "first", dialogKind: "elicitation_dialog", payload: {} }),
      ev("a2", "agent_dialog", { dialogId: "second", dialogKind: "elicitation_dialog", payload: {} }),
    ]);
    expect(firstPendingDialog(st)?.dialogId).toBe("first");
  });
});
