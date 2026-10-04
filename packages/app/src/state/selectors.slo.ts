import type { SliRollupResult, SliTaskSummary, SloThreshold, UsageQueryResult } from "@chimera/protocol";

export const SLO_WINDOWS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;
export type SloWindow = keyof typeof SLO_WINDOWS;
export type SloBreach = { id: string; threshold: SloThreshold; observed: number; taskId?: string; queue?: string };

export function thresholdValue(t: SloThreshold, sli: SliRollupResult, usage: UsageQueryResult): number {
  if (t.metric === "p95_latency_ms") return sli.totals.p95DurationMs ?? 0;
  if (t.metric === "active_age_ms") return Math.max(0, ...sli.tasks.map((x) => x.activeAgeMs ?? 0));
  if (t.metric === "error_rate") return sli.totals.errorRate;
  if (t.metric === "gate_failure_rate") {
    const n = sli.totals.gatePasses + sli.totals.gateFailures;
    return n ? sli.totals.gateFailures / n : 0;
  }
  return usage.totalCostUsd;
}

export function evaluateThresholds(thresholds: readonly SloThreshold[], sli: SliRollupResult, usage: UsageQueryResult): SloBreach[] {
  return thresholds.filter((t) => t.enabled).flatMap((threshold) => {
    const observed = thresholdValue(threshold, sli, usage);
    if (observed <= threshold.limit) return [];
    const task = threshold.metric === "active_age_ms"
      ? [...sli.tasks].sort((a, b) => (b.activeAgeMs ?? 0) - (a.activeAgeMs ?? 0))[0] : undefined;
    return [{ id: `slo:${threshold.id}`, threshold, observed, taskId: task?.taskId, queue: task?.queue ?? undefined }];
  });
}

export function taskDeepLink(task: SliTaskSummary) {
  return { kind: "task" as const, taskId: task.taskId, ...(task.queue ? { queue: task.queue } : {}) };
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const METRIC_LABELS: Record<SloThreshold["metric"], string> = {
  p95_latency_ms: "p95 latency",
  active_age_ms: "oldest active",
  error_rate: "turn errors",
  gate_failure_rate: "gate failures",
  spend_usd: "spend",
};

/** Human label for a threshold's metric — never render `metric` raw (snake_case RPC field name). */
export function metricLabel(metric: SloThreshold["metric"]): string {
  return METRIC_LABELS[metric];
}

/** Format a raw metric value in its native unit (ms / fraction / USD) for display —
 * mirrors thresholdValue's per-metric dispatch so limits and observed values never
 * render as bare numbers (e.g. an error_rate of .1 must read "10.0%", not "0.1"). */
export function formatMetricValue(metric: SloThreshold["metric"], value: number): string {
  if (metric === "p95_latency_ms" || metric === "active_age_ms") return fmtMs(value);
  if (metric === "error_rate" || metric === "gate_failure_rate") return `${(value * 100).toFixed(1)}%`;
  return `$${value.toFixed(2)}`;
}
