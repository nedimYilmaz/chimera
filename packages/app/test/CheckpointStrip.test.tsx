import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const calls: Array<{ method: string; params: unknown }> = [];
const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "agent.status") return { spec: { cwd: "/repo/demo" } };
  if (method === "checkpoint.status") {
    return {
      supported: true,
      count: 1,
      latest: { id: "1", ref: "refs/chimera/checkpoints/1", sha: "abc", ts: 1000, trigger: "manual", cwd: "/repo/demo" },
    };
  }
  if (method === "checkpoint.create") return {};
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

import { CheckpointStrip } from "../src/components/CheckpointStrip";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("CheckpointStrip", () => {
  it("the mod+k new chip calls createManual for the selected agent", async () => {
    calls.length = 0;
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "checkpoint-agent", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "checkpoint-agent" });
      mounted = create(React.createElement(CheckpointStrip));
    });
    await flush();
    await flush();

    const chip = mounted!.root.findByProps({ "data-checkpoint-new": true });
    act(() => chip.props["onClick"]({ stopPropagation: vi.fn() }));
    await flush();

    expect(calls).toContainEqual({
      method: "checkpoint.create",
      params: { cwd: "/repo/demo", trigger: "manual", agentId: "checkpoint-agent" },
    });
  });
});
