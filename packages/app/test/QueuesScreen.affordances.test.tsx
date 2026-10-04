import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  };
}

const task = {
  taskId: "task-1",
  queue: "build",
  state: "pending",
  role: "worker",
  priority: 0,
  prompt: "ship it",
  attempts: 0,
  agentId: null,
};

const rpcImpl = vi.fn(async (method: string): Promise<unknown> => {
  if (method === "queue.list") return [{ name: "build", retryLimit: 2, paused: false, createdAt: 1 }];
  if (method === "queue.status") {
    return {
      spec: { name: "build", retryLimit: 2, paused: false },
      counts: { pending: 1, blocked: 0, in_progress: 0, done: 0, failed: 0 },
      tasks: [task],
    };
  }
  if (method === "job.list" || method === "workflow.list" || method === "artifact.list") return [];
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  readArtifactSnapshot: vi.fn(async () => ""),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
}));

import { QueuesScreen } from "../src/screens/QueuesScreen";
import { registerActionHandler } from "../src/keymap";

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("QueuesScreen mouse action affordances", () => {
  it.each([
    ["queues.workflow", "data-action-chip", "w"],
    ["queues.pin", "data-pin-task", "task-1"],
  ])("%s dispatches the existing action id", async (actionId, attr, value) => {
    act(() => { mounted = create(React.createElement(QueuesScreen)); });
    await flush();
    await flush();
    await flush();

    const handler = vi.fn();
    const dispose = registerActionHandler(actionId, handler);
    const node = mounted!.root.find((candidate) => candidate.props[attr] === value);

    act(() => node.props.onClick({ stopPropagation: vi.fn() }));

    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });
});
