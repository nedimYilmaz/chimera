import { describe, expect, it } from "vitest";
import { nextReviewHunk, reviewFiles, reviewUnavailable } from "../src/state/selectors.review";
import type { TaskEvidence } from "@chimera/protocol";

describe("review selectors", () => {
  it("maps provenance onto sorted files and wraps hunk navigation", () => {
    const patch = (path: string, id: string) => ({ path, oldPath: null, status: "modified" as const, language: null, binary: false, truncated: false, hunks: [{ id, header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }] });
    const evidence = { taskId: "t", queue: "q", state: "done", workflow: null, steps: [], artifacts: [], provenance: [{ worktreeKey: "w", branch: "chimera/w", mainRepo: "/r", agentIds: ["agent"], diff: { available: true, source: "merged", baseSha: "a", headSha: "b", mergeCommitSha: "merge", files: [], patches: [patch("z.ts", "hz"), patch("a.ts", "ha")], patchTruncated: false, statText: "", truncated: false, dirty: null } }] } satisfies TaskEvidence;
    const files = reviewFiles(evidence);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
    expect(files[0]!.agentIds).toEqual(["agent"]);
    expect(nextReviewHunk(files, "hz", 1)).toEqual({ path: "a.ts", hunkId: "ha" });
  });

  // REVIEW-ROOM-UNBOUND-TASKS: an unavailable diff surfaces its per-branch reason so the room can
  // explain WHY there is no patch (direct-on-main, no git evidence, etc.) instead of a bare miss.
  it("collects per-branch reasons for provenance entries whose diff is unavailable", () => {
    const evidence = { taskId: "t", queue: "q", state: "done", workflow: null, steps: [], artifacts: [], provenance: [
      { worktreeKey: "w", branch: "chimera/w", mainRepo: "/r", agentIds: ["agent"], diff: { available: false, reason: "landed directly on main (isolation:\"none\")" } },
    ] } satisfies TaskEvidence;
    expect(reviewFiles(evidence)).toEqual([]);
    expect(reviewUnavailable(evidence)).toEqual([{ branch: "chimera/w", agentIds: ["agent"], reason: "landed directly on main (isolation:\"none\")" }]);
  });
});
