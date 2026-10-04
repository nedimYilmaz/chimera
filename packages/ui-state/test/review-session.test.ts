import { describe, expect, it } from "vitest";
import { attentionInbox, initialState, reduce } from "../src/index.js";
import type { ReviewSession, TaskEvidence } from "@chimera/protocol";

const evidence: TaskEvidence = { taskId: "t1", queue: "q", state: "done", workflow: null, steps: [], artifacts: [], provenance: [{ worktreeKey: "w", branch: "chimera/w", mainRepo: "/r", agentIds: ["a"], diff: { available: true, source: "merged", baseSha: "a", headSha: "b", mergeCommitSha: "c", files: [], patches: [{ path: "a.ts", oldPath: null, status: "modified", language: "typescript", binary: false, truncated: false, hunks: [{ id: "h1", header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }] }], patchTruncated: false, statText: "", truncated: false, dirty: null } }] };
const session: ReviewSession = { taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0 };

describe("review room reducer", () => {
  it("loads a first file/hunk and preserves it when the room closes", () => {
    let state = reduce(initialState, { type: "reviewRoomOpen", taskId: "t1" });
    state = reduce(state, { type: "reviewRoomLoaded", taskId: "t1", evidence, session });
    expect(state.reviewRoom.selectedPath).toBe("a.ts");
    expect(state.reviewRoom.selectedHunkId).toBe("h1");
    state = reduce(state, { type: "reviewRoomClose" });
    expect(state.reviewRoom.evidenceByTask.t1).toBe(evidence);
  });

  it("accepts a session-less load (evidence OK, review.get unavailable) without faking a session", () => {
    let state = reduce(initialState, { type: "reviewRoomOpen", taskId: "t1" });
    state = reduce(state, { type: "reviewRoomLoaded", taskId: "t1", evidence, session: null, sessionError: "review unavailable — daemon predates review RPCs (restart chimerad)" });
    expect(state.reviewRoom.evidenceByTask.t1).toBe(evidence);
    expect(state.reviewRoom.sessionsByTask.t1).toBeUndefined();
    expect(state.reviewRoom.sessionError).toBe("review unavailable — daemon predates review RPCs (restart chimerad)");
    expect(state.reviewRoom.error).toBeNull();
    expect(state.reviewRoom.selectedPath).toBe("a.ts");
  });

  it("ignores a stale load after navigation to another task", () => {
    let state = reduce(initialState, { type: "reviewRoomOpen", taskId: "t1" });
    state = reduce(state, { type: "reviewRoomOpen", taskId: "t2" });
    state = reduce(state, { type: "reviewRoomLoaded", taskId: "t1", evidence, session });
    expect(state.reviewRoom.evidenceByTask.t1).toBeUndefined();
  });

  it("raises request-changes in the inbox and clears it after acceptance", () => {
    let state = reduce(initialState, { type: "reviewRoomSession", session: { ...session, revision: 1, decision: { status: "changes_requested", actorAgentId: null, summary: "fix it", revision: 1, decidedAt: 10 } } });
    expect(attentionInbox(state).map((i) => i.kind)).toEqual(["review_decision"]);
    state = reduce(state, { type: "reviewRoomSession", session: { ...session, revision: 2, decision: { status: "accepted", actorAgentId: null, summary: "ok", revision: 2, decidedAt: 20 } } });
    expect(attentionInbox(state)).toEqual([]);
  });
});
