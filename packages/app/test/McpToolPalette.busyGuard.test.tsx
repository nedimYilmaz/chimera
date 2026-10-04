// DOUBLE-SUBMIT-SWEEP — McpToolPalette's submitFlat/submitRaw fired
// mcpInvoke unconditionally, with no check against the `pending` flag that
// was already tracking an in-flight dispatch: a rapid double-click/double-Enter
// on the "run" chip while a request was still pending could dispatch the
// underlying daemon RPC twice concurrently. `pending` itself was already
// cleared correctly (in a finally, after the await settled) — the bug was the
// missing re-entrancy check, the mirror of RULE-FORM-BUSY-GUARD's sync-clear
// bug. Same harness as AccountsCard.quota.test.tsx: McpToolPalette has no
// named export (self-registers via registerOverlay at module-eval time), so
// it's imported for its side effect and mounted through OverlayOutlet.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let pendingCalls: Array<{ method: string; params: unknown }> = [];
let deferreds: Deferred[] = [];
const rpcCallMock = vi.fn((method: string, params?: unknown) => {
  pendingCalls.push({ method, params });
  return new Promise((resolve, reject) => { deferreds.push({ resolve, reject }); });
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcCallMock(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import "../src/components/McpToolPalette";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import { appStore } from "../src/state/store";

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

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  pendingCalls = [];
  deferreds = [];
  rpcCallMock.mockClear();
  act(() => appStore.dispatch({ type: "mcpPaletteOpen", open: false }));
});

describe("McpToolPalette — pending guard", () => {
  it("a second run click while the first dispatch is still pending does not invoke the RPC again", async () => {
    act(() => {
      mounted = create(React.createElement(OverlayOutlet, { host: "agents", bottomInset: 0 }));
      appStore.dispatch({ type: "mcpPaletteOpen", open: true });
    });

    // open the zero-field flat tool "daemon_status" (-> daemon.status RPC). The
    // browse list renders only its first 12 catalog rows (a user narrows it by
    // typing), and the catalog has outgrown that window — so drive the real
    // query input rather than assuming the tool is among the unfiltered rows.
    const input = byAttr(mounted!.toJSON() as TreeNode, "data-mcp-input")[0]!;
    act(() => { (input.props["onChange"] as (e: { target: { value: string } }) => void)({ target: { value: "daemon_status" } }); });
    const row = byAttr(mounted!.toJSON() as TreeNode, "data-mcp-row").find((n) => n.props["data-mcp-row"] === "daemon_status");
    expect(row, "daemon_status row must be visible after filtering the palette by name").toBeDefined();
    act(() => { (row!.props["onClick"] as () => void)(); });

    const runButton = () => byAttr(mounted!.toJSON() as TreeNode, "data-mcp-run")[0]!;
    act(() => { (runButton().props["onClick"] as () => void)(); });
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0]).toEqual({ method: "daemon.status", params: {} });
    expect(runButton().props["disabled"]).toBe(true);

    // a second click while still pending must be a no-op.
    act(() => { (runButton().props["onClick"] as () => void)(); });
    expect(pendingCalls).toHaveLength(1); // still 1 — the guard must block the re-entrant click

    await act(async () => { deferreds[0]!.resolve({ agents: { running: 0 } }); await Promise.resolve(); await Promise.resolve(); });
    expect(runButton().props["disabled"]).toBeFalsy();
  });
});
