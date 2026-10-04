import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// Regression: switching memory.edit directly from note B to note A (without
// closing the editor first) must resync the form to A's fields. Before the
// `key={editingNoteId}` fix on MemoryNoteEditor's mount site, React reused the
// existing editor instance across the id swap — its `useState(initial)` only
// stamps the form once, so the title/body kept showing B's stale content while
// the save call silently targeted A's id. See MemoryScreen.tsx (editor mount).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = { id: "A", author: "app", title: "Note A", text: "alpha body", tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
const NOTE_B = { id: "B", author: "app", title: "Note B", text: "beta body", tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 3, updatedAt: 4 };

const GET: Record<string, unknown> = {
  A: { record: NOTE_A, links: [], backlinks: [] },
  B: { record: NOTE_B, links: [], backlinks: [] },
};

// list order [B, A] so cursor 0 = B.
const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string, params?: unknown) => {
    if (method === "memory.search") return [{ record: NOTE_B, score: 0 }, { record: NOTE_A, score: 0 }];
    if (method === "memory.stats") return { total: 2, byKind: { note: 2 }, byFolder: [{ folder: null, count: 2 }], topTags: [] };
    if (method === "memory.get") return GET[(params as { id: string }).id];
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
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};
const createNodeMock = () => ({ value: "", scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); });

const titleInput = (): TreeNode =>
  findAll(mounted!.toJSON() as TreeNode, (n) => n.props["aria-label"] === "title")[0]!;

describe("MemoryScreen — editor resyncs when switching notes without closing", () => {
  it("shows the newly-selected note's title, not the previous note's stale value", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();

    // cursor starts at 0 = B; open editor on B.
    expect(appStore.getState().memoryCursor).toBe(0);
    await act(async () => { runAction("memory.edit", appStore); });
    await flush();
    expect(titleInput().props["value"]).toBe("Note B");

    // move cursor to A and re-trigger edit WITHOUT closing the editor first.
    await act(async () => { appStore.dispatch({ type: "memoryCursor", delta: 1 }); });
    await act(async () => { runAction("memory.edit", appStore); });
    await flush();

    expect(titleInput().props["value"]).toBe("Note A");
  });
});
