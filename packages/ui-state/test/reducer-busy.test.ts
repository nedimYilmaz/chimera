import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { emptyAgent, reduce } from "@chimera/ui-state";
import { initialState, type AgentView, type UiState } from "@chimera/ui-state";

// Task T1: per-agent `busy` flag — true while a turn is in progress, false when
// idle/terminal. Foundation for F1 (outbox), F3 (thinking animation), F6
// (per-agent activity). NO other feature logic lives in this file.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

// Full AgentView fixture builder — AgentView REQUIRES resultDetail (types.ts).
function agentFixture(overrides: Partial<AgentView> = {}): AgentView {
  return { ...emptyAgent(overrides.agentId ?? "a1"), ...overrides };
}

describe("reducer: AgentView.busy — emptyAgent default", () => {
  it("emptyAgent seeds busy: false for a freshly-created agent", () => {
    expect(emptyAgent("a1").busy).toBe(false);
  });

  it("a brand-new agent surfaced only via an event (no prior busy-setting kind) starts busy: false", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });
});

describe("reducer: AgentView.busy — event-kind transitions (brief §3)", () => {
  it("message_delta sets busy true; a later turn_complete clears it back to false", () => {
    const st = feed(initialState, [ev("a1", "message_delta", { text: "hi" })]);
    expect(st.agents["a1"]!.busy).toBe(true);
    const st2 = feed(st, [ev("a1", "turn_complete", { turnCostUsd: 0.1 })]);
    expect(st2.agents["a1"]!.busy).toBe(false);
  });

  it("tool_call sets busy true", () => {
    const st = feed(initialState, [ev("a1", "tool_call", { toolName: "Bash" })]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("result clears busy (seeded busy via a prior message_delta)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "result", { text: "done", costUsd: 0.1 }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("error clears busy (seeded busy via a prior message_delta)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "error", { message: "boom" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("status{state:'interrupted'} clears busy (seeded busy via a prior message_delta)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { state: "interrupted" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("tool_call → busy true → turn_complete → busy false → tool_call again → busy true (toggles back and forth)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Bash" }),
      ev("a1", "turn_complete", { turnCostUsd: 0.1 }),
      ev("a1", "tool_call", { toolName: "Edit" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("repeated message_delta events keep busy true (idempotent, no toggling per-event)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "a" }),
      ev("a1", "message_delta", { text: "b" }),
      ev("a1", "message_delta", { text: "c" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("error on an already-idle agent leaves busy false (idempotent, not a toggle)", () => {
    const st = feed(initialState, [ev("a1", "error", { message: "boom" })]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("result on an already-idle agent leaves busy false (idempotent)", () => {
    const st = feed(initialState, [ev("a1", "result", { text: "done" })]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("a combined status event (denied + interrupted together) still clears busy via the interrupted branch", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { denied: true, toolName: "Bash", state: "interrupted" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });
});

describe("reducer: AgentView.busy — event kinds that do NOT touch busy (carry prev.busy)", () => {
  it("agent_started does not touch busy — stays false when not yet working", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("agent_started does not clear an already-busy agent", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "agent_started", { model: "m1" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("message_complete does not touch busy — carries the true value set by the preceding message_delta", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "hel" }),
      ev("a1", "message_complete", { text: "hello" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("tool_result does not touch busy — carries the true value set by the preceding tool_call", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Bash" }),
      ev("a1", "tool_result", { result: "ok" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("permission_request does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "permission_request", { requestId: "r1", toolName: "Bash", input: {}, policy: "tui" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("agent_question does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "agent_question", { questionId: "q1", prompt: "ok?" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("failover does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "failover", { from: "main", to: "second", reason: "429" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a status event with denied:true but no interrupted state does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { denied: true, toolName: "Bash" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a status event with delivered:true does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { delivered: true, from: "mcp", text: "hi" }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a status event with permissionResolved:true does not touch busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { permissionResolved: true, requestId: "r1", allow: false }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a status event with none of the recognized sub-fields is a harmless no-op on busy", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "working" }),
      ev("a1", "status", { somethingUnrelated: true }),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
  });
});

describe("reducer: AgentView.busy — userSent action (brief §5)", () => {
  it("userSent sets busy true for an existing (previously idle) agent", () => {
    const withAgent = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(withAgent.agents["a1"]!.busy).toBe(false);
    const st = reduce(withAgent, { type: "userSent", agentId: "a1", text: "go" });
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("userSent keeps busy true for an already-busy existing agent (idempotent)", () => {
    const withAgent = feed(initialState, [ev("a1", "message_delta", { text: "working" })]);
    expect(withAgent.agents["a1"]!.busy).toBe(true);
    const st = reduce(withAgent, { type: "userSent", agentId: "a1", text: "hurry" });
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("userSent's emptyAgent upsert fallback for an unknown agentId still ends busy: true", () => {
    const st = reduce(initialState, { type: "userSent", agentId: "ghost", text: "x" });
    expect(st.agents["ghost"]).toBeDefined();
    expect(st.agents["ghost"]!.busy).toBe(true);
    // sanity: the rest of the FIX-B3 upsert contract (state:"running") is untouched by this task.
    expect(st.agents["ghost"]!.state).toBe("running");
  });
});

describe("reducer: AgentView.busy — agentRecords merge preserves prev.busy (brief §4)", () => {
  it("a daemon snapshot merge does NOT reset an already-busy agent to false", () => {
    const withBusyAgent = feed(initialState, [ev("a1", "message_delta", { text: "working" })]);
    expect(withBusyAgent.agents["a1"]!.busy).toBe(true);
    const st = reduce(withBusyAgent, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.busy).toBe(true);
  });

  it("a TERMINAL daemon snapshot (killed/done/failed) CLEARS busy on a previously-busy agent", () => {
    // 'killed' only ever arrives via the agentRecords path; a busy agent that dies
    // must not linger busy:true (F1/F6 would misread it as a live working agent).
    for (const terminal of ["killed", "done", "failed"] as const) {
      const withBusyAgent = feed(initialState, [ev("a1", "message_delta", { text: "working" })]);
      expect(withBusyAgent.agents["a1"]!.busy).toBe(true);
      const st = reduce(withBusyAgent, {
        type: "agentRecords",
        records: [{ agentId: "a1", state: terminal, accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      expect(st.agents["a1"]!.busy).toBe(false);
    }
  });

  it("a daemon snapshot merge for an already-idle agent leaves busy false (not flipped on)", () => {
    const withIdleAgent = feed(initialState, [ev("a1", "agent_started", {})]);
    expect(withIdleAgent.agents["a1"]!.busy).toBe(false);
    const st = reduce(withIdleAgent, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.busy).toBe(false);
  });

  it("a daemon snapshot for a brand-new agentId (never seen via events) is built via emptyAgent — busy false", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "fresh", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["fresh"]!.busy).toBe(false);
  });
});

// ELAPSED-TIMER: busySince is the event ts (epoch ms) of the event that drove the
// CURRENT turn busy — stamped ONLY on the false→true transition, held fixed across
// the turn's remaining events, cleared on turn_complete/result/error/terminal. The
// thinking/streaming elapsed counters anchor on this so a UI opened mid-turn shows
// TRUE elapsed (mount time irrelevant). The `ev` helper stamps ts = 1000 + seq.
describe("reducer: AgentView.busySince — turn-start ts (elapsed-timer anchor)", () => {
  it("emptyAgent seeds busySince: undefined", () => {
    expect(emptyAgent("a1").busySince).toBeUndefined();
  });

  it("message_delta stamps busySince to THAT event's ts (the turn start)", () => {
    const st = feed(initialState, [ev("a1", "message_delta", { text: "hi" }, 5)]);
    expect(st.agents["a1"]!.busySince).toBe(1005);
  });

  it("tool_call stamps busySince to its ts", () => {
    const st = feed(initialState, [ev("a1", "tool_call", { toolName: "Bash" }, 7)]);
    expect(st.agents["a1"]!.busySince).toBe(1007);
  });

  it("busySince is FIXED at the turn's FIRST event — later busy-keeping events (higher ts) never bump it", () => {
    // The core elapsed-timer property: a mid-turn UI must read elapsed from when the
    // turn STARTED (1010), not from the latest streaming byte (1050).
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "a" }, 10),
      ev("a1", "message_delta", { text: "b" }, 20),
      ev("a1", "tool_call", { toolName: "Bash" }, 30),
      ev("a1", "tool_result", { result: "ok" }, 40),
      ev("a1", "message_delta", { text: "c" }, 50),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
    expect(st.agents["a1"]!.busySince).toBe(1010);
  });

  it("turn_complete clears busySince back to undefined", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "hi" }, 5),
      ev("a1", "turn_complete", { turnCostUsd: 0.1 }, 9),
    ]);
    expect(st.agents["a1"]!.busySince).toBeUndefined();
  });

  it("result clears busySince", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "w" }, 5),
      ev("a1", "result", { text: "done", costUsd: 0.1 }, 9),
    ]);
    expect(st.agents["a1"]!.busySince).toBeUndefined();
  });

  it("error clears busySince", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "w" }, 5),
      ev("a1", "error", { message: "boom" }, 9),
    ]);
    expect(st.agents["a1"]!.busySince).toBeUndefined();
  });

  it("status{interrupted} clears busySince", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "w" }, 5),
      ev("a1", "status", { state: "interrupted" }, 9),
    ]);
    expect(st.agents["a1"]!.busySince).toBeUndefined();
  });

  it("a NEW turn after turn_complete re-stamps busySince to the new turn's ts (not the old one)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "turn1" }, 10),
      ev("a1", "turn_complete", {}, 15),
      ev("a1", "tool_call", { toolName: "Edit" }, 20),
    ]);
    expect(st.agents["a1"]!.busy).toBe(true);
    expect(st.agents["a1"]!.busySince).toBe(1020);
  });

  it("agentRecords snapshot (state:running) preserves a busy agent's busySince", () => {
    const withBusy = feed(initialState, [ev("a1", "message_delta", { text: "w" }, 12)]);
    expect(withBusy.agents["a1"]!.busySince).toBe(1012);
    const st = reduce(withBusy, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.busySince).toBe(1012);
  });

  it("a TERMINAL agentRecords snapshot clears busySince alongside busy", () => {
    const withBusy = feed(initialState, [ev("a1", "message_delta", { text: "w" }, 12)]);
    const st = reduce(withBusy, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "done", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a1"]!.busy).toBe(false);
    expect(st.agents["a1"]!.busySince).toBeUndefined();
  });
});

describe("reducer: AgentView.busy — fixture sanity (resultDetail required field)", () => {
  it("agentFixture builds a full AgentView (incl. resultDetail) usable directly in state.agents", () => {
    const busyAgent = agentFixture({ agentId: "a1", busy: true });
    const state: UiState = { ...initialState, agents: { a1: busyAgent }, agentOrder: ["a1"] };
    expect(state.agents["a1"]!.busy).toBe(true);
    expect(state.agents["a1"]!.resultDetail).toBeNull();
  });
});
