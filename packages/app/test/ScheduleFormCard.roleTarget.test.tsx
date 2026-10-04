import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// JOB-ROLE-TARGET: the schedule form's third target kind ("role" — spawn
// directly off a global role-library entry, no team/queue) must be reachable
// without hand-writing JSON, and the team target's new optional "pin role"
// field must appear alongside "team" but not alongside "agent"/"role".
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { ScheduleFormCard } from "../src/components/ScheduleFormCard";
import { defaultScheduleFormValues } from "../src/state/selectors.jobs";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}
function byField(tree: TreeNode, field: string): TreeNode[] {
  return findAll(tree, (n) => n.props["data-field"] === field);
}

function render(initial: ReturnType<typeof defaultScheduleFormValues>) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(ScheduleFormCard, { mode: "create", initial, onSubmit: async () => {}, onClose: () => {} }),
    );
  });
  return renderer.toJSON() as TreeNode;
}

describe("ScheduleFormCard — role target (JOB-ROLE-TARGET)", () => {
  it("offers an existing-agent picker without spawn settings", () => {
    const tree = render({ ...defaultScheduleFormValues(), targetKind: "existing", existingAgentId: "agent-123" });
    expect(byField(tree, "existingAgentId")).toHaveLength(1);
    for (const field of ["cwd", "model", "maxBudgetUsd", "team", "role"]) expect(byField(tree, field)).toHaveLength(0);
    expect(findAll(tree, (n) => n.props["aria-label"] === "pick existing agent")).toHaveLength(1);
    expect(findAll(tree, (n) => n.type === "option" && n.props["value"] === "agent-123")).toHaveLength(1);
  });
  it("shows a 'role' text field when targetKind is role, and no team/cwd fields", () => {
    const tree = render({ ...defaultScheduleFormValues(), targetKind: "role" });
    expect(byField(tree, "role")).toHaveLength(1);
    expect(byField(tree, "team")).toHaveLength(0);
    expect(byField(tree, "cwd")).toHaveLength(0);
  });

  it("shows the optional 'teamRole' pin field only for the team target", () => {
    expect(byField(render({ ...defaultScheduleFormValues(), targetKind: "team" }), "teamRole")).toHaveLength(1);
    expect(byField(render({ ...defaultScheduleFormValues(), targetKind: "agent" }), "teamRole")).toHaveLength(0);
    expect(byField(render({ ...defaultScheduleFormValues(), targetKind: "role" }), "teamRole")).toHaveLength(0);
  });
});
