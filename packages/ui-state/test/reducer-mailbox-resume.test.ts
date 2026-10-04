import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce } from "@chimera/ui-state";

// PAUSED-CONDUCTOR: a wake nobody asked for out loud — mail (or an ask_agent) arriving for a
// dormant agent revives it — used to be invisible: the row just flipped back to running with no
// trace of who woke it or out of which hold. One system line makes it readable in the transcript.

const ev = (agentId: string, kind: string, data: Record<string, unknown> = {}, seq = 1): NormalizedEvent =>
  ({ seq, ts: 1000 + seq, agentId, kind, data } as unknown as NormalizedEvent);

const feed = (events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), initialState);

const PAUSE = ev("c1", "status", { state: "paused", paused: true, reason: "idle-timeout" }, 1);

describe("mailbox-resume fold", () => {
  it("records who woke the agent and which hold it came out of", () => {
    const s = feed([
      PAUSE,
      ev("c1", "status", { state: "running", resumed: true, resumedBy: "mailbox", from: "worker-3", resumedFromPause: "idle-timeout" }, 2),
    ]);
    expect(s.agents["c1"]?.state).toBe("running");
    expect(s.agents["c1"]?.pauseReason).toBeUndefined();
    const last = s.agents["c1"]?.transcript.at(-1);
    expect(last?.role).toBe("system");
    expect(last?.text).toBe("⏵ resumed by mailbox from worker-3 (was idle-timeout)");
  });

  it("an operator-driven resume (no resumedBy) renders exactly as before — no extra line", () => {
    const before = feed([PAUSE]).agents["c1"]?.transcript.length ?? 0;
    const s = feed([PAUSE, ev("c1", "status", { state: "running", resumed: true }, 2)]);
    expect(s.agents["c1"]?.state).toBe("running");
    expect(s.agents["c1"]?.transcript.length).toBe(before);
  });
});
