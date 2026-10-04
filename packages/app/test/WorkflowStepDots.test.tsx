import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { WorkflowStepDots } from "../src/components/WorkflowStepDots";
import type { WorkflowDotState } from "../src/state/selectors.workflows";

// AgentList step indicator (F16 workflow-bound tasks) — a real render pass
// via react-test-renderer (no DOM, mirrors commands.checkpoints.test.ts's
// useFilesSinceMeta harness): asserts the dot COUNT/classing and the
// aria-label summary, both of which are what an accessibility tree / a
// screenshot diff would actually see.

type TreeNode = { type: string; props: Record<string, unknown>; children: TreeNode[] | null };

function renderDots(steps: WorkflowDotState[]): TreeNode | null {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(WorkflowStepDots, { steps }));
  });
  return renderer.toJSON() as TreeNode | null;
}

describe("WorkflowStepDots", () => {
  it("renders nothing for zero steps (the caller should not render this without a resolved workflow)", () => {
    expect(renderDots([])).toBeNull();
  });

  it("renders exactly one dot per step, classed by its state", () => {
    const tree = renderDots(["done", "current", "pending", "failed", "waiting"]);
    expect(tree!.children).toHaveLength(5);
    const classes = tree!.children!.map((c) => c.props["className"] as string);
    expect(classes[0]).toMatch(/dotDone/);
    expect(classes[1]).toMatch(/dotCurrent/);
    expect(classes[2]).toMatch(/dotPending/);
    expect(classes[3]).toMatch(/dotFailed/);
    expect(classes[4]).toMatch(/dotWaiting/);
    // every dot shares the base .dot class alongside its state class
    for (const c of classes) expect(c).toMatch(/^_dot_/);
  });

  it("aria-label summarizes progress for a screen reader (\"step N/total <word>\")", () => {
    expect(renderDots(["done", "current", "pending"])!.props["aria-label"]).toBe("step 2/3 running");
    expect(renderDots(["done", "failed", "pending"])!.props["aria-label"]).toBe("step 2/3 failed");
    expect(renderDots(["done", "waiting", "pending"])!.props["aria-label"]).toBe("step 2/3 waiting");
    expect(renderDots(["done", "done", "done"])!.props["aria-label"]).toBe("step 3/3 done");
  });
});
