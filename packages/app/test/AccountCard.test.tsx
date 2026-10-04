import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// STALE-STATE-SWEEP: same harness as ModelCard.test.tsx (this package's vitest
// config runs a node env, no jsdom — OverlayCard's esc-key effect needs a bare
// window stub).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const rpcImpl = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({}));

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

import { AccountCard } from "../src/components/AccountCard";
import { appStore } from "../src/state/store";
import { systemLocal } from "../src/state/commands.system";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

function selectAgent(agentId: string, provider: string, accountName: string): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "running", accountName, provider, costUsd: 0, createdAt: 0 }],
  });
  appStore.dispatch({ type: "selectAgent", agentId });
}

let renderer: ReturnType<typeof create> | null = null;

async function renderAccountCard(): Promise<ReturnType<typeof create>> {
  await act(async () => {
    renderer = create(React.createElement(AccountCard));
  });
  return renderer!;
}

beforeEach(() => {
  rpcImpl.mockReset();
  rpcImpl.mockImplementation(async () => ({}));
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  systemLocal.set({ accountOpen: false });
});

describe("AccountCard — stale-state-on-agent-switch", () => {
  it("sends a manually selected target account and model together", async () => {
    selectAgent("agent-switch", "claude", "cl-main");
    systemLocal.set({ accountOpen: true });
    const r = await renderAccountCard();
    act(() => { (byAttr(r.toJSON() as TreeNode, "data-account-input")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "cx-main" } }); });
    act(() => { (byAttr(r.toJSON() as TreeNode, "data-account-model")[0]!.props.onChange as (e: unknown) => void)({ target: { value: "gpt-6-astra" } }); });
    await act(async () => { (byAttr(r.toJSON() as TreeNode, "data-account-apply")[0]!.props.onClick as () => void)(); });
    expect(rpcImpl).toHaveBeenCalledWith("agent.setAccount", { agentId: "agent-switch", account: "cx-main", model: "gpt-6-astra" });
  });
  it("STALE-STATE-SWEEP: re-seeds from the newly selected agent when selection changes while the card stays OPEN", async () => {
    selectAgent("agent-a", "claude", "acct-a");
    systemLocal.set({ accountOpen: true });
    const r = await renderAccountCard();

    const [input] = byAttr(r.toJSON() as TreeNode, "data-account-input");
    act(() => { (input!.props["onChange"] as (e: unknown) => void)({ target: { value: "acct-a-custom" } }); });
    expect(byAttr(r.toJSON() as TreeNode, "data-account-input")[0]!.props["value"]).toBe("acct-a-custom");

    // selection moves to agent-b WITHOUT closing the card (a left-rail row click).
    act(() => { selectAgent("agent-b", "claude", "acct-b"); });

    const inputAfter = byAttr(r.toJSON() as TreeNode, "data-account-input")[0]!;
    expect(inputAfter.props["value"]).not.toBe("acct-a-custom");

    const [apply] = byAttr(r.toJSON() as TreeNode, "data-account-apply");
    act(() => { (apply!.props["onClick"] as () => void)(); });
    const setAccountCall = rpcImpl.mock.calls.find(([method]) => method === "agent.setAccount");
    expect((setAccountCall as [string, { agentId: string; account: string }])[1].agentId).toBe("agent-b");
    expect((setAccountCall as [string, { agentId: string; account: string }])[1].account).not.toBe("acct-a-custom");
  });
});
