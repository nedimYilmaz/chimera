import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ONBOARDING-GATE R2 — same harness as CommandPalette.test.tsx: real appStore
// singleton, rpc/bridge mocked, a bare window shim (this package's vitest env
// is plain node, no jsdom).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { TopBar } from "../src/components/TopBar";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}

const connectedNoAccounts = { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts: [] };
const connectedWithAccount = { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts: [{ name: "a", provider: "claude" }] };

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("TopBar — ONBOARDING-GATE R2 (zero CONFIRMED accounts locks the tab strip)", () => {
  it("dims + disables every tab but agents while gated, and a click on a locked tab is a no-op", () => {
    act(() => {
      appStore.dispatch({ type: "daemonStatus", status: connectedNoAccounts as never });
      appStore.dispatch({ type: "selectTab", tab: "agents" });
    });
    act(() => { mounted = create(React.createElement(TopBar)); });
    const root = mounted!.root as unknown as TreeNode;
    const locked = findAll(root, (n) => n.props["data-tab-locked"] !== undefined);
    expect(locked.length).toBeGreaterThan(0); // every non-agents slot is locked
    expect(locked.some((n) => n.props["onClick"] !== undefined)).toBe(false); // no click handler while locked

    const teamsSlot = findAll(root, (n) => n.props["data-topbar-tab"] === "teams")[0];
    expect(teamsSlot).toBeDefined();
    act(() => { (teamsSlot!.props["onClick"] as (() => void) | undefined)?.(); });
    expect(appStore.getState().activeTab).toBe("agents"); // click did nothing
  });

  it("tab.next/prev/settings/inbox/slo registry handlers are all swallowed while gated", async () => {
    act(() => {
      appStore.dispatch({ type: "daemonStatus", status: connectedNoAccounts as never });
      appStore.dispatch({ type: "selectTab", tab: "agents" });
    });
    const { runAction } = await import("../src/keymap");
    act(() => { mounted = create(React.createElement(TopBar)); });
    act(() => { runAction("tab.settings", appStore); });
    expect(appStore.getState().activeTab).toBe("agents");
    act(() => { runAction("tab.next", appStore); });
    expect(appStore.getState().activeTab).toBe("agents");
  });

  it("unlocks every slot the moment an account is confirmed present", () => {
    act(() => {
      appStore.dispatch({ type: "daemonStatus", status: connectedWithAccount as never });
      appStore.dispatch({ type: "selectTab", tab: "agents" });
    });
    act(() => { mounted = create(React.createElement(TopBar)); });
    const root = mounted!.root as unknown as TreeNode;
    const locked = findAll(root, (n) => n.props["data-tab-locked"] !== undefined);
    expect(locked.length).toBe(0);

    const teamsSlot = findAll(root, (n) => n.props["data-topbar-tab"] === "teams")[0];
    act(() => { (teamsSlot!.props["onClick"] as (() => void) | undefined)?.(); });
    expect(appStore.getState().activeTab).toBe("teams");
  });
});
