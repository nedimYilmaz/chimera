import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { FolderRail } from "../src/components/FolderRail";
import type { MemoryFolderNode } from "../src/state/selectors.coord";
import type { MemoryFolderSel } from "@chimera/ui-state";

// MEM-5 (PLAN-MEMORY.md §8) — the folder rail render half. The pure tree math
// (buildFolderTree) is proven in selectors.coord.test.ts; here we assert the
// component wiring the screen test leaves untested: the selected-highlight
// (sameSel), the collapse toggle, and the `visible` collapsed-ancestor filter.
// Node-env render harness (this package's vitest has no jsdom), same shape as
// MessageBody.test.tsx.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};
const createNodeMock = () => ({ focus: () => {}, addEventListener: () => {}, removeEventListener: () => {} });

// ops (children) / ops/failure / ops/protocols / tasks — mirrors the tree
// buildFolderTree emits (pre-order, roll-up counts).
const TREE: MemoryFolderNode[] = [
  { path: "ops", name: "ops", depth: 0, count: 5, hasChildren: true },
  { path: "ops/failure", name: "failure", depth: 1, count: 2, hasChildren: false },
  { path: "ops/protocols", name: "protocols", depth: 1, count: 3, hasChildren: false },
  { path: "tasks", name: "tasks", depth: 0, count: 4, hasChildren: false },
];

let mounted: ReturnType<typeof create> | null = null;
function render(props: { selected: MemoryFolderSel; onSelect?: (s: MemoryFolderSel) => void }): TreeNode {
  act(() => {
    mounted = create(
      React.createElement(FolderRail, {
        tree: TREE,
        total: 9,
        unfiled: 4,
        selected: props.selected,
        onSelect: props.onSelect ?? (() => {}),
      }),
      { createNodeMock },
    );
  });
  return mounted!.toJSON() as TreeNode;
}
const entries = (tree: TreeNode): string[] =>
  findAll(tree, (n) => typeof n.props["data-folder-entry"] === "string").map((n) => n.props["data-folder-entry"] as string);
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("FolderRail — tree render", () => {
  it("renders the virtual all/unfiled entries then the folder tree, in order", () => {
    const tree = render({ selected: { kind: "all" } });
    expect(entries(tree)).toEqual(["all", "unfiled", "f:ops", "f:ops/failure", "f:ops/protocols", "f:tasks"]);
  });

  it("shows the total / unfiled / per-folder counts", () => {
    const tree = render({ selected: { kind: "all" } });
    const counts = findAll(tree, (n) => typeof n.props["className"] === "string" && (n.props["className"] as string).includes("count"));
    // all=9, unfiled=4, ops=5, failure=2, protocols=3, tasks=4
    expect(counts.map((c) => (c.children ?? []).join(""))).toEqual(["9", "4", "5", "2", "3", "4"]);
  });
});

describe("FolderRail — selection highlight (sameSel)", () => {
  it("marks the selected virtual `all` entry", () => {
    const tree = render({ selected: { kind: "all" } });
    const all = findAll(tree, (n) => n.props["data-folder-entry"] === "all")[0]!;
    expect(all.props["className"]).toContain("entrySelected");
  });

  it("marks the selected folder entry by path, leaving siblings unselected", () => {
    const tree = render({ selected: { kind: "folder", path: "ops/failure" } });
    const failure = findAll(tree, (n) => n.props["data-folder-entry"] === "f:ops/failure")[0]!;
    const protocols = findAll(tree, (n) => n.props["data-folder-entry"] === "f:ops/protocols")[0]!;
    expect(failure.props["className"]).toContain("entrySelected");
    expect(protocols.props["className"]).not.toContain("entrySelected");
  });

  it("routes a click to onSelect with the entry's folder selection", () => {
    const onSelect = vi.fn();
    const tree = render({ selected: { kind: "all" }, onSelect });
    const ops = findAll(tree, (n) => n.props["data-folder-entry"] === "f:ops")[0]!;
    (ops.props["onClick"] as () => void)();
    expect(onSelect).toHaveBeenCalledWith({ kind: "folder", path: "ops" });
  });
});

describe("FolderRail — fold toggle + visible ancestor-hide filter", () => {
  it("renders a fold caret only on nodes with children", () => {
    const tree = render({ selected: { kind: "all" } });
    const folds = findAll(tree, (n) => typeof n.props["data-folder-fold"] === "string").map((n) => n.props["data-folder-fold"]);
    expect(folds).toEqual(["ops"]); // only ops has children
  });

  it("collapsing a parent hides its descendants but keeps the parent (and siblings)", () => {
    const tree = render({ selected: { kind: "all" } });
    const opsFold = findAll(tree, (n) => n.props["data-folder-fold"] === "ops")[0]!;
    act(() => (opsFold.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} }));
    // ops/failure and ops/protocols vanish; ops itself + tasks remain.
    expect(entries(mounted!.toJSON() as TreeNode)).toEqual(["all", "unfiled", "f:ops", "f:tasks"]);
  });

  it("toggles the caret glyph and re-expands on a second click", () => {
    const tree = render({ selected: { kind: "all" } });
    const readCaret = (): string =>
      (findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-folder-fold"] === "ops")[0]!.children ?? []).join("");
    expect(readCaret()).toBe("▾"); // expanded
    const opsFold = findAll(tree, (n) => n.props["data-folder-fold"] === "ops")[0]!;
    act(() => (opsFold.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} }));
    expect(readCaret()).toBe("▸"); // collapsed
    const opsFold2 = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-folder-fold"] === "ops")[0]!;
    act(() => (opsFold2.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} }));
    expect(readCaret()).toBe("▾"); // expanded again
    expect(entries(mounted!.toJSON() as TreeNode)).toContain("f:ops/failure");
  });
});
