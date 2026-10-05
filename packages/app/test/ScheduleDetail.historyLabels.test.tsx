import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// ScheduleDetail imports the app store, which wires daemon events at module load.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
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

import { ScheduleDetail } from "../src/components/ScheduleDetail";
import { jobRow } from "../src/state/selectors.jobs";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Node = { children?: (Node | string)[] | null };
function text(node: Node | string | null | (Node | string)[]): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return (node.children ?? []).map(text).join("");
}

function run(ts: number, over: Record<string, unknown> = {}) {
  return { ts, trigger: "scheduled", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0.5, ...over };
}

function render(nextRunTs: number | null) {
  const lastRuns = [run(NOW - 10 * DAY, { trigger: "manual" }), run(NOW - 27 * MIN, { result: "failed", error: "boom" })];
  const raw = {
    name: "atlas-a11y-sweep",
    enabled: true,
    schedule: { cron: "30 6 * * *" },
    target: { role: "reviewer" },
    nextRunTs,
    lastRuns,
    deliveryDroppedAt: NOW - 3 * HOUR,
  };
  const row = jobRow(raw);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(ScheduleDetail, { row, spec: { ...raw, tz: "UTC", prompt: "sweep" }, now: NOW }));
  });
  return text(renderer.toJSON() as Node);
}

// nextRunLabel exists for a NEXT-RUN column: a slot far in the past reads "overdue by 9h" because
// the machine slept through it. Applied to a timestamp that is *supposed* to be in the past (a
// finished run, a dropped delivery) it printed "overdue by 27m" — a finished run is not overdue.
describe("ScheduleDetail time labels", () => {
  it("reads finished runs and the dropped-delivery stamp as '<n> ago', never 'overdue by'", () => {
    const out = render(NOW + 4 * HOUR);
    expect(out).not.toContain("overdue");
    expect(out).toContain("27m ago");   // last-run line AND the newest history row
    expect(out).toContain("10d ago");   // the oldest history row
    expect(out).toContain("delivery removed 3h ago");
    expect(out).toContain("in 4h");     // the genuine next run stays forward-looking
  });

  it("still flags an overdue UPCOMING slot, and only that one", () => {
    const out = render(NOW - 33_180_000);
    expect(out).toContain("overdue by 9h");
    expect(out.match(/overdue by/g)).toHaveLength(1);
    expect(out).toContain("27m ago");
  });
});
