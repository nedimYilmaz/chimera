// ROLES-TAB S5 (docs/superpowers/specs/2026-07-28-roles-tab.md), rewritten by
// ROLES-UNIFY S5 (docs/superpowers/specs/2026-07-28-roles-unify.md §8 S5/§6.4):
// command wrappers for the Roles tab, structured like commands.coord.ts (pure
// factory over injected store + request — no ../rpc/bridge import, so this is
// unit-testable against a plain createStore + stub request). Unified-library
// CRUD (role.*) plus the team-binding edit path (§5, now the atomic
// team.updateRoleBinding RPC — no client-side RMW) and attach/detach (§4).
import type { UiStore } from "@chimera/ui-state";
import { buildRemoveTeamRolePatch } from "@chimera/ui-state";
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

export type RolesCommands = ReturnType<typeof createRolesCommands>;

export function createRolesCommands(store: UiStore, request: RequestFn) {
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  /** §6: role.list is newer than team.* — an older daemon degrades the
   * session section to "available: false" (an upgrade-daemon notice, S5's
   * job) instead of erroring, same tryPhase2 shape commands.coord.ts uses. */
  const loadRoles = async (): Promise<void> => {
    try {
      const items = await request<Array<Record<string, unknown>>>("role.list", {});
      store.dispatch({ type: "roles", available: true, items });
    } catch (err) {
      if (isUnknownMethod(err)) store.dispatch({ type: "roles", available: false, items: [] });
      // other errors: transient — keep the previous pane contents
    }
  };

  return {
    loadRoles,

    /** role.create — REJECTS on failure (RoleFormCard's inline error). */
    createRole: async (spec: Record<string, unknown>): Promise<void> => {
      await request("role.create", { spec });
      await loadRoles();
    },

    /** role.update — REJECTS on failure (RoleFormCard inline error), AND
     * dispatches commandError so the refusal also surfaces as a toast (same
     * dual-channel precedent as commands.coord's updateTeam). */
    updateRole: async (name: string, patch: Record<string, unknown>): Promise<void> => {
      try {
        await request("role.update", { name, patch });
        await loadRoles();
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        throw err;
      }
    },

    /** §2: builtin "delete" is really an immediate reset-to-pristine (never a
     * true delete — RoleStore reseeds any missing builtin at restart anyway;
     * doing it via role.update is honest and doesn't need a restart). */
    resetBuiltinRole: (name: string, builtinPatch: Record<string, unknown>): Promise<void> =>
      guarded(async () => {
        await request("role.update", { name, patch: builtinPatch });
        await loadRoles();
      }),

    /** Destructive — only ever reached through the ConfirmCard gate. Refused
     * server-side while attached to any team (§4); the refusal surfaces via
     * commandError so it's visible even though this action is fire-and-forget
     * from a confirm card. */
    deleteRole: (name: string): Promise<void> =>
      guarded(async () => {
        await request("role.delete", { name });
        await loadRoles();
      }),

    /** §4: team.attachRole — REJECTS on failure (attach form inline error). */
    attachRole: async (params: { team: string; role: string; as?: string; cwd?: string }): Promise<void> => {
      await request("team.attachRole", params);
    },

    /** ROLES-UNIFY §5/§6.4: the binding-override edit path — a direct call to the
     * atomic, server-side-RMW `team.updateRoleBinding` RPC. No client-side
     * fetch-then-rebase dance (the old buildTeamRoleEditPatch/team.update RMW
     * this replaces): the daemon touches only `roleKey` against whatever the
     * CURRENT record is at the moment the request lands, so a sibling role
     * edited concurrently can never be clobbered by a stale client-side spread.
     * REJECTS on failure (the override editor's inline error), mirroring
     * updateRole's dual-channel refusal shape. */
    updateTeamRole: async (team: string, roleKey: string, overrides: Record<string, unknown>): Promise<void> => {
      try {
        await request("team.updateRoleBinding", { team, roleKey, overrides });
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        throw err;
      }
    },

    /** §3's explicit-removal path — never constructed by omission. Destructive
     * (drops the role from the team) — reached through ConfirmCard. */
    removeTeamRole: (team: string, roleKey: string): Promise<void> =>
      guarded(async () => {
        const fresh = await request<{ spec: Record<string, unknown> }>("team.status", { name: team });
        const patch = buildRemoveTeamRolePatch(fresh.spec, roleKey);
        await request("team.update", { name: team, patch });
      }),
  };
}

let singleton: RolesCommands | null = null;
export function getRolesCommands(store: UiStore, request: RequestFn): RolesCommands {
  if (!singleton) singleton = createRolesCommands(store, request);
  return singleton;
}
