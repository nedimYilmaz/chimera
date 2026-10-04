import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F34 §2.7: the detail chip row is display-only and renders the server-stamped
// scope — "global" for scope:null, the project name for a scoped record.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_GLOBAL = { id: "G", author: "app", title: "Global note", text: "no scope", tags: [], kind: "note", folder: null, scope: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
const NOTE_ALPHA = { id: "S", author: "app", title: "Alpha note", text: "scoped note", tags: [], kind: "note", folder: null, scope: "alpha", treeId: null, taskId: null, createdAt: 3, updatedAt: 4 };

const rpc = vi.hoisted(() => ({
  fn: vi.fn(async (method: string) => {
    if (method === "memory.search") return [{ record: NOTE_GLOBAL, score: 0 }, { record: NOTE_ALPHA, score: 0 }];
    if (method === "memory.stats") return { total: 2, byKind: { note: 2 }, byFolder: [{ folder: null, count: 2 }], topTags: [] };
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
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const textOf = (node: TreeNode | null): string =>
  node ? (node.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("") : "";
const createNodeMock = () => ({ scrollIntoView: () => {}, addEventListener: () => {}, removeEventListener: () => {}, focus: () => {}, setSelectionRange: () => {} });

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
  appStore.dispatch({ type: "memoryMode", mode: "hybrid" });
});
afterEach(() => { act(() => mounted?.unmount()); mounted = null; rpc.fn.mockClear(); });

const whole = (): string => textOf(mounted!.toJSON() as TreeNode);

describe("F34 MemoryScreen — scope chip", () => {
  it("renders 'global' for a scope:null record, then the project name after navigating to a scoped one", async () => {
    await act(async () => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();

    // cursor 0 = G (scope:null) → chip reads "global".
    expect(whole()).toContain("global");

    appStore.dispatch({ type: "memoryCursor", delta: 1 }); // move to S (scope:"alpha")
    await flush();

    expect(whole()).toContain("alpha");
  });
});
