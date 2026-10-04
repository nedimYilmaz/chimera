import { describe, expect, it } from "vitest";
import type { EvidenceProvenanceEntry, EvidenceStep } from "@chimera/protocol";
import {
  evidenceDiffSummary,
  evidenceFileStatusGlyph,
  evidenceProvenanceLine,
  evidenceStepGlyph,
  evidenceStepLine,
} from "../src/state/selectors.evidence";

// FEATURE-10 (Changes & Evidence Review) — pure selector coverage, same style as
// selectors.artifacts.test.ts/selectors.workflows.test.ts (no React, no store).

const step = (over: Partial<EvidenceStep> = {}): EvidenceStep => ({
  stepIndex: 0, stepId: "s0", title: "build", agentId: "a1", startedAt: 1000, endedAt: 41_000,
  outcome: "passed", reason: null, handoffSummary: null, gate: { kind: "command", spec: { command: "npm test" } },
  ...over,
});

const entry = (over: Partial<EvidenceProvenanceEntry> = {}): EvidenceProvenanceEntry => ({
  worktreeKey: "agent-1", branch: "chimera/agent-1", mainRepo: "/repo", agentIds: ["agent-1"],
  diff: {
    available: true, source: "live", baseSha: "aaa1111", headSha: "bbb2222", mergeCommitSha: null,
    files: [{ path: "a.ts", status: "modified", insertions: 3, deletions: 1 }],
    statText: "a.ts | 4 ++--", truncated: false, dirty: 0,
  },
  ...over,
});

describe("evidenceStepGlyph", () => {
  it("maps passed/failed/retried outcomes to their glyph", () => {
    expect(evidenceStepGlyph(step({ outcome: "passed" }))).toBe("●");
    expect(evidenceStepGlyph(step({ outcome: "failed" }))).toBe("✗");
    expect(evidenceStepGlyph(step({ outcome: "retried" }))).toBe("↻");
  });
  it("renders a still-open (crash-mid-step) entry as ◐", () => {
    expect(evidenceStepGlyph(step({ outcome: null }))).toBe("◐");
  });
});

describe("evidenceStepLine", () => {
  it("includes title, gate kind, and a formatted duration when both timestamps are present", () => {
    const line = evidenceStepLine(step());
    expect(line).toContain("build");
    expect(line).toContain("[command]");
    expect(line).toContain("40s");
  });
  it("falls back to the raw stepId when there's no matching WorkflowStep title", () => {
    expect(evidenceStepLine(step({ title: null, stepId: "orphan-step" }))).toContain("orphan-step");
  });
  it("omits the gate suffix and duration when absent (still-open step)", () => {
    const line = evidenceStepLine(step({ gate: null, endedAt: null, outcome: null }));
    expect(line).not.toContain("[");
    expect(line).not.toMatch(/\(\d/);
  });
});

describe("evidenceDiffSummary", () => {
  it("sums insertions/deletions across files for an available diff", () => {
    const e = entry({ diff: { ...entry().diff, available: true, files: [
      { path: "a.ts", status: "modified", insertions: 3, deletions: 1 },
      { path: "b.ts", status: "added", insertions: 10, deletions: 0 },
    ] } as EvidenceProvenanceEntry["diff"] });
    expect(evidenceDiffSummary(e)).toEqual({ filesChanged: 2, insertions: 13, deletions: 1 });
  });
  it("returns zeros for an unavailable diff", () => {
    const e = entry({ diff: { available: false, reason: "gone" } });
    expect(evidenceDiffSummary(e)).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe("evidenceProvenanceLine", () => {
  it("renders a 'live' diff with a dirty count", () => {
    const line = evidenceProvenanceLine(entry({ diff: { ...entry().diff, dirty: 2 } as EvidenceProvenanceEntry["diff"] }));
    expect(line).toContain("chimera/agent-1");
    expect(line).toContain("live");
    expect(line).toContain("1 file");
    expect(line).toContain("dirty(2)");
  });
  it("renders a 'merged' diff with a short merge commit sha, no dirty count", () => {
    const line = evidenceProvenanceLine(entry({ diff: {
      available: true, source: "merged", baseSha: "a", headSha: "b", mergeCommitSha: "0123456789abcdef",
      files: [], statText: "", truncated: false, dirty: null,
    } }));
    expect(line).toContain("merged 0123456");
    expect(line).not.toContain("dirty");
  });
  it("renders the reason text for an unavailable diff", () => {
    const line = evidenceProvenanceLine(entry({ diff: { available: false, reason: "no live worktree and no merge commit found" } }));
    expect(line).toContain("no diff available: no live worktree and no merge commit found");
  });
});

describe("evidenceFileStatusGlyph", () => {
  it("maps every EvidenceFileChange status to a glyph, with a safe fallback", () => {
    expect(evidenceFileStatusGlyph("added")).toBe("+");
    expect(evidenceFileStatusGlyph("modified")).toBe("~");
    expect(evidenceFileStatusGlyph("deleted")).toBe("−");
    expect(evidenceFileStatusGlyph("renamed")).toBe("→");
    expect(evidenceFileStatusGlyph("bogus")).toBe("~");
  });
});
