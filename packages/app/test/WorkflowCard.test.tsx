import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { WorkflowCard } from "../src/components/WorkflowCard";
import { workflowRow } from "../src/state/selectors.workflows";

// F16.1 Phase 1 (WF-2) — dim one-line instructions preview under each step
// title: a real render pass via react-test-renderer, mirroring
// WorkflowStepDots.test.tsx's harness. This suite's subject renders through
// OverlayCard, whose esc-key effect touches `window.addEventListener` — the
// package's vitest config runs a bare node env (no jsdom dependency), so we
// stub just the two methods that effect needs rather than pull in a DOM.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function renderCard(workflow: ReturnType<typeof workflowRow> | null): TreeNode {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(WorkflowCard, { queueName: "q1", workflow, onNew: () => {}, onEdit: () => {}, onClose: () => {} }),
    );
  });
  return renderer.toJSON() as TreeNode;
}

describe("WorkflowCard — per-step instructions preview", () => {
  it("offers the full-screen Studio for a bound workflow", () => {
    let opened = false;
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(WorkflowCard, { queueName: "q1", workflow: workflowRow({ name: "release", steps: [{ id: "a", title: "A", gate: { kind: "none" } }] }), onNew: () => {}, onEdit: () => {}, onOpenStudio: () => { opened = true; }, onClose: () => {} })); });
    const node = findAll(renderer.toJSON() as TreeNode, (n) => n.props["data-action"] === "open-studio")[0]!;
    act(() => { (node.props["onClick"] as () => void)(); });
    expect(opened).toBe(true);
  });
  it("renders a dim preview line under a step's title when it has instructions", () => {
    const workflow = workflowRow({
      name: "release-flow",
      steps: [{ id: "plan", title: "plan", gate: { kind: "none" }, instructions: "read the release checklist first" }],
    });
    const tree = renderCard(workflow);
    const previews = findAll(tree, (n) => n.props["className"] && /stepInstructions/.test(String(n.props["className"])));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.children).toEqual(["read the release checklist first"]);
  });

  it("renders no preview line for a step with no instructions", () => {
    const workflow = workflowRow({ name: "release-flow", steps: [{ id: "plan", title: "plan", gate: { kind: "none" } }] });
    const tree = renderCard(workflow);
    const previews = findAll(tree, (n) => n.props["className"] && /stepInstructions/.test(String(n.props["className"])));
    expect(previews).toHaveLength(0);
  });

  it("truncation is CSS-driven (text-overflow: ellipsis), not string slicing — the full text stays in the DOM/tree", () => {
    const long = "a".repeat(300);
    const workflow = workflowRow({
      name: "release-flow",
      steps: [{ id: "plan", title: "plan", gate: { kind: "none" }, instructions: long }],
    });
    const tree = renderCard(workflow);
    const preview = findAll(tree, (n) => n.props["className"] && /stepInstructions/.test(String(n.props["className"])))[0]!;
    expect(preview.children).toEqual([long]);
  });
});

describe("WorkflowCard — per-step role chip (F16.1 Phase 3, WF-10)", () => {
  it("renders an @role chip for a step with a role set", () => {
    const workflow = workflowRow({
      name: "release-flow",
      steps: [{ id: "review", title: "review", gate: { kind: "none" }, role: "qa" }],
    });
    const tree = renderCard(workflow);
    const chip = findAll(tree, (n) => n.props["data-step-role"] === "qa")[0]!;
    expect(chip.children).toEqual(["@", "qa"]);
  });

  it("renders no role chip for a step without a role", () => {
    const workflow = workflowRow({ name: "release-flow", steps: [{ id: "plan", title: "plan", gate: { kind: "none" } }] });
    const tree = renderCard(workflow);
    expect(findAll(tree, (n) => n.props["data-step-role"] !== undefined)).toHaveLength(0);
  });
});

// QUEUE-WORKFLOW-OVERLAY-BLIND: `w` on a queue read the queue's DEFAULT binding only
// (queue.spec.workflow). queue.push's per-task `workflow` override pins {name,version} onto the
// TaskRecord and never touches the queue spec, so a queue running nothing but overridden tasks
// reported "no workflow bound to this queue" while its workflows were visibly running in the same
// pane — and `inspect workflow graph` on any of those tasks opened the Studio on exactly the
// workflow the overlay claimed did not exist.
function renderWithTaskBound(
  workflow: ReturnType<typeof workflowRow> | null,
  taskBound: Array<{ name: string; version: number; taskCount: number }>,
): TreeNode {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(WorkflowCard, {
      queueName: "evetle-platform", workflow, taskBound,
      onNew: () => {}, onEdit: () => {}, onClose: () => {},
    }));
  });
  return renderer.toJSON() as TreeNode;
}

function textOf(node: TreeNode): string {
  const out: string[] = [];
  const walk = (n: TreeNode | string): void => {
    if (typeof n === "string") { out.push(n); return; }
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  // JSX splits a sentence into several text children; join with nothing and collapse the
  // whitespace so an assertion can read the rendered sentence the way a person sees it.
  return out.join("").replace(/\s+/g, " ").trim();
}

describe("WorkflowCard — per-task bindings when the queue has no default", () => {
  it("names the workflows actually in effect instead of claiming none exists", () => {
    const tree = renderWithTaskBound(null, [{ name: "evetle-gate", version: 1, taskCount: 5 }]);
    const chips = findAll(tree, (n) => typeof n.props["data-task-bound-workflow"] === "string");
    expect(chips.map((c) => c.props["data-task-bound-workflow"])).toEqual(["evetle-gate"]);
    expect(textOf(chips[0]!)).toContain("evetle-gate v1");
    expect(textOf(chips[0]!)).toContain("5 tasks");
    expect(textOf(tree)).not.toContain("no workflow bound to this queue.");
  });

  it("says a default set NOW applies to future tasks only — the pinned ones keep their version", () => {
    const tree = renderWithTaskBound(null, [{ name: "evetle-gate", version: 1, taskCount: 5 }]);
    const body = textOf(tree);
    expect(body).toContain("no queue DEFAULT binding");
    expect(body).toContain("FUTURE tasks only");
  });

  it("lists several distinct bindings, and singularises a one-task count", () => {
    const tree = renderWithTaskBound(null, [
      { name: "gate-a", version: 2, taskCount: 3 },
      { name: "gate-b", version: 1, taskCount: 1 },
    ]);
    const chips = findAll(tree, (n) => typeof n.props["data-task-bound-workflow"] === "string");
    expect(chips.map((c) => c.props["data-task-bound-workflow"])).toEqual(["gate-a", "gate-b"]);
    expect(textOf(chips[1]!)).toContain("1 task");
    expect(textOf(chips[1]!)).not.toContain("1 tasks");
  });

  it("still says 'no workflow bound' when there is genuinely nothing — neither default nor per-task", () => {
    expect(textOf(renderWithTaskBound(null, []))).toContain("no workflow bound to this queue.");
  });

  it("a queue DEFAULT still wins the display — the per-task list is the no-default fallback", () => {
    const tree = renderWithTaskBound(workflowRow({ name: "release", steps: [{ id: "a", title: "A", gate: { kind: "none" } }] }), [
      { name: "evetle-gate", version: 1, taskCount: 5 },
    ]);
    expect(findAll(tree, (n) => typeof n.props["data-task-bound-workflow"] === "string")).toHaveLength(0);
    expect(textOf(tree)).toContain("enforced");
  });
});
