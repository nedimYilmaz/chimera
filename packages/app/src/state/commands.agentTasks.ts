// W20 (AgentList workflow-step indicator) — pulls EVERY queue's task list so
// an arbitrary agent's CURRENT task (and its workflow binding) can be
// resolved regardless of which screen is open: QueuesScreen's own
// queueDetail only ever holds the ONE drilled-into queue, which isn't enough
// for a left-pane row that has to work for every agent at once. Mirrors
// commands.workflows.ts's module-local-store pattern — a tiny screen-
// agnostic store, refreshed on tab mount + coordination events
// (selectors.coord.latestCoordSeq) by the caller, no polling timers here.
import { useSyncExternalStore } from "react";
import type { RequestFn } from "./commands.coord";
import { singleFlight } from "./singleFlight";

export type AgentTasksLocalState = { tasks: Array<Record<string, unknown>> };

const initialLocal: AgentTasksLocalState = { tasks: [] };

export type AgentTasksLocalStore = {
  getState(): AgentTasksLocalState;
  set(patch: Partial<AgentTasksLocalState>): void;
  subscribe(fn: () => void): () => void;
};

export function createAgentTasksLocal(): AgentTasksLocalStore {
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

/** The ONE app-wide W20 local store (module singleton — pure, no IO). */
export const agentTasksLocal: AgentTasksLocalStore = createAgentTasksLocal();

/** React binding — same selector discipline as useStore/useWorkflowsLocal. */
export function useAgentTasksLocal<T>(selector: (s: AgentTasksLocalState) => T): T {
  return useSyncExternalStore(agentTasksLocal.subscribe, () => selector(agentTasksLocal.getState()));
}

export type AgentTasksCommands = ReturnType<typeof createAgentTasksCommands>;

export function createAgentTasksCommands(local: AgentTasksLocalStore, request: RequestFn) {
  /** queue.list -> queue.status per queue, flattened into ONE tasks array —
   * the only way to resolve an arbitrary agent's current task without
   * knowing its queue up front. Deliberately silent on failure (a daemon
   * with Phase-2 coordination disabled, or a transient RPC hiccup, just
   * leaves the previous snapshot — or the initial empty one — in place; this
   * is a best-effort augmentation of the always-visible AgentList, not worth
   * a commandError toast). A single queue's status failing doesn't blank the
   * others (per-item catch, not one that fails the whole Promise.all). */
  const loadAgentTasks = singleFlight(async (): Promise<void> => {
    try {
      const queues = await request<Array<Record<string, unknown>>>("queue.list", {});
      const statuses = await Promise.all(
        queues.map((q) =>
          request<{ tasks: Array<Record<string, unknown>> }>("queue.status", { queue: q["name"] })
            .catch((): { tasks: Array<Record<string, unknown>> } => ({ tasks: [] })),
        ),
      );
      local.set({ tasks: statuses.flatMap((s) => s.tasks) });
    } catch {
      // queue.list itself failed (unknown method / transient) — leave `tasks` as-is.
    }
  });

  return { loadAgentTasks, refresh: loadAgentTasks };
}

// The app-side singleton: bound lazily by the first caller with the deps IT
// imports — this module itself stays free of bridge imports for tests.
let singleton: AgentTasksCommands | null = null;
export function getAgentTasksCommands(request: RequestFn): AgentTasksCommands {
  if (!singleton) singleton = createAgentTasksCommands(agentTasksLocal, request);
  return singleton;
}
