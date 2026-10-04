import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce } from "@chimera/ui-state";

// COMPACTION-IN-PROGRESS: compaction used to be observable only AFTER the fact, so an operator
// watching the ctx bar drop had no way to tell a compaction from a glitch. The phase tag makes
// the running state foldable — and, just as importantly, keeps it bounded.

const ev = (agentId: string, kind: string, data: Record<string, unknown> = {}, seq = 1): NormalizedEvent =>
  ({ seq, ts: 1000 + seq, agentId, kind, data } as unknown as NormalizedEvent);

const feed = (events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), initialState);

describe("compaction phase fold", () => {
  it("marks the agent compacting on start, without counting a compaction that has not happened", () => {
    const s = feed([ev("a", "compaction", { phase: "start", trigger: "manual" })]);
    expect(s.agents["a"]?.compacting).toBe(true);
    expect(s.agents["a"]?.compactions ?? 0).toBe(0);
    expect(s.agents["a"]?.transcript.length ?? 0).toBe(0);      // no banner for a start
  });

  it("clears it and counts once on completion", () => {
    const s = feed([
      ev("a", "compaction", { phase: "start", trigger: "manual" }, 1),
      ev("a", "compaction", { trigger: "manual", owner: "sdk", before: { tokens: 100 }, after: { tokens: 20 } }, 2),
    ]);
    expect(s.agents["a"]?.compacting).toBe(false);
    expect(s.agents["a"]?.compactions).toBe(1);
  });

  it("an aborted trigger releases the state without inventing a compaction", () => {
    const s = feed([
      ev("a", "compaction", { phase: "start" }, 1),
      ev("a", "compaction", { phase: "aborted", error: "stream closed" }, 2),
    ]);
    expect(s.agents["a"]?.compacting).toBe(false);
    expect(s.agents["a"]?.compactions ?? 0).toBe(0);
  });

  it("a phase-less event is a completion — every pre-existing backend emitter is unchanged", () => {
    const s = feed([ev("a", "compaction", { trigger: "budget", owner: "chimera" })]);
    expect(s.agents["a"]?.compactions).toBe(1);
    expect(s.agents["a"]?.compacting).toBe(false);
  });

  it("cannot outlive the AGENT — once it is done, no completion event is ever coming", () => {
    const s = feed([
      ev("a", "compaction", { phase: "start" }, 1),
      ev("a", "result", { costUsd: 0 }, 2),
    ]);
    expect(s.agents["a"]?.compacting).toBe(false);
  });
});

// COMPACTION-OUTLIVES-THE-TURN — a provider-native /compact keeps working after the turn that
// requested it ends. Observed live: the turn_complete landed 3s after the compaction START and the
// completion arrived 3m11s later, so the app reported "finished" while ~800k tokens were still
// being compacted, and the banner turned up only after the operator had sent their next message.
//
// The rule these pin: a compaction the PROVIDER announced is ended by its own completion; one
// chimera merely requested is still bounded by the turn; a terminal agent ends either.
describe("a compaction the provider announced", () => {
  const started = (seq: number) => ev("a", "compaction", { phase: "start", trigger: "manual" }, seq);

  it("survives the turn that requested it", () => {
    const s = feed([started(1), ev("a", "turn_complete", { turnCostUsd: 0.1 }, 2)]);
    expect(s.agents["a"]?.compacting).toBe(true);
  });

  it("survives several turns — the operator can keep talking while it runs", () => {
    const s = feed([
      started(1),
      ev("a", "turn_complete", {}, 2),
      ev("a", "agent_started", {}, 3),
      ev("a", "turn_complete", {}, 4),
    ]);
    expect(s.agents["a"]?.compacting).toBe(true);
  });

  it("is ended by its own completion, and counted exactly once", () => {
    const s = feed([
      started(1),
      ev("a", "turn_complete", {}, 2),
      ev("a", "compaction", { trigger: "manual", owner: "sdk", before: { tokens: 799207 }, after: { tokens: 19790 } }, 3),
    ]);
    expect(s.agents["a"]?.compacting).toBe(false);
    expect(s.agents["a"]?.compactions).toBe(1);
  });

  it("is ended by an abort too", () => {
    const s = feed([started(1), ev("a", "turn_complete", {}, 2), ev("a", "compaction", { phase: "aborted" }, 3)]);
    expect(s.agents["a"]?.compacting).toBe(false);
  });

  it.each([
    ["error", "error", { message: "boom" }],
    ["paused", "status", { paused: true, reason: "sessionLimit" }],
  ])("is ended when the agent goes %s — nothing will report it now", (_label, kind, data) => {
    const s = feed([started(1), ev("a", kind, data as Record<string, unknown>, 2)]);
    expect(s.agents["a"]?.compacting).toBe(false);
  });
});

describe("a compaction chimera only REQUESTED", () => {
  it("stays bounded by the turn — a provider that swallowed the command must not spin forever", () => {
    // No phase:"start" ever arrived, so nothing confirmed it began. This is the case the old
    // unconditional turn bound existed for, and it is unchanged.
    const s = feed([ev("a", "turn_complete", {}, 1)]);
    expect(s.agents["a"]?.compacting).toBe(false);
  });
});
