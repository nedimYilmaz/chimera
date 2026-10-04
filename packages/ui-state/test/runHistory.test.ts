import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_HISTORY_FILTER,
  filterRuns,
  formatRunDuration,
  runHistoryClientFilter,
  runHistoryCounts,
  runHistoryHeaderCounts,
  runHistoryFilterSummary,
  runHistoryRowDetail,
  runHistoryTeams,
  runHistoryTotalsLine,
  runHistoryTriggerLabel,
  runHistoryTruncationLine,
  isRunHistoryFilterActive,
  nextRunHistoryWindow,
  type RunHistoryFilter,
} from "../src/index.js";
import type { RunHistoryRow } from "@chimera/protocol";

function row(overrides: Partial<RunHistoryRow>): RunHistoryRow {
  return {
    id: "r1",
    kind: "agent",
    subject: "agent-1",
    trigger: { kind: "operator", ref: null, detail: null },
    model: "sonnet",
    costUsd: 0,
    costBasis: "booked",
    outcome: "done",
    reason: null,
    startedAt: 0,
    endedAt: 1000,
    durationMs: 1000,
    unseen: false,
    queue: null,
    team: null,
    jobName: null,
    agentId: "agent-1",
    taskId: null,
    steps: null,
    stepFailures: null,
    ...overrides,
  };
}

describe("filterRuns", () => {
  it("with EMPTY_RUN_HISTORY_FILTER returns every row unchanged", () => {
    const rows = [row({ id: "a" }), row({ id: "b", kind: "task" })];
    expect(filterRuns(rows, EMPTY_RUN_HISTORY_FILTER)).toEqual(rows);
  });

  it("filters by kind", () => {
    const rows = [row({ id: "a", kind: "agent" }), row({ id: "b", kind: "task" })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, kinds: ["task"] };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by outcome", () => {
    const rows = [row({ id: "a", outcome: "done" }), row({ id: "b", outcome: "failed" })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, outcome: ["failed"] };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by unseenOnly", () => {
    const rows = [row({ id: "a", unseen: false }), row({ id: "b", unseen: true })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, unseenOnly: true };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["b"]);
  });

  it("matches text against subject, model and trigger.ref, case-insensitively", () => {
    const rows = [
      row({ id: "a", subject: "nightly-digest" }),
      row({ id: "b", model: "GPT-5" }),
      row({ id: "c", trigger: { kind: "job", ref: "daily-digest-0800", detail: null } }),
      row({ id: "d", subject: "unrelated" }),
    ];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, text: "digest" };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("runHistoryCounts", () => {
  it("sums costUsd only over costBasis:booked rows — never double-counting a rolled-up task/job total", () => {
    const rows = [
      row({ id: "a", kind: "agent", costBasis: "booked", costUsd: 1.5 }),
      row({ id: "b", kind: "agent", costBasis: "booked", costUsd: 2.5 }),
      // task/job rows restate the same booked dollars for display — must be excluded from the sum
      row({ id: "c", kind: "task", costBasis: "rolled-up", costUsd: 4 }),
      row({ id: "d", kind: "job", costBasis: "rolled-up", costUsd: 4 }),
    ];
    const counts = runHistoryCounts(rows);
    expect(counts.costUsd).toBe(4);
    expect(counts.total).toBe(4);
    expect(counts.byKind).toEqual({ agent: 2, task: 1, job: 1 });
  });

  it("counts failed and unseen rows", () => {
    const rows = [
      row({ id: "a", outcome: "failed", unseen: true }),
      row({ id: "b", outcome: "done", unseen: false }),
    ];
    const counts = runHistoryCounts(rows);
    expect(counts.failed).toBe(1);
    expect(counts.unseen).toBe(1);
  });
});

describe("formatRunDuration", () => {
  it("formats null as an em dash", () => {
    expect(formatRunDuration(null)).toBe("—");
  });
  it("formats sub-minute durations as seconds", () => {
    expect(formatRunDuration(42_000)).toBe("42s");
  });
  it("formats sub-hour durations as minutes and seconds", () => {
    expect(formatRunDuration(8 * 60_000 + 12_000)).toBe("8m 12s");
  });
  it("formats hour-plus durations as hours and minutes", () => {
    expect(formatRunDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
  });
});

describe("runHistoryTriggerLabel", () => {
  it("labels a job trigger", () => {
    expect(runHistoryTriggerLabel({ kind: "job", ref: "daily-digest-0800", detail: null })).toBe("job daily-digest-0800");
  });
  it("labels an operator trigger", () => {
    expect(runHistoryTriggerLabel({ kind: "operator", ref: null, detail: null })).toBe("operator");
  });
  it("labels an unknown trigger as an em dash", () => {
    expect(runHistoryTriggerLabel({ kind: "unknown", ref: null, detail: null })).toBe("—");
  });

  // [F13.QA M-1] a job RUN row says WHY the scheduler fired it; "scheduled X" vs "manual X" is
  // the whole point of `detail` and the reason kind:"schedule" exists next to kind:"job".
  it("labels a schedule trigger with the fire reason, not just the job name", () => {
    expect(runHistoryTriggerLabel({ kind: "schedule", ref: "nightly-digest", detail: "scheduled" })).toBe("scheduled nightly-digest");
    expect(runHistoryTriggerLabel({ kind: "schedule", ref: "nightly-digest", detail: "manual" })).toBe("manual nightly-digest");
    expect(runHistoryTriggerLabel({ kind: "schedule", ref: "nightly-digest", detail: "catchup" })).toBe("catchup nightly-digest");
  });
  it("never invents a fire reason — a null detail degrades to plain 'schedule'", () => {
    expect(runHistoryTriggerLabel({ kind: "schedule", ref: "nightly-digest", detail: null })).toBe("schedule nightly-digest");
    expect(runHistoryTriggerLabel({ kind: "schedule", ref: null, detail: null })).toBe("schedule");
  });
});

// [F13.QA M-4] the header must describe the whole matched set, not the capped page — and must
// stop claiming to when a client-only chip narrows what is actually on screen.
describe("runHistoryHeaderCounts", () => {
  const totals = { runs: 812, costUsd: 42.5, failed: 30, unseen: 9 };
  const page = [row({ id: "a", outcome: "failed", unseen: true, costUsd: 1 })];

  it("prefers server totals over the page whenever no client-only chip is active", () => {
    expect(runHistoryHeaderCounts(totals, page, EMPTY_RUN_HISTORY_FILTER)).toEqual({ total: 812, costUsd: 42.5, failed: 30, unseen: 9 });
  });
  it("still prefers server totals under a kind/outcome chip — those were applied server-side", () => {
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, kinds: ["agent"], outcome: ["failed"] };
    expect(runHistoryHeaderCounts(totals, page, f).total).toBe(812);
  });
  it("falls back to the visible page once a client-only chip narrows it", () => {
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, teams: ["alpha"] };
    expect(runHistoryHeaderCounts(totals, page, f)).toEqual({ total: 1, costUsd: 1, failed: 1, unseen: 1 });
  });
  it("falls back to the page when the server sent no totals at all", () => {
    expect(runHistoryHeaderCounts(null, page, EMPTY_RUN_HISTORY_FILTER).total).toBe(1);
  });
});

// [F13.QA M-3] kind/outcome are SERVER facets; re-running them over a capped page would drop
// matches the server already counted and totalled.
describe("runHistoryClientFilter", () => {
  it("drops kinds and outcome, keeping every page-only chip", () => {
    const f: RunHistoryFilter = { kinds: ["agent"], outcome: ["failed"], teams: ["alpha"], costBasis: ["booked"], unseenOnly: true, text: "x" };
    expect(runHistoryClientFilter(f)).toEqual({ kinds: [], outcome: [], teams: ["alpha"], costBasis: ["booked"], unseenOnly: true, text: "x" });
  });
  it("keeps a row the server already matched even when it is not the chip's kind", () => {
    const rows = [row({ id: "a", kind: "task" })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, kinds: ["agent"] };
    expect(filterRuns(rows, runHistoryClientFilter(f)).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("filterRuns — team and cost basis facets", () => {
  it("filters by team, excluding rows with no team", () => {
    const rows = [row({ id: "a", team: "alpha" }), row({ id: "b", team: "beta" }), row({ id: "c", team: null })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, teams: ["alpha"] };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["a"]);
  });

  it("filters by cost basis so an operator can see only the dollars the total counts", () => {
    const rows = [row({ id: "a", costBasis: "booked" }), row({ id: "b", costBasis: "rolled-up" })];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, costBasis: ["booked"] };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["a"]);
  });

  it("matches text against team, queue, job name and reason too", () => {
    const rows = [
      row({ id: "a", team: "harness" }),
      row({ id: "b", queue: "harness-queue" }),
      row({ id: "c", jobName: "harness-nightly" }),
      row({ id: "d", reason: "harness timeout" }),
      row({ id: "e", subject: "unrelated" }),
    ];
    const f: RunHistoryFilter = { ...EMPTY_RUN_HISTORY_FILTER, text: "harness" };
    expect(filterRuns(rows, f).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("runHistoryTeams", () => {
  it("derives sorted unique team chips and drops nulls", () => {
    expect(runHistoryTeams([row({ team: "b" }), row({ team: "a" }), row({ team: "b" }), row({ team: null })])).toEqual(["a", "b"]);
  });
});

describe("isRunHistoryFilterActive", () => {
  it("is false for the empty filter and true once any facet is set", () => {
    expect(isRunHistoryFilterActive(EMPTY_RUN_HISTORY_FILTER)).toBe(false);
    expect(isRunHistoryFilterActive({ ...EMPTY_RUN_HISTORY_FILTER, text: "  " })).toBe(false);
    expect(isRunHistoryFilterActive({ ...EMPTY_RUN_HISTORY_FILTER, teams: ["a"] })).toBe(true);
    expect(isRunHistoryFilterActive({ ...EMPTY_RUN_HISTORY_FILTER, unseenOnly: true })).toBe(true);
  });
});

describe("runHistoryTotalsLine", () => {
  it("says 'booked' in the line — the sum excludes rolled-up rows on purpose", () => {
    const rows = [
      row({ id: "a", costBasis: "booked", costUsd: 1.5, unseen: true }),
      row({ id: "b", costBasis: "rolled-up", costUsd: 4, outcome: "failed" }),
    ];
    expect(runHistoryTotalsLine(runHistoryCounts(rows))).toBe("2 runs · $1.50 booked · 1 failed · 1 new");
  });

  it("reads sensibly when only rolled-up rows are shown", () => {
    expect(runHistoryTotalsLine(runHistoryCounts([row({ costBasis: "rolled-up", costUsd: 4 })]))).toBe(
      "1 runs · $0.00 booked · 0 failed · 0 new",
    );
  });
});

describe("runHistoryTruncationLine", () => {
  it("is null when the page holds everything the window matched", () => {
    expect(runHistoryTruncationLine(12, 12)).toBeNull();
  });
  it("names both numbers when the page was capped", () => {
    expect(runHistoryTruncationLine(500, 812)).toBe("showing 500 of 812 — narrow the window or the kind/outcome filters to see the rest");
  });
});

describe("runHistoryFilterSummary", () => {
  it("reads 'no filters' when nothing narrows the list", () => {
    expect(runHistoryFilterSummary(EMPTY_RUN_HISTORY_FILTER)).toBe("no filters");
  });
  it("joins every active facet", () => {
    expect(
      runHistoryFilterSummary({ kinds: ["agent"], outcome: ["failed"], teams: ["alpha"], costBasis: ["booked"], unseenOnly: true, text: "x" }),
    ).toBe('agent · failed · team alpha · booked · new only · "x"');
  });
});

describe("nextRunHistoryWindow", () => {
  it("cycles 12h → 24h → 7d → 12h", () => {
    expect(nextRunHistoryWindow("12h")).toBe("24h");
    expect(nextRunHistoryWindow("24h")).toBe("7d");
    expect(nextRunHistoryWindow("7d")).toBe("12h");
  });
});

describe("runHistoryRowDetail", () => {
  it("says so plainly when the row carries no extra detail", () => {
    expect(runHistoryRowDetail(row({}))).toBe("no further detail recorded");
  });
  it("joins team, queue, steps and the failure reason", () => {
    expect(runHistoryRowDetail(row({ team: "alpha", queue: "q1", steps: 4, stepFailures: 1, reason: "exit 1" }))).toBe(
      "team alpha · queue q1 · 4 steps (1 failed) · exit 1",
    );
  });
});
