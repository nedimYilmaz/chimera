import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { Collapse } from "../src/components/Collapse";

// P0 regression (commit aafbf0e broke long-detail-content scroll under the
// F-TOGGLE-ANIM Collapse): the grid-template-rows 0fr→1fr trick sizes to the
// content's max-content height by default, which is exactly right for
// self-bounded content (AgentDetailPanel's own max-height+overflow-y:auto)
// but swallows a wrapped flex:1/overflow-y:auto scroll body (QueuesScreen's
// .tasksBody etc.) unless Collapse is told to bound itself to the REST of
// its flex parent's height instead — that's what the `fill` prop and the
// `.inner` overflow-y:auto-only-while-open rule are for. react-test-renderer
// can't assert actual CSS layout, so this locks in the class contract the
// CSS rules key off (Collapse.module.css's `.collapse.fill` / `.collapse.open
// .inner`) rather than the pixels themselves.

type TreeNode = { type: string; props: Record<string, unknown>; children: TreeNode[] | null };

function renderCollapse(props: { open: boolean; fill?: boolean; children?: React.ReactNode }): TreeNode | null {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Collapse, props));
  });
  return renderer.toJSON() as TreeNode | null;
}

describe("Collapse", () => {
  it("closed + never opened renders nothing", () => {
    expect(renderCollapse({ open: false, children: "x" })).toBeNull();
  });

  it("open renders the collapse+inner wrapper without the fill class by default", () => {
    const tree = renderCollapse({ open: true, children: "detail" });
    expect(tree!.props["className"]).toMatch(/collapse/);
    expect(tree!.props["className"]).toMatch(/open/);
    expect(tree!.props["className"]).not.toMatch(/fill/);
    const inner = tree!.children![0];
    expect(inner.props["className"]).toMatch(/inner/);
  });

  it("fill prop adds the fill class — bounds the collapse to the parent's flex space instead of the content's max-content height (QueuesScreen/TeamsScreen/ProjectsScreen/MemoryScreen's outer detail pane)", () => {
    const tree = renderCollapse({ open: true, fill: true, children: "detail" });
    expect(tree!.props["className"]).toMatch(/fill/);
  });

  it("closing keeps rendering the last content until the grid-template-rows transition ends (so the exit animation has something to shrink)", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(Collapse, { open: true, children: "long detail content" }));
    });
    act(() => {
      renderer.update(React.createElement(Collapse, { open: false, children: null }));
    });
    let tree = renderer.toJSON() as TreeNode;
    expect(tree.props["className"]).not.toMatch(/open/);
    expect(tree.children![0].children).toEqual(["long detail content"]); // cached, not yet unmounted

    act(() => {
      (tree.props["onTransitionEnd"] as (e: { propertyName: string }) => void)({ propertyName: "grid-template-rows" });
    });
    tree = renderer.toJSON() as TreeNode;
    expect(tree).toBeNull(); // unmounts for real once the shrink-to-0 transition ends
  });
});
