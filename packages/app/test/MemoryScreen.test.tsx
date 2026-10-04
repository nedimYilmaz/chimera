import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { MemoryRecord } from "@chimera/protocol";
import type { MemoryHit } from "@chimera/ui-state";

// MEM-6 — MemoryScreen's list ⇄ graph wiring: mod+r (was ctrl+g — KEYMAP-REDESIGN
// re-lettered it to resolve a meaning collision with system.model, rule 7) swaps
// the detail pane for the neural graph view (and the footer chip label), Enter
// routes to the graph's focusSearch while in graph mode (instead of the list's
// expand no-op), and a node-select from the graph moves the shared memoryCursor
// to that record. The MemoryGraph child is stubbed so the test owns its
// imperative handle + onSelect.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rpcImpl = vi.fn(async (method: string): Promise<unknown> => {
  // memory.search returns a MemoryHit[] directly (commands.coord.memorySearch /
  // memoryCount both consume it as an array). Everything else is unused here.
  if (method === "memory.search") return [];
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

// Stub the graph child — capture its latest props + expose a focusSearch spy on
// the imperative handle MemoryScreen calls on Enter-in-graph-mode.
const graphMock = vi.hoisted(() => ({
  focusSearch: vi.fn(),
  props: { current: null as { active: boolean; query: string; onSelectNode?: (n: unknown) => void } | null },
}));
vi.mock("../src/components/MemoryGraph", async () => {
  const React2 = await import("react");
  const MemoryGraph = React2.forwardRef(function MemoryGraphStub(
    props: { active: boolean; query: string; onSelectNode?: (n: unknown) => void },
    ref: React.Ref<unknown>,
  ) {
    graphMock.props.current = props;
    React2.useImperativeHandle(ref, () => ({ focusSearch: graphMock.focusSearch }), []);
    return React2.createElement("div", { "data-testid": "memory-graph-stub" });
  });
  return { MemoryGraph };
});

import { MemoryScreen } from "../src/screens/MemoryScreen";
import { displayChord, runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const record = (id: string, text: string): MemoryRecord => ({
  id,
  author: "agent-1",
  text,
  title: null,
  folder: null,
  tags: [],
  kind: "note",
  treeId: null,
  taskId: null,
  createdAt: 1,
  updatedAt: 1,
});
const hit = (id: string, text: string): MemoryHit => ({ record: record(id, text), score: 1 });

const hasStub = (m: ReturnType<typeof create>) =>
  m.root.findAll((n) => n.props["data-testid"] === "memory-graph-stub").length > 0;
const chip = (m: ReturnType<typeof create>, key: string) =>
  m.root.findAll((n) => Array.isArray(n.props.chips)).flatMap((n) => n.props.chips as Array<{ key: string; label: string }>)
    .find((c) => c.key === key);

// host refs (search input, panels) just need the no-op DOM surface the screen
// touches — .focus() on the search input, plus the usual query/scroll methods.
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

beforeEach(() => {
  rpcImpl.mockClear();
  graphMock.focusSearch.mockClear();
  graphMock.props.current = null;
  // reset shared singleton store slices this suite touches
  act(() => {
    appStore.dispatch({ type: "memory", items: [] });
    appStore.dispatch({ type: "memoryQuery", query: "" });
    appStore.dispatch({ type: "setMode", mode: "normal" });
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("MemoryScreen mod+r list ⇄ graph toggle", () => {
  it("shows the list detail (no graph) by default", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    expect(hasStub(mounted!)).toBe(false);
    expect(chip(mounted!, displayChord("mod+r"))?.label).toBe("graph");
  });

  it("mod+r swaps the detail pane in for the graph view and flips the chip label", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { runAction("memory.graph", appStore); });
    expect(hasStub(mounted!)).toBe(true);
    expect(graphMock.props.current?.active).toBe(true);
    expect(chip(mounted!, displayChord("mod+r"))?.label).toBe("list");
  });

  it("mod+r again returns to the list detail", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { runAction("memory.graph", appStore); });
    expect(hasStub(mounted!)).toBe(true);
    act(() => { runAction("memory.graph", appStore); });
    expect(hasStub(mounted!)).toBe(false);
  });
});

describe("MemoryScreen Enter routing", () => {
  it("Enter in graph mode calls the graph's focusSearch (§5.2)", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => { runAction("memory.graph", appStore); });

    const input = mounted!.root.find((n) => n.props["data-memory-search"] !== undefined);
    act(() => { input.props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
    expect(graphMock.focusSearch).toHaveBeenCalledTimes(1);
  });

  it("Enter in list mode does NOT call focusSearch", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    const input = mounted!.root.find((n) => n.props["data-memory-search"] !== undefined);
    act(() => { input.props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
    expect(graphMock.focusSearch).not.toHaveBeenCalled();
  });
});

describe("MemoryScreen graph node-select → memoryCursor", () => {
  it("selecting a node moves the list cursor to that record", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush(); // let the mount's loadMemory settle first (it dispatches [])
    act(() => {
      appStore.dispatch({ type: "memory", items: [hit("m0", "first"), hit("m1", "second")] });
    });
    expect(appStore.getState().memoryCursor).toBe(0);

    act(() => { runAction("memory.graph", appStore); });
    // drive the graph's onSelectNode with the second record's node
    act(() => { graphMock.props.current?.onSelectNode?.({ id: "m1", label: "second" }); });
    expect(appStore.getState().memoryCursor).toBe(1);
  });

  it("selecting null (deselect) leaves the cursor unchanged", async () => {
    act(() => { mounted = create(React.createElement(MemoryScreen), { createNodeMock }); });
    await flush();
    act(() => {
      appStore.dispatch({ type: "memory", items: [hit("m0", "first"), hit("m1", "second")] });
    });
    act(() => { runAction("memory.graph", appStore); });
    act(() => { graphMock.props.current?.onSelectNode?.(null); });
    expect(appStore.getState().memoryCursor).toBe(0);
  });
});
