// FEATURE-10 (Changes & Evidence Review) — evidence.get RPC wrapper + the panel's
// fetch-on-open hook. Structured like commands.artifacts.ts: a pure factory over an
// injected `request` (unit-testable), plus a reactive hook the screen binds with the
// real rpc/bridge.ts `rpcCall`.
import { useEffect, useState } from "react";
import type { TaskEvidence } from "@chimera/protocol";
import type { ReviewFinding, ReviewSession } from "@chimera/protocol";
import { errorToText, isUnknownMethod, type UiStore } from "@chimera/ui-state";
import type { RequestFn } from "./commands.coord";

export type EvidenceCommands = ReturnType<typeof createEvidenceCommands>;

export function createEvidenceCommands(request: RequestFn) {
  return {
    get: (taskId: string): Promise<TaskEvidence> => request<TaskEvidence>("evidence.get", { taskId }),
    getReview: (taskId: string): Promise<ReviewSession> => request("review.get", { taskId }),
    addFinding: (input: { taskId: string; path: string; hunkId?: string | null; parentId?: string | null; authorAgentId?: string | null; severity: "note" | "warning" | "blocking"; body: string }): Promise<ReviewFinding> => request("review.finding.add", input),
    resolveFinding: (taskId: string, findingId: string): Promise<ReviewFinding> => request("review.finding.resolve", { taskId, findingId }),
    decide: (taskId: string, status: "accepted" | "changes_requested", summary: string): Promise<ReviewSession> => request("review.decide", { taskId, status, summary }),
  };
}

// review.get (review-room landing, same day as this fix) is a NEWER rpc than
// evidence.get — against an older daemon it rejects unknown-method while
// evidence.get still succeeds. The two fetches resolve INDEPENDENTLY
// (allSettled, not Promise.all) so an unknown-method review.get degrades the
// room instead of taking it down: the diff still renders, and the
// findings/decision rail gets a friendly explanation via sessionError.
export async function openReviewRoom(store: UiStore, request: RequestFn, taskId: string): Promise<void> {
  store.dispatch({ type: "reviewRoomOpen", taskId });
  store.dispatch({ type: "reviewRoomLoading", taskId });
  const [evidenceResult, sessionResult] = await Promise.allSettled([
    request<TaskEvidence>("evidence.get", { taskId }),
    request<ReviewSession>("review.get", { taskId }),
  ]);
  if (evidenceResult.status === "rejected") {
    const evidenceError = errorToText(evidenceResult.reason);
    const error = sessionResult.status === "rejected" ? `${evidenceError}; ${errorToText(sessionResult.reason)}` : evidenceError;
    store.dispatch({ type: "reviewRoomFailed", taskId, error });
    return;
  }
  const sessionError = sessionResult.status === "rejected"
    ? isUnknownMethod(sessionResult.reason)
      ? "review unavailable — daemon predates review RPCs (restart chimerad)"
      : errorToText(sessionResult.reason)
    : null;
  store.dispatch({ type: "reviewRoomLoaded", taskId, evidence: evidenceResult.value, session: sessionResult.status === "fulfilled" ? sessionResult.value : null, sessionError });
}

// The app-side singleton: bound lazily by the first caller with the deps IT imports
// (getArtifactsCommands/getWorkflowsCommands precedent).
let singleton: EvidenceCommands | null = null;
export function getEvidenceCommands(request: RequestFn): EvidenceCommands {
  if (!singleton) singleton = createEvidenceCommands(request);
  return singleton;
}

export type TaskEvidenceQuery = { loading: boolean; data: TaskEvidence | null; error: string | null };

/** Fetches evidence.get ONLY while `taskId` is non-null — the panel must be explicitly
 * opened before this heavier, git-shelling aggregate call fires. Unlike useArtifacts,
 * there is no event-ring optimism to ride here (nothing in the ring maps to "this
 * task's diff changed") — plain fetch-on-open, re-fetching whenever `taskId` changes;
 * `null` clears the result immediately (closing the panel). */
export function useTaskEvidence(taskId: string | null, request: RequestFn): TaskEvidenceQuery {
  const [state, setState] = useState<TaskEvidenceQuery>({ loading: false, data: null, error: null });

  useEffect(() => {
    if (!taskId) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let alive = true;
    setState({ loading: true, data: null, error: null });
    // Calls `request` directly (NOT the getEvidenceCommands singleton, which binds to
    // whichever `request` closure first calls it and would go stale on a fresh one —
    // useArtifacts avoids the exact same trap the same way, see commands.artifacts.ts).
    request<TaskEvidence>("evidence.get", { taskId })
      .then((data) => {
        if (alive) setState({ loading: false, data, error: null });
      })
      .catch((err) => {
        if (alive) setState({ loading: false, data: null, error: errorToText(err) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return state;
}
