import { describe, expect, it } from "vitest";
import {
  artifactFromEvent,
  artifactPreviewText,
  artifactRow,
  countDiffLines,
  formatArtifactSize,
  isPreviewableKind,
  latestArtifactSeq,
  mergeArtifacts,
  optimisticArtifacts,
  type ArtifactRow,
} from "../src/state/selectors.artifacts";

const rec = (overrides: Record<string, unknown> = {}) => ({
  id: "art-1",
  kind: "report",
  label: "report.md",
  agentId: "agent-1",
  taskId: "task-1",
  createdAt: 1000,
  sizeBytes: 4300,
  path: "/tmp/report.md",
  url: null,
  ...overrides,
});

describe("artifactRow (projecting an ArtifactRecord)", () => {
  it("projects every field", () => {
    expect(artifactRow(rec())).toEqual({
      id: "art-1",
      kind: "report",
      label: "report.md",
      agentId: "agent-1",
      taskId: "task-1",
      createdAt: 1000,
      sizeBytes: 4300,
      path: "/tmp/report.md",
      url: null,
    });
  });

  it("falls back to id for a blank label, and to \"file\" for an unknown kind", () => {
    const row = artifactRow(rec({ label: "", kind: "bogus" }));
    expect(row.label).toBe("art-1");
    expect(row.kind).toBe("file");
  });

  it("reads defensively against a field-less record (daemon drift never crashes a pane)", () => {
    expect(artifactRow({})).toEqual({
      id: "", kind: "file", label: "", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null,
    });
  });
});

describe("formatArtifactSize", () => {
  it("bytes under 1k", () => expect(formatArtifactSize(512)).toBe("512b"));
  it("kilobytes with one decimal", () => expect(formatArtifactSize(4300)).toBe("4.2k"));
  it("megabytes with one decimal", () => expect(formatArtifactSize(1_400_000)).toBe("1.3M"));
});

describe("countDiffLines", () => {
  it("counts +/- content lines, excluding the +++/--- file headers", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,3 @@", "+added one", "+added two", "-removed one", " context"].join("\n");
    expect(countDiffLines(patch)).toEqual({ plus: 2, minus: 1 });
  });

  it("empty text has no lines", () => expect(countDiffLines("")).toEqual({ plus: 0, minus: 0 }));
});

describe("artifactPreviewText (F12 renderer fence wrapping)", () => {
  it("wraps a diff snapshot in a ```diff fence", () => {
    expect(artifactPreviewText("diff", "+a\n-b")).toBe("```diff\n+a\n-b\n```");
  });
  it("wraps a chart snapshot in a ```chart fence", () => {
    expect(artifactPreviewText("chart", '{"type":"bar","data":[]}')).toBe('```chart\n{"type":"bar","data":[]}\n```');
  });
  it("uses a report's markdown content verbatim", () => {
    expect(artifactPreviewText("report", "# hello")).toBe("# hello");
  });
});

describe("isPreviewableKind", () => {
  it("report/diff/chart are previewable; file/link are not", () => {
    expect(isPreviewableKind("report")).toBe(true);
    expect(isPreviewableKind("diff")).toBe(true);
    expect(isPreviewableKind("chart")).toBe(true);
    expect(isPreviewableKind("file")).toBe(false);
    expect(isPreviewableKind("link")).toBe(false);
  });
});

describe("artifactFromEvent (optimistic seed)", () => {
  it("builds a row from an artifact_added event's payload", () => {
    const row = artifactFromEvent({
      kind: "artifact_added",
      ts: 500,
      data: { id: "art-2", kind: "diff", label: "perf.patch", agentId: "agent-1", taskId: "task-1", sizeBytes: 900 },
    });
    expect(row).toEqual({
      id: "art-2", kind: "diff", label: "perf.patch", agentId: "agent-1", taskId: "task-1",
      createdAt: 500, sizeBytes: 900, path: null, url: null,
    });
  });

  it("ignores a non-artifact_added event", () => {
    expect(artifactFromEvent({ kind: "status", ts: 1, data: {} })).toBeNull();
  });

  it("ignores an artifact_added event with no data", () => {
    expect(artifactFromEvent({ kind: "artifact_added", ts: 1 })).toBeNull();
  });
});

describe("optimisticArtifacts + mergeArtifacts (F17 optimistic + reconcile)", () => {
  const events = [
    { kind: "artifact_added", ts: 10, data: { id: "a", kind: "report", label: "r.md", agentId: "agent-1", taskId: "task-1", sizeBytes: 10 } },
    { kind: "status", ts: 11, data: {} },
    { kind: "artifact_added", ts: 12, data: { id: "b", kind: "diff", label: "p.patch", agentId: "agent-2", taskId: "task-1", sizeBytes: 20 } },
  ];

  it("filters the ring buffer to one agent scope", () => {
    const rows = optimisticArtifacts(events, { agentId: "agent-1" });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters the ring buffer to one task scope", () => {
    const rows = optimisticArtifacts(events, { taskId: "task-1" });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("mergeArtifacts: fetched wins by id, unreconciled optimistic rows stay appended", () => {
    const fetched: ArtifactRow[] = [artifactRow(rec({ id: "a", label: "reconciled.md" }))];
    const optimistic = optimisticArtifacts(events, { taskId: "task-1" });
    const merged = mergeArtifacts(fetched, optimistic);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
    expect(merged[0]!.label).toBe("reconciled.md"); // fetched copy, not the optimistic one
  });
});

describe("latestArtifactSeq", () => {
  it("finds the newest artifact_added seq, ignoring other event kinds", () => {
    const events = [{ seq: 1, kind: "status" }, { seq: 2, kind: "artifact_added" }, { seq: 3, kind: "status" }];
    expect(latestArtifactSeq(events)).toBe(2);
  });
  it("0 when there is no artifact_added event", () => {
    expect(latestArtifactSeq([{ seq: 1, kind: "status" }])).toBe(0);
  });
});
