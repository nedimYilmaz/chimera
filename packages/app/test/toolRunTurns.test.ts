import { describe, expect, it } from "vitest";
import { toolRunTurns } from "../src/state/selectors";
import type { TranscriptItem } from "@chimera/ui-state";

// TURN-COST-VISIBLE — how many model turns a tool strip actually cost.
//
// The strip collapses a maximal run of CONSECUTIVE tool calls into one "Bash ×3", regardless of
// which assistant message produced them. So the thing that reads as one step is usually three, and
// each extra turn is another full re-read of the whole context — which is where the money goes.
// Measured across the event log: 91% of multi-tool strips span several turns, 623 of the "×3"
// strips are three turns against 26 that are one.
//
// The operator could not see that difference. These pin what the readout says, including the two
// cases where it must say nothing rather than guess.

const tool = (turnId?: string): TranscriptItem =>
  ({ role: "tool", toolName: "Bash", status: "done", ...(turnId ? { turnId } : {}) }) as TranscriptItem;

const items = (...ids: Array<string | undefined>) =>
  ids.map(tool) as ReadonlyArray<Extract<TranscriptItem, { role: "tool" }>>;

describe("toolRunTurns", () => {
  it("counts three separate turns — the case that costs three context reads", () => {
    expect(toolRunTurns(items("m1", "m2", "m3"))).toBe(3);
  });

  it("counts one turn when the calls were batched into a single message", () => {
    // Same strip on screen, a third of the cost. This is the distinction the whole readout exists
    // to make visible.
    expect(toolRunTurns(items("m1", "m1", "m1"))).toBe(1);
  });

  it("counts the distinct turns of a partly-batched run", () => {
    expect(toolRunTurns(items("m1", "m1", "m2"))).toBe(2);
  });

  it("says NOTHING when no call reports a turn", () => {
    // An older daemon, or a backend that does not emit one. Zero means "no readout" — inventing a
    // count from the call count would report exactly the thing being measured, wrongly.
    expect(toolRunTurns(items(undefined, undefined))).toBe(0);
  });

  it("counts only what was actually reported in a mixed run", () => {
    // Half-reported is still better than silent, and must not be inflated by the unreported half.
    expect(toolRunTurns(items("m1", undefined, "m1"))).toBe(1);
    expect(toolRunTurns(items("m1", undefined, "m2"))).toBe(2);
  });

  it("handles an empty run", () => {
    expect(toolRunTurns([])).toBe(0);
  });
});
