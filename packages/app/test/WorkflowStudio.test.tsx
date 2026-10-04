import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// R2 QA fix wave 2 (#3, #4) — real store-driven render harness (InboxScreen.test.tsx's
// pattern: real appStore singleton, rpc/bridge mocked out, a bare window shim since this
// package's vitest env is plain node — no jsdom, matching WorkflowCard.test.tsx's own note).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { WorkflowStudio } from "../src/components/WorkflowStudio";
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

// every node button (not a header button) carries `style.left` — the header's Save/Close
// buttons render with no `style` prop at all.
const isNodeButton = (n: TreeNode): boolean =>
  n.type === "button" && typeof (n.props.style as Record<string, unknown> | undefined)?.["left"] === "number";

const DOC = {
  name: "release-flow",
  onFail: "halt" as const,
  retryLimit: 0,
  params: [],
  nodeOrder: ["a", "b"],
  nodesById: {
    a: { id: "a", step: { id: "a", title: "A", gate: { kind: "none" as const } } },
    b: { id: "b", step: { id: "b", title: "B", gate: { kind: "none" as const } } },
  },
  edgesById: {},
};

function renderStudio() {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(WorkflowStudio)); });
  return renderer.toJSON() as TreeNode;
}

function mountStudio() {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(WorkflowStudio)); });
  return renderer;
}

afterEach(() => {
  act(() => {
    appStore.dispatch({ type: "workflowStudioClose" });
    appStore.dispatch({ type: "queueDetail", detail: null });
  });
});

describe("WorkflowStudio — runtime overlay rendering", () => {
  it("a pending-state node's className never contains the literal 'undefined'", () => {
    act(() => {
      appStore.dispatch({ type: "queueDetail", detail: { spec: { name: "q1" }, counts: {}, tasks: [{ taskId: "t1", stepHistory: [] }] } });
      appStore.dispatch({ type: "workflowStudioOpen", mode: "inspect", document: DOC, queue: "q1", taskId: "t1", version: 1 });
    });
    const tree = renderStudio();
    const nodes = findAll(tree, isNodeButton);
    expect(nodes).toHaveLength(2); // both "a" and "b" are pending — no stepHistory entries at all
    for (const n of nodes) expect(String(n.props.className)).not.toMatch(/\bundefined\b/);
  });

  it("failedOnly renders only the failed-state node", () => {
    act(() => {
      appStore.dispatch({
        type: "queueDetail",
        detail: { spec: { name: "q1" }, counts: {}, tasks: [{ taskId: "t1", stepHistory: [{ stepId: "b", stepIndex: 1, agentId: "x", outcome: "failed", reason: "boom" }] }] },
      });
      appStore.dispatch({ type: "workflowStudioOpen", mode: "inspect", document: DOC, queue: "q1", taskId: "t1", version: 1, failedOnly: true });
    });
    const tree = renderStudio();
    const nodes = findAll(tree, isNodeButton);
    expect(nodes).toHaveLength(1);
    expect(String(nodes[0]!.props.className)).toContain("failed");
  });

  it("without failedOnly the same data renders every node (regression guard on the filter default)", () => {
    act(() => {
      appStore.dispatch({
        type: "queueDetail",
        detail: { spec: { name: "q1" }, counts: {}, tasks: [{ taskId: "t1", stepHistory: [{ stepId: "b", stepIndex: 1, agentId: "x", outcome: "failed", reason: "boom" }] }] },
      });
      appStore.dispatch({ type: "workflowStudioOpen", mode: "inspect", document: DOC, queue: "q1", taskId: "t1", version: 1 });
    });
    const tree = renderStudio();
    expect(findAll(tree, isNodeButton)).toHaveLength(2);
  });
});

describe("WorkflowStudio — close discards unsaved edits", () => {
  const textOf = (n: TreeNode): string => (n.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");
  const findButtonByText = (tree: TreeNode, text: string): TreeNode | undefined =>
    findAll(tree, (n) => n.type === "button").find((n) => textOf(n).includes(text));

  it("closing with unsaved (dirty) edits shows a discard confirm instead of closing immediately", () => {
    act(() => {
      appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: DOC, version: 1 });
      appStore.dispatch({ type: "workflowStudioDraft", document: { ...DOC, name: "release-flow-edited" } });
    });
    const renderer = mountStudio();
    expect(appStore.getState().workflowStudio.dirty).toBe(true);
    act(() => { (findButtonByText(renderer.toJSON() as TreeNode, "Close Esc")!.props as { onClick: () => void }).onClick(); });
    // still open — the close was intercepted by the confirm gate, not applied
    expect(appStore.getState().workflowStudio.open).toBe(true);
    const confirmChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("confirm discard"));
    expect(confirmChip).toBeTruthy();
  });

  it("confirming discard actually closes the studio", () => {
    act(() => {
      appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: DOC, version: 1 });
      appStore.dispatch({ type: "workflowStudioDraft", document: { ...DOC, name: "release-flow-edited" } });
    });
    const renderer = mountStudio();
    act(() => { (findButtonByText(renderer.toJSON() as TreeNode, "Close Esc")!.props as { onClick: () => void }).onClick(); });
    const confirmChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("confirm discard"));
    act(() => { (confirmChip!.props as { onClick: () => void }).onClick(); });
    expect(appStore.getState().workflowStudio.open).toBe(false);
  });

  it("closing with no unsaved edits closes immediately (no confirm gate for clean state)", () => {
    act(() => {
      appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: DOC, version: 1 });
    });
    const renderer = mountStudio();
    expect(appStore.getState().workflowStudio.dirty).toBe(false);
    act(() => { (findButtonByText(renderer.toJSON() as TreeNode, "Close Esc")!.props as { onClick: () => void }).onClick(); });
    expect(appStore.getState().workflowStudio.open).toBe(false);
  });
});

describe("WorkflowStudio — save-error visibility", () => {
  it("renders studio.error text in the header when a save fails (was silently dropped)", () => {
    act(() => {
      appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: DOC, version: 1 });
      appStore.dispatch({ type: "workflowStudioSaving", saving: false, error: "workflow.update failed: boom" });
    });
    const tree = renderStudio();
    const spans = findAll(tree, (n) => n.type === "span");
    const errorSpan = spans.find((n) => (n.children ?? []).some((c) => typeof c === "string" && c.includes("workflow.update failed: boom")));
    expect(errorSpan).toBeTruthy();
  });
});
