import { describe, expect, it, vi } from "vitest";
import type { SliRollupResult, UsageQueryResult } from "@chimera/protocol";
import { createSloCommands } from "../src/state/commands.slo";

const sli = { tasks: [], buckets: [], breakdown: [], totals: { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
  gatePasses: 0, gateFailures: 0, turnCount: 0, errorCount: 0, errorRate: 0, completedTasks: 0, activeTasks: 0,
  latencySamples: 0, p50DurationMs: null, p95DurationMs: null } } satisfies SliRollupResult;
const usage = { totalCostUsd: 4, totalTokensIn: 0, totalTokensOut: 0, totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0, count: 0, groups: [] } satisfies UsageQueryResult;

describe("SLO query store", () => {
  it("queries SLI and usage over the exact same window and shapes a breach once", async () => {
    const calls: Array<{ method: string; params: any }> = []; const notified = vi.fn();
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "sli.rollup") return sli as T;
      if (method === "usage.query") return usage as T;
      if (method === "config.get") return { sloThresholds: [{ id: "cost", metric: "spend_usd", limit: 2, window: "24h", enabled: true }] } as T;
      return {} as T;
    };
    const cmd = createSloCommands(request, () => 1_000_000, notified);
    await cmd.loadThresholds(); await cmd.refresh(); await cmd.refresh();
    const qs = calls.filter((c) => c.method === "sli.rollup" || c.method === "usage.query").slice(0, 2);
    expect(qs.map((c) => [c.params.from, c.params.to])).toEqual([[1_000_000 - 86_400_000, 1_000_000], [1_000_000 - 86_400_000, 1_000_000]]);
    expect(cmd.getState().breaches).toHaveLength(1);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("persists the whole thresholds array via config.patch", async () => {
    const request = vi.fn(async () => ({})); const cmd = createSloCommands(request as never, () => 10);
    const thresholds = [{ id: "errors", metric: "error_rate" as const, limit: .1, window: "24h" as const, enabled: true }];
    await cmd.saveThresholds(thresholds);
    expect(request).toHaveBeenCalledWith("config.patch", { patch: { sloThresholds: thresholds } });
  });

  it("a usage.query rejection doesn't blank the still-successful sli.rollup tiles", async () => {
    const request = async <T>(method: string): Promise<T> => {
      if (method === "sli.rollup") return sli as T;
      if (method === "usage.query") throw new Error("usage boom");
      return {} as T;
    };
    const cmd = createSloCommands(request, () => 1_000_000);
    await cmd.refresh();
    expect(cmd.getState().sli).toEqual(sli);
    expect(cmd.getState().usage).toBeNull();
    expect(cmd.getState().error).toContain("usage boom");
    expect(cmd.getState().loading).toBe(false);
  });

  it("a sli.rollup rejection doesn't blank the still-successful usage.query tiles", async () => {
    const request = async <T>(method: string): Promise<T> => {
      if (method === "sli.rollup") throw new Error("sli boom");
      if (method === "usage.query") return usage as T;
      return {} as T;
    };
    const cmd = createSloCommands(request, () => 1_000_000);
    await cmd.refresh();
    expect(cmd.getState().usage).toEqual(usage);
    expect(cmd.getState().sli).toBeNull();
    expect(cmd.getState().error).toContain("sli boom");
  });

  it("keeps the previously-fetched side on a later partial-failure refresh instead of clearing it", async () => {
    let usageShouldFail = false;
    const request = async <T>(method: string): Promise<T> => {
      if (method === "sli.rollup") return sli as T;
      if (method === "usage.query") { if (usageShouldFail) throw new Error("transient"); return usage as T; }
      return {} as T;
    };
    const cmd = createSloCommands(request, () => 1_000_000);
    await cmd.refresh();
    expect(cmd.getState().usage).toEqual(usage);
    usageShouldFail = true;
    await cmd.refresh();
    expect(cmd.getState().usage).toEqual(usage); // stale beats blank
    expect(cmd.getState().sli).toEqual(sli);
    expect(cmd.getState().error).toContain("transient");
  });
});
