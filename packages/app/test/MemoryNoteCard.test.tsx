import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// MEM-5 (PLAN-MEMORY.md §8) — the add/edit memory-note card. WikiAutocomplete's
// pure core and the popup are proven in WikiAutocomplete.test.tsx; here we assert
// the CARD-level wiring the screen test never touches: the MEM-5 field set/order
// (title · text · tags · kind · folder), the folder <datalist>, the `[[` popup
// mounting over the text field, and the submit-on-error focus jump back to
// `text`. OverlayCard's esc effect needs a bare window stub (node-env vitest, no
// jsdom); the text field's ref is a fake element we can hand a value+caret so the
// wiki hook reads a live `[[` token (createNodeMock returns real DOM-less mocks).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => { cb(0); return 0; };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { MemoryNoteCard } from "../src/components/MemoryNoteCard";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
const findAll = (node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] => {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) if (typeof c !== "string") findAll(c, pred, out);
  return out;
};
const hasText = (node: TreeNode | string | null, needle: string): boolean => {
  if (node === null) return false;
  if (typeof node === "string") return node.includes(needle);
  for (const c of node.children ?? []) if (hasText(c, needle)) return true;
  return false;
};
const inputByField = (tree: TreeNode, field: string): TreeNode =>
  findAll(tree, (n) => n.props["data-field"] === field)[0]!;
const clsOf = (n: TreeNode): string => (n.props["className"] as string) ?? "";

// The text field's ref becomes THIS fake element, so the wiki hook can read a
// live value+caret (react-test-renderer node mocks are DOM-less).
const TITLES = ["Note A", "Note B"];
const FOLDERS = ["ops", "ops/failure", "tasks"];
let textEl: { value: string; selectionStart: number; focus: () => void; setSelectionRange: (a: number, b: number) => void };
const createNodeMock = (el: { type?: string; props?: Record<string, unknown> }) => {
  const base = { value: "", selectionStart: 0, focus: () => {}, setSelectionRange: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  if (el.props?.["data-field"] === "text") { textEl = base; return base; }
  return base;
};

let mounted: ReturnType<typeof create> | null = null;
function render(overrides: { onSubmit?: (p: Record<string, unknown>) => Promise<void>; onClose?: () => void } = {}): TreeNode {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => {});
  const onClose = overrides.onClose ?? vi.fn();
  act(() => {
    mounted = create(
      React.createElement(MemoryNoteCard, { titles: TITLES, folders: FOLDERS, onSubmit, onClose }),
      { createNodeMock },
    );
  });
  return mounted!.toJSON() as TreeNode;
}
afterEach(() => { act(() => mounted?.unmount()); mounted = null; });

describe("MemoryNoteCard — MEM-5 field set", () => {
  it("renders the five fields in title · text · tags · kind · folder order", () => {
    const tree = render();
    const order = findAll(tree, (n) => typeof n.props["data-field"] === "string").map((n) => n.props["data-field"]);
    expect(order).toEqual(["title", "text", "tags", "kind", "folder"]);
  });

  it("caps the title field at 120 chars (the record-title bound)", () => {
    const tree = render();
    expect(inputByField(tree, "title").props["maxLength"]).toBe(120);
  });
});

describe("MemoryNoteCard — folder datalist", () => {
  it("wires the folder field to a <datalist> carrying every known folder", () => {
    const tree = render();
    const folder = inputByField(tree, "folder");
    const datalist = findAll(tree, (n) => n.type === "datalist")[0]!;
    expect(folder.props["list"]).toBe(datalist.props["id"]);
    const opts = findAll(datalist, (n) => n.type === "option").map((o) => o.props["value"]);
    expect(opts).toEqual(FOLDERS);
  });
});

describe("MemoryNoteCard — `[[` autocomplete over the text field", () => {
  it("opens the wiki popup when the text field holds an open `[[` token", () => {
    const tree = render();
    // seed the fake text element with a live `[[No` token, then fire onChange so
    // the field's wiki.refresh() reads it.
    textEl.value = "see [[No";
    textEl.selectionStart = textEl.value.length;
    act(() => { (inputByField(tree, "text").props["onChange"] as (e: unknown) => void)({ target: { value: textEl.value } }); });
    const popup = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-wiki-autocomplete"] !== undefined)[0]!;
    expect(popup).toBeDefined();
    const options = findAll(popup, (n) => typeof n.props["data-wiki-option"] === "string").map((n) => n.props["data-wiki-option"]);
    expect(options).toEqual(["Note A", "Note B"]);
  });
});

describe("MemoryNoteCard — submit validation", () => {
  it("focuses the text field and shows the error when submitting an empty note", () => {
    const onSubmit = vi.fn(async () => {});
    const tree = render({ onSubmit });
    // jump the field cursor to the LAST field (folder) so a submit validates
    // instead of just advancing.
    act(() => { (inputByField(tree, "folder").props["onFocus"] as () => void)(); });
    const submit = findAll(mounted!.toJSON() as TreeNode, (n) => clsOf(n).includes("submitChip"))[0]!;
    act(() => { (submit.props["onClick"] as () => void)(); });
    const after = mounted!.toJSON() as TreeNode;
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasText(after, "text is required")).toBe(true);
    // validation parks the active field back on `text`.
    expect(clsOf(inputByField(after, "text"))).toContain("inputActive");
  });
});
