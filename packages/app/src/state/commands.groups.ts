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

  /** group.list is newer than every other list RPC here — an older daemon degrades to
   * "available: false" (mirrors loadRoles' own tryPhase2-style degradation) instead of
   * erroring the whole pane. */
  const loadGroups = async (): Promise<void> => {
    try {
      const res = await request<{ groups: AgentGroup[] }>("group.list", {});
      // Defensive: a stub/mock bridge (or a malformed response) can resolve without
      // rejecting at all — never trust `res.groups` is actually an array (mirrors this
      // package's own convention of never assuming wire-shaped data — see jobGroups.ts).
      const items = Array.isArray(res?.groups) ? res.groups : [];
      store.dispatch({ type: "groups", available: true, items });
    } catch (err) {
      if (isUnknownMethod(err)) store.dispatch({ type: "groups", available: false, items: [] });
      // other errors: transient — keep the previous pane contents
    }
  };

  return {
    loadGroups,

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
     * member's row simply resolves as ungrouped on its next projection. */
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
