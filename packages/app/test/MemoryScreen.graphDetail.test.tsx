import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { MemoryRecord } from "@chimera/protocol";
import type { MemoryHit } from "@chimera/ui-state";

// MEM-6 fix — clicking a node in the neural graph view used to show only a
// one-line footer preview (MemoryGraph's own `.status` readout), not the full
// note. This suite covers the fix: a real-node click fetches memory.get and
// renders the SAME detail (title/folder header, body, links→/backlinks←) list
// mode uses, in a panel over the canvas; a ghost node gets a title-only
// placeholder with no memory.get call; and esc / the × chip / re-selecting
// null (empty-canvas click, per MemoryGraph's onSelectNode(null) contract)
// all close the panel.

// node-env window stub that captures registered keydown listeners so we can
// fire a synthetic capture-phase Escape (same pattern as
// OverlayCard.escGuard.test.tsx).
const keydownHandlers: Array<(ev: unknown) => void> = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === "keydown") keydownHandlers.push(fn); },
  removeEventListener: (type: string, fn: (ev: unknown) => void) => {
    if (type !== "keydown") return;
    const i = keydownHandlers.indexOf(fn);
    if (i >= 0) keydownHandlers.splice(i, 1);
  },
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fireEscape = (): void => {
  const e = { key: "Escape", preventDefault() {}, stopPropagation() {} };
  for (const h of [...keydownHandlers]) h(e);
};

const NOTE_1: MemoryRecord = {
  id: "m1", author: "app", title: "Second Note", text: "full body text for m1",
  tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2,
};

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "memory.search") return [];
  if (method === "memory.get") {
    const id = (params as { id: string }).id;
    if (id === "m1") return { record: NOTE_1, links: [], backlinks: [] };
    return { record: { ...NOTE_1, id }, links: [], backlinks: [] };
  }
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

// Stub the graph child exactly like MemoryScreen.test.tsx does — the real
// canvas renderer isn't exercised here, just MemoryScreen's own wiring around
// the onSelectNode callback and the imperative `deselect` handle.
const graphMock = vi.hoisted(() => ({
  deselect: vi.fn(),
  props: { current: null as { active: boolean; query: string; onSelectNode?: (n: unknown) => void } | null },
}));
vi.mock("../src/components/MemoryGraph", async () => {
  const React2 = await import("react");
  const MemoryGraph = React2.forwardRef(function MemoryGraphStub(
    props: { active: boolean; query: string; onSelectNode?: (n: unknown) => void },
    ref: React.Ref<unknown>,
  ) {
    graphMock.props.current = props;
    React2.useImperativeHandle(ref, () => ({ focusSearch: () => {}, deselect: graphMock.deselect }), []);
    return React2.createElement("div", { "data-testid": "memory-graph-stub" });
  });
  return { MemoryGraph };
});

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

const record = (id: string, text: string): MemoryRecord => ({
  id, author: "agent-1", text, title: null, folder: null, tags: [], kind: "note", treeId: null, taskId: null, createdAt: 1, updatedAt: 1,
});
const hit = (id: string, text: string): MemoryHit => ({ record: record(id, text), score: 1 });

const createNodeMock = () => ({
  focus: () => {},
  blur: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 430, height: 600 }),
  querySelector: () => null,
  scrollIntoView: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  style: {} as Record<string, string>,
});

let mounted: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const panelOf = (m: ReturnType<typeof create>): TreeNode[] =>
  findAll(m.toJSON() as TreeNode, (n) => n.props["data-graph-detail-panel"] !== undefined);
const whole = (m: ReturnType<typeof create>): string => textOf(m.toJSON() as TreeNode);

beforeEach(() => {
  rpcImpl.mockClear();
  graphMock.deselect.mockClear();
  graphMock.props.current = null;
  act(() => {
    appStore.dispatch({ type: "memory", items: [] });
    appStore.dispatch({ type: "memoryQuery", query: "" });
    appStore.dispatch({ type: "setMode", mode: "normal" });
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  keydownHandlers.length = 0;
});

describe("MemoryScreen graph-mode node detail panel", () => {
  it("selecting a real node fetches memory.get and renders the full note body in a panel", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    // m1's list-row record IS NOTE_1 — same note the memory.get mock resolves,
    // matching the real invariant that a search hit and its memory.get detail
    // describe the same underlying record.
    act(() => { appStore.dispatch({ type: "memory", items: [hit("m0", "first"), { record: NOTE_1, score: 1 }] }); });
    act(() => { runAction("memory.graph", appStore); });

    expect(panelOf(mounted!)).toHaveLength(0); // nothing selected yet — no panel

    act(() => { graphMock.props.current?.onSelectNode?.({ id: "m1", label: "Second Note", ghost: false }); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("memory.get", { id: "m1" });
    expect(panelOf(mounted!)).toHaveLength(1);
    expect(whole(mounted!)).toContain("full body text for m1");
    expect(whole(mounted!)).toContain("Second Note");
  });

  it("a ghost node shows a title-only placeholder — no memory.get call", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { appStore.dispatch({ type: "memory", items: [hit("m0", "first")] }); });
    act(() => { runAction("memory.graph", appStore); });

    act(() => { graphMock.props.current?.onSelectNode?.({ id: "ghost:untitled idea", label: "untitled idea", ghost: true }); });
    await flush();

    // the ghost id itself is never fetched (list mode's own cursor-tracking
    // effect independently fetches "m0" regardless of graph mode — unrelated).
    expect(rpcImpl).not.toHaveBeenCalledWith("memory.get", { id: "ghost:untitled idea" });
    expect(panelOf(mounted!)).toHaveLength(1);
    expect(whole(mounted!)).toContain("untitled idea");
    expect(whole(mounted!)).toContain("ghost — no note yet");
  });

  it("closing via the × chip clears the panel and tells the graph to deselect", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { appStore.dispatch({ type: "memory", items: [hit("m0", "first"), hit("m1", "second")] }); });
    act(() => { runAction("memory.graph", appStore); });
    act(() => { graphMock.props.current?.onSelectNode?.({ id: "m1", label: "second", ghost: false }); });
    await flush();
    expect(panelOf(mounted!)).toHaveLength(1);

    const closeChip = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["title"] === "esc · close")[0]!;
    act(() => { (closeChip.props["onClick"] as () => void)(); });

    expect(panelOf(mounted!)).toHaveLength(0);
    expect(graphMock.deselect).toHaveBeenCalledTimes(1);
  });

  it("closing via esc clears the panel and tells the graph to deselect", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { appStore.dispatch({ type: "memory", items: [hit("m0", "first"), hit("m1", "second")] }); });
    act(() => { runAction("memory.graph", appStore); });
    act(() => { graphMock.props.current?.onSelectNode?.({ id: "m1", label: "second", ghost: false }); });
    await flush();
    expect(panelOf(mounted!)).toHaveLength(1);

    act(() => { fireEscape(); });

    expect(panelOf(mounted!)).toHaveLength(0);
    expect(graphMock.deselect).toHaveBeenCalledTimes(1);
  });

  it("re-selecting null (empty-canvas click) closes the panel", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { appStore.dispatch({ type: "memory", items: [hit("m0", "first"), hit("m1", "second")] }); });
    act(() => { runAction("memory.graph", appStore); });
    act(() => { graphMock.props.current?.onSelectNode?.({ id: "m1", label: "second", ghost: false }); });
    await flush();
    expect(panelOf(mounted!)).toHaveLength(1);

    act(() => { graphMock.props.current?.onSelectNode?.(null); });
    expect(panelOf(mounted!)).toHaveLength(0);
  });
});
