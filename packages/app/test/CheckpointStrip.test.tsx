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
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("CheckpointStrip", () => {
  it("opens checkpoints from one button and retains the new checkpoint shortcut", async () => {
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

    const chip = mounted!.root.findByProps({ "data-checkpoint-strip": true });
    expect(chip.type).toBe("button");
    expect(chip.props["aria-label"]).toContain("cp-1");
    act(() => chip.props.onClick());
    expect(mounted!.root.findByProps({ "data-checkpoint-strip": true }).props["aria-expanded"]).toBe(true);
    act(() => runAction("agents.checkpoint", appStore));
    await flush();

    expect(calls).toContainEqual({
      method: "checkpoint.create",
      params: { cwd: "/repo/demo", trigger: "manual", agentId: "checkpoint-agent" },
    });
  });
});
