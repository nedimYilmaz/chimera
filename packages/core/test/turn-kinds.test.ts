import { describe, it, expect } from "vitest";
import { TURN_OPENING_KINDS, TURN_CLOSING_KINDS } from "@chimera/core/turn-kinds";

// F09/J4: this module was EXTRACTED from health.ts, not authored. The membership below is the
// literal set health.ts carried before the move — pinned here so a future edit to the stall
// watch cannot quietly widen what counts as "the agent started a turn" for liveness too.
describe("turn kinds (F09/J4: the shared definition of a turn opening/closing)", () => {
  it("the opening set is exactly the pre-extraction membership", () => {
    expect([...TURN_OPENING_KINDS].sort()).toEqual([
      "agent_dialog", "agent_question", "agent_task", "message_complete",
      "message_delta", "permission_request", "tool_call", "tool_result",
    ]);
  });

  it("the closing set is exactly the pre-extraction membership", () => {
    expect([...TURN_CLOSING_KINDS].sort()).toEqual(["agent_started", "error", "result", "turn_complete"]);
  });

  it("no kind is both opening and closing", () => {
    expect([...TURN_OPENING_KINDS].filter((k) => TURN_CLOSING_KINDS.has(k))).toEqual([]);
  });

  it("'status' is neither — a supervisor delivery event is not evidence of a turn (A1 negative)", () => {
    expect(TURN_OPENING_KINDS.has("status")).toBe(false);
    expect(TURN_CLOSING_KINDS.has("status")).toBe(false);
  });
});
