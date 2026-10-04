// DOUBLE-SUBMIT-SWEEP — ScheduleFormCard/TeamFormCard/QueueFormCard/
// WorkflowFormCard's field-walk submit() called `void onSubmit(payload)
// .then(onClose).catch(...)` with NO guard at all against a second call while
// the first save was still in flight (unlike the sibling ImportCard, whose
// established convention this family otherwise copies): the form stays
// mounted and its submit chip stays clickable for the whole RPC round-trip,
// so a rapid double-click/double-Enter on the final field fires onSubmit
// twice. Fixed by adding the same `busy` guard ImportCard already uses.
// Same harness as RuleFormCard.busyGuard.test.tsx (react-test-renderer, a
// window stub for OverlayCard's esc-key effect, no jsdom).
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

// ROLES-BINDING-CORRECTNESS: TeamFormCard now imports rpc/bridge (role.list, for its
// role picker) — same gotcha SpawnCard.test.tsx's own comment documents: the real
// bridge module fires listen()/invoke() at import time, which throw outside a webview.
// Stub it so this file only exercises the busy guard, not a live rpc round-trip.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: async () => ({}),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { ScheduleFormCard } from "../src/components/ScheduleFormCard";
import { TeamFormCard } from "../src/components/TeamFormCard";
import { QueueFormCard } from "../src/components/QueueFormCard";
import { WorkflowFormCard } from "../src/components/WorkflowFormCard";
import { defaultScheduleFormValues, type ScheduleFormValues } from "../src/state/selectors.jobs";
import { defaultWorkflowFormValues, emptyWorkflowStep } from "../src/state/selectors.workflows";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

/** A controllable async onSubmit: doesn't resolve until `resolve()` is called. */
function deferredSubmit<T extends unknown[]>() {
  let calls = 0;
  let resolve!: () => void;
  const pending = new Promise<void>((r) => { resolve = r; });
  const onSubmit = (..._args: T) => { calls += 1; return pending; };
  return { onSubmit, resolve, get calls() { return calls; } };
}

/** Field-walk forms attempt a real submit only on their LAST field; repeatedly
 * click the submit chip (advancing the walk each time) until onSubmit is
 * actually invoked once, then return — mirrors a user pressing Enter through
 * every field with valid values already filled in via `initial`. */
function walkToSubmit(getRenderer: () => ReturnType<typeof create>, dataAttr: string, calls: () => number, maxSteps = 20): void {
  for (let i = 0; i < maxSteps; i++) {
    const chip = byAttr(getRenderer().toJSON() as TreeNode, dataAttr)[0]!;
    act(() => { (chip.props["onClick"] as () => void)(); });
    if (calls() > 0) return;
  }
  throw new Error(`${dataAttr}: did not reach a real submit within ${maxSteps} clicks`);
}

describe("TeamFormCard — busy guard", () => {
  it("a second submit click while the first save is still pending does not call onSubmit again", () => {
    const d = deferredSubmit();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(TeamFormCard, {
          mode: "edit",
          initial: { name: "t1", role: "dev", maxConcurrent: "2", cwd: "/tmp/proj", queue: "", purpose: "", model: "", persistent: "", instructions: "" },
          onSubmit: d.onSubmit, onClose: () => {},
        }),
      );
    });
    walkToSubmit(() => renderer, "data-team-submit", () => d.calls);
    expect(d.calls).toBe(1);

    const chip = byAttr(renderer.toJSON() as TreeNode, "data-team-submit")[0]!;
    act(() => { (chip.props["onClick"] as () => void)(); });
    expect(d.calls).toBe(1); // still 1 — the guard must block the re-entrant click
  });
});

describe("QueueFormCard — busy guard", () => {
  it("a second submit click while the first save is still pending does not call onSubmit again", () => {
    const d = deferredSubmit();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(QueueFormCard, {
          mode: "edit",
          initial: { name: "q1", retryLimit: "2" },
          onSubmit: d.onSubmit, onClose: () => {},
        }),
      );
    });
    walkToSubmit(() => renderer, "data-queue-submit", () => d.calls);
    expect(d.calls).toBe(1);

    const chip = byAttr(renderer.toJSON() as TreeNode, "data-queue-submit")[0]!;
    act(() => { (chip.props["onClick"] as () => void)(); });
    expect(d.calls).toBe(1);
  });
});

describe("ScheduleFormCard — busy guard", () => {
  it("a second submit click while the first save is still pending does not call onSubmit again", () => {
    const d = deferredSubmit();
    const initial: ScheduleFormValues = {
      ...defaultScheduleFormValues(),
      name: "job1", targetKind: "team", team: "team1", prompt: "do the thing",
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ScheduleFormCard, { mode: "edit", initial, onSubmit: d.onSubmit, onClose: () => {} }),
      );
    });
    walkToSubmit(() => renderer, "data-schedule-submit", () => d.calls);
    expect(d.calls).toBe(1);

    const chip = byAttr(renderer.toJSON() as TreeNode, "data-schedule-submit")[0]!;
    act(() => { (chip.props["onClick"] as () => void)(); });
    expect(d.calls).toBe(1);
  });
});

describe("WorkflowFormCard — busy guard", () => {
  it("a second submit click while the first save is still pending does not call onSubmit again", () => {
    const d = deferredSubmit<[unknown, boolean]>();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(WorkflowFormCard, {
          initial: { ...defaultWorkflowFormValues(), name: "wf1", steps: [{ ...emptyWorkflowStep(), id: "s1", title: "step one" }] },
          bindQueue: null,
          onSubmit: d.onSubmit as (payload: unknown, bind: boolean) => Promise<void>,
          onClose: () => {},
        }),
      );
    });
    const click = () => {
      const chip = byAttr(renderer.toJSON() as TreeNode, "data-workflow-submit")[0]!;
      (chip.props["onClick"] as () => void)();
    };
    act(click);
    expect(d.calls).toBe(1);

    act(click); // re-query: the guard lives in a fresh closure after the busy-state re-render
    expect(d.calls).toBe(1); // still 1 — the guard must block the re-entrant click
  });
});
