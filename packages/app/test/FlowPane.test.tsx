import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// [FLOW-VIEW-SCROLL] First render-level test for the app's FlowPane. The flow
// list is the scroll container (.body: overflow-y:auto) so a long flow
// overflows/clips; ↑↓ node movement used to change only the `.selected` class
// and leave the viewport put, so the cursor could walk off-screen. These pin
// (1) that every flattened row is actually rendered into the scroll container
// (overflow render — nothing is truncated away), and (2) that moving the node
// cursor scrolls the freshly-selected row into view (viewport-follows-selection).
//
// Harness follows HostToolsCard.test.tsx: react-test-renderer under this
// package's node env (no jsdom), a bare window stub, the Tauri bridge mocked so
// no real listen()/invoke() fires, and EventsScreen's createNodeMock
// scrollIntoView spy so refs resolve to a spy-able DOM node.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

import type { AgentView, FlowNode } from "@chimera/ui-state";
import { FlowPane } from "../src/components/FlowPane";
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function textOf(node: TreeNode): string {
  const parts: string[] = [];
  for (const c of node.children ?? []) {
    if (typeof c === "string") parts.push(c);
    else parts.push(textOf(c));
  }
  return parts.join("");
}

// Every div gets a fake DOM node so selectedRowRef resolves to something with a
// scrollIntoView to spy on — same technique as HostToolsCard/EventsScreen.
const scrollCalls: unknown[] = [];
const createNodeMock = () => ({
  scrollIntoView: (opts: unknown) => scrollCalls.push(opts),
  addEventListener: () => {},
  removeEventListener: () => {},
});

// A flat flow tree far longer than any pane can show at once — the overflow shape.
const NODE_COUNT = 40;
const tree: FlowNode[] = Array.from({ length: NODE_COUNT }, (_, i) => ({
  id: `n${i}`,
  kind: "tool" as const,
  label: `node-${i}`,
  status: "completed",
  children: [],
}));
const agent = { agentId: "a1", flowTree: tree } as unknown as AgentView;

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  scrollCalls.length = 0;
});

function mount(): void {
  act(() => {
    mounted = create(React.createElement(FlowPane, { agent }), { createNodeMock });
  });
}

describe("app FlowPane — viewport follows the node cursor (overflow)", () => {
  it("overflow render: every flattened row is rendered into the scroll container", () => {
    mount();
    const tree0 = mounted!.toJSON() as TreeNode;
    const whole = textOf(tree0);
    // nothing is windowed away in the DOM — the .body scroller owns overflow, so
    // the first AND last node must both be present.
    expect(whole).toContain("node-0");
    expect(whole).toContain(`node-${NODE_COUNT - 1}`);
    // and it's the row count we expect (one rendered row per flattened node).
    const rows = findAll(tree0, (n) => typeof n.props["onClick"] === "function");
    expect(rows.length).toBe(NODE_COUNT);
  });

  it("viewport-follows-selection: moving the node cursor scrolls the selected row into view", () => {
    mount();
    // mount fires the follow effect once for the initial cursor (row 0).
    expect(scrollCalls.length).toBeGreaterThanOrEqual(1);
    const before = scrollCalls.length;

    // walk the cursor down several nodes via the same keymap action ↓ drives.
    act(() => {
      for (let i = 0; i < 10; i++) runAction("agents.down", appStore);
    });

    // each cursor move re-ran the follow effect with the block:"nearest" idiom.
    expect(scrollCalls.length).toBeGreaterThan(before);
    expect(scrollCalls).toContainEqual({ block: "nearest" });
  });

  it("follow-tail: driving the cursor to the last node keeps scrolling it into view", () => {
    mount();
    scrollCalls.length = 0;
    act(() => {
      for (let i = 0; i < NODE_COUNT; i++) runAction("agents.down", appStore); // clamps at the last row
    });
    // the terminal move settled on the last node and asked to reveal it.
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls[scrollCalls.length - 1]).toEqual({ block: "nearest" });
  });
});
