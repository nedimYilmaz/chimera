import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { SliRollupResult, UsageQueryResult } from "@chimera/protocol";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

// SLO-INBOX-RAW-UNITS: this file is separate from InboxScreen.test.tsx on purpose.
// commands.slo.ts's SLO command singleton is created lazily on first use — if any
// earlier test in the same module registry mounts InboxScreen first, useSloState
// installs an inert placeholder singleton (request always throws) and getSloCommands
// can never replace it afterwards (`if (!singleton)` guard). Calling getSloCommands
// with the real mocked request BEFORE anything touches useSloState guarantees this
// file's singleton is the real one.
const sli: SliRollupResult = {
  tasks: [], buckets: [], breakdown: [],
  totals: { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, gatePasses: 0, gateFailures: 0,
    turnCount: 0, errorCount: 0, errorRate: .15, completedTasks: 0, activeTasks: 0, latencySamples: 0,
    p50DurationMs: null, p95DurationMs: null },
};
const usage: UsageQueryResult = { totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0,
  totalCacheReadTokens: 0, totalCacheCreationTokens: 0, count: 0, groups: [] };

const rpcImpl = vi.fn(async (method: string): Promise<unknown> => {
  if (method === "sli.rollup") return sli;
  if (method === "usage.query") return usage;
  if (method === "config.patch") return {};
  if (method === "config.get") return {};
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { getSloCommands } from "../src/state/commands.slo";
import { InboxScreen } from "../src/screens/InboxScreen";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("InboxScreen SLO breach rendering", () => {
  it("renders a breach row in human units, not a raw snake_case metric key and bare fraction", async () => {
    const slo = getSloCommands(rpcImpl);
    await slo.saveThresholds([{ id: "err", metric: "error_rate", limit: .1, window: "24h", enabled: true }]);

    act(() => { mounted = create(React.createElement(InboxScreen)); });
    await flush();

    const text = JSON.stringify(mounted!.toJSON());
    expect(text).toContain("turn errors");
    expect(text).toContain("15.0%");
    expect(text).toContain("10.0%");
    // pre-fix rendering used `metric.replace(/_/g," ")` and raw fraction numbers
    expect(text).not.toMatch(/error_rate/);
    expect(text).not.toContain("0.15");
    expect(text).not.toContain("0.1\"");
  });
});
