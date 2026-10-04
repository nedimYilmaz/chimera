import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// SCHEDULE-TZ-DEAD-FOR-AT — computeNextRunTs (packages/core/src/jobs.ts) and
// buildJobSpec/computeSchedulePreview (selectors.jobs.ts) never consult `tz`
// for scheduleKind:"at" — the datetime-local value is resolved via Date.parse
// in the browser's own zone. The form used to render an editable "timezone"
// field alongside "at" anyway, implying it controlled the one-shot run time
// when it was actually inert. The field must be hidden for "at".
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
function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

describe("ScheduleFormCard — tz field vs scheduleKind", () => {
  it("hides the timezone field when scheduleKind is 'at' (tz is inert for one-shot schedules)", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ScheduleFormCard, {
          mode: "create",
          initial: { ...defaultScheduleFormValues(), scheduleKind: "at", at: "2026-08-01T12:00" },
          onSubmit: async () => {},
          onClose: () => {},
        }),
      );
    });

    const tzFields = byAttr(renderer.toJSON() as TreeNode, "data-field").filter(
      (n) => n.props["data-field"] === "tz",
    );
    expect(tzFields).toHaveLength(0);
  });

  it("shows the timezone field for cron and every schedules, where tz genuinely matters", () => {
    for (const scheduleKind of ["cron", "every"] as const) {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          React.createElement(ScheduleFormCard, {
            mode: "create",
            initial: { ...defaultScheduleFormValues(), scheduleKind },
            onSubmit: async () => {},
            onClose: () => {},
          }),
        );
      });

      const tzFields = byAttr(renderer.toJSON() as TreeNode, "data-field").filter(
        (n) => n.props["data-field"] === "tz",
      );
      expect(tzFields).toHaveLength(1);
    }
  });
});
