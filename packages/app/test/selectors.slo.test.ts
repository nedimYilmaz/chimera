import { describe, expect, it } from "vitest";
import type { SliRollupResult, UsageQueryResult } from "@chimera/protocol";
import { evaluateThresholds, formatMetricValue, metricLabel, taskDeepLink } from "../src/state/selectors.slo";

const sli: SliRollupResult = {
  tasks: [{ taskId: "t1", workflow: "qa", version: 3, startedAt: 1, endedAt: null, activeAgeMs: 1200,
    agentIds: ["a1"], team: "ui", provider: "codex", queue: "features", durationMs: null,
    tokensIn: 10, tokensOut: 5, costUsd: 1, gatePasses: 1, gateFailures: 1, turnCount: 2, errorCount: 1, errorRate: .5, steps: [] }],
  buckets: [], breakdown: [], totals: { durationMs: 0, tokensIn: 10, tokensOut: 5, costUsd: 1, gatePasses: 1,
    gateFailures: 1, turnCount: 2, errorCount: 1, errorRate: .5, completedTasks: 0, activeTasks: 1,
    latencySamples: 0, p50DurationMs: null, p95DurationMs: null },
};
const usage: UsageQueryResult = { totalCostUsd: 3, totalTokensIn: 10, totalTokensOut: 5,
  totalCacheReadTokens: 0, totalCacheCreationTokens: 0, count: 1, groups: [] };

describe("SLO selectors", () => {
  it("breaches strictly above a threshold and preserves the active task drill target", () => {
    const breaches = evaluateThresholds([{ id: "age", metric: "active_age_ms", limit: 1000, window: "24h", enabled: true }], sli, usage);
    expect(breaches).toEqual([{ id: "slo:age", threshold: expect.any(Object), observed: 1200, taskId: "t1", queue: "features" }]);
    expect(taskDeepLink(sli.tasks[0]!)).toEqual({ kind: "task", taskId: "t1", queue: "features" });
  });
  it("does not breach equality or disabled thresholds", () => {
    expect(evaluateThresholds([
      { id: "cost", metric: "spend_usd", limit: 3, window: "24h", enabled: true },
      { id: "err", metric: "error_rate", limit: .1, window: "24h", enabled: false },
    ], sli, usage)).toEqual([]);
  });
});

describe("SLO metric formatting", () => {
  it("formats each metric in its native unit instead of a bare number", () => {
    expect(formatMetricValue("p95_latency_ms", 300_000)).toBe("5.0m");
    expect(formatMetricValue("active_age_ms", 1500)).toBe("1.5s");
    expect(formatMetricValue("error_rate", .1)).toBe("10.0%");
    expect(formatMetricValue("gate_failure_rate", .5)).toBe("50.0%");
    expect(formatMetricValue("spend_usd", 12.5)).toBe("$12.50");
  });
  it("labels every metric with a human-readable, non-snake_case string", () => {
    expect(metricLabel("p95_latency_ms")).toBe("p95 latency");
    expect(metricLabel("active_age_ms")).toBe("oldest active");
    expect(metricLabel("error_rate")).toBe("turn errors");
    expect(metricLabel("gate_failure_rate")).toBe("gate failures");
    expect(metricLabel("spend_usd")).toBe("spend");
    for (const metric of ["p95_latency_ms", "active_age_ms", "error_rate", "gate_failure_rate", "spend_usd"] as const) {
      expect(metricLabel(metric)).not.toMatch(/_/);
    }
  });
});
