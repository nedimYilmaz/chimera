import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { HistoryRunsResponse, RunHistoryRow } from "@chimera/protocol";

// Same bare-window shim the other screen tests use — this package's vitest config
// runs a node env (no jsdom).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const T0 = Date.UTC(2026, 8, 5, 10, 0, 0);
const row = (over: Partial<RunHistoryRow> & Pick<RunHistoryRow, "id" | "kind">): RunHistoryRow => ({
  subject: over.id, trigger: { kind: "operator", ref: null, detail: null }, model: "opus", costUsd: 1.5,
  costBasis: "booked", outcome: "done", reason: null, startedAt: T0, endedAt: T0 + 1000,
  durationMs: 1000, unseen: false, queue: null, team: null, jobName: null, agentId: null,
  taskId: null, steps: null, stepFailures: null, ...over,
});

const coverage = { agentsScanned: 1, tasksScanned: 1, jobRunsScanned: 1, journalEntries: 3,
  journalTruncated: false, spanRollupReplayed: false, spanRollupTruncated: false };

// One booked agent ($1.50) plus a task and a job whose costs are ROLLED UP from it —
// the visible cost column sums to $4.50 while the honest total is $1.50.
let response: HistoryRunsResponse = {
  rows: [
    row({ id: "t-1", kind: "task", costBasis: "rolled-up", outcome: "failed", startedAt: T0 + 1000 }),
    row({ id: "j-1", kind: "job", costBasis: "rolled-up", startedAt: T0 }),
    row({ id: "a-1", kind: "agent", unseen: true, startedAt: T0 + 2000 }),
  ],
  nextCursor: null, matched: 3, from: T0, to: T0 + 3000,
  totals: { runs: 3, costUsd: 1.5, failed: 1, unseen: 1 }, coverage,
};

/** The server's own fold — booked dollars only, over the WHOLE matched set (F13.QA M-4). */
const foldTotals = (rows: readonly RunHistoryRow[]) => ({
  runs: rows.length,
  costUsd: rows.reduce((n, r) => (r.costBasis === "booked" ? n + r.costUsd : n), 0),
  failed: rows.filter((r) => r.outcome === "failed").length,
  unseen: rows.filter((r) => r.unseen).length,
});

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method !== "history.runs") return {};
  // kinds/outcome are SERVER facets since F13.QA M-3 — the mock has to honour them, or a
  // chip test would "pass" against a client-side pass that no longer exists.
  const p = (params ?? {}) as { kinds?: string[]; outcome?: string[] };
  if (!p.kinds && !p.outcome) return response;
  const rows = response.rows.filter((r) =>
    (!p.kinds || p.kinds.includes(r.kind)) && (!p.outcome || p.outcome.includes(r.outcome)));
  return { ...response, rows, matched: rows.length, totals: foldTotals(rows) };
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
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

import { HistoryScreen } from "../src/screens/HistoryScreen";
import { __resetRunHistoryCommands } from "../src/state/commands.runHistory";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
const byAttr = (tree: TreeNode, attr: string) => findAll(tree, (n) => attr in n.props);
const textOf = (n: TreeNode): string => (n.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const buttonLabelled = (tree: TreeNode, label: string) =>
  findAll(tree, (n) => n.type === "button" && textOf(n) === label)[0];

let renderer: ReturnType<typeof create> | null = null;
const mount = async () => {
  await act(async () => { renderer = create(React.createElement(HistoryScreen)); });
  return renderer!.toJSON() as TreeNode;
};

beforeEach(() => { __resetRunHistoryCommands(); rpcImpl.mockClear(); });
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

describe("HistoryScreen", () => {
  it("renders agent, task and job rows in one list, newest first", async () => {
    const tree = await mount();
    expect(byAttr(tree, "data-run-kind").map((n) => n.props["data-run-kind"])).toEqual(["agent", "task", "job"]);
  });

  // [F13.QA M-3] a kind chip re-issues history.runs on purpose: the page is capped at
  // `limit`, so a client-side pass would silently hide every match past the cap.
  it("a kind chip re-issues history.runs with kinds[] so the daemon filters the whole window", async () => {
    const tree = await mount();
    expect(rpcImpl.mock.calls.filter((c) => c[0] === "history.runs")).toHaveLength(1);
    await act(async () => { (buttonLabelled(tree, "agents")!.props["onClick"] as () => void)(); });
    const calls = rpcImpl.mock.calls.filter((c) => c[0] === "history.runs");
    expect(calls).toHaveLength(2);
    expect((calls[1]![1] as { kinds?: string[] }).kinds).toEqual(["agent"]);
    expect(byAttr(renderer!.toJSON() as TreeNode, "data-run-kind").map((n) => n.props["data-run-kind"])).toEqual(["agent"]);
  });

  it("an outcome chip goes to the daemon as outcome[] too", async () => {
    const tree = await mount();
    await act(async () => { (buttonLabelled(tree, "failed")!.props["onClick"] as () => void)(); });
    const calls = rpcImpl.mock.calls.filter((c) => c[0] === "history.runs");
    expect((calls[1]![1] as { outcome?: string[] }).outcome).toEqual(["failed"]);
    expect(byAttr(renderer!.toJSON() as TreeNode, "data-run-outcome").map((n) => n.props["data-run-outcome"])).toEqual(["failed"]);
  });

  // [F13.QA M-4] the header describes every matched run, not the page it could fit.
  it("the totals line reports the server fold over the whole window, not the returned page", async () => {
    const saved = response;
    response = { ...response, matched: 812, totals: { runs: 812, costUsd: 96.25, failed: 40, unseen: 17 } };
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-totals")[0]!)).toBe("812 runs · $96.25 booked · 40 failed · 17 new");
    response = saved;
  });

  it("falls back to page-derived counts once a client-only chip narrows what is visible", async () => {
    const saved = response;
    response = { ...response, matched: 812, totals: { runs: 812, costUsd: 96.25, failed: 40, unseen: 17 } };
    const tree = await mount();
    act(() => { (byAttr(tree, "data-run-search")[0]!.props["onChange"] as (e: unknown) => void)({ target: { value: "a-1" } }); });
    expect(textOf(byAttr(renderer!.toJSON() as TreeNode, "data-run-totals")[0]!)).toBe("1 runs · $1.50 booked · 0 failed · 1 new");
    response = saved;
  });

  it("the totals line shows the booked cost, not the sum of the visible column", async () => {
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-totals")[0]!)).toBe("3 runs · $1.50 booked · 1 failed · 1 new");
  });

  it("the truncated banner renders only when coverage.journalTruncated is true", async () => {
    expect(byAttr(await mount(), "data-run-banner")).toHaveLength(0);
    act(() => renderer?.unmount());
    renderer = null;
    __resetRunHistoryCommands();
    response = { ...response, coverage: { ...coverage, journalTruncated: true } };
    expect(byAttr(await mount(), "data-run-banner")).toHaveLength(1);
    response = { ...response, coverage };
  });

  it('the empty state reads "nothing ran in this window"', async () => {
    const saved = response;
    response = { ...response, rows: [], matched: 0, totals: { runs: 0, costUsd: 0, failed: 0, unseen: 0 } };
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-empty")[0]!)).toBe("nothing ran in this window");
    response = saved;
  });

  it('the unseen chip reads "N new" and filters to unseen rows', async () => {
    const tree = await mount();
    const chip = buttonLabelled(tree, "1 new");
    expect(chip).toBeTruthy();
    act(() => { (chip!.props["onClick"] as () => void)(); });
    const after = renderer!.toJSON() as TreeNode;
    expect(byAttr(after, "data-run-kind").map((n) => n.props["data-run-kind"])).toEqual(["agent"]);
  });
  it("says how much of the window is hidden when the page is capped", async () => {
    const saved = response;
    response = { ...response, matched: 812 };
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-truncated")[0]!))
      .toBe("showing 3 of 812 — narrow the window or the kind/outcome filters to see the rest");
    response = saved;
  });

  // [F13.QA M-5] the other half of the banner's contract: an uncapped page says NOTHING.
  // A permanent "showing 3 of 3" would train operators to ignore the line that matters.
  it("says nothing about truncation when the page already holds every matched run", async () => {
    const tree = await mount();
    expect(response.matched).toBe(response.rows.length);
    expect(byAttr(tree, "data-run-truncated")).toHaveLength(0);
  });

  // [F13.QA M-6] formerly a twin of the retired TUI's "renders the ui-state totals line verbatim" test —
  // same fixture, same two literals. Pins runHistoryTotalsLine(runHistoryHeaderCounts(...)) so a
  // drift in the shared ui-state wording fails here and names itself.
  it("says the same totals sentence the TUI pane says", async () => {
    const saved = response;
    const parityRows = [
      row({ id: "p1", kind: "agent", subject: "alpha agent", costBasis: "booked", costUsd: 1.5, outcome: "done", unseen: true, team: "alpha", startedAt: T0 + 5000 }),
      row({ id: "p2", kind: "task", subject: "alpha task", costBasis: "rolled-up", costUsd: 9, outcome: "failed", unseen: false, team: "alpha", startedAt: T0 + 4000 }),
      row({ id: "p3", kind: "agent", subject: "beta agent", costBasis: "booked", costUsd: 2.25, outcome: "done", unseen: false, team: "beta", startedAt: T0 + 3000 }),
    ];
    response = { ...response, rows: parityRows, matched: 812,
      totals: { runs: 812, costUsd: 96.25, failed: 40, unseen: 17 } };
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-totals")[0]!)).toBe("812 runs · $96.25 booked · 40 failed · 17 new");
    // Typing a client-only filter drops the header to this page: the rolled-up $9 task
    // counts as a run and a failure but adds no dollars — the invariant, stated in one line.
    act(() => { (byAttr(tree, "data-run-search")[0]!.props["onChange"] as (e: unknown) => void)({ target: { value: "alpha" } }); });
    expect(textOf(byAttr(renderer!.toJSON() as TreeNode, "data-run-totals")[0]!))
      .toBe("2 runs · $1.50 booked · 1 failed · 1 new");
    response = saved;
  });

  // The server now answers an outcome chip with ZERO rows, so "nothing matched" can no
  // longer be inferred from an empty page — it is keyed off the active filter (M-3).
  it("filtered-to-empty is a different state than nothing-ran, and clears", async () => {
    const tree = await mount();
    await act(async () => { (buttonLabelled(tree, "running")!.props["onClick"] as () => void)(); });
    let after = renderer!.toJSON() as TreeNode;
    expect(textOf(byAttr(after, "data-run-empty")[0]!)).toContain("no runs match these filters");
    await act(async () => { (byAttr(after, "data-run-clear")[0]!.props["onClick"] as () => void)(); });
    after = renderer!.toJSON() as TreeNode;
    expect(byAttr(after, "data-run-empty")).toHaveLength(0);
  });

  it("a failed row explains itself instead of showing a bare outcome", async () => {
    const saved = response;
    response = { ...response, rows: response.rows.map((r) => r.kind === "task"
      ? { ...r, reason: "worker exited 1", steps: 4, stepFailures: 1 } : r) };
    const tree = await mount();
    expect(textOf(byAttr(tree, "data-run-reason")[0]!)).toBe("4 steps (1 failed) · worker exited 1");
    response = saved;
  });

  it("clicking a row with an agent opens that agent on the agents tab", async () => {
    const saved = response;
    response = { ...response, rows: [row({ id: "a-9", kind: "agent", agentId: "a-9" })] };
    const tree = await mount();
    const target = byAttr(tree, "data-run-open")[0]!;
    await act(async () => { (target.props["onClick"] as () => void)(); });
    expect(appStore.getState().selectedAgentId).toBe("a-9");
    expect(appStore.getState().activeTab).toBe("agents");
    response = saved;
  });

  it("a failed load keeps the rows visible and offers a retry", async () => {
    await mount();
    rpcImpl.mockImplementationOnce(async () => { throw new Error("daemon is down"); });
    const tree = renderer!.toJSON() as TreeNode;
    await act(async () => { (buttonLabelled(tree, "refresh")!.props["onClick"] as () => void)(); });
    const after = renderer!.toJSON() as TreeNode;
    expect(textOf(byAttr(after, "data-run-error")[0]!)).toContain("couldn't load run history");
    expect(byAttr(after, "data-run-kind")).toHaveLength(3);
    expect(buttonLabelled(after, "try again")).toBeTruthy();
  });
});
