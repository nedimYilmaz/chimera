import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// Same bare-window shim as AccountCard.test.tsx — this package's vitest config
// runs a node env (no jsdom), and OverlayCard/ConfirmCard's esc-key effect
// needs a window to attach to.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const emptySli = { tasks: [], buckets: [], breakdown: [], totals: { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
  gatePasses: 0, gateFailures: 0, turnCount: 0, errorCount: 0, errorRate: 0, completedTasks: 0, activeTasks: 0,
  latencySamples: 0, p50DurationMs: null, p95DurationMs: null } };
const emptyUsage = { totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0, count: 0, groups: [] };

const rpcImpl = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
  if (method === "sli.rollup") return emptySli;
  if (method === "usage.query") return emptyUsage;
  return {};
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { SloScreen } from "../src/screens/SloScreen";
import { getSloCommands } from "../src/state/commands.slo";
import { rpcCall } from "../src/rpc/bridge";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

const threshold = { id: "errors", metric: "error_rate" as const, limit: .1, window: "24h" as const, enabled: true };
const commands = getSloCommands(rpcCall);

let renderer: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
});

afterEach(async () => {
  act(() => renderer?.unmount());
  renderer = null;
  rpcImpl.mockClear();
  await commands.saveThresholds([]);
  rpcImpl.mockClear();
});

describe("SloScreen — saved-threshold delete needs confirmation", () => {
  it("clicking the × does not delete immediately — every other delete in the app gates behind a ConfirmCard", async () => {
    await act(async () => { await commands.saveThresholds([threshold]); });
    rpcImpl.mockClear();

    await act(async () => { renderer = create(React.createElement(SloScreen)); });
    const tree = renderer!.toJSON() as TreeNode;

    const [deleteBtn] = byAttr(tree, "aria-label");
    expect(deleteBtn).toBeTruthy();
    act(() => { (deleteBtn!.props["onClick"] as () => void)(); });

    // No RPC has fired yet — deletion must wait on confirmation, not happen on click.
    expect(rpcImpl).not.toHaveBeenCalledWith("config.patch", expect.anything());
    expect(commands.getState().thresholds).toHaveLength(1);

    const [confirmBtn] = byAttr(renderer!.toJSON() as TreeNode, "data-confirm");
    expect(confirmBtn).toBeTruthy();
    await act(async () => { await (confirmBtn!.props["onClick"] as () => void | Promise<void>)(); });

    expect(rpcImpl).toHaveBeenCalledWith("config.patch", { patch: { sloThresholds: [] } });
    expect(commands.getState().thresholds).toHaveLength(0);
  });
});
