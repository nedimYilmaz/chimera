import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// BUDGET-PAUSE-SPEND: the banner's own selector key collapsed to just
// maxBudgetUsd, silently dropping totalCostUsd (computed by
// budgetPauseForSelected but never rendered) — the user could see the cap
// but never the actual overage that triggered the pause. Same harness as
// AgentList.running.test.tsx.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { BudgetPauseBanner } from "../src/components/BudgetPauseBanner";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";
import { CONFIRMS } from "../src/copy";
import { budgetResumeEffect, budgetSpendSplit } from "@chimera/ui-state";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

describe("BudgetPauseBanner (BUDGET-PAUSE-SPEND)", () => {
  it("renders both the actual spend and the cap, not just the cap", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bp-1", treeId: "bp-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "bp-1" });
      appStore.dispatch({
        type: "event",
        event: {
          ts: 1,
          seq: 1,
          agentId: "bp-1",
          kind: "status",
          data: { paused: true, reason: "budget", treeId: "bp-1", maxBudgetUsd: 2, totalCostUsd: 2.37 },
        },
      });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(BudgetPauseBanner)); });
    const text = flattenText(renderer.toJSON() as TreeNode);

    expect(text).toContain("2.37");
    expect(text).toContain("2.00");
  });

  it("prefixes spend with ~ only when estimatedUsd > 0", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bp-2", treeId: "bp-2", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "bp-2" });
      appStore.dispatch({
        type: "event",
        event: {
          ts: 1,
          seq: 2,
          agentId: "bp-2",
          kind: "status",
          data: { paused: true, reason: "budget", treeId: "bp-2", maxBudgetUsd: 2, totalCostUsd: 2.37, estimatedUsd: 1.9 },
        },
      });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(BudgetPauseBanner)); });
    const text = flattenText(renderer.toJSON() as TreeNode);

    expect(text).toContain("~$2.37");
    expect(text).toContain("estimated from token counts");
  });

  it("renders re-paused copy when afterResume is true", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bp-3", treeId: "bp-3", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "bp-3" });
      appStore.dispatch({
        type: "event",
        event: {
          ts: 1,
          seq: 3,
          agentId: "bp-3",
          kind: "status",
          data: { paused: true, reason: "budget", treeId: "bp-3", maxBudgetUsd: 2, totalCostUsd: 2.37, afterResume: true },
        },
      });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(BudgetPauseBanner)); });
    const text = flattenText(renderer.toJSON() as TreeNode);

    expect(text).toContain("re-paused after operator resume");
  });

  // F50.UI: releasing a budget pause is audited and re-arms the watermark, so the click
  // must raise the confirm gate — NOT fire the RPC. A one-click release was the finding-5
  // double-click hazard (two audit records, a wider second watermark) in its worst form.
  it("clicking resume asks for confirmation instead of calling budget.resume", async () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bp-4", treeId: "bp-4", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "bp-4" });
      appStore.dispatch({ type: "confirm", confirm: null });
      appStore.dispatch({
        type: "event",
        event: {
          ts: 1,
          seq: 4,
          agentId: "bp-4",
          kind: "status",
          data: { paused: true, reason: "budget", treeId: "bp-4", maxBudgetUsd: 2, totalCostUsd: 2.37, estimatedUsd: 1.9 },
        },
      });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(BudgetPauseBanner)); });
    const button = renderer.root.findByType("button");
    await act(async () => { button.props.onClick(); });

    const confirm = appStore.getState().confirm;
    expect(confirm?.kind).toBe("resumeBudget");
    expect(confirm).toMatchObject({ treeId: "bp-4", totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 });
    expect(rpcCall).not.toHaveBeenCalledWith("budget.resume", expect.anything());

    // and the button is spent while that gate is open, so a second click cannot queue a second release
    const after = renderer.root.findByType("button");
    expect(after.props.disabled).toBe(true);
  });

  it("carries the pause's spend split and cap-unchanged promise into the confirm copy", () => {
    const body = CONFIRMS.resumeBudget(
      "bp-5",
      budgetSpendSplit({ totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 }),
      budgetResumeEffect({ totalCostUsd: 2.37, estimatedUsd: 1.9, maxBudgetUsd: 2 }),
    );
    expect(body.body).toContain("$0.47 reported by the provider");
    expect(body.body).toContain("~$1.90 estimated from token counts");
    expect(body.note).toContain("does not raise the $2.00 cap");
    expect(body.note).toContain("past $2.37");
    expect(body.note).toContain("audit ledger");
  });
});
