import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { WorkflowFlowBar } from "../src/components/WorkflowFlowBar";
import type { WorkflowFlowBarView } from "../src/state/selectors.workflows";
import type { AgentView } from "@chimera/ui-state";

// WORKFLOW-FIX-STEPPER-UI — the handoff caption used to render as an extra
// child ABOVE each step chip inside the step's own horizontal flex item
// (.stepGroup), with no width constraint: a long caption stretched that
// item's box far past a single step's width and visually slid across
// neighboring steps. The fix moves every handoff caption OUT of the
// per-step horizontal row entirely, into a dedicated `.transitions` block
// that's a sibling of `.timeline` (not nested inside any step). This test
// locks in that structural separation — the timeline's step-row children
// carry no such caption at all — rather than asserting on the (soft) CSS
// truncation.

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

function renderBar(view: WorkflowFlowBarView, agents: Record<string, AgentView> = {}) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(WorkflowFlowBar, { view, agents }));
  });
  return renderer.toJSON() as TreeNode;
}

const MULTI_AGENT_VIEW: WorkflowFlowBarView = {
  name: "review-and-fix",
  version: 1,
  enforced: true,
  steps: [
    { title: "Implement", role: "engineer", state: "done", durationMs: 60_000, agentId: "agent-aaaaaaaa", isHandoffBoundary: false, reason: null },
    { title: "Review", role: "reviewer", state: "current", durationMs: null, agentId: "agent-bbbbbbbb", isHandoffBoundary: true, reason: null },
    { title: "Fix", role: "engineer", state: "pending", durationMs: null, agentId: "agent-cccccccc", isHandoffBoundary: true, reason: null },
  ],
};

describe("WorkflowFlowBar — handoff caption placement", () => {
  it("renders one caption per handoff boundary, none inside a step's own row", () => {
    const tree = renderBar(MULTI_AGENT_VIEW);

    const steps = byAttr(tree, "data-workflow-flow-step");
    expect(steps).toHaveLength(3);
    // no step's own subtree contains a transition row — the caption never
    // lives inside a step chip's horizontal flow.
    for (const step of steps) {
      expect(byAttr(step, "data-handoff-boundary")).toHaveLength(0);
    }

    const captions = byAttr(tree, "data-handoff-boundary");
    expect(captions).toHaveLength(2); // steps 1 and 2 are both boundaries (step 0 never counts)
    expect(captions[0]!.props["data-handoff-boundary"]).toBe(1);
    expect(captions[1]!.props["data-handoff-boundary"]).toBe(2);
  });

  it("caption text is unconstrained (full detail) but carried in a title attribute for tooltip, not forced onto the visible node's width", () => {
    const tree = renderBar(MULTI_AGENT_VIEW);
    const [caption] = byAttr(tree, "data-handoff-boundary");
    expect(caption!.props["title"]).toMatch(/^handed step 2 → @/);
    expect(caption!.children).toEqual([caption!.props["title"]]);
  });

  it("single-agent / no-handoff workflow renders no transitions block at all", () => {
    const view: WorkflowFlowBarView = {
      name: "solo",
      version: 1,
      enforced: true,
      steps: [
        { title: "Do it", role: null, state: "current", durationMs: null, agentId: "agent-aaaaaaaa", isHandoffBoundary: false, reason: null },
        { title: "Done", role: null, state: "pending", durationMs: null, agentId: "agent-aaaaaaaa", isHandoffBoundary: false, reason: null },
      ],
    };
    const tree = renderBar(view);
    expect(byAttr(tree, "data-handoff-boundary")).toHaveLength(0);
  });
});

// WORKFLOW-FLOWBAR-LAYOUT — react-test-renderer has no layout engine, so it
// cannot catch misaligned arrows, wrapping, or clipping directly (same
// caveat as TopBar.overflow.test.tsx's CSS-source check). Assert the CSS
// module source for the properties that encode the fix instead, and cover
// the scroll-into-view trigger logic (an effect keyed on activeIndex)
// separately via a rendered ref, which react-test-renderer DOES give us.
describe("WorkflowFlowBar — layout CSS (WORKFLOW-FLOWBAR-LAYOUT)", () => {
  it("the steps row never wraps to a second line and scrolls horizontally instead", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/WorkflowFlowBar.module.css"), "utf8");
    const timelineRule = css.match(/\.timeline\s*\{[^}]*\}/)?.[0];
    expect(timelineRule).toBeDefined();
    expect(timelineRule).not.toMatch(/flex-wrap:\s*wrap/);
    expect(timelineRule).toMatch(/flex-wrap:\s*nowrap/);
    expect(timelineRule).toMatch(/overflow-x:\s*auto/);
  });

  it("the arrow's height is anchored to the step head (glyph+title), not the full chip", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/WorkflowFlowBar.module.css"), "utf8");
    const arrowRule = css.match(/\.arrow\s*\{[^}]*\}/)?.[0];
    expect(arrowRule).toBeDefined();
    expect(arrowRule).toMatch(/align-items:\s*center/);
    expect(arrowRule).toMatch(/height:/);
    // .head groups glyph+title so that fixed height is independent of the
    // optional duration/agent sub-lines rendered below it.
    expect(css).toMatch(/\.head\s*\{/);
  });
});

describe("WorkflowFlowBar — scroll the active step into view", () => {
  it("calls scrollIntoView on the active step's node on mount", () => {
    const calls: Array<ScrollIntoViewOptions | boolean | undefined> = [];
    const OriginalHTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
    const createNodeMock = () => ({
      scrollIntoView: (opts?: ScrollIntoViewOptions | boolean) => {
        calls.push(opts);
      },
    });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(WorkflowFlowBar, { view: MULTI_AGENT_VIEW, agents: {} }), { createNodeMock });
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toMatchObject({ block: "nearest" });
    act(() => renderer.unmount());
    void OriginalHTMLElement;
  });

  it("re-triggers when the active step changes but not on unrelated re-renders", () => {
    const calls: number[] = [];
    const createNodeMock = () => ({
      scrollIntoView: () => {
        calls.push(1);
      },
    });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(WorkflowFlowBar, { view: MULTI_AGENT_VIEW, agents: {} }), { createNodeMock });
    });
    const afterMount = calls.length;
    expect(afterMount).toBeGreaterThan(0);

    // Re-render with the exact same view (activeIndex unchanged) — no extra scroll.
    act(() => {
      renderer.update(React.createElement(WorkflowFlowBar, { view: { ...MULTI_AGENT_VIEW }, agents: {} }));
    });
    expect(calls.length).toBe(afterMount);

    // Now advance the active step — scrollIntoView fires again.
    const advanced: WorkflowFlowBarView = {
      ...MULTI_AGENT_VIEW,
      steps: [
        { ...MULTI_AGENT_VIEW.steps[0]!, state: "done" },
        { ...MULTI_AGENT_VIEW.steps[1]!, state: "done" },
        { ...MULTI_AGENT_VIEW.steps[2]!, state: "current" },
      ],
    };
    act(() => {
      renderer.update(React.createElement(WorkflowFlowBar, { view: advanced, agents: {} }));
    });
    expect(calls.length).toBe(afterMount + 1);
    act(() => renderer.unmount());
  });
});
