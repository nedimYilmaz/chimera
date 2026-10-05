// AGENT-GROUPS Phase 1: command wrappers for the group registry (group.*) and per-agent
// membership (agent.setGroups), structured exactly like commands.roles.ts (pure factory over
// injected store + request — no ../rpc/bridge import, unit-testable against a plain
// createStore + stub request), including its module-level memoized-singleton accessor.
import type { AgentGroup, AgentGroupColor } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import type { RequestFn } from "./commands.coord";

const isUnknownMethod = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === "protocol" && typeof message === "string" && /unknown method/.test(message);
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

export type GroupsCommands = ReturnType<typeof createGroupsCommands>;

export function createGroupsCommands(store: UiStore, request: RequestFn) {
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  let revision = 0;
  let epoch = 0;
  let pending = false;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // One request owns both mount/local-command loads and external invalidations. A newer
  // invalidation or disconnect discards the old reply; at most one follow-up is queued.
  const loadGroups = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    pending = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (pending && !disposed) {
        pending = false;
        const requestedRevision = revision, requestedEpoch = epoch;
        try {
          const res = await request<{ groups: AgentGroup[] }>("group.list", {});
          if (disposed || requestedRevision !== revision || requestedEpoch !== epoch) continue;
          const items = Array.isArray(res?.groups) ? res.groups : [];
          store.dispatch({ type: "groups", available: true, items });
          const active = store.getState().activeGroupId;
          if (active && !items.some(g => g.id === active)) store.dispatch({ type: "setActiveGroup", groupId: null });
        } catch (err) {
          if (!disposed && requestedRevision === revision && requestedEpoch === epoch && isUnknownMethod(err))
            store.dispatch({ type: "groups", available: false, items: [] });
          // Transient errors retain the prior catalog. Events/reconnect provide the next
          // refresh opportunity; no periodic retry loop runs while a pane is mounted.
        }
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const scheduleRefresh = (): void => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => { timer = null; void loadGroups(); }, 25);
  };
  let connected = store.getState().connected;
  let lastEvents = store.getState().events;
  let lastSeq = store.getState().lastSeq;
  const off = store.subscribe(() => {
    const state = store.getState();
    if (connected !== state.connected) {
      connected = state.connected;
      epoch++;
      if (connected) scheduleRefresh();
      else {
        pending = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      }
    }
    if (lastEvents !== state.events) {
      lastEvents = state.events;
      // The reducer appends deduped events to a bounded ring. Examine only the new
      // suffix, so unrelated agent output never scans the whole fleet or reloads groups.
      let changed = false;
      for (let i = state.events.length - 1; i >= 0; i--) {
        const event = state.events[i]!;
        if (event.seq <= lastSeq) break;
        if (event.kind === "group_registry_changed") changed = true;
      }
      lastSeq = state.lastSeq;
      if (changed) { revision++; scheduleRefresh(); }
    }
  });

  return {
    loadGroups,
    dispose: (): void => {
      disposed = true; epoch++; pending = false; off();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },

    /** group.create — REJECTS on failure (the create-box's inline error). */
    createGroup: async (name: string, color?: AgentGroupColor): Promise<void> => {
      await request("group.create", { name, ...(color ? { color } : {}) });
      await loadGroups();
    },

    renameGroup: (id: string, name: string): Promise<void> =>
      guarded(async () => {
        await request("group.update", { id, name });
        await loadGroups();
      }),

    setGroupColor: (id: string, color: AgentGroupColor): Promise<void> =>
      guarded(async () => {
        await request("group.update", { id, color });
        await loadGroups();
      }),

    /** Destructive — only ever reached through the ConfirmCard gate (mirrors deleteRole).
     * Never touches any agent record server-side (core/src/groups.ts's own contract) — a
     * member's row retains the existing raw-ID group box fallback until reassigned/cleared. */
    deleteGroup: (id: string): Promise<void> =>
      guarded(async () => {
        await request("group.delete", { id });
        if (store.getState().activeGroupId === id) store.dispatch({ type: "setActiveGroup", groupId: null });
        await loadGroups();
      }),

    /** agent.setGroups — replaces an agent's membership wholesale. One group per agent in
     * the Phase 1 UI (the multi-select gesture is deferred), so callers pass a single id or
     * null to clear. */
    setAgentGroup: async (agentId: string, groupId: string | null): Promise<boolean> => {
      try {
        await request("agent.setGroups", { agentId, groups: groupId ? [groupId] : [] });
        return true;
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        return false;
      }
    },

    /** Client-VIEW only (never a daemon RPC) — see UiState.activeGroupId's own doc comment. */
    setActiveGroup: (groupId: string | null): void => {
      store.dispatch({ type: "setActiveGroup", groupId });
    },
  };
}

let singleton: GroupsCommands | null = null;
export function getGroupsCommands(store: UiStore, request: RequestFn): GroupsCommands {
  if (!singleton) singleton = createGroupsCommands(store, request);
  return singleton;
}
