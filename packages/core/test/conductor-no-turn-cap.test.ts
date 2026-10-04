import { describe, it, expect } from "vitest";
import { resolveAgentSpec } from "@chimera/core/supervisor";

// CONDUCTOR-NO-TURN-CAP: a conductor is an interactive, multi-turn seat by contract — the same
// contract that already forces `persistent`. The spec default (maxTurns 40, turnLimitPolicy
// "fail") scheduled a project conductor to die on its 40th turn and take the project's routing
// with it. Normalized at the one spawn entry every RPC/MCP/UI path traverses.

describe("conductor turn limits", () => {
  it("a conductor runs past its turn budget instead of failing on it", () => {
    const spec = resolveAgentSpec({ prompt: "p", cwd: "/tmp", conductor: true });
    expect(spec.turnLimitPolicy).toBe("soft");
    expect(spec.persistent).toBe(true);      // the sibling invariant, unchanged
  });

  it("an explicit 'fail' on a conductor is still honoured — this is a default, not an override", () => {
    const spec = resolveAgentSpec({ prompt: "p", cwd: "/tmp", conductor: true, turnLimitPolicy: "fail" });
    expect(spec.turnLimitPolicy).toBe("fail");
  });

  it("an ordinary worker is untouched — a turn cap is a real guardrail for one-shot work", () => {
    const spec = resolveAgentSpec({ prompt: "p", cwd: "/tmp" });
    expect(spec.turnLimitPolicy).toBe("fail");
    expect(spec.maxTurns).toBe(40);
  });

  it("keeps the budget NUMBER, so the turnBudgetExceeded signal is not lost", () => {
    const spec = resolveAgentSpec({ prompt: "p", cwd: "/tmp", conductor: true, maxTurns: 200 });
    expect(spec.maxTurns).toBe(200);
    expect(spec.turnLimitPolicy).toBe("soft");
  });
});
