import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F36.UI — the operator-visible side of value-based eviction on the Memory screen:
// an ALWAYS-present capacity row (pins held + what goes first), a ★ marker on pinned
// rows, and the memory.pin action that mouse chip and mod+p both dispatch. The
// next-out preview used to live only in a tooltip that only appeared while alarming.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = { id: "A", author: "app", title: "Note A", text: "plain body", tags: [], kind: "note", folder: "ops", scope: null, pinned: false, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };

const state = vi.hoisted(() => ({ statsReply: null as unknown, pinned: false }));
const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "memory.search") return [{ record: { ...NOTE, pinned: state.pinned }, score: 0 }];
    if (method === "memory.stats") return state.statsReply;
    if (method === "memory.get") return { record: { ...NOTE, pinned: state.pinned }, links: [], backlinks: [] };
    if (method === "memory.update") { state.pinned = params?.["pinned"] === true; return {}; }
    if (method === "memory.index") throw new Error("unknown method: memory.index");
    return {};
  }),
}));

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: rpc.fn,
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import { MemoryScreen } from "../src/screens/MemoryScreen";
import { appStore } from "../src/state/store";
import { runAction } from "../src/keymap";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};
const textOf = (node: TreeNode): string => (node.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const CAP = (over: Record<string, unknown> = {}) => ({
  total: 3, byKind: { note: 3 }, byFolder: [{ folder: "ops", count: 3 }], byScope: [], topTags: [],
  capacity: { limit: 2000, total: 1586, fill: 0.793, alarmAt: 0.9, alarming: false, pinned: 2, nextToEvict: [{ id: "abc12345", title: "old scratch note", kind: "note", value: 0, inbound: 0, pinned: false }], ...over },
});

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
  state.pinned = false;
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); state.statsReply = null; });

async function mount(): Promise<TreeNode> {
  await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
  await flush();
  return mounted!.toJSON() as TreeNode;
}

describe("MemoryScreen — F36.UI capacity row", () => {
  it("names the pins held and what goes first, WITHOUT waiting for the alarm", async () => {
    state.statsReply = CAP();
    const tree = await mount();
    const row = findAll(tree, (n) => n.props["data-memory-capacity-row"] !== undefined)[0]!;
    expect(row).toBeDefined();
    expect(textOf(row)).toContain("2 pinned");
    expect(textOf(row)).toContain("next out: old scratch note");
  });

  it("says so in words when nothing is evictable yet", async () => {
    state.statsReply = CAP({ pinned: 0, nextToEvict: [] });
    const tree = await mount();
    const out = findAll(tree, (n) => n.props["data-memory-next-out"] !== undefined)[0]!;
    expect(textOf(out)).toBe("nothing to drop yet");
  });

  it("renders no capacity row on an older daemon that answers without a capacity block", async () => {
    state.statsReply = { total: 1, byKind: { note: 1 }, byFolder: [], byScope: [], topTags: [] };
    const tree = await mount();
    expect(findAll(tree, (n) => n.props["data-memory-capacity-row"] !== undefined)).toHaveLength(0);
  });
});

describe("MemoryScreen — F36.UI pin action", () => {
  it("memory.pin toggles the selected note's pinned flag and marks the row", async () => {
    state.statsReply = CAP();
    let tree = await mount();
    expect(findAll(tree, (n) => n.props["data-memory-pinned-row"] !== undefined)).toHaveLength(0);

    await act(async () => { runAction("memory.pin", appStore); await flush(); });
    await flush();
    expect(rpc.fn.mock.calls.some(([m, p]) => m === "memory.update" && (p as Record<string, unknown>)?.["pinned"] === true)).toBe(true);
    // Pinning is not authorship — the patch must not re-stamp the note's author.
    const patch = rpc.fn.mock.calls.find(([m]) => m === "memory.update")![1] as Record<string, unknown>;
    expect(patch["author"]).toBeUndefined();

    tree = mounted!.toJSON() as TreeNode;
    expect(findAll(tree, (n) => n.props["data-memory-pinned-row"] !== undefined)).toHaveLength(1);
  });
});
