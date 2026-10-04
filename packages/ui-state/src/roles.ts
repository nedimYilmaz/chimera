// ROLES-UNIFY S4 (docs/superpowers/specs/2026-07-28-roles-unify.md §8 S4/§6.4), extending
// ROLES-TAB S4's original slice: pure selectors + patch builders for the unified role
// library's shared state. No screen lives here (S5/S7) -- just the usage join, the
// binding-usage scan, the sparse override-patch builders, and the builtin-edited diff.
// Protocol-only dependency (this package's hard rule) -- every input here is a plain
// object/AgentView, never a live RPC call.
import type { AgentView } from "./types.js";

export type RoleUsageAgent = { agentId: string; state: string };
export type RoleUsage = { liveAgents: RoleUsageAgent[]; liveCount: number };

const LIVE_STATES = new Set(["running", "paused"]);

function usageFrom(agents: Record<string, AgentView>, matches: (a: AgentView) => boolean): RoleUsage {
  const liveAgents: RoleUsageAgent[] = [];
  for (const a of Object.values(agents)) {
    if (matches(a)) liveAgents.push({ agentId: a.agentId, state: a.state });
  }
  return { liveAgents, liveCount: liveAgents.filter((a) => LIVE_STATES.has(a.state)).length };
}

/** Team-role usage half of the join (§1 "Uses" section, live-agents part): agents
 * whose `membership` (already folded onto AgentView by TEAMGROUP) matches
 * {team, role}. Works today -- no S1 dependency. */
export function teamRoleUsage(agents: Record<string, AgentView>, team: string, role: string): RoleUsage {
  return usageFrom(agents, (a) => a.membership?.team === team && a.membership?.role === role);
}

/** Session-role usage half of the join: agents whose `sessionRole` (G1/S1's stamp)
 * matches `name`. DEGRADES CLEANLY when `sessionRole` is absent everywhere -- an
 * older daemon build or S1 not yet landed simply yields no live agents, never a
 * throw (every AgentView.sessionRole read here is optional-chained). */
export function sessionRoleUsage(agents: Record<string, AgentView>, name: string): RoleUsage {
  return usageFrom(agents, (a) => a.sessionRole === name);
}

/** A role's visible config (Teams detail's per-role expand section / TUI's role-render
 * line): model / permissionProfile / isolation / maxTurns / turnLimitPolicy + the raw
 * instructions text — read defensively since a role entry is just whatever the daemon's
 * RoleTemplateSchema stamped over the wire. ROLES-BINDING-CORRECTNESS: hoisted out of the
 * app's selectors.coord.ts and the TUI's coord.ts, which had kept byte-identical copies —
 * one shared implementation instead of two that can drift. Takes a FLAT spec object (a
 * library RoleSpec, or a team binding already resolved via resolvedRoleBindingSpec below)
 * — never a raw `{role, overrides}` binding, whose fields live under `overrides`. */
export type RoleConfig = {
  model: string | null;
  permissionProfile: string | null;
  isolation: string | null;
  maxTurns: number | null;
  turnLimitPolicy: string | null;
  instructions: string | null;
};

export function roleConfig(role: Record<string, unknown> | undefined): RoleConfig {
  return {
    model: typeof role?.["model"] === "string" ? (role["model"] as string) : null,
    permissionProfile: typeof role?.["permissionProfile"] === "string" ? (role["permissionProfile"] as string) : null,
    isolation: typeof role?.["isolation"] === "string" ? (role["isolation"] as string) : null,
    maxTurns: typeof role?.["maxTurns"] === "number" && Number.isFinite(role["maxTurns"]) ? (role["maxTurns"] as number) : null,
    turnLimitPolicy: typeof role?.["turnLimitPolicy"] === "string" ? (role["turnLimitPolicy"] as string) : null,
    instructions: typeof role?.["instructions"] === "string" && (role["instructions"] as string).length > 0 ? (role["instructions"] as string) : null,
  };
}

/** A team binding's overrides record, defensively read (a loose wire object) — ROLES-UNIFY
 * §3.1's `{role, overrides}` shape. Hoisted from the app's RolesScreen.tsx (the one place
 * that got this right after ROLES-UNIFY) so every call site — including the ones that were
 * still reading the RAW binding's top-level fields (BUG: roleConfig(binding) instead of
 * roleConfig(resolvedRoleBindingSpec(binding, library))) — shares one implementation. */
export function overridesOf(binding: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const o = binding?.["overrides"];
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
}

/** The binding's resolved display spec — library defaults with the binding's own overrides
 * spread on top, mirroring resolveRole's merge order (core S2/§4) closely enough for a UI
 * summary. Not used for anything actuating — team.updateRoleBinding always carries the
 * operator's OWN edited overrides, never this computed merge. Falls back to the raw
 * binding's overrides alone when the referenced library role is missing from `library`
 * (deleted-but-still-bound edge case), so a summary line still reflects the pinned fields
 * rather than going blank. */
export function resolvedRoleBindingSpec(
  binding: Record<string, unknown> | undefined | null,
  library: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const roleName = binding?.["role"];
  const libSpec = typeof roleName === "string" ? library.find((r) => r["name"] === roleName) : undefined;
  return { ...(libSpec ?? {}), ...overridesOf(binding) };
}

/** Field names the binding PINS (as opposed to inherits from the library role) — a
 * binding's `overrides` keys ARE, by construction, exactly the fields it overrides. The
 * operator's "inherited vs pinned" mental model depends on this staying distinct from the
 * resolved values `roleConfig`/`resolvedRoleBindingSpec` show. */
export function overriddenFieldsOf(binding: Record<string, unknown> | undefined | null): string[] {
  return Object.keys(overridesOf(binding));
}

/** Team names a library role is bound in (ROLES-UNIFY §3.1 usage join). REWRITTEN off
 * `roles[key].role` bindings -- `TeamSpec.sharedRoles` is REMOVED (S1, one-way break,
 * operator-approved: "a binding's own `role` field is now the provenance -- a separate
 * marker list is redundant once every slot is a binding"). A team can bind the same
 * library role under multiple keys; it is still reported once. DEGRADES CLEANLY to []
 * when `roles` is absent/malformed (older daemon predating the migration, or a loose
 * fixture) -- never assumes structure. `teams` is the loose `UiState.teams.items` shape. */
export function attachedTeamNames(teams: ReadonlyArray<Record<string, unknown>>, roleName: string): string[] {
  const out: string[] = [];
  for (const t of teams) {
    const roles = t["roles"];
    const name = t["name"];
    if (!roles || typeof roles !== "object" || typeof name !== "string") continue;
    const bound = Object.values(roles as Record<string, unknown>).some(
      (binding) => !!binding && typeof binding === "object" && (binding as Record<string, unknown>)["role"] === roleName,
    );
    if (bound) out.push(name);
  }
  return out;
}

/** §3's explicit-removal path: RMW minus exactly the removed key. ROLES-UNIFY §6.4: this
 * is the ONE client-side RMW kept -- `team.update`'s `roles` patch still REPLACES the
 * whole record on the wire, so dropping a single binding still needs the freshest record
 * rebased at submit (the caller refetches team.status immediately before this) with
 * exactly the target key removed. The EDIT case no longer uses this pattern (see
 * `buildRoleBindingOverridePatch` below) -- it now goes through the atomic
 * `team.updateRoleBinding` RPC, which RMWs server-side against the current record and
 * needs no client rebase at all. Never constructed by omission-from-form -- only ever
 * called from the dedicated "remove this role" action, confirm-gated (ConfirmAction
 * "removeTeamRole"). `spec.roles[key]` is now a `RoleBinding` (`{role, overrides}`), but
 * this function is shape-agnostic -- it only ever touches the top-level key. */
export function buildRemoveTeamRolePatch(spec: Record<string, unknown>, roleKey: string): Record<string, unknown> {
  const roles = spec["roles"] && typeof spec["roles"] === "object" ? { ...(spec["roles"] as Record<string, unknown>) } : {};
  delete roles[roleKey];
  return { roles };
}

// ROLES-UNIFY §2/§5: the full RoleSpec field set minus `name` (the identifier) -- exactly
// RoleUpdateRequestSchema's patch fields (contract.ts ~189-234), which is itself the
// widened set now that team-role and session-role templates share one schema. Deliberately
// not `.partial()` server-side (zod's `.partial()` still fires each field's `.default()`
// for an absent key), so the client must emit ONLY changed keys or silently reintroduce a
// default. Keep this list in lockstep with that schema.
export const ROLE_SPEC_PATCH_FIELDS = [
  "cwd", "displayLabel", "account", "provider", "isolation", "workdirKey", "model", "effort",
  "instructions", "resultSchema", "permissionProfile", "autonomy", "acknowledgeCodexFullAccessRisk",
  "maxTurns", "turnLimitPolicy", "idleTimeoutMs", "maxTurnDurationMs", "inherit", "mcpServers",
  "mcpToolAllowlist", "strictMcpConfig", "plugins", "orchestration", "crossProviderFailover", "deliverTo",
  "deliverWake", "maxBudgetUsd", "conductor", "session", "persistent", "poolSize", "on",
  "providerOptions", "resume", "resumeOnly", "cause", "skills",
] as const;
export type RoleSpecPatchField = (typeof ROLE_SPEC_PATCH_FIELDS)[number];

function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Sparse patch of only the `RoleSpec` fields where `next` differs from `prev` -- never
 * `.partial()`'s "every key present" shape (see ROLE_SPEC_PATCH_FIELDS's own comment). An
 * unchanged key is OMITTED entirely (never sent back with its old value, never set to
 * `undefined`), so a later `JSON.stringify`/`Object.keys` on the result sees exactly the
 * changed keys and nothing else. Shared by both callers below -- they differ only in WHAT
 * `prev`/`next` represent, not in the sparseness rule itself. */
function sparseRoleSpecPatch(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ROLE_SPEC_PATCH_FIELDS) {
    if (!fieldsEqual(prev[key], next[key])) patch[key] = next[key];
  }
  return patch;
}

/** Sparse library-role edit patch, for `role.update`'s `patch` (§2/§5, widened to the full
 * unified `RoleSpec` field set -- was the old 6-field `SessionRoleSpecSchema` subset). */
export function buildSessionRolePatch(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return sparseRoleSpecPatch(prev, next);
}

/** NEW (ROLES-UNIFY §6.3/§6.4): the sparse builder feeding the binding-override editor --
 * `team.updateRoleBinding`'s `overrides` patch. `prev` is the binding's currently-resolved
 * value for each field (what the editor shows greyed-out as "inherited" -- the library
 * default when not yet overridden, or the existing override when it already is one);
 * `next` is the editor's edited form state, where a field toggled back to "inherited"
 * must already read back as `prev`'s value (the editor's job, not this function's) so it
 * naturally drops out of the patch. Getting this wrong silently converts "inherited from
 * the library role" into "pinned override" -- the exact hazard the operator's headline
 * requirement (§6.4/decision doc: "editing a library role propagates to bindings that did
 * not override that field") depends on this staying sparse. Same field set/technique as
 * `buildSessionRolePatch` -- reused deliberately, not reinvented, per §6.4's instruction. */
export function buildRoleBindingOverridePatch(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return sparseRoleSpecPatch(prev, next);
}

/** §2 builtin badge: true when `current`'s patchable fields differ from the pristine
 * `BUILTIN_ROLES` entry of the same name -- the "builtin · edited" badge condition. Widened
 * to the full `RoleSpec` field set alongside the patch builders above. */
export function builtinDiff(current: Record<string, unknown>, builtin: Record<string, unknown>): boolean {
  for (const key of ROLE_SPEC_PATCH_FIELDS) {
    if (!fieldsEqual(current[key], builtin[key])) return true;
  }
  return false;
}
