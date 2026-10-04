import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { buildMemoryUpdateParams, type MemoryFormValues } from "../src/state/selectors.coord";

// MEM-5 (PLAN-MEMORY.md §8) — the in-place rich note editor. The wiki hook/popup
// and the update-param builder have their own unit suites; here we assert the
// EDITOR wiring: the title input, the folder <datalist>, the `[[` popup mounting
// OVER the body textarea (placement above), and ctrl/cmd+enter routing through
// validation into onSave. Node-env harness — the mount effect focuses the
// textarea, so createNodeMock hands the textarea a fake element with a live
// value+caret the wiki hook can read.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => { cb(0); return 0; };
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { MemoryNoteEditor } from "../src/components/MemoryNoteEditor";

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
const byLabel = (tree: TreeNode, label: string): TreeNode =>
  findAll(tree, (n) => n.props["aria-label"] === label)[0]!;

const TITLES = ["Note A", "Note B"];
const FOLDERS = ["ops", "tasks"];
const INITIAL: MemoryFormValues = { title: "Alpha", text: "the body", tags: "x, y", kind: "decision", folder: "ops" };

// The textarea ref becomes this fake element so the wiki hook can read a live
// value+caret; the mount effect calls focus()/setSelectionRange() on it.
let taEl: { value: string; selectionStart: number; focus: () => void; setSelectionRange: (a: number, b: number) => void };
const createNodeMock = (el: { type?: string }) => {
  const base = { value: "", selectionStart: 0, focus: () => {}, setSelectionRange: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  if (el.type === "textarea") { base.value = INITIAL.text; base.selectionStart = INITIAL.text.length; taEl = base; return base; }
  return base;
};

let mounted: ReturnType<typeof create> | null = null;
function render(overrides: { initial?: MemoryFormValues; onSave?: (p: Record<string, unknown>) => Promise<void>; onClose?: () => void } = {}): TreeNode {
  const onSave = overrides.onSave ?? vi.fn(async () => {});
  const onClose = overrides.onClose ?? vi.fn();
  act(() => {
    mounted = create(
      React.createElement(MemoryNoteEditor, { noteId: "n1", initial: overrides.initial ?? INITIAL, titles: TITLES, folders: FOLDERS, onSave, onClose }),
      { createNodeMock },
    );
  });
  return mounted!.toJSON() as TreeNode;
}
afterEach(() => { act(() => mounted?.unmount()); mounted = null; });

const ctrlEnter = () => ({ key: "Enter", ctrlKey: true, metaKey: false, preventDefault: vi.fn() });

describe("MemoryNoteEditor — MEM-5 header fields", () => {
  it("prefills the title input from the initial record (capped at 120)", () => {
    const tree = render();
    const title = byLabel(tree, "title");
    expect(title.props["value"]).toBe("Alpha");
    expect(title.props["maxLength"]).toBe(120);
  });

  it("wires the folder field to a <datalist> of the known folders", () => {
    const tree = render();
    const folder = byLabel(tree, "folder");
    const datalist = findAll(tree, (n) => n.type === "datalist")[0]!;
    expect(folder.props["list"]).toBe(datalist.props["id"]);
    expect(findAll(datalist, (n) => n.type === "option").map((o) => o.props["value"])).toEqual(FOLDERS);
  });
});

describe("MemoryNoteEditor — `[[` autocomplete over the body textarea", () => {
  it("opens the wiki popup when the textarea holds an open `[[` token", () => {
    const tree = render();
    taEl.value = "[[No";
    taEl.selectionStart = taEl.value.length;
    const textarea = findAll(tree, (n) => n.type === "textarea")[0]!;
    act(() => { (textarea.props["onChange"] as (e: unknown) => void)({ target: { value: taEl.value } }); });
    const popup = findAll(mounted!.toJSON() as TreeNode, (n) => n.props["data-wiki-autocomplete"] !== undefined)[0]!;
    expect(popup).toBeDefined();
    expect(findAll(popup, (n) => typeof n.props["data-wiki-option"] === "string").map((n) => n.props["data-wiki-option"])).toEqual(["Note A", "Note B"]);
  });
});

describe("MemoryNoteEditor — ctrl/cmd+enter save routing", () => {
  it("saves the built update params through onSave when the note is valid", () => {
    const onSave = vi.fn(async () => {});
    const tree = render({ onSave });
    const shell = findAll(tree, (n) => "onKeyDown" in n.props)[0]!; // outer editor div
    act(() => { (shell.props["onKeyDown"] as (e: unknown) => void)(ctrlEnter()); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(buildMemoryUpdateParams("n1", INITIAL, "app"));
  });

  it("blocks the save and surfaces the error when the body is empty", () => {
    const onSave = vi.fn(async () => {});
    const tree = render({ initial: { ...INITIAL, text: "" }, onSave });
    const shell = findAll(tree, (n) => "onKeyDown" in n.props)[0]!;
    act(() => { (shell.props["onKeyDown"] as (e: unknown) => void)(ctrlEnter()); });
    expect(onSave).not.toHaveBeenCalled();
    expect(hasText(mounted!.toJSON() as TreeNode, "text is required")).toBe(true);
  });
});

// Regression (code-review F1): the body textarea lives INSIDE the editor <div>
// that also carries the shell handler, so a keydown that acts MUST stopPropagation
// or it bubbles up and runs twice (double memory.update on ctrl+Enter; an Escape
// meant only to dismiss the [[ popup would also tear down the whole edit).
describe("MemoryNoteEditor — body keydown stops propagation (no double-handling)", () => {
  const bodyOnKeyDown = (tree: TreeNode) => findAll(tree, (n) => n.type === "textarea")[0]!.props["onKeyDown"] as (e: unknown) => void;

  it("ctrl+Enter on the body stops propagation so the shell can't re-fire save", () => {
    const onSave = vi.fn(async () => {});
    const tree = render({ onSave });
    const stopPropagation = vi.fn();
    act(() => { bodyOnKeyDown(tree)({ key: "Enter", ctrlKey: true, metaKey: false, preventDefault: vi.fn(), stopPropagation }); });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("Escape dismissing the `[[` popup stops propagation and does NOT close the editor", () => {
    const onClose = vi.fn();
    const tree = render({ onClose });
    // open the popup
    taEl.value = "[[No"; taEl.selectionStart = taEl.value.length;
    const textarea = findAll(tree, (n) => n.type === "textarea")[0]!;
    act(() => { (textarea.props["onChange"] as (e: unknown) => void)({ target: { value: taEl.value } }); });
    // Escape: the wiki popup consumes it; must stop propagation and leave onClose untouched
    const stopPropagation = vi.fn();
    act(() => { bodyOnKeyDown(mounted!.toJSON() as TreeNode)({ key: "Escape", preventDefault: vi.fn(), stopPropagation }); });
    expect(stopPropagation).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
