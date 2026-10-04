import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// QUEUE-REORDER: render coverage for the drain-order view (requirement 1), the effective
// position badge + move up/down affordance (requirement 2), and the retry-without-retyping
// action (requirement 3) — see packages/core/test/queues-reorder.test.ts for the underlying
// scheduling behavior; this file only proves the UI surfaces it.

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

// Deliberately shuffled + distinct createdAt/priority/orderKey so "newest" and "drain" modes
// produce DIFFERENT rendered orders — proof the sort-mode toggle actually changes what's shown,
// not just a cosmetic label.
//   newest-first (createdAt desc):        t-c(200), t-a(100), t-b(50)
//   drain order (priority desc, orderKey asc): t-c(pri5), t-b(orderKey2), t-a(orderKey5)
const taskC = { taskId: "t-c", queue: "build", state: "pending", role: "worker", priority: 5, orderKey: 0, prompt: "high priority", attempts: 0, agentId: null, createdAt: 200, dependsOn: [] };
const taskA = { taskId: "t-a", queue: "build", state: "pending", role: "worker", priority: 0, orderKey: 5, prompt: "task a", attempts: 0, agentId: null, createdAt: 100, dependsOn: [] };
const taskB = { taskId: "t-b", queue: "build", state: "pending", role: "worker", priority: 0, orderKey: 2, prompt: "task b", attempts: 0, agentId: null, createdAt: 50, dependsOn: [] };
const taskFailed = { taskId: "t-failed", queue: "build", state: "failed", role: "worker", priority: 0, orderKey: 9, prompt: "broken task", attempts: 1, agentId: null, createdAt: 10, error: "boom", dependsOn: [] };

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "queue.list") return [{ name: "build", retryLimit: 2, paused: false, createdAt: 1 }];
  if (method === "queue.status") {
    return {
      spec: { name: "build", retryLimit: 2, paused: false },
      counts: { pending: 3, blocked: 0, in_progress: 0, done: 0, failed: 1 },
      tasks: [taskA, taskC, taskB, taskFailed],   // deliberately NOT in any sorted order
    };
  }
  if (method === "queue.moveTask" || method === "queue.retryTask") return { ...taskA, ...(params as Record<string, unknown>) };
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

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let mounted: ReturnType<typeof create> | null = null;

const taskRowOrder = (root: ReturnType<typeof create>["root"]): string[] =>
  root.findAll((n) => typeof n.props["data-task-row"] === "string").map((n) => n.props["data-task-row"] as string);

beforeEach(() => {
  rpcImpl.mockClear();
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("QueuesScreen — QUEUE-REORDER drain-order view", () => {
  it("defaults to newest-first, and switching to drain order actually changes the rendered row order", async () => {
    act(() => { mounted = create(React.createElement(QueuesScreen)); });
    await flush(); await flush(); await flush();

    // Default: newest-first (createdAt desc) — t-c, t-a, t-b, t-failed.
    expect(taskRowOrder(mounted!.root)).toEqual(["t-c", "t-a", "t-b", "t-failed"]);

    const drainOption = mounted!.root.find((n) => n.props["data-sort-option"] === "drain");
    act(() => drainOption.props.onClick());
    await flush();

    // Drain order: t-c (priority 5) first, then t-b/t-a by orderKey asc, t-failed last (terminal bucket).
    expect(taskRowOrder(mounted!.root)).toEqual(["t-c", "t-b", "t-a", "t-failed"]);
  });

  it("shows the effective drain position for pending/blocked rows in EITHER sort mode", async () => {
    act(() => { mounted = create(React.createElement(QueuesScreen)); });
    await flush(); await flush(); await flush();

    // Still in the default "newest" mode — position badges must already be correct.
    const posCells = mounted!.root.findAll((n) => typeof n.props["data-task-pos"] === "string");
    const byTask = Object.fromEntries(posCells.map((n) => [n.props["data-task-pos"], n]));
    expect(flattenText(byTask["t-c"])).toContain("1");
    expect(flattenText(byTask["t-b"])).toContain("2");
    expect(flattenText(byTask["t-a"])).toContain("3");
    // The terminal task has no drain position (it isn't pending/blocked).
    expect(flattenText(byTask["t-failed"])).toBe("");
  });

  it("move buttons only render in drain-order mode, and clicking one calls queue.moveTask", async () => {
    act(() => { mounted = create(React.createElement(QueuesScreen)); });
    await flush(); await flush(); await flush();

    // Not yet visible in "newest" mode.
    expect(mounted!.root.findAll((n) => n.props["data-move-down"] === "t-c")).toHaveLength(0);

    const drainOption = mounted!.root.find((n) => n.props["data-sort-option"] === "drain");
    act(() => drainOption.props.onClick());
    await flush();

    const moveDown = mounted!.root.find((n) => n.props["data-move-down"] === "t-c");
    act(() => moveDown.props.onClick({ stopPropagation: vi.fn() }));
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("queue.moveTask", { taskId: "t-c", direction: "down" });
  });

  it("a failed task's retry action clones it via queue.retryTask, without asking for the prompt again", async () => {
    act(() => { mounted = create(React.createElement(QueuesScreen)); });
    await flush(); await flush(); await flush();

    const row = mounted!.root.find((n) => n.props["data-task-row"] === "t-failed");
    act(() => row.props.onClick());
    await flush(); await flush();

    const retryEl = mounted!.root.find((n) => n.props["data-retry-task"] === "t-failed");
    act(() => retryEl.props.onClick());
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("queue.retryTask", { taskId: "t-failed" });
  });
});

function flattenText(node: { children?: unknown }): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") { parts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object" && "children" in n) walk((n as { children?: unknown }).children);
  };
  walk(node);
  return parts.join("");
}
