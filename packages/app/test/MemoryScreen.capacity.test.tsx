import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F36 (task 2/3, acceptance criterion 14) — the Memory tab's read-only capacity
// chip: fill level always, "next out: <title>" once memory.stats().capacity.alarming.
// A daemon that answers memory.stats WITHOUT a capacity block (older daemon) must
// render no chip and must not crash — the app only casts the reply, never parses it.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = { id: "A", author: "app", title: "Note A", text: "plain body no links", tags: [], kind: "note", folder: "ops", treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };

const state = vi.hoisted(() => ({ statsReply: null as unknown }));
const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string) => {
    if (method === "memory.search") return [{ record: NOTE, score: 0 }];
    if (method === "memory.stats") return state.statsReply;
    if (method === "memory.get") return { record: NOTE, links: [], backlinks: [] };
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

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); state.statsReply = null; });

async function mount(): Promise<TreeNode> {
  await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
  await flush();
  return mounted!.toJSON() as TreeNode;
}

describe("MemoryScreen — capacity chip (memory.stats().capacity)", () => {
  it("renders the fill level", async () => {
    state.statsReply = {
      total: 1586, byKind: { note: 1586 }, byFolder: [{ folder: "ops", count: 1586 }], byScope: [], topTags: [],
      capacity: { limit: 2000, total: 1586, fill: 0.793, alarmAt: 0.9, alarming: false, pinned: 0, nextToEvict: [] },
    };
    const tree = await mount();
    const chip = findAll(tree, (n) => n.props["data-memory-capacity"] !== undefined)[0]!;
    expect(chip).toBeDefined();
    expect(chip.props["data-memory-capacity"]).toBe("ok");
    expect(textOf(chip)).toBe("1586/2000 · 79% full");
  });

  it("warns and names the next record out when alarming", async () => {
    state.statsReply = {
      total: 1801, byKind: { note: 1801 }, byFolder: [{ folder: "ops", count: 1801 }], byScope: [], topTags: [],
      capacity: {
        limit: 2000, total: 1801, fill: 0.9005, alarmAt: 0.9, alarming: true, pinned: 0,
        nextToEvict: [{ id: "abc12345", title: "Memory store size on 2026-09-02…", kind: "note", value: 0, inbound: 0, pinned: false }],
      },
    };
    const tree = await mount();
    const chip = findAll(tree, (n) => n.props["data-memory-capacity"] !== undefined)[0]!;
    expect(chip.props["data-memory-capacity"]).toBe("alarm");
    expect(textOf(chip)).toContain("· next out: Memory store size on 2026-09-02…");
  });

  it("renders no chip when the daemon answers with no capacity block (an older daemon)", async () => {
    state.statsReply = { total: 1, byKind: { note: 1 }, byFolder: [{ folder: "ops", count: 1 }], byScope: [], topTags: [] };
    const tree = await mount();
    expect(findAll(tree, (n) => n.props["data-memory-capacity"] !== undefined)).toHaveLength(0);
  });
});
