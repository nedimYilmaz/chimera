import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { EditTaskFormValues } from "../src/state/selectors.coord";

// TASK-EDIT-VERSIONING — the edit-task form (EditTaskCard) is PushTaskCard's
// silhouette but PREFILLED from a still-queued task and submitting a
// queue.editTask patch. Harness mirrors SpawnCard.test.tsx: OverlayCard's
// esc-key effect needs a bare window stub (this package's vitest config runs a
// node env, no jsdom), and we drive the form through its onChange / onKeyDown
// props against a scripted onSubmit spy (no rpc bridge — EditTaskCard takes
// onSubmit as a prop, so there's nothing to mock).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { EditTaskCard } from "../src/components/EditTaskCard";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function byAttr(tree: TreeNode, attr: string, value?: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props && (value === undefined || n.props[attr] === value));
}

/** The single wrapping div carrying onKeyDown (Enter submits/advances, ↑↓ navigate). */
function keyHost(tree: TreeNode): TreeNode {
  return findAll(tree, (n) => "onKeyDown" in n.props)[0]!;
}

/** The two clickable chips, in document order: [0] enter/save submit, [1] esc cancel. */
function clickChips(tree: TreeNode): TreeNode[] {
  return findAll(tree, (n) => "onClick" in n.props);
}

/** Does the rendered tree contain a text node including `needle` (error hint lives
 * in the header as a bare string child of a <span>). */
function hasText(node: TreeNode | string | null, needle: string): boolean {
  if (node === null) return false;
  if (typeof node === "string") return node.includes(needle);
  for (const child of node.children ?? []) if (hasText(child, needle)) return true;
  return false;
}

const INITIAL: EditTaskFormValues = { prompt: "ship the thing", priority: "3", role: "dev", tags: "" };

function renderCard(overrides: {
  initial?: EditTaskFormValues;
  onSubmit?: (patch: Record<string, unknown>) => Promise<void>;
  onClose?: () => void;
} = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => {});
  const onClose = overrides.onClose ?? vi.fn();
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(EditTaskCard, {
        taskId: "t7",
        queue: "build",
        initial: overrides.initial ?? INITIAL,
        onSubmit,
        onClose,
      }),
    );
  });
  return { renderer, onSubmit, onClose };
}

function type(renderer: ReturnType<typeof create>, field: string, value: string): void {
  const tree = renderer.toJSON() as TreeNode;
  const [input] = byAttr(tree, "data-field", field);
  act(() => { (input!.props["onChange"] as (e: unknown) => void)({ target: { value } }); });
}

function pressEnter(renderer: ReturnType<typeof create>): void {
  const host = keyHost(renderer.toJSON() as TreeNode);
  act(() => { (host.props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", preventDefault() {} }); });
}

function pressArrow(renderer: ReturnType<typeof create>, dir: "ArrowUp" | "ArrowDown"): void {
  const host = keyHost(renderer.toJSON() as TreeNode);
  act(() => { (host.props["onKeyDown"] as (e: unknown) => void)({ key: dir, preventDefault() {} }); });
}

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("EditTaskCard — prefill", () => {
  it("renders prompt/priority/role/tags inputs prefilled from the task's head fields", () => {
    const { renderer } = renderCard();
    const tree = renderer.toJSON() as TreeNode;
    expect(byAttr(tree, "data-field", "prompt")[0]!.props["value"]).toBe("ship the thing");
    expect(byAttr(tree, "data-field", "priority")[0]!.props["value"]).toBe("3");
    expect(byAttr(tree, "data-field", "role")[0]!.props["value"]).toBe("dev");
  });

  it("shows the taskId → queue in the header meta", () => {
    const { renderer } = renderCard();
    expect(hasText(renderer.toJSON() as TreeNode, "t7 → build")).toBe(true);
  });
});

describe("EditTaskCard — Enter field navigation + submit gating", () => {
  it("Enter advances through fields and only submits from the LAST (tags) field", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ onSubmit });
    pressEnter(renderer); // prompt -> priority
    pressEnter(renderer); // priority -> role
    pressEnter(renderer); // role -> tags   (TASK-TAGS added this field; role is no longer last)
    expect(onSubmit).not.toHaveBeenCalled();
    pressEnter(renderer); // tags (last) -> validate + submit
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("the enter/save chip runs the SAME submit() as Enter — advancing from a non-last field, submitting from the last", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ onSubmit });
    const clickSubmit = () => {
      const [chip] = clickChips(renderer.toJSON() as TreeNode);
      act(() => { (chip!.props["onClick"] as () => void)(); });
    };
    clickSubmit(); // from field 0 -> advances, no submit
    expect(onSubmit).not.toHaveBeenCalled();
    clickSubmit(); // field 1 -> advances
    clickSubmit(); // field 2 -> advances
    clickSubmit(); // field 3 (tags, last) -> submit
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("EditTaskCard — Arrow key navigation", () => {
  it("ArrowDown jumps focus toward the last field so a single Enter then submits", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ onSubmit });
    pressArrow(renderer, "ArrowDown"); // 0 -> 1
    pressArrow(renderer, "ArrowDown"); // 1 -> 2
    pressArrow(renderer, "ArrowDown"); // 2 -> 3 (tags, last)
    pressEnter(renderer);              // last field -> submit
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ArrowUp is clamped at the first field (Enter from index 0 never submits)", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ onSubmit });
    pressArrow(renderer, "ArrowUp");   // clamp at 0
    pressArrow(renderer, "ArrowUp");   // still 0
    pressEnter(renderer);              // 0 -> 1, not a submit
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("EditTaskCard — validation + error placement", () => {
  it("an empty prompt blocks submit and surfaces the prompt error in the header", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ initial: { prompt: "", priority: "3", role: "dev", tags: "" }, onSubmit });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer); // submit attempt from last field
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasText(renderer.toJSON() as TreeNode, "prompt is required")).toBe(true);
  });

  it("a non-integer priority blocks submit and surfaces the priority error", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ initial: { prompt: "go", priority: "abc", role: "", tags: "" }, onSubmit });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasText(renderer.toJSON() as TreeNode, "priority must be an integer")).toBe(true);
  });

  it("editing a field clears a shown error", async () => {
    const { renderer } = renderCard({ initial: { prompt: "", priority: "3", role: "", tags: "" } });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    expect(hasText(renderer.toJSON() as TreeNode, "prompt is required")).toBe(true);
    type(renderer, "prompt", "now has content");
    expect(hasText(renderer.toJSON() as TreeNode, "prompt is required")).toBe(false);
  });
});

describe("EditTaskCard — buildEditPatch on final submit", () => {
  it("submits the trimmed prompt, numeric priority, and the role verbatim", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ initial: { prompt: "  do it  ", priority: "5", role: "qa", tags: " gate:coverage , area:core " }, onSubmit });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ prompt: "do it", priority: 5, role: "qa", tags: ["gate:coverage", "area:core"] });
  });

  it("an empty role field clears the per-task override to null", async () => {
    const onSubmit = vi.fn(async () => {});
    const { renderer } = renderCard({ initial: { prompt: "go", priority: "0", role: "", tags: "" }, onSubmit });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    // TASK-TAGS: an emptied tags field submits [] — that IS how an operator removes every tag.
    expect(onSubmit).toHaveBeenCalledWith({ prompt: "go", priority: 0, role: null, tags: [] });
  });

  it("calls onClose after onSubmit resolves", async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    const { renderer } = renderCard({ initial: { prompt: "go", priority: "1", role: "dev", tags: "" }, onSubmit, onClose });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected onSubmit as an inline error and does NOT close", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("task no longer queued"); });
    const onClose = vi.fn();
    const { renderer } = renderCard({ initial: { prompt: "go", priority: "1", role: "dev", tags: "" }, onSubmit, onClose });
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");
    pressArrow(renderer, "ArrowDown");   // TASK-TAGS: one more field to walk past
    pressEnter(renderer);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(hasText(renderer.toJSON() as TreeNode, "task no longer queued")).toBe(true);
  });
});

describe("EditTaskCard — cancel", () => {
  it("clicking the esc/cancel chip calls onClose without submitting", () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    const { renderer } = renderCard({ onSubmit, onClose });
    const chips = clickChips(renderer.toJSON() as TreeNode);
    act(() => { (chips[1]!.props["onClick"] as () => void)(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
