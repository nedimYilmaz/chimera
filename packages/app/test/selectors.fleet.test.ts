import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, reduce, type UiState } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { defaultLiveboardIds, fleetRows, fleetSummary, groupFleetRows, queuePressure } from "../src/state/selectors.fleet";

function fixture(): UiState {
  const a = { ...emptyAgent("a"), state: "running", busy: true, lastEventTs: 1_000, projectId: "p", membership: { team: "red", role: "dev" }, costUsd: 2, usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } };
  const b = { ...emptyAgent("b"), state: "running", busy: false, lastEventTs: 9_000, projectId: "p", membership: { team: "red", role: "qa" }, costUsd: 1 };
  return { ...initialState, agents: { a, b }, agentOrder: ["a", "b"], selectedAgentId: "b", tasks: { t1: { taskId: "t1", queue: "q", state: "blocked", agentId: "a", attempts: 0, priority: 0, subject: "x", updatedAt: 1 } } };
}

describe("fleet projection", () => {
  it("groups deterministically and computes utilization, cost, tokens, stalls", () => {
    const groups = groupFleetRows(fleetRows(fixture(), 70_000), "team");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "red", running: 2, busy: 1, stalled: 1, costUsd: 3, tokens: 15, utilization: .5 });
  });
  it("projects queue pressure and prioritizes selected then anomalous lanes", () => {
    const state = fixture();
    const rows = fleetRows(state, 70_000);
    expect(queuePressure(state)).toEqual([{ queue: "q", pending: 0, blocked: 1, inProgress: 0 }]);
    expect(defaultLiveboardIds(rows, "b")).toEqual(["b", "a"]);
  });
  it("never stalls terminal agents", () => {
    const state = fixture(); state.agents.a = { ...state.agents.a!, state: "done" };
    expect(fleetRows(state, 999_999)[0]!.stalled).toBe(false);
  });
  it("F09: promptStall raises attention without raising stalled — the two concepts stay separate", () => {
    const state = fixture();
    state.agents.b = { ...state.agents.b!, promptStall: { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45_000 } };
    const row = fleetRows(state, 70_000).find((r) => r.agentId === "b")!;
    expect(row.attention).toBe(true);
    expect(row.stalled).toBe(false);
  });
});

describe("PHANTOM-PRINCIPAL-ROWS: fleetSummary/fleetRows never count synthetic notify/job principals", () => {
  it("total stays at the real agent count, not real+synthetic", () => {
    let seq = 0;
    const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
      ({ ts: 1000 + ++seq, seq, agentId, kind, data });
    let state = reduce(initialState, { type: "event", event: ev("a1", "agent_started", { model: "m1" }) });
    state = reduce(state, { type: "event", event: ev("notify", "notify", { ruleId: "job-failed", kind: "job_run_finished", channel: "toast", agentId: "a1", count: 1 }) });
    state = reduce(state, { type: "event", event: ev("job:nightly-sync", "job_run_finished", { job: "nightly-sync", result: "failed", costUsd: 0, error: "boom" }) });

    const rows = fleetRows(state, 70_000);
    expect(rows).toHaveLength(1);
    const summary = fleetSummary(rows, state);
    expect(summary.total).toBe(1);
  });
});

describe("fleetSummary", () => {
  it("rolls up counts, utilization, stalls, cost, top queues, and team/project breakdowns", () => {
    const state = fixture();
    const rows = fleetRows(state, 70_000);
    const summary = fleetSummary(rows, state);
    expect(summary).toMatchObject({
      total: 2,
      byState: { running: 2 },
      activeCount: 2,
      doneCount: 0,
      running: 2,
      busy: 1,
      utilization: 0.5,
      stalled: 1,
      costUsd: 3,
    });
    expect(summary.costByProvider).toEqual([{ key: "local", count: 2, costUsd: 3 }]);
    expect(summary.topQueues).toEqual([{ queue: "q", pending: 0, blocked: 1, inProgress: 0 }]);
    expect(summary.byTeam).toEqual([{ key: "red", count: 2, costUsd: 3 }]);
    expect(summary.byProject).toEqual([{ key: "p", count: 2, costUsd: 3 }]);
  });

  it("splits active vs done and keeps every state key, without dropping the running ones", () => {
    const state = fixture();
    state.agents.c = { ...emptyAgent("c"), state: "done", projectId: "p", membership: { team: "red", role: "dev" }, costUsd: 0.5 };
    state.agentOrder = [...state.agentOrder, "c"];
    const rows = fleetRows(state, 70_000);
    const summary = fleetSummary(rows, state);
    expect(summary.total).toBe(3);
    expect(summary.byState).toEqual({ running: 2, done: 1 });
    expect(summary.activeCount).toBe(2);
    expect(summary.doneCount).toBe(1);
  });

  it("sorts cost-by-provider descending and keeps distinct providers apart", () => {
    const state = fixture();
    state.agents.a = { ...state.agents.a!, provider: "anthropic", costUsd: 1 };
    state.agents.b = { ...state.agents.b!, provider: "openai", costUsd: 5 };
    const rows = fleetRows(state, 70_000);
    const summary = fleetSummary(rows, state);
    expect(summary.costByProvider).toEqual([
      { key: "openai", count: 1, costUsd: 5 },
      { key: "anthropic", count: 1, costUsd: 1 },
    ]);
  });
});
