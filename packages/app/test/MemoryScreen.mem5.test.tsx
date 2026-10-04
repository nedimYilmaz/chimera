import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// MEM-5 acceptance (§8, run-the-app round-trip proven at render level): two
// linked notes — B's body says `[[Note A]]` — surface as a links→ row on B and a
// backlinks← row on A, and clicking B's link navigates the pane to A. The daemon
// is scripted through the mocked rpc bridge; memory.get supplies the resolved
// links/backlinks per note id.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = { id: "A", author: "app", title: "Note A", text: "the alpha note", tags: [], kind: "note", folder: "ops", treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
const NOTE_B = { id: "B", author: "app", title: "Note B", text: "see [[Note A]] for context", tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 3, updatedAt: 4 };

const GET: Record<string, unknown> = {
  A: { record: NOTE_A, links: [], backlinks: [{ id: "B", title: "Note B", kind: "note", folder: null, snippet: "see [[Note A]] for context" }] },
  B: { record: NOTE_B, links: [{ target: "Note A", resolvedId: "A", resolvedTitle: "Note A" }], backlinks: [] },
};

// list order [B, A] so cursor 0 = B (the note carrying the outbound link).
const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string, params?: unknown) => {
    if (method === "memory.search") return [{ record: NOTE_B, score: 0 }, { record: NOTE_A, score: 0 }];
    if (method === "memory.stats") return { total: 2, byKind: { note: 2 }, byFolder: [{ folder: null, count: 1 }, { folder: "ops", count: 1 }], topTags: [] };
    if (method === "memory.get") return GET[(params as { id: string }).id];
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
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};
const textOf = (node: TreeNode): string =>
  (node.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  // fresh cursor/mode/folder for a deterministic start (shared singleton store).
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); });

const whole = (): string => textOf(mounted!.toJSON() as TreeNode);

describe("MEM-5 MemoryScreen — linked-notes round-trip", () => {
  it("shows B's link→ Note A, then navigating to A shows the backlink← from B", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();

    // list shows both titles; cursor 0 = B → detail links→ resolves "Note A".
    const links = findAll(mounted!.toJSON() as TreeNode, (n) => typeof n.props["data-memory-link"] === "string");
    expect(links.map((n) => n.props["data-memory-link"])).toEqual(["A"]);
    expect(whole()).toContain("links →");

    // click B's link row → cursor moves to A; A's detail carries the backlink.
    await act(async () => { (links[0]!.props["onClick"] as () => void)(); });
    await flush();

    const backlinks = findAll(mounted!.toJSON() as TreeNode, (n) => typeof n.props["data-memory-backlink"] === "string");
    expect(backlinks.map((n) => n.props["data-memory-backlink"])).toEqual(["B"]);
    expect(whole()).toContain("backlinks ←");
    expect(appStore.getState().memoryCursor).toBe(1); // A is at index 1

    // alt+← back-step pops the nav history → cursor returns to B (index 0).
    await act(async () => { runAction("memory.back", appStore); });
    await flush();
    expect(appStore.getState().memoryCursor).toBe(0);
  });

  it("the folder rail renders the stats tree (all / unfiled / ops) with counts", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    const rail = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-memory-folder-rail"] === true)[0]!;
    const entries = findAll(rail, (n) => typeof n.props["data-folder-entry"] === "string").map((n) => n.props["data-folder-entry"]);
    expect(entries).toEqual(["all", "unfiled", "f:ops"]);
  });

  it("mod+k keymap handler advances the mode past lexical (no stale-closure freeze)", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    expect(appStore.getState().memory.mode).toBe("hybrid");
    await act(async () => { runAction("memory.mode", appStore); });   // hybrid → lexical
    expect(appStore.getState().memory.mode).toBe("lexical");
    await act(async () => { runAction("memory.mode", appStore); });   // lexical → semantic (would freeze at lexical if stale)
    expect(appStore.getState().memory.mode).toBe("semantic");
    await act(async () => { runAction("memory.mode", appStore); });   // semantic → hybrid (wraps)
    expect(appStore.getState().memory.mode).toBe("hybrid");
  });
});
