import { describe, it, expect } from "vitest";
import { resolveAgentSpec } from "@chimera/core/supervisor";

// SESSION-IS-A-CHAT-NOT-A-TASK: a quick-spawned session is opened to work WITH — the operator
// decides when it is finished, which is why the agent list keeps a finished session's row until
// they dismiss it. Without `persistent` the backend closed its input the moment its first turn
// went idle, so it answered once and died: you had to spawn a new one to ask the follow-up.

const spec = (over: Record<string, unknown> = {}) =>
  resolveAgentSpec({ prompt: "p", cwd: "/tmp", ...over });

describe("an ad-hoc session outlives its first turn", () => {
  it("is persistent, so the backend never closes its input after an idle turn", () => {
    expect(spec({ session: true }).persistent).toBe(true);
  });

  it("and is not turn-capped — the fix above would otherwise buy a session that freezes instead of dying", () => {
    expect(spec({ session: true }).turnLimitPolicy).toBe("soft");
  });

  it("keeps the operator's explicit choice either way", () => {
    expect(spec({ session: true, turnLimitPolicy: "fail" }).turnLimitPolicy).toBe("fail");
    expect(spec({ session: true, persistent: true }).persistent).toBe(true);
  });
});

describe("what this does NOT change", () => {
  it("an ordinary one-shot worker still ends when its work ends — that IS the contract there", () => {
    const s = spec();
    expect(s.persistent).toBe(false);
    expect(s.turnLimitPolicy).toBe("fail");
  });

  it("a conductor is unaffected — it already had both, for the same reasons", () => {
    const s = spec({ conductor: true });
    expect(s.persistent).toBe(true);
    expect(s.turnLimitPolicy).toBe("soft");
  });

  it("the turn BUDGET number survives — soft makes it a signal, not a cap", () => {
    expect(spec({ session: true, maxTurns: 200 }).maxTurns).toBe(200);
  });
});
