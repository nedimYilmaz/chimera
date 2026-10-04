import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F34.UI (QA F34 §6a/§6b/§6c): the Memory screen's scope axis — the @-sigilled chip
// on every note, the byScope summary line, and the cycle filter (⇧⌘K).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_GLOBAL = { id: "G", author: "app", title: "Global note", text: "no scope", tags: [], kind: "note", folder: "global", scope: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
const NOTE_ALPHA = { id: "S", author: "app", title: "Alpha note", text: "scoped note", tags: [], kind: "note", folder: null, scope: "alpha", treeId: null, taskId: null, createdAt: 3, updatedAt: 4 };

const rpc = vi.hoisted(() => ({
  searchParams: [] as Record<string, unknown>[],
  fn: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "memory.search") { rpc.searchParams.push(params ?? {}); return [{ record: NOTE_GLOBAL, score: 0 }, { record: NOTE_ALPHA, score: 0 }]; }
    if (method === "memory.stats") return { total: 2, byKind: { note: 2 }, byFolder: [{ folder: null, count: 2 }], topTags: [], byScope: [{ scope: null, count: 1 }, { scope: "alpha", count: 1 }] };
    if (method === "memory.get") throw new Error("unknown method: memory.get");
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

const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
// Anchored on data-attributes, not whole-tree text: "global" is also a FOLDER name here.
const count = (attr: string): number =>
  mounted!.root.findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined, { deep: true }).length;
const nodeText = (attr: string): string => {
  const hits = mounted!.root.findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined, { deep: true });
  return hits.map((h) => (Array.isArray(h.props.children) ? h.props.children.join("") : String(h.props.children ?? ""))).join("|");
};

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
  appStore.dispatch({ type: "memoryScope", scope: { kind: "all" } });
  rpc.searchParams.length = 0;
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); });

const mount = async () => {
  await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
  await flush();
};

describe("F34.UI MemoryScreen — scope chip + summary + filter", () => {
  it("sigils the detail chip so a folder named 'global' and the global SCOPE never look alike", async () => {
    await mount();
    expect(nodeText("data-memory-scope")).toBe("@global");   // NOTE_GLOBAL is FILED in folder "global"
  });

  it("summarises memory.stats byScope in the header", async () => {
    await mount();
    expect(nodeText("data-memory-scope-summary")).toBe("1 scope · 1 global");
  });

  it("⇧⌘K cycles the filter: all → @global (post-filtered, no scope param) → @alpha (scope param)", async () => {
    await mount();
    expect(nodeText("data-memory-scope-filter")).toBe("all scopes");
    const cycle = () => act(() => { runAction("memory.scope", appStore); });   // the action ⇧⌘K is bound to

    cycle(); await flush();
    expect(nodeText("data-memory-scope-filter")).toBe("@global");
    expect(rpc.searchParams.at(-1)).not.toHaveProperty("scope");        // no is-null form on the RPC
    expect(appStore.getState().memory.items.map((h) => h.record.id)).toEqual(["G"]);

    cycle(); await flush();
    expect(nodeText("data-memory-scope-filter")).toBe("@alpha");
    expect(rpc.searchParams.at(-1)).toMatchObject({ scope: "alpha" });
    expect(appStore.getState().memory.items.map((h) => h.record.id)).toEqual(["S"]);  // widened reply post-filtered

    cycle(); await flush();
    expect(nodeText("data-memory-scope-filter")).toBe("all scopes");
  });

  it("keeps the chip visible for a scope:null note (criterion 12) rather than suppressing it", async () => {
    await mount();
    expect(count("data-memory-scope")).toBeGreaterThan(0);
  });
});
