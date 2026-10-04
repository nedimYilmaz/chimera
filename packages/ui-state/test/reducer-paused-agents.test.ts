import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type PauseReason, type UiState } from "@chimera/ui-state";

// PAUSED-AGENTS-VISIBLE: a paused agent used to be indistinguishable from any other row (the
// app's stateVisual had no "paused" case, and the daemon's live status{paused:true} event was a
// no-op in the shared reducer — only the next agent.list snapshot, which the desktop app fetches
// exactly once per connection, would ever teach the projection an agent had paused). These tests
// lock the fix: the live event AND the snapshot path both fold state/pauseReason/resumeAt, and
// each of the three real pauseReason values (supervisor.ts's parkPaused) survives the fold.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

const PAUSE_REASONS: PauseReason[] = ["session-limit", "crash-loop-backoff", "reattach-recovery"];

describe("reducer: a live parkPaused status event projects state + reason + resumeAt (PAUSED-AGENTS-VISIBLE)", () => {
  for (const reason of PAUSE_REASONS) {
    it(`status{paused:true, reason:'${reason}'} sets state 'paused' and folds reason + resumeAt`, () => {
      const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" }), ev("a1", "message_delta", { text: "working" })]);
      expect(working.agents["a1"]!.state).toBe("running");
      expect(working.agents["a1"]!.busy).toBe(true);

      const paused = feed(working, [ev("a1", "status", { state: "paused", paused: true, reason, resumeScheduledAt: 5000 })]);
      expect(paused.agents["a1"]!.state).toBe("paused");
      expect(paused.agents["a1"]!.pauseReason).toBe(reason);
      expect(paused.agents["a1"]!.resumeAt).toBe(5000);
      // A parked agent isn't mid-turn — the busy dot/elapsed timer must not keep ticking.
      expect(paused.agents["a1"]!.busy).toBe(false);
    });
  }

  it("status{resumed:true} clears state back to 'running' and drops reason + resumeAt", () => {
    const paused = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "status", { state: "paused", paused: true, reason: "session-limit", resumeScheduledAt: 5000 }),
    ]);
    expect(paused.agents["a1"]!.state).toBe("paused");

    const resumed = feed(paused, [ev("a1", "status", { state: "running", resumed: true, account: "main" })]);
    expect(resumed.agents["a1"]!.state).toBe("running");
    expect(resumed.agents["a1"]!.pauseReason).toBeUndefined();
    expect(resumed.agents["a1"]!.resumeAt).toBeUndefined();
  });

  it("a bare status{state:'paused'} with no paused:true flag stays a no-op (locked by reducer-terminal-status.test.ts)", () => {
    const working = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    const st = feed(working, [ev("a1", "status", { state: "paused" })]);
    expect(st.agents["a1"]!.state).toBe("running");
    expect(st.agents["a1"]!.pauseReason).toBeUndefined();
  });
});

describe("reducer: an agent.list snapshot projects state + reason + resumeAt (PAUSED-AGENTS-VISIBLE)", () => {
  const record = (over: Partial<AgentRecordLite>): AgentRecordLite => ({
    agentId: "a1", state: "paused", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over,
  });

  for (const reason of PAUSE_REASONS) {
    it(`a snapshot with state:'paused', pauseReason:'${reason}' projects both onto the view`, () => {
      const st = reduce(initialState, { type: "agentRecords", records: [record({ pauseReason: reason, resumeAt: 9000 })] });
      expect(st.agents["a1"]!.state).toBe("paused");
      expect(st.agents["a1"]!.pauseReason).toBe(reason);
      expect(st.agents["a1"]!.resumeAt).toBe(9000);
    });
  }

  it("a later 'running' snapshot clears a previously-projected pauseReason/resumeAt (no stale badge after resume)", () => {
    const paused = reduce(initialState, {
      type: "agentRecords",
      records: [record({ pauseReason: "crash-loop-backoff", resumeAt: 9000 })],
    });
    expect(paused.agents["a1"]!.pauseReason).toBe("crash-loop-backoff");

    const resumed = reduce(paused, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(resumed.agents["a1"]!.state).toBe("running");
    expect(resumed.agents["a1"]!.pauseReason).toBeUndefined();
    expect(resumed.agents["a1"]!.resumeAt).toBeUndefined();
  });
});
