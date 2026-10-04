// F17 (W19 artifacts & deliverables, coverage B21/C15) — artifact.* RPC
// wrappers + the strip/preview's reactive hooks + the preview-card's local
// store. Structured like commands.workflows.ts: a PURE factory over an
// injected `request` so the RPC wrappers stay unit-testable; the reactive
// hooks below additionally take `events`/`readSnapshot` as parameters instead
// of importing the app's singleton store/bridge directly, for the same
// reason (Composer/ResultCard/QueuesScreen bind them with the real
// useStore()-sourced events + rpc/bridge.ts functions).
import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import type { NormalizedEvent } from "@chimera/protocol";
import type { RequestFn } from "./commands.coord";
import {
  artifactRow,
  countDiffLines,
  latestArtifactSeq,
  mergeArtifacts,
  optimisticArtifacts,
  type ArtifactRow,
  type ArtifactScope,
} from "./selectors.artifacts";

export type ArtifactsCommands = ReturnType<typeof createArtifactsCommands>;

/** artifact.list scoped by agentId or taskId — the sole data source for every
 * F17 surface (the strip, ResultCard's and TaskInspector's own-artifact
 * lists); artifact.get backs the preview card's per-id fetch. */
export function createArtifactsCommands(request: RequestFn) {
  return {
    listForAgent: (agentId: string): Promise<ArtifactRow[]> =>
      request<Array<Record<string, unknown>>>("artifact.list", { agentId }).then((rows) => rows.map(artifactRow)),
    listForTask: (taskId: string): Promise<ArtifactRow[]> =>
      request<Array<Record<string, unknown>>>("artifact.list", { taskId }).then((rows) => rows.map(artifactRow)),
    get: (id: string): Promise<ArtifactRow> => request<Record<string, unknown>>("artifact.get", { id }).then(artifactRow),
  };
}

// The app-side singleton: bound lazily by the first caller with the deps IT
// imports (getWorkflowsCommands/getJobsCommands precedent).
let singleton: ArtifactsCommands | null = null;
export function getArtifactsCommands(request: RequestFn): ArtifactsCommands {
  if (!singleton) singleton = createArtifactsCommands(request);
  return singleton;
}

// ---------------------------------------------------------------------------
// live-reactive artifact list for one scope (F17: "Persist across agent
// close + daemon restart (driven by artifact_added events; optimistic +
// reconcile)")
// ---------------------------------------------------------------------------

const scopeKey = (scope: ArtifactScope): string => ("agentId" in scope ? `a:${scope.agentId}` : `t:${scope.taskId}`);

/** Optimistic half: reads straight off the event ring (instant, same tick as
 * the artifact_added event). Reconcile half: `latestArtifactSeq` changing
 * triggers a fresh artifact.list fetch, whose result always wins over an
 * optimistic row once it lands (mergeArtifacts). A daemon restart or the
 * registering agent closing needs no special handling — the reconcile fetch
 * reads the daemon's own persisted ArtifactStore, so the next mount (or the
 * next event-triggered refetch) already reflects it. */
export function useArtifacts(
  scope: ArtifactScope | null,
  events: readonly NormalizedEvent[],
  request: RequestFn,
): ArtifactRow[] {
  const [fetched, setFetched] = useState<ArtifactRow[]>([]);
  const seq = scope ? latestArtifactSeq(events) : 0;
  const key = scope ? scopeKey(scope) : null;

  useEffect(() => {
    if (!scope) {
      setFetched([]);
      return;
    }
    let alive = true;
    const params = "agentId" in scope ? { agentId: scope.agentId } : { taskId: scope.taskId };
    request<Array<Record<string, unknown>>>("artifact.list", params)
      .then((rows) => {
        if (alive) setFetched(rows.map(artifactRow));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, seq]);

  if (!scope) return [];
  return mergeArtifacts(fetched, optimisticArtifacts(events, scope));
}

/** Lazily resolves ±line counts for every diff-kind row in the list (the
 * chip's "±lines" meta needs the snapshot CONTENT, not just sizeBytes) —
 * fetched once per id and cached for the component's lifetime. */
export function useDiffMeta(
  rows: readonly ArtifactRow[],
  readSnapshot: (id: string) => Promise<string>,
): Record<string, { plus: number; minus: number }> {
  const [meta, setMeta] = useState<Record<string, { plus: number; minus: number }>>({});
  const diffIds = rows.filter((r) => r.kind === "diff").map((r) => r.id);
  const key = diffIds.join(",");

  useEffect(() => {
    let alive = true;
    for (const id of diffIds) {
      if (meta[id]) continue;
      readSnapshot(id)
        .then((text) => {
          if (alive) setMeta((m) => ({ ...m, [id]: countDiffLines(text) }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return meta;
}

// ---------------------------------------------------------------------------
// the preview card's local store (which artifact id, if any, is open)
// ---------------------------------------------------------------------------

export type ArtifactsLocalState = { previewId: string | null };
const initialLocal: ArtifactsLocalState = { previewId: null };

export type ArtifactsLocalStore = {
  getState(): ArtifactsLocalState;
  set(patch: Partial<ArtifactsLocalState>): void;
  subscribe(fn: () => void): () => void;
};

export function createArtifactsLocal(): ArtifactsLocalStore {
  let state = initialLocal;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The ONE app-wide F17 local store (module singleton — pure, no IO). Any
 * surface (strip/ResultCard/TaskInspector) can open a preview by id; the
 * preview card itself is registered once via OverlayOutlet, so it renders
 * regardless of which screen opened it. */
export const artifactsLocal: ArtifactsLocalStore = createArtifactsLocal();

/** React binding — same selector discipline as useStore/useWorkflowsLocal. */
export function useArtifactsLocal<T>(selector: (s: ArtifactsLocalState) => T): T {
  return useSyncExternalStore(artifactsLocal.subscribe, () => selector(artifactsLocal.getState()));
}
