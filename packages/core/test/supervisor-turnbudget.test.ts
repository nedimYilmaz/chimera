import { describe, it, expect } from "vitest";
import { makeSupervisor } from "./helpers.js";

// SOFT-TURN-LIMIT: the backend-level claude/codex tests cover the actual
// boundary/counting logic; this is the supervisor-side contract those events
// feed into — a `status` event carrying turnBudgetExceeded:true must flag the
// AgentRecord (surfaced on agent.list/agent.status) WITHOUT ever moving state
// off "running", exactly the opposite of an authError/killed/failed status.

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("AgentSupervisor turnBudgetExceeded (SOFT-TURN-LIMIT)", () => {
  it("a turnBudgetExceeded status flags the record but leaves state running", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "status", data: { turnBudgetExceeded: true, turnsCompleted: 40, turnBudget: 40 } } },
      { awaitSend: true },   // parks the agent running (no terminal step) so status() sees it live
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none", turnLimitPolicy: "soft" });
    await settle();
    const st = sup.status(rec.agentId);
    expect(st.state).toBe("running");
    expect(st.turnBudgetExceeded).toBe(true);
    // rides the agent.list snapshot verbatim too (the same path agent.status serves from)
    expect(sup.list().find((a) => a.agentId === rec.agentId)?.turnBudgetExceeded).toBe(true);
  });

  it("never sets turnBudgetExceeded absent an explicit status event (default 'fail'-policy run)", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    expect(sup.status(rec.agentId).turnBudgetExceeded).toBeUndefined();
  });
});
