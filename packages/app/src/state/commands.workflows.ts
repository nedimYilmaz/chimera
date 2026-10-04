// W18 (F16 task workflows, coverage B20/C14) — workflow.* command wrappers +
// their screen-local store. Workflow DEFINITIONS have no ui-state slot (a
// registry surface, not a per-agent/coordination-tab concern), mirroring
// commands.jobs.ts's own module-local store precedent for the schedules
// registry. Structured identically: a PURE factory over injected deps so the
// behaviors are unit-testable against stub stores; the Queues screen binds
// the singleton with the real appStore + rpcCall via getWorkflowsCommands.
import { useSyncExternalStore } from "react";
import type { UiStore, WorkflowGraphDocument } from "@chimera/ui-state";
import { normalizeWorkflowGraph, serializeWorkflowGraph } from "@chimera/ui-state";
import { WorkflowSpecSchema } from "@chimera/protocol";
import type { RequestFn } from "./commands.coord";
import { workflowDocumentFromRow, workflowRow, type WorkflowRow } from "./selectors.workflows";

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// ---------------------------------------------------------------------------
// the W18 local store
// ---------------------------------------------------------------------------

export type WorkflowsLocalState = {
  items: WorkflowRow[];
  cardOpen: boolean;        // the read-only WorkflowCard (`w` in queues)
  formOpen: boolean;        // WorkflowFormCard
  editing: string | null;   // non-null: formOpen is an EDIT of this workflow name (prefilled)
  confirmDelete: string | null; // workflow name awaiting the delete ConfirmCard gate
};

const initialLocal: WorkflowsLocalState = { items: [], cardOpen: false, formOpen: false, editing: null, confirmDelete: null };

export type WorkflowsLocalStore = {
  getState(): WorkflowsLocalState;
  set(patch: Partial<WorkflowsLocalState>): void;
  subscribe(fn: () => void): () => void;
};

export function createWorkflowsLocal(): WorkflowsLocalStore {
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
      return () => { listeners.delete(fn); };
    },
  };
}

/** The ONE app-wide W18 local store (module singleton — pure, no IO). */
export const workflowsLocal: WorkflowsLocalStore = createWorkflowsLocal();

/** React binding — same selector discipline as useStore/useJobsLocal. */
export function useWorkflowsLocal<T>(selector: (s: WorkflowsLocalState) => T): T {
  return useSyncExternalStore(workflowsLocal.subscribe, () => selector(workflowsLocal.getState()));
}

// ---------------------------------------------------------------------------
// workflow deep-link navigation (App.tsx's useNavigationSurfaces)
// ---------------------------------------------------------------------------

export type WorkflowNavigationResult = { document: WorkflowGraphDocument; version: number; failedOnly: boolean };

/** Resolves a `{kind:"workflow"}` deep link for App.tsx's useNavigationSurfaces — a standalone
 * function (not tied to workflowsLocal) since navigation must resolve regardless of whether the
 * Queues screen is even mounted. workflow.list is the sole source (no workflow.get{name} RPC),
 * mirroring loadWorkflows' own fetch below. Throws on no match so the navigation surface reports
 * it the same way every other deep-link kind does (a commandError, see App.tsx). */
export async function resolveWorkflowNavigation(
  request: RequestFn,
  target: { name: string; failedOnly?: boolean },
): Promise<WorkflowNavigationResult> {
  const records = await request<Array<Record<string, unknown>>>("workflow.list", {});
  const match = records.find((r) => r["name"] === target.name);
  if (!match) throw new Error(`workflow not found: ${target.name}`);
  const row = workflowRow(match);
  return { document: workflowDocumentFromRow(row), version: row.version, failedOnly: target.failedOnly === true };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type WorkflowsCommands = ReturnType<typeof createWorkflowsCommands>;

export function createWorkflowsCommands(local: WorkflowsLocalStore, store: UiStore, request: RequestFn) {
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  /** workflow.list is the sole source for the whole registry — a full relist
   * on tab entry + after every mutation, mirroring commands.jobs.ts's own
   * refresh-on-event cadence (no polling timers; workflow definitions are
   * created/edited by a human, not an external scheduler, so there is no
   * dedicated workflow_* event to ride here — the step-gate events that DO
   * fire live on selectors.coord's latestCoordSeq, which refreshes the queue
   * drill, not this registry). */
  const loadWorkflows = (): Promise<void> =>
    guarded(async () => {
      const items = (await request<Array<Record<string, unknown>>>("workflow.list", {})).map(workflowRow);
      local.set({ items });
    });

  return {
    loadWorkflows,
    refresh: loadWorkflows,

    /** workflow.create — REJECTS on failure (WorkflowFormCard shows the error
     * inline). `bindToQueue`, when given, immediately binds the new workflow
     * as that queue's DEFAULT (queue.update{patch:{workflow:name}}) — without
     * this the workflow card that opened the form would have nothing to bind
     * to a queue with (there is no other W18 affordance that sets a queue's
     * default workflow). */
    createWorkflow: async (spec: Record<string, unknown>, bindToQueue?: string): Promise<void> => {
      await request("workflow.create", { spec });
      if (bindToQueue) await request("queue.update", { name: bindToQueue, patch: { workflow: spec["name"] } });
      await loadWorkflows();
    },

    /** workflow.update{name,patch} — APPENDS a new version (never mutates a
     * running task's pinned version); REJECTS on failure. */
    updateWorkflow: async (name: string, patch: Record<string, unknown>): Promise<void> => {
      await request("workflow.update", { name, patch });
      await loadWorkflows();
    },

    saveStudio: async (): Promise<void> => {
      const studio = store.getState().workflowStudio;
      if (!studio.draft || studio.mode !== "author") return;
      const spec = WorkflowSpecSchema.parse(serializeWorkflowGraph(studio.draft));
      store.dispatch({ type: "workflowStudioSaving", saving: true, error: null });
      try {
        if (studio.version === null) {
          await request("workflow.create", { spec });
          if (studio.queue) await request("queue.update", { name: studio.queue, patch: { workflow: spec.name } });
        } else {
          const { name: _name, ...patch } = spec;
          await request("workflow.update", { name: spec.name, patch });
        }
        const records = await request<Array<Record<string, unknown>>>("workflow.list", {});
        const rows = records.map(workflowRow);
        local.set({ items: rows });
        const saved = rows.find((row) => row.name === spec.name);
        store.dispatch({ type: "workflowStudioSaved", document: saved ? normalizeWorkflowGraph(WorkflowSpecSchema.parse(saved.spec)) : studio.draft, version: saved?.version });
      } catch (err) {
        store.dispatch({ type: "workflowStudioSaving", saving: false, error: errMessage(err) });
        throw err;
      }
    },

    /** Destructive — only ever reached through the ConfirmCard gate. */
    deleteWorkflow: (name: string): Promise<void> =>
      guarded(async () => {
        await request("workflow.delete", { name });
        local.set({ confirmDelete: null });
        await loadWorkflows();
      }),
  };
}

// The app-side singleton: bound lazily by the first caller with the deps IT
// imports — this module itself stays free of bridge/store imports for tests.
let singleton: WorkflowsCommands | null = null;
export function getWorkflowsCommands(store: UiStore, request: RequestFn): WorkflowsCommands {
  if (!singleton) singleton = createWorkflowsCommands(workflowsLocal, store, request);
  return singleton;
}
