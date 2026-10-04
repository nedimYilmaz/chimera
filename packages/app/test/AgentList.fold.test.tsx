import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// AGENTLIST-CARET-REMOVAL (render half): selectors.test.ts already proves
// buildAgentRows computes `collapsed`/`hiddenCount` (the pure model). What was
// untested is the app web `Row` component ACTUALLY rendering that model — the
// dim "+N" hidden-child suffix on a folded parent — and, symmetrically, that the
// old click-to-fold ▾/▸ caret span (and its onClick dispatch) is GONE (folding
// is keyboard-only now, agents.foldLeft/foldRight; see AgentList.tsx's
// AGENTLIST-CARET-REMOVAL comment). These are render assertions, so they live
// beside the AgentList render harness (agent-shadow-pane.test.tsx) rather than
// the pure-selector suite.
//
// Same node-env shims/mocks that agent-shadow-pane.test.tsx uses to render
// AgentList (this package's vitest env is plain node, no jsdom/Tauri context).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { AgentList } from "../src/components/AgentList";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

// The app's AgentList reads the SHARED appStore singleton, which accumulates
// agents across tests (agentRecords upserts, it never removes) and keeps a
// process-wide `collapsed` Set. So every assertion is scoped to ONE row's
// subtree, located by a per-test-unique agentId that is not a prefix of any
// other id in play — never the whole flattened list.
function walk(node: TreeNode | string | null, visit: (n: TreeNode) => void): void {
  if (!node || typeof node === "string") return;
  visit(node);
  (node.children ?? []).forEach((c) => walk(c as TreeNode, visit));
}

// The onClick-bearing row container whose flattened text carries `idToken`
// (an agent row renders its agentId as the dim secondary label). undefined when
// that agent has no row — e.g. it's hidden inside a folded parent.
function findRow(root: TreeNode | null, idToken: string): TreeNode | undefined {
  let hit: TreeNode | undefined;
  walk(root, (n) => {
    if (typeof n.props?.onClick === "function" && flattenText(n).includes(idToken) && !hit) hit = n;
  });
  return hit;
}

// A parent (depth 0) with one same-tree child (depth 1) — the parent is
// `collapsible`, so folding it hides the child and yields hiddenCount 1. The
// child's treeId matches the parent so buildAgentRows sees it as a descendant;
// the agentIds are chosen so neither is a substring of the other.
function seed(parent: string, child: string) {
  act(() => {
    appStore.dispatch({
      type: "agentRecords",
      records: [
        { agentId: parent, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: parent, depth: 0 },
        { agentId: child, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, treeId: parent, depth: 1 },
      ],
    });
  });
}

function render(): TreeNode {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(AgentList)); });
  return renderer.toJSON() as TreeNode;
}

// Leave the process-wide `collapsed` Set clean so a leaked id can't flip the
// meaning of a later test's `collapse` toggle.
const toUncollapse: string[] = [];
afterEach(() => {
  act(() => {
    for (const id of toUncollapse) {
      if (appStore.getState().collapsed.has(id)) appStore.dispatch({ type: "collapse", agentId: id });
    }
  });
  toUncollapse.length = 0;
});
function collapse(id: string) {
  toUncollapse.push(id);
  act(() => appStore.dispatch({ type: "collapse", agentId: id }));
}

describe("AgentList Row — folded parent shows a dim +N suffix (AGENTLIST-CARET-REMOVAL)", () => {
  it("appends +N (N = hidden descendant rows) inside a folded parent's row", () => {
    seed("par1", "kid1");
    collapse("par1");
    const row = findRow(render(), "par1");
    expect(row && flattenText(row)).toContain("+1");
  });

  it("removes the folded parent's child row from the rendered list", () => {
    seed("par2", "kid2");
    collapse("par2");
    expect(findRow(render(), "kid2")).toBeUndefined();
  });

  it("shows NO +N suffix while that parent is expanded (child row present instead)", () => {
    seed("par3", "kid3");
    const tree = render();
    expect(flattenText(findRow(tree, "par3"))).not.toContain("+");
    expect(findRow(tree, "kid3")).toBeDefined();
  });
});

describe("AgentList Row — the click-to-fold caret is gone (AGENTLIST-CARET-REMOVAL)", () => {
  it("renders NO ▾/▸ fold caret glyph in a collapsible parent's row, expanded or folded", () => {
    seed("par4", "kid4");
    const expanded = flattenText(findRow(render(), "par4"));
    expect(expanded).not.toContain("▾");
    expect(expanded).not.toContain("▸");
    collapse("par4");
    const folded = flattenText(findRow(render(), "par4"));
    expect(folded).not.toContain("▾");
    expect(folded).not.toContain("▸");
  });

  it("has no separate caret onClick: a parent row wires exactly one onClick (row-select), no nested clickable", () => {
    seed("par5", "kid5");
    const row = findRow(render(), "par5");
    expect(row).toBeDefined();
    // The row container itself carries the select-on-click; a resurrected caret
    // would add a SECOND onClick-bearing node nested inside the row.
    let nestedClickables = 0;
    (row!.children ?? []).forEach((c) => walk(c as TreeNode, (n) => {
      if (typeof n.props?.onClick === "function") nestedClickables++;
    }));
    expect(nestedClickables).toBe(0);
  });
});
