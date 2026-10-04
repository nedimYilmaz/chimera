import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// UNSAVED-EDIT-FORMS-NO-GUARD — ScheduleFormCard/QueueFormCard/TeamFormCard
// wired Esc/backdrop-click straight to onClose with no dirty-check, unlike
// WorkflowStudio (which prompts via ConfirmCard before discarding). A user
// editing a field who hits Esc out of habit silently lost the edit. This
// covers QueueFormCard (the simplest of the three: a single editable field).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { QueueFormCard } from "../src/components/QueueFormCard";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}
const textOf = (n: TreeNode): string => (n.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");

function mount(onClose: () => void) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(QueueFormCard, { mode: "create", onSubmit: async () => {}, onClose }),
    );
  });
  return renderer;
}

function setRetryLimit(renderer: ReturnType<typeof create>, value: string) {
  const input = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "input" && n.props["data-field"] === "retryLimit")[0]!;
  act(() => { (input.props as { onChange: (e: { target: { value: string } }) => void }).onChange({ target: { value } }); });
}

describe("QueueFormCard — unsaved-edit close guard", () => {
  it("esc-cancel with a dirty field shows a discard confirm instead of closing immediately", () => {
    let closed = false;
    const renderer = mount(() => { closed = true; });
    setRetryLimit(renderer, "5");
    const cancelChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("esc cancel"))!;
    act(() => { (cancelChip.props as { onClick: () => void }).onClick(); });
    expect(closed).toBe(false);
    const confirmChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("confirm discard"));
    expect(confirmChip).toBeTruthy();
  });

  it("confirming discard actually calls onClose", () => {
    let closed = false;
    const renderer = mount(() => { closed = true; });
    setRetryLimit(renderer, "5");
    const cancelChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("esc cancel"))!;
    act(() => { (cancelChip.props as { onClick: () => void }).onClick(); });
    const confirmChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("confirm discard"))!;
    act(() => { (confirmChip.props as { onClick: () => void }).onClick(); });
    expect(closed).toBe(true);
  });

  it("esc-cancel with no edits closes immediately (no confirm gate for clean state)", () => {
    let closed = false;
    const renderer = mount(() => { closed = true; });
    const cancelChip = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "button").find((n) => textOf(n).includes("esc cancel"))!;
    act(() => { (cancelChip.props as { onClick: () => void }).onClick(); });
    expect(closed).toBe(true);
  });
});
