import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// HOLD-PAUSE-BANNER-STALE-CLOCK: `now` state only refreshed on the 30s
// interval tick. When pauseKey drops to null (pause cleared) the interval is
// torn down and `now` freezes; if a NEW hold-pause starts moments later, the
// effect restarts the interval but doesn't resync `now` first, so the ETA can
// read stale (inflated "resumes in Xm") for up to 30s. Same harness as
// BudgetPauseBanner.test.tsx.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { HoldPauseBanner } from "../src/components/HoldPauseBanner";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

describe("HoldPauseBanner (HOLD-PAUSE-BANNER-STALE-CLOCK)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resyncs the clock immediately when a new hold-pause starts, not just on the next 30s tick", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "hp-1", treeId: "hp-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "hp-1" });
      appStore.dispatch({
        type: "event",
        event: {
          ts: 0,
          seq: 1,
          agentId: "hp-1",
          kind: "status",
          data: { paused: true, reason: "session-limit", treeId: "hp-1", resumeScheduledAt: 100_000 },
        },
      });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(HoldPauseBanner)); });

    // Clear the pause (agent resumes running) — interval torn down, `now` frozen.
    act(() => {
      appStore.dispatch({
        type: "event",
        event: { ts: 25_000, seq: 2, agentId: "hp-1", kind: "status", data: { state: "running" } },
      });
    });

    // Real time moves forward well past the point where a stale `now` would
    // under-count elapsed time (simulating the gap before a fresh pause hits).
    act(() => { vi.setSystemTime(90_000); });

    // A new hold-pause starts with an ETA fixed relative to the CURRENT time.
    act(() => {
      appStore.dispatch({
        type: "event",
        event: {
          ts: 90_000,
          seq: 3,
          agentId: "hp-1",
          kind: "status",
          data: { paused: true, reason: "crash-loop-backoff", treeId: "hp-1", resumeScheduledAt: 90_000 + 5_000 },
        },
      });
    });
    act(() => { renderer.update(React.createElement(HoldPauseBanner)); });

    const text = flattenText(renderer.toJSON() as TreeNode);
    // If `now` were stale (still 0), the ETA would compute against a 90s-old
    // clock and show a wildly inflated resume time instead of "a few seconds".
    expect(text).not.toMatch(/1m|2m|[0-9]{2,}m/);
  });
});
