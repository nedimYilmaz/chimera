import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { MemoryIndexView } from "../src/state/commands.coord";

// MEM-5 (§8) — the mode-chip index hint row the mem5 round-trip test leaves
// uncovered. memory.index {action:"status"} drives two spans: a "◍ indexing n/N"
// progress hint while the embed index is building, and a "semantic off — lexical"
// degraded badge (index degraded, or the embedder off while the mode still asks
// for vectors). A daemon without the RPC degrades to null → no row at all. The
// daemon is scripted through the mocked rpc bridge; `indexReply` is swapped per
// test before mount.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = { id: "A", author: "app", title: "Note A", text: "plain body no links", tags: [], kind: "note", folder: "ops", treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };

const state = vi.hoisted(() => ({ indexReply: null as unknown }));
const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string, params?: unknown) => {
    if (method === "memory.search") return [{ record: NOTE, score: 0 }];
    if (method === "memory.stats") return { total: 1, byKind: { note: 1 }, byFolder: [{ folder: "ops", count: 1 }], topTags: [] };
    if (method === "memory.get") return { record: NOTE, links: [], backlinks: [] };
    if (method === "memory.index") {
      if ((params as { action?: string } | undefined)?.action === "rebuild" && state.indexReply === "rebuild-fail") {
        throw new Error("daemon busy");
      }
      if (state.indexReply === "throw") throw new Error("unknown method: memory.index");
      return state.indexReply;
    }
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
const clsFind = (tree: TreeNode, needle: string): TreeNode[] =>
  findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes(needle));
const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); state.indexReply = null; });

async function mount(): Promise<TreeNode> {
  await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
  await flush();
  return mounted!.toJSON() as TreeNode;
}

describe("MemoryScreen — index hint row (memory.index status)", () => {
  it("shows the ◍ indexing n/N progress hint while the embed index is building", async () => {
    state.indexReply = { state: "building", embedded: 3, total: 10, pending: 7 } satisfies MemoryIndexView;
    const tree = await mount();
    const indexing = clsFind(tree, "indexing")[0]!;
    expect(indexing).toBeDefined();
    expect(textOf(indexing)).toBe("◍ indexing 3/10");
    expect(clsFind(tree, "degraded")).toHaveLength(0);
  });

  it("shows the degraded badge when the index reports degraded", async () => {
    state.indexReply = { state: "ready", embedded: 10, total: 10, pending: 0, degraded: true } satisfies MemoryIndexView;
    const tree = await mount();
    const degraded = clsFind(tree, "degraded")[0]!;
    expect(degraded).toBeDefined();
    expect(textOf(degraded)).toBe("semantic off — lexical");
  });

  it("shows the degraded badge when the embedder is off but the mode still wants vectors", async () => {
    // state:"off" + hybrid mode (≠ lexical) → the search can't reach semantic.
    state.indexReply = { state: "off", embedded: 0, total: 0, pending: 0 } satisfies MemoryIndexView;
    const tree = await mount();
    expect(clsFind(tree, "degraded")[0]).toBeDefined();
  });

  it("renders NO index row on a daemon without the memory.index RPC (null status)", async () => {
    state.indexReply = "throw"; // memoryIndexStatus swallows the unknown-method error → null
    const tree = await mount();
    expect(clsFind(tree, "indexRow")).toHaveLength(0);
  });

  // MEM-7 (§8): the row is now visible whenever memory.index answers at all — not just while
  // building/degraded — so the provider/model line and the rebuild action are always reachable.
  it("shows the provider/model line and a rebuild action even when ready and not degraded", async () => {
    state.indexReply = { state: "ready", provider: "transformers", model: "bge-small-en-v1.5", embedded: 10, total: 10, pending: 0, degraded: false } satisfies MemoryIndexView;
    const tree = await mount();
    expect(clsFind(tree, "indexRow")).toHaveLength(1);
    const meta = clsFind(tree, "indexMeta")[0]!;
    expect(textOf(meta)).toBe("transformers · bge-small-en-v1.5");
    const rebuild = findAll(tree, (n) => n.props["data-memory-index-rebuild"] !== undefined)[0]!;
    expect(rebuild).toBeDefined();
  });

  it("rebuild action calls memory.index {action:'rebuild'} and swaps in the returned status", async () => {
    state.indexReply = { state: "ready", provider: "transformers", model: "bge-small-en-v1.5", embedded: 10, total: 10, pending: 0, degraded: false } satisfies MemoryIndexView;
    const tree = await mount();
    const rebuild = findAll(tree, (n) => n.props["data-memory-index-rebuild"] !== undefined)[0]!;

    state.indexReply = { state: "building", provider: "transformers", model: "bge-small-en-v1.5", embedded: 0, total: 10, pending: 10 } satisfies MemoryIndexView;
    await act(async () => { (rebuild.props["onClick"] as () => void)(); await new Promise((r) => setTimeout(r, 0)); });

    const rebuildCalls = rpc.fn.mock.calls.filter((c) => c[0] === "memory.index" && (c[1] as { action: string })?.action === "rebuild");
    expect(rebuildCalls).toHaveLength(1);
    const retree = mounted!.toJSON() as TreeNode;
    expect(textOf(clsFind(retree, "indexing")[0]!)).toBe("◍ indexing 0/10");
  });

  // MEMORY-REBUILD-SILENT-FAIL: a rejected memory.index rebuild call used to be
  // swallowed by an empty `.catch(() => {})` — no toast, no re-enable — leaving the
  // user with a control that looks like it did nothing. It must now surface a
  // notice and drop the busy guard so the action can be retried.
  it("surfaces a notice and re-enables the control when the rebuild call rejects", async () => {
    state.indexReply = { state: "ready", provider: "transformers", model: "bge-small-en-v1.5", embedded: 10, total: 10, pending: 0, degraded: false } satisfies MemoryIndexView;
    const tree = await mount();
    const rebuild = findAll(tree, (n) => n.props["data-memory-index-rebuild"] !== undefined)[0]!;

    state.indexReply = "rebuild-fail";
    await act(async () => { (rebuild.props["onClick"] as () => void)(); await new Promise((r) => setTimeout(r, 0)); });

    expect(appStore.getState().notice).toMatch(/rebuild failed/i);
    const retree = mounted!.toJSON() as TreeNode;
    const rebuildAfter = findAll(retree, (n) => n.props["data-memory-index-rebuild"] !== undefined)[0]!;
    expect(rebuildAfter.props["aria-disabled"]).not.toBe(true);
    expect(textOf(rebuildAfter)).toBe("rebuild");
  });
});
