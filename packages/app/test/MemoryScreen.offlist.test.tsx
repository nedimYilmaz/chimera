import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// MEM-5 regression (code-review F2): a link/backlink can resolve to a note that
// is OUTSIDE the current folder-filtered, limit-capped page (memory.get resolves
// against the whole store). Clicking such a link must NOT be a dead click — the
// screen clears the filter, reloads wide, and selects the target once it lands.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = { id: "A", author: "app", title: "Note A", text: "alpha", tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
const NOTE_B = { id: "B", author: "app", title: "Note B", text: "see [[Note A]]", tags: [], kind: "note", folder: "ops", treeId: null, taskId: null, createdAt: 3, updatedAt: 4 };
const GET: Record<string, unknown> = {
  A: { record: NOTE_A, links: [], backlinks: [{ id: "B", title: "Note B", kind: "note", folder: "ops", snippet: "see [[Note A]]" }] },
  B: { record: NOTE_B, links: [{ target: "Note A", resolvedId: "A", resolvedTitle: "Note A" }], backlinks: [] },
};

// Stateful search: the FIRST page shows only B (A is off-list, e.g. filtered out);
// any later (wide) reload returns both — modeling the load-then-select recovery.
const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  searchCount: 0,
  fn: vi.fn(async function (this: void, method: string, params?: unknown) {
    (rpc.calls as Array<{ method: string; params: unknown }>).push({ method, params });
    if (method === "memory.search") {
      rpc.searchCount += 1;
      return rpc.searchCount === 1 ? [{ record: NOTE_B, score: 0 }] : [{ record: NOTE_B, score: 0 }, { record: NOTE_A, score: 0 }];
    }
    if (method === "memory.stats") return { total: 2, byKind: { note: 2 }, byFolder: [{ folder: "ops", count: 1 }, { folder: null, count: 1 }], topTags: [] };
    if (method === "memory.get") return GET[(params as { id: string }).id];
    if (method === "memory.index") throw new Error("unknown method");
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
const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "folder", path: "ops" } });
  appStore.dispatch({ type: "memoryQuery", query: "q" });
  rpc.searchCount = 0;
  rpc.calls.length = 0;
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); });

describe("MemoryScreen — off-list link navigation (load-then-select)", () => {
  it("clicking a link to an off-list note clears the filter, reloads, and selects it", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    // only B is listed; its detail links→ resolve Note A (id A), which is off-list.
    const link = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-memory-link"] === "A")[0]!;
    expect(link).toBeDefined();
    expect(appStore.getState().memory.items.map((h) => h.record.id)).toEqual(["B"]);

    await act(async () => { (link.props["onClick"] as () => void)(); });
    await flush();

    // filter reset to surface the target, and the cursor now sits on A.
    expect(appStore.getState().memory.folder).toEqual({ kind: "all" });
    expect(appStore.getState().memory.query).toBe("");
    const items = appStore.getState().memory.items;
    expect(items.map((h) => h.record.id)).toEqual(["B", "A"]);
    expect(items[appStore.getState().memoryCursor]?.record.id).toBe("A");
  });
});
