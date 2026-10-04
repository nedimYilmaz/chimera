import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { MessageBody, WikiLinkProvider, type WikiLinkHandlers, type WikiLinkResolution } from "../src/components/MessageBody";

// MEM-5 (PLAN-MEMORY.md §8) — the four `WikiChip` status branches. The screen
// round-trip (MemoryScreen.mem5.test.tsx) wires the provider end-to-end, but the
// resolved / ghost / missing / plain branch selection (class + clickability +
// title) is never asserted directly. A `[[Title]]` inline span parses to a
// wikilink; the provider's resolve() decides the branch. Node-env harness,
// mirrors MessageBody.test.tsx.
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
const textOf = (node: TreeNode | string): string =>
  typeof node === "string" ? node : (node.children ?? []).map(textOf).join("");

let mounted: ReturnType<typeof create> | null = null;
function renderBody(text: string, handlers?: WikiLinkHandlers): TreeNode {
  const body = React.createElement(MessageBody, { text, done: true, rawView: false });
  act(() => {
    mounted = create(handlers ? React.createElement(WikiLinkProvider, { value: handlers, children: body }) : body);
  });
  return mounted!.toJSON() as TreeNode;
}
// the wiki chip is a span whose class name carries the "wiki" prefix.
const chipOf = (tree: TreeNode): TreeNode =>
  findAll(tree, (n) => n.type === "span" && typeof n.props["className"] === "string" && (n.props["className"] as string).toLowerCase().includes("wiki"))[0]!;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

const handlers = (resolve: (t: string) => WikiLinkResolution | null, onNavigate = vi.fn()): WikiLinkHandlers => ({ resolve, onNavigate });

describe("WikiChip — resolved branch (a [[..]] pointing at a live note)", () => {
  it("renders a clickable link chip and routes a click to onNavigate", () => {
    const onNavigate = vi.fn();
    const tree = renderBody("see [[Note A]]", handlers(() => ({ resolvedId: "A", resolvedTitle: "Note A" }), onNavigate));
    const chip = chipOf(tree);
    expect(chip.props["className"]).toContain("wikiLink");
    expect(chip.props["role"]).toBe("button");
    expect(chip.props["title"]).toBe("Note A");
    (chip.props["onClick"] as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onNavigate).toHaveBeenCalledWith("Note A");
  });
});

describe("WikiChip — ghost branch (a title with no note yet)", () => {
  it("renders a dim, NON-clickable ghost chip with a 'no note yet' title", () => {
    // A ghost has no note to navigate to (resolvedId null), so it must not be a
    // button whose click silently no-ops (code-review advisory).
    const tree = renderBody("see [[Future]]", handlers(() => ({ resolvedId: null, resolvedTitle: "Future" })));
    const chip = chipOf(tree);
    expect(chip.props["className"]).toContain("wikiGhost");
    expect(chip.props["role"]).toBeUndefined();
    expect(chip.props["onClick"]).toBeUndefined();
    expect(chip.props["title"]).toBe("Future (no note yet)");
  });
});

describe("WikiChip — missing branch (an evicted/deleted target)", () => {
  it("renders a non-clickable missing chip (resolve → null)", () => {
    const onNavigate = vi.fn();
    const tree = renderBody("see [[gone-id]]", handlers(() => null, onNavigate));
    const chip = chipOf(tree);
    expect(chip.props["className"]).toContain("wikiMissing");
    expect(chip.props["role"]).toBeUndefined();
    expect(chip.props["onClick"]).toBeUndefined();
    expect(chip.props["title"]).toBe("gone-id (missing)");
  });

  it("also treats a fully-unresolved resolution ({null,null}) as missing", () => {
    const tree = renderBody("see [[gone]]", handlers(() => ({ resolvedId: null, resolvedTitle: null })));
    expect(chipOf(tree).props["className"]).toContain("wikiMissing");
  });
});

describe("WikiChip — plain branch (no provider / transcript)", () => {
  it("renders a static plain chip with no role and no navigation", () => {
    const tree = renderBody("see [[Note A]]"); // no WikiLinkProvider
    const chip = chipOf(tree);
    expect(chip.props["className"]).toContain("wikiPlain");
    expect(chip.props["role"]).toBeUndefined();
    expect(chip.props["onClick"]).toBeUndefined();
    expect(textOf(chip)).toBe("Note A"); // display text preserved
  });
});
