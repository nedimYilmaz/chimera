import { describe, it, expect } from "vitest";
import { AgentSupervisor } from "@chimera/core/supervisor";
import type { AgentRecord } from "@chimera/core/supervisor";

// CLOCKLESS-HOLD-SURVIVES-RESTART: `resumeAt` separates a pause that is waiting for a MOMENT
// (session-limit, crash backoff) from one waiting for a DECISION (idle-timeout, daemon-restart,
// operator-hold). reattachPaused read `resumeAt ?? now()` and resumed anything already due —
// which for a clockless hold is now() <= now(), always true. Every clockless pause therefore came
// back RUNNING on the next daemon start, reported as "paused agents turned into running ones
// after a reinstall".

const harness = () => {
  const resumed: string[] = [];
  const scheduled: Array<{ agentId: string; at: number }> = [];
  const NOW = 1_000_000;
  const sup = Object.create(AgentSupervisor.prototype) as AgentSupervisor & Record<string, unknown>;
  Object.assign(sup, {
    agents: new Map<string, AgentRecord>(),
    generation: 0,
    now: () => NOW,
    resumePaused: async (id: string) => { resumed.push(id); },
    scheduleResume: (id: string, at: number) => { scheduled.push({ agentId: id, at }); },
  });
  return { sup, resumed, scheduled, NOW };
};

const rec = (over: Partial<AgentRecord>): AgentRecord =>
  ({ agentId: "a1", state: "paused", ...over } as AgentRecord);

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("reattachPaused", () => {
  it("leaves an OPERATOR HOLD held — a restart is not a release", async () => {
    const { sup, resumed, scheduled } = harness();
    sup.reattachPaused(rec({ pauseReason: "operator-hold" }));
    await settle();
    expect(resumed).toEqual([]);
    expect(scheduled).toEqual([]);
    expect((sup.agents as Map<string, AgentRecord>).get("a1")).toMatchObject({ state: "paused", pauseReason: "operator-hold" });
  });

  it("leaves an idle-reaped agent parked — its process was reclaimed, not owed a restart", async () => {
    const { sup, resumed } = harness();
    sup.reattachPaused(rec({ pauseReason: "idle-timeout" }));
    await settle();
    expect(resumed).toEqual([]);
  });

  it("leaves a restart-dormant agent dormant — otherwise lazy reattach undoes itself on the next boot", async () => {
    const { sup, resumed } = harness();
    sup.reattachPaused(rec({ pauseReason: "daemon-restart" }));
    await settle();
    expect(resumed).toEqual([]);
  });

  it("still resumes a session-limit hold whose reset passed while the daemon was down", async () => {
    const { sup, resumed, NOW } = harness();
    sup.reattachPaused(rec({ pauseReason: "session-limit", resumeAt: NOW - 60_000 }));
    await settle();
    expect(resumed).toEqual(["a1"]);
  });

  it("and re-arms one whose reset is still ahead — the clock survives the restart", async () => {
    const { sup, resumed, scheduled, NOW } = harness();
    sup.reattachPaused(rec({ pauseReason: "session-limit", resumeAt: NOW + 60_000 }));
    await settle();
    expect(resumed).toEqual([]);
    expect(scheduled).toEqual([{ agentId: "a1", at: NOW + 60_000 }]);
  });

  it("registers the record either way — a held agent must still appear in the roster", () => {
    const { sup } = harness();
    sup.reattachPaused(rec({ pauseReason: "operator-hold" }));
    expect((sup.agents as Map<string, AgentRecord>).has("a1")).toBe(true);
  });
});
