import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { WorkflowFormCard } from "../src/components/WorkflowFormCard";
import { defaultWorkflowFormValues, workflowFormValuesFromRow, workflowRow } from "../src/state/selectors.workflows";

// F16.1 Phase 1 (WF-2) — per-step instructions textarea: a real render pass
// via react-test-renderer, mirroring WorkflowStepDots.test.tsx's harness (no
// DOM, just the rendered tree). This suite's subject renders through
// OverlayCard, whose esc-key effect touches `window.addEventListener` — the
// package's vitest config runs a bare node env (no jsdom dependency), so we
// stub just the two methods that effect needs rather than pull in a DOM.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

type TreeNode = { type: string; props: Record<string, unknown>; children: TreeNode[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

describe("WorkflowFormCard — per-step instructions field", () => {
  it("renders one instructions textarea per step (create mode, default single step)", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, {
          initial: undefined,
          bindQueue: null,
          onSubmit: async () => {},
          onClose: () => {},
        }),
      );
    });
    const tree = renderer.toJSON() as TreeNode;
    const textareas = findAll(tree, (n) => n.type === "textarea");
    expect(textareas).toHaveLength(1);
    expect(textareas[0]!.props["data-field"]).toBe("step-0-instructions");
    expect(textareas[0]!.props["value"]).toBe("");
  });

  it("prefills each step's textarea in edit mode from workflowFormValuesFromRow", () => {
    const row = workflowRow({
      name: "release-flow",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" }, instructions: "check the changelog" },
        { id: "ship", title: "ship it", gate: { kind: "none" } },
      ],
    });
    const initial = workflowFormValuesFromRow(row);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, { initial, bindQueue: null, onSubmit: async () => {}, onClose: () => {} }),
      );
    });
    const tree = renderer.toJSON() as TreeNode;
    const textareas = findAll(tree, (n) => n.type === "textarea");
    expect(textareas).toHaveLength(2);
    expect(textareas[0]!.props["value"]).toBe("check the changelog");
    expect(textareas[1]!.props["value"]).toBe("");
  });

  it("adding a step adds another instructions textarea", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, {
          initial: defaultWorkflowFormValues(),
          bindQueue: null,
          onSubmit: async () => {},
          onClose: () => {},
        }),
      );
    });
    const addChip = findAll(renderer.toJSON() as TreeNode, (n) => n.props["role"] === "button" && /add step/.test(String(n.children?.[0] ?? "")))[0]!;
    act(() => {
      (addChip.props["onClick"] as () => void)();
    });
    const textareas = findAll(renderer.toJSON() as TreeNode, (n) => n.type === "textarea");
    expect(textareas).toHaveLength(2);
    expect(textareas[1]!.props["data-field"]).toBe("step-1-instructions");
  });
});

describe("WorkflowFormCard — per-step role input + context toggle (F16.1 Phase 3, WF-10)", () => {
  it("renders a role input (create mode, default single step) defaulting to \"\" with the default \"handoff\" context chip active", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, { initial: undefined, bindQueue: null, onSubmit: async () => {}, onClose: () => {} }),
      );
    });
    const tree = renderer.toJSON() as TreeNode;
    const roleInput = findAll(tree, (n) => n.props["data-field"] === "step-0-role")[0]!;
    expect(roleInput.props["value"]).toBe("");
    expect(roleInput.props["placeholder"]).toMatch(/role/);
    const contextChips = findAll(tree, (n) => n.props["data-step-context"] !== undefined);
    expect(contextChips.map((c) => c.props["data-step-context"])).toEqual(["handoff", "none"]);
  });

  it("typing a role updates that step's role field", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, { initial: undefined, bindQueue: null, onSubmit: async () => {}, onClose: () => {} }),
      );
    });
    const roleInput = findAll(renderer.toJSON() as TreeNode, (n) => n.props["data-field"] === "step-0-role")[0]!;
    act(() => {
      (roleInput.props["onChange"] as (e: unknown) => void)({ target: { value: "reviewer" } });
    });
    const updated = findAll(renderer.toJSON() as TreeNode, (n) => n.props["data-field"] === "step-0-role")[0]!;
    expect(updated.props["value"]).toBe("reviewer");
  });

  it("clicking the \"clean\" (context:none) chip switches the active chip", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, { initial: undefined, bindQueue: null, onSubmit: async () => {}, onClose: () => {} }),
      );
    });
    const noneChip = findAll(renderer.toJSON() as TreeNode, (n) => n.props["data-step-context"] === "none")[0]!;
    act(() => {
      (noneChip.props["onClick"] as () => void)();
    });
    const tree = renderer.toJSON() as TreeNode;
    const handoffChip = findAll(tree, (n) => n.props["data-step-context"] === "handoff")[0]!;
    const cleanChip = findAll(tree, (n) => n.props["data-step-context"] === "none")[0]!;
    expect(String(cleanChip.props["className"])).toMatch(/ChipActive/);
    expect(String(handoffChip.props["className"])).not.toMatch(/ChipActive/);
  });

  it("prefills role + context from workflowFormValuesFromRow in edit mode", () => {
    const row = workflowRow({
      name: "release-flow",
      steps: [{ id: "review", title: "review", gate: { kind: "none" }, role: "qa", context: "none" }],
    });
    const initial = workflowFormValuesFromRow(row);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, { initial, bindQueue: null, onSubmit: async () => {}, onClose: () => {} }),
      );
    });
    const tree = renderer.toJSON() as TreeNode;
    const roleInput = findAll(tree, (n) => n.props["data-field"] === "step-0-role")[0]!;
    expect(roleInput.props["value"]).toBe("qa");
    const cleanChip = findAll(tree, (n) => n.props["data-step-context"] === "none")[0]!;
    expect(String(cleanChip.props["className"])).toMatch(/ChipActive/);
  });
});
