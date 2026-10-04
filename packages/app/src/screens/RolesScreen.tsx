import { useEffect, useMemo, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { attachedTeamNames, builtinDiff, overriddenFieldsOf, overridesOf, resolvedRoleBindingSpec, ROLE_SPEC_PATCH_FIELDS, sessionRoleUsage, teamRoleUsage } from "@chimera/ui-state";
import { BUILTIN_ROLES } from "@chimera/protocol";
import { onRowKeyDown } from "../a11y";
import { displayChord, registerActionHandler } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getRolesCommands } from "../state/commands.roles";
import { getCoordCommands } from "../state/commands.coord";
import { composerLocal } from "../state/commands.agents";
import { CONFIRMS } from "../copy";
import { isDiscoveredRole, latestCoordSeq, newestFirst, roleConfig, str } from "../state/selectors.coord";
import { RoleFormCard, roleFormValuesFromSpec, type RoleFormValues } from "../components/RoleFormCard";
import { RoleBindingOverrideEditor } from "../components/RoleBindingOverrideEditor";
import { ConfirmCard } from "../components/ConfirmCard";
import { ActionChipRow } from "../components/ActionChipRow";
import { Panel, PanelFooter } from "../components/Panel";
import styles from "./RolesScreen.module.css";
import { usePaneRow } from "../components/PaneDivider";

// ROLES-TAB S5 (docs/superpowers/specs/2026-07-28-roles-tab.md), rewritten by
// ROLES-UNIFY S5 (docs/superpowers/specs/2026-07-28-roles-unify.md §6.1): the
// app tab connecting the ONE unified role library (role.*) and team bindings
// (team.update's `roles` record, now `{role, overrides}` pairs — §3.1) to one
// master list / detail pane. The library and per-team bindings are two
// sections under ONE cursor (roleCursor), unchanged from ROLES-TAB §1 — what
// changed is that "team roles" are no longer materialized copies, they are
// references into the SAME flat library section above.

const roles = getRolesCommands(appStore, rpcCall);
const coord = getCoordCommands(appStore, rpcCall);
const BUILTIN_NAMES = new Set(BUILTIN_ROLES.map((b) => b.name));
const builtinByName = new Map(BUILTIN_ROLES.map((b) => [b.name, b as unknown as Record<string, unknown>]));

type Row =
  | { kind: "library"; name: string; spec: Record<string, unknown> }
  | { kind: "team"; team: string; roleKey: string; binding: Record<string, unknown>; teamSpec: Record<string, unknown> };

function rowKey(r: Row): string {
  return r.kind === "library" ? `s:${r.name}` : `t:${r.team}:${r.roleKey}`;
}

export function RolesScreen() {
  // PANE-RESIZE: the row carries the width and is the drag ceiling.
  const pane = usePaneRow("roles");
  const rolesState = useStore((s: UiState) => s.roles);
  const teams = useStore((s: UiState) => s.teams);
  const agents = useStore((s: UiState) => s.agents);
  const roleCursor = useStore((s: UiState) => s.roleCursor);
  const mode = useStore((s: UiState) => s.mode);
  const confirm = useStore((s: UiState) => s.confirm);
  const coordSeq = useStore((s: UiState) => latestCoordSeq(s.events));

  const [formTarget, setFormTarget] = useState<{ kind: "createSession" | "editSession" | "cloneSession"; name?: string } | null>(null);
  const [attachTeam, setAttachTeam] = useState<string | null>(null);
  const [attachRoleName, setAttachRoleName] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);

  // tab entry: this screen needs BOTH role.list (the unified library) and
  // team.list (team bindings) — unlike TeamsScreen, no other always-mounted
  // owner guarantees teams.items is populated before this tab is ever opened.
  useEffect(() => { void roles.loadRoles(); void coord.loadTeams(); }, []);
  useEffect(() => { if (coordSeq > 0) void coord.loadTeams(); }, [coordSeq]);

  const sortedTeams = useMemo(() => newestFirst(teams.items), [teams.items]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const spec of rolesState.items) out.push({ kind: "library", name: str(spec["name"]), spec });
    for (const teamSpec of sortedTeams) {
      const roleRecord = teamSpec["roles"] && typeof teamSpec["roles"] === "object" ? (teamSpec["roles"] as Record<string, unknown>) : {};
      for (const roleKey of Object.keys(roleRecord)) {
        out.push({ kind: "team", team: str(teamSpec["name"]), roleKey, binding: roleRecord[roleKey] as Record<string, unknown>, teamSpec });
      }
    }
    return out;
  }, [rolesState.items, sortedTeams]);

  // clamp the cursor against the current row count, same pattern TeamsScreen
  // uses for its search-narrowed list.
  useEffect(() => {
    const n = rows.length;
    const cur = appStore.getState().roleCursor;
    if (n > 0 && cur >= n) appStore.dispatch({ type: "roleCursor", delta: n - 1 - cur });
  }, [rows.length]);

  const selected = rows[roleCursor] ?? null;

  useEffect(() => {
    const disposers = [
      registerActionHandler("roles.up", () => move(-1)),
      registerActionHandler("roles.down", () => move(1)),
      registerActionHandler("roles.new", () => { setFormTarget({ kind: "createSession" }); appStore.dispatch({ type: "setMode", mode: "roleForm" }); }),
      registerActionHandler("roles.edit", () => requestEdit()),
      registerActionHandler("roles.delete", () => requestDelete()),
    ];
    return () => { for (const d of disposers) d(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read live state via appStore.getState()
  }, []);

  function move(delta: number): void {
    const n = rows.length;
    const cur = appStore.getState().roleCursor;
    const next = n === 0 ? 0 : Math.max(0, Math.min(n - 1, cur + delta));
    if (next !== cur) appStore.dispatch({ type: "roleCursor", delta: next - cur });
  }

  function closeForm(): void {
    setFormTarget(null);
    appStore.dispatch({ type: "setMode", mode: "normal" });
  }

  function requestEdit(): void {
    const row = rows[appStore.getState().roleCursor];
    if (!row || row.kind !== "library") return; // team-binding edit is inline in the detail pane
    setFormTarget({ kind: "editSession", name: row.name });
    appStore.dispatch({ type: "setMode", mode: "roleForm" });
  }

  function requestDelete(): void {
    const row = rows[appStore.getState().roleCursor];
    if (!row || row.kind !== "library") return;
    const kind = BUILTIN_NAMES.has(row.name) ? "resetBuiltinRole" : "deleteSessionRole";
    appStore.dispatch({ type: "confirm", confirm: { kind, name: row.name } });
  }

  function submitAttach(): void {
    if (!attachTeam) return;
    if (!attachRoleName.trim()) { setAttachError("pick a library role"); return; }
    void roles.attachRole({ team: attachTeam, role: attachRoleName.trim() })
      .then(() => { setAttachTeam(null); setAttachRoleName(""); setAttachError(null); void roles.loadRoles(); void coord.loadTeams(); })
      .catch((err: unknown) => setAttachError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div data-screen-layout="split" className={styles.row} {...pane.rowProps}>
      <Panel label={<>roles <span className={styles.countMeta}>({rows.length})</span></>} className={styles.master}>
        {!rolesState.available ? (
          <div className={styles.emptyHint}>the role library requires a Phase 2 daemon — team roles below still work</div>
        ) : null}
        <div className={styles.sectionHead}>role library</div>
        {rolesState.available && rolesState.items.length === 0 && (
          <div className={styles.emptyHint}>no roles — {displayChord("mod+o")} creates one</div>
        )}
        {rows.map((r, i) => {
          if (r.kind === "library") {
            const usage = sessionRoleUsage(agents, r.name);
            const boundTo = attachedTeamNames(teams.items, r.name);
            const builtin = BUILTIN_NAMES.has(r.name);
            const bref = builtinByName.get(r.name);
            const edited = builtin && bref ? builtinDiff(r.spec, bref) : false;
            return (
              <div
                key={rowKey(r)}
                className={i === roleCursor ? styles.rowSelected : styles.rowItem}
                onClick={() => appStore.dispatch({ type: "roleCursor", delta: i - roleCursor })}
                onKeyDown={onRowKeyDown(() => appStore.dispatch({ type: "roleCursor", delta: i - roleCursor }))}
                role="button" tabIndex={0} data-role-row={r.name}
              >
                <div className={styles.colName}>
                  <span>{r.name}</span>
                  {builtin && <span className={styles.badge}>{edited ? "builtin · edited" : "builtin"}</span>}
                  {boundTo.length > 0 && <span className={styles.badge}>bound ×{boundTo.length}</span>}
                </div>
                <div className={`${styles.colUsage} ${styles.mutedCell}`}>{usage.liveCount > 0 ? `◐ ${usage.liveCount}` : "idle"}</div>
              </div>
            );
          }
          return null;
        })}
        <div className={styles.sectionHead}>team roles</div>
        {sortedTeams.length === 0 && <div className={styles.emptyHint}>no teams yet</div>}
        {sortedTeams.map((teamSpec) => {
          const teamName = str(teamSpec["name"]);
          const roleRecord = teamSpec["roles"] && typeof teamSpec["roles"] === "object" ? (teamSpec["roles"] as Record<string, unknown>) : {};
          return (
            <div key={teamName}>
              <div className={styles.teamHead}>
                <span>{teamName}</span>
                <span className={styles.attachChip} onClick={() => { setAttachTeam(teamName); setAttachError(null); }} data-attach-role={teamName}>+ attach</span>
              </div>
              {Object.keys(roleRecord).map((roleKey) => {
                const i = rows.findIndex((r) => r.kind === "team" && r.team === teamName && r.roleKey === roleKey);
                const usage = teamRoleUsage(agents, teamName, roleKey);
                const discovered = isDiscoveredRole(teamSpec, roleKey);
                const binding = roleRecord[roleKey] as Record<string, unknown>;
                // ROLES-UNIFY §6.1: the real per-field diff replacing the old opaque
                // "shared: <name>" badge — a binding's `overrides` keys ARE, by
                // construction, exactly the fields this slot pins vs the library role.
                const overriddenFields = overriddenFieldsOf(binding);
                return (
                  <div
                    key={roleKey}
                    className={i === roleCursor ? styles.rowSelected : styles.rowItem}
                    onClick={() => appStore.dispatch({ type: "roleCursor", delta: i - roleCursor })}
                    onKeyDown={onRowKeyDown(() => appStore.dispatch({ type: "roleCursor", delta: i - roleCursor }))}
                    role="button" tabIndex={0} data-role-row={`${teamName}/${roleKey}`}
                  >
                    <div className={styles.colName}>
                      <span className={styles.indent}>{roleKey}</span>
                      {discovered && <span className={styles.badge}>from .claude</span>}
                      <span className={styles.badge}>→ {str(binding["role"])}</span>
                      {overriddenFields.length > 0 ? (
                        <span className={styles.badgeOverride} data-overridden-fields={overriddenFields.join(",")}>
                          overrides: {overriddenFields.join(", ")}
                        </span>
                      ) : (
                        <span className={styles.badge}>inherits all</span>
                      )}
                    </div>
                    <div className={`${styles.colUsage} ${styles.mutedCell}`}>{usage.liveCount > 0 ? `◐ ${usage.liveCount}` : "idle"}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div className={styles.filler} />
        <PanelFooter>
          <div className={styles.footerRow}>
            <span>↑↓ select</span>
            <ActionChipRow
              chips={[
                { key: displayChord("mod+o"), label: "new role", onClick: () => { setFormTarget({ kind: "createSession" }); appStore.dispatch({ type: "setMode", mode: "roleForm" }); } },
                { key: displayChord("mod+e"), label: "edit", onClick: requestEdit, disabled: selected?.kind !== "library" },
                { key: displayChord("mod+shift+x"), label: "delete", danger: true, onClick: requestDelete, disabled: selected?.kind !== "library" },
              ]}
            />
          </div>
        </PanelFooter>
      </Panel>

      {/* PANE-RESIZE: the seam, in place of the gap. */}
      {pane.divider}
      <Panel label={selected ? (selected.kind === "library" ? `role · ${selected.name}` : `role · ${selected.team}/${selected.roleKey}`) : "role"} className={styles.detail}>
        {selected === null ? (
          <div className={styles.emptyPane}>
            <div className={styles.emptyGlyph}>◆</div>
            <div className={styles.emptyHint}>no role selected</div>
          </div>
        ) : selected.kind === "library" ? (
          <LibraryRoleDetail
            row={selected}
            liveCount={sessionRoleUsage(agents, selected.name).liveCount}
            liveAgents={sessionRoleUsage(agents, selected.name).liveAgents}
            boundTo={attachedTeamNames(teams.items, selected.name)}
            onClone={() => { setFormTarget({ kind: "cloneSession", name: selected.name }); appStore.dispatch({ type: "setMode", mode: "roleForm" }); }}
          />
        ) : (
          <TeamRoleDetail
            row={selected}
            library={rolesState.items}
            liveCount={teamRoleUsage(agents, selected.team, selected.roleKey).liveCount}
            liveAgents={teamRoleUsage(agents, selected.team, selected.roleKey).liveAgents}
            discovered={isDiscoveredRole(selected.teamSpec, selected.roleKey)}
          />
        )}

        {mode === "roleForm" && formTarget?.kind === "createSession" && (
          <RoleFormCard onSubmit={(spec) => roles.createRole(spec)} onClose={closeForm} />
        )}
        {mode === "roleForm" && formTarget?.kind === "cloneSession" && formTarget.name && (() => {
          const src = rolesState.items.find((it) => it["name"] === formTarget.name);
          const initial: RoleFormValues | undefined = src ? { ...roleFormValuesFromSpec(src), name: "" } : undefined;
          return <RoleFormCard initial={initial} onSubmit={(spec) => roles.createRole(spec)} onClose={closeForm} />;
        })()}
        {mode === "roleForm" && formTarget?.kind === "editSession" && formTarget.name && (() => {
          const src = rolesState.items.find((it) => it["name"] === formTarget.name);
          if (!src) return null;
          const liveCount = sessionRoleUsage(agents, formTarget.name).liveCount;
          return (
            <RoleFormCard
              mode="edit"
              initial={roleFormValuesFromSpec(src)}
              liveCount={liveCount}
              onSubmit={(spec) => {
                const { name: _n, ...patch } = spec;
                return roles.updateRole(formTarget.name!, patch);
              }}
              onClose={closeForm}
            />
          );
        })()}

        {confirm?.kind === "deleteSessionRole" && (
          <ConfirmCard
            title="⚠ delete role" meta={confirm.name}
            body={CONFIRMS.deleteSessionRole(confirm.name).body}
            note={CONFIRMS.deleteSessionRole(confirm.name).note}
            confirmLabel="confirm delete"
            onConfirm={() => { const name = confirm.name; appStore.dispatch({ type: "confirm", confirm: null }); void roles.deleteRole(name); }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {confirm?.kind === "resetBuiltinRole" && (
          <ConfirmCard
            title="⚠ reset to default" meta={confirm.name}
            body={CONFIRMS.resetBuiltinRole(confirm.name).body}
            note={CONFIRMS.resetBuiltinRole(confirm.name).note}
            confirmLabel="confirm reset"
            onConfirm={() => {
              const name = confirm.name;
              appStore.dispatch({ type: "confirm", confirm: null });
              const b = builtinByName.get(name);
              // Full honest reset — every ROLE_SPEC_PATCH_FIELDS key, not just
              // the old 6-field subset — else a customization to a widened
              // field (effort/persistent/orchestration/...) would survive a
              // "reset to pristine" and silently keep polluting the builtin.
              if (b) void roles.resetBuiltinRole(name, Object.fromEntries(ROLE_SPEC_PATCH_FIELDS.map((k) => [k, b[k]])));
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        {confirm?.kind === "removeTeamRole" && (
          <ConfirmCard
            title="⚠ remove team role" meta={`${confirm.team}/${confirm.role}`}
            body={CONFIRMS.removeTeamRole(confirm.team, confirm.role).body}
            note={CONFIRMS.removeTeamRole(confirm.team, confirm.role).note}
            confirmLabel="confirm remove"
            onConfirm={() => { const { team, role } = confirm; appStore.dispatch({ type: "confirm", confirm: null }); void roles.removeTeamRole(team, role).then(() => coord.loadTeams()); }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}

        {attachTeam !== null && (
          <div className={styles.attachOverlay} data-attach-form>
            <div className={styles.attachCard}>
              <div className={styles.attachTitle}>attach a library role to {attachTeam}</div>
              <select className={styles.attachSelect} value={attachRoleName} onChange={(e) => setAttachRoleName(e.target.value)} data-attach-select>
                <option value="">(pick a role)</option>
                {rolesState.items.map((it) => <option key={str(it["name"])} value={str(it["name"])}>{str(it["name"])}</option>)}
              </select>
              {attachError && <div className={styles.attachError}>{attachError}</div>}
              <div className={styles.attachFooter}>
                <span className={styles.submitChip} onClick={submitAttach} data-attach-submit>attach</span>
                <span className={styles.cancelChip} onClick={() => { setAttachTeam(null); setAttachError(null); }}>cancel</span>
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function LibraryRoleDetail({ row, liveCount, liveAgents, boundTo, onClone }: {
  row: Extract<Row, { kind: "library" }>;
  liveCount: number;
  liveAgents: Array<{ agentId: string; state: string }>;
  boundTo: string[];
  onClone: () => void;
}) {
  const cfg = roleConfig(row.spec);
  const builtin = BUILTIN_NAMES.has(row.name);
  return (
    <div className={styles.detailBody}>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{row.name}</span>
          {builtin && <span className={styles.badge}>builtin</span>}
        </div>
        <div className={styles.chipRow}>
          {cfg.model !== null && <span className={styles.chip}>{cfg.model}</span>}
          {cfg.permissionProfile !== null && <span className={styles.chip}>{cfg.permissionProfile}</span>}
          <span className={styles.chip}>{liveCount} running</span>
        </div>
        <div className={styles.honesty}>a role is a spawn template — editing it changes future spawns only; {liveCount} running agent{liveCount === 1 ? "" : "s"} keep{liveCount === 1 ? "s" : ""} the current spec.</div>
        {cfg.instructions !== null && <div className={styles.rolePrompt}>{cfg.instructions}</div>}
        <div className={styles.actionRow}>
          <span
            className={styles.spawnChip}
            // Tab switch MUST dispatch first: installAppOverlayLifecycle's
            // check() runs synchronously off the appStore subscription and
            // dismisses composerLocal's spawnOpen on any tab change (S5's own
            // bug -- setting spawnOpen before the dispatch got it clobbered
            // in the same tick, so the card never actually opened).
            onClick={() => { appStore.dispatch({ type: "selectTab", tab: "agents" }); composerLocal.set({ spawnOpen: true, spawnPrefillRole: row.name }); }}
            data-spawn-with-role
          >
            spawn session with this role
          </span>
          <span className={styles.spawnChip} onClick={onClone} data-clone-role>clone</span>
        </div>
      </div>
      <div className={styles.usesSection}>
        <div className={styles.usesHead}>bound in {boundTo.length} team{boundTo.length === 1 ? "" : "s"}: {boundTo.join(", ") || "—"}</div>
        {liveAgents.length > 0 && (
          <div className={styles.usesHead}>live agents: {liveAgents.map((a) => `${a.agentId.slice(0, 6)} (${a.state})`).join(", ")}</div>
        )}
      </div>
    </div>
  );
}

function TeamRoleDetail({ row, library, liveCount, liveAgents, discovered }: {
  row: Extract<Row, { kind: "team" }>;
  library: ReadonlyArray<Record<string, unknown>>;
  liveCount: number;
  liveAgents: Array<{ agentId: string; state: string }>;
  discovered: boolean;
}) {
  const librarySpec = library.find((r) => r["name"] === row.binding["role"]);
  const resolved = resolvedRoleBindingSpec(row.binding, library);
  const cfg = roleConfig(resolved);
  const overrides = overridesOf(row.binding);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [row.team, row.roleKey]);

  return (
    <div className={styles.detailBody}>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{row.team}/{row.roleKey}</span>
          {discovered && <span className={styles.badge}>from .claude</span>}
        </div>
        <div className={styles.chipRow}>
          <span className={styles.chip}>→ {str(row.binding["role"])}</span>
          {cfg.model !== null && <span className={styles.chip}>{cfg.model}</span>}
          {cfg.permissionProfile !== null && <span className={styles.chip}>{cfg.permissionProfile}</span>}
          <span className={styles.chip}>{liveCount} running</span>
        </div>
        <div className={styles.honesty}>a role binding is a spawn template — editing its overrides changes future spawns only; {liveCount} running agent{liveCount === 1 ? "" : "s"} keep{liveCount === 1 ? "s" : ""} the current spec.</div>
        {/* ROLES-UNIFY §6.3: the binding-override editor — every field shows the
            library value (grey, inherited) or the pinned override (highlighted),
            editable AT ANY TIME. discovered rows stay read-only (regenerated by
            project sync — an edit here would just be clobbered next sync). */}
        <RoleBindingOverrideEditor
          key={`${row.team}/${row.roleKey}`}
          librarySpec={librarySpec}
          overrides={overrides}
          readOnly={discovered}
          onSave={(next) =>
            getRolesCommands(appStore, rpcCall).updateTeamRole(row.team, row.roleKey, next)
              .then(() => getCoordCommands(appStore, rpcCall).loadTeams())
              .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); throw err; })
          }
        />
        {error && <div className={styles.attachError}>{error}</div>}
        {!discovered && (
          <div className={styles.actionRow}>
            <span className={styles.dangerChip} onClick={() => appStore.dispatch({ type: "confirm", confirm: { kind: "removeTeamRole", team: row.team, role: row.roleKey } })} data-team-role-remove>remove</span>
          </div>
        )}
      </div>
      {liveAgents.length > 0 && (
        <div className={styles.usesSection}>
          <div className={styles.usesHead}>live agents: {liveAgents.map((a) => `${a.agentId.slice(0, 6)} (${a.state})`).join(", ")}</div>
        </div>
      )}
    </div>
  );
}
