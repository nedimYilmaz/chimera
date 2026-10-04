import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce, type UiState } from "@chimera/ui-state";

// SLASH-COMMAND-IN-FLIGHT: a slow slash command showed as a bare "thinking…" with nothing on
// screen to say what was taking the time — /compact on a large context runs for a minute or more,
// which is indistinguishable from a wedged agent. Reported as "I send a slash command and no
// output comes, it just says thinking".
//
// A client cannot infer this from the text: an ordinary message may legitimately start with "/".
// The daemon knows, because it delivered it as a command, so it says so.

let seq = 0;
const ev = (agentId: string, kind: string, data: Record<string, unknown>): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data } as unknown as NormalizedEvent);
const feed = (events: NormalizedEvent[]): UiState =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), initialState);

describe("the in-flight command is named", () => {
  it("remembers a delivered slash command for the turn it starts", () => {
    const s = feed([ev("a", "status", { delivered: true, from: "app", text: "/compact", slash: true })]);
    expect(s.agents["a"]?.pendingCommand).toBe("/compact");
  });

  it("ignores an ordinary message that merely starts with a slash", () => {
    const s = feed([ev("a", "status", { delivered: true, from: "worker", text: "/Users/alice/repo is ready" })]);
    expect(s.agents["a"]?.pendingCommand).toBeUndefined();
  });

  it("clears when the turn ends — the command is done when the turn is, whatever it printed", () => {
    const s = feed([
      ev("a", "status", { delivered: true, from: "app", text: "/compact", slash: true }),
      ev("a", "turn_complete", {}),
    ]);
    expect(s.agents["a"]?.pendingCommand).toBeUndefined();
  });

  it("clears on a result too, not only a clean turn boundary", () => {
    const s = feed([
      ev("a", "status", { delivered: true, from: "app", text: "/effort high", slash: true }),
      ev("a", "result", { costUsd: 0 }),
    ]);
    expect(s.agents["a"]?.pendingCommand).toBeUndefined();
  });

  it("a second command replaces the first rather than stacking", () => {
    const s = feed([
      ev("a", "status", { delivered: true, from: "app", text: "/compact", slash: true }),
      ev("a", "status", { delivered: true, from: "app", text: "/effort high", slash: true }),
    ]);
    expect(s.agents["a"]?.pendingCommand).toBe("/effort high");
  });
});
