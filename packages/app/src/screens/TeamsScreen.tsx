import { useEffect, useMemo, useRef, useState } from "react";
import { useTeamList } from "../state/useTeamList";
import { LoadStatusNote } from "../components/LoadStatusNote";
import type { UiState } from "@chimera/ui-state";
import { onRowKeyDown } from "../a11y";
import { displayChord, registerActionHandler } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getCoordCommands } from "../state/commands.coord";
import { getRolesCommands } from "../state/commands.roles";
import { RoleBindingOverrideEditor } from "../components/RoleBindingOverrideEditor";
import { CONFIRMS } from "../copy";
import { accountToneVar, fmtCost, ownerLabel, shortId, stateVisual, agentName } from "../state/selectors";
import {
  agentActivity,
  buildAddMemberPatch,
  isDiscoveredRole,
  latestCoordSeq,
  matchesTeamQuery,
  mergeTeamAgents,
  newestFirst,
  num,
  overriddenFieldsOf,
  resolvedRoleBindingSpec,
  roleConfig,
  str,
  taskForAgent,
  teamFormValuesFromSpec,
  teamListRow,
  teamMemberIds,
  validateAddMemberForm,
} from "../state/selectors.coord";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { AgentInspector } from "../components/AgentInspector";
import { Collapse } from "../components/Collapse";
import { TeamFormCard } from "../components/TeamFormCard";
import { ConfirmCard } from "../components/ConfirmCard";
import { ActionChipRow } from "../components/ActionChipRow";
import { SearchBox } from "../components/SearchBox";
import { toggleCollapsed, toggleIndex } from "../state/selectionToggle";
import { errorText } from "../state/errorText";
import styles from "./TeamsScreen.module.css";
import { usePaneRow } from "../components/PaneDivider";

// W5 — the Teams screen (mock s_teams, coverage B8): 430px master list
// (team/roles/running/queue) + detail pane (chips + roles line + agents table
// with the AgentInspector under the selected row). Data: team.list (running
// stamped by the engine) + team.status on drill + queue.status for the bound
// queue (task bindings for the inspector). Refresh: tab entry + relevant
// events (status/result) + after each mutation — no polling timers.
// Direct management (create/dissolve) is product-approved (coverage's ⚠ B8
// note: the earlier monitor-only decision is deliberately superseded).

const coord = getCoordCommands(appStore, rpcCall);
// ROLES-BINDING-CORRECTNESS: the role summary chips need the library to resolve a
// binding's `{role, overrides}` shape — RolesScreen already loads this on its own tab
// entry, but an operator who opens Teams first without ever visiting Roles would
// otherwise resolve against an empty library (still correct for overridden fields,
// but inherited ones would read as unset instead of their real value).
const rolesCommands = getRolesCommands(appStore, rpcCall);

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
};

export function TeamsScreen() {
  // PANE-RESIZE: the row carries the width and is the drag ceiling.
  const pane = usePaneRow("teams");
  const teams = useStore((s: UiState) => s.teams);
  const teamStatus = useTeamList(coord);
  const roles = useStore((s: UiState) => s.roles);
  const teamCursor = useStore((s: UiState) => s.teamCursor);
  const detail = useStore((s: UiState) => s.teamDetail);
  const mode = useStore((s: UiState) => s.mode);
  const confirm = useStore((s: UiState) => s.confirm);
  const agents = useStore((s: UiState) => s.agents);
  const agentOrder = useStore((s: UiState) => s.agentOrder);
  const collapsed = useStore((s: UiState) => s.collapsed);
  const mainConductorId = useStore((s: UiState) => s.mainConductorId);
  const coordSeq = useStore((s: UiState) => latestCoordSeq(s.events));

  // detail-pane agent selection (screen-local; the ref keeps the mounted-once
  // keymap handlers reading the LIVE value)
  const [agentIdx, setAgentIdx] = useState(0);
  const agentIdxRef = useRef(0);
  agentIdxRef.current = agentIdx;

  // W16 (F15/D11): the team name the "e" edit chip is targeting — null means
  // the open teamForm is a plain create. Screen-local; the FORM itself stays
  // the shared create card, just prefilled. toggleForm is invoked through the
  // mount-once keymap registration below (registerActionHandler's effect has
  // `[]` deps, like this screen's other handlers — see agentIdxRef for the
  // SAME live-read precedent), so it must read the CURRENT editingTeam
  // through a ref, never the closed-over state.
  const [editingTeam, setEditingTeam] = useState<string | null>(null);
  const editingTeamRef = useRef<string | null>(null);
  editingTeamRef.current = editingTeam;

  // Selection alone drives the detail pane now (no separate drill action to
  // SEE it) — `enter`/dblclick only move keyboard focus INTO the agent table.
  const [agentFocused, setAgentFocused] = useState(false);
  const agentFocusedRef = useRef(false);
  agentFocusedRef.current = agentFocused;

  // F-TOGGLE-ANIM: clicking the ALREADY-selected team row again collapses the
  // detail pane (animated via Collapse below) instead of being a no-op — a
  // separate flag because teamCursor is shared ui-state reducer state
  // (clampCursor never lets it go negative, so it can't represent "closed"
  // itself). Any real cursor move (click or arrow key) reopens it.
  const [teamDetailCollapsed, setTeamDetailCollapsed] = useState(false);
  useEffect(() => setTeamDetailCollapsed(false), [teamCursor]);

  // W-SORT (P2 UX): newest-first display order — teamCursor indexes THIS
  // reordering everywhere below (selection, edit/dissolve targets), not the
  // raw teams.items the daemon returns, so ↑↓ tracks the rendered rows.
  const sortedTeams = useMemo(() => newestFirst(teams.items), [teams.items]);

  // SEARCH-TEAMS: free-text filter over name/purpose/role names/member ids
  // ("search everything in it"). teamCursor indexes `filteredTeams`/`rows`
  // (SAME array, same order) below — not sortedTeams — so ↑↓/click/detail
  // never desync from what's actually on screen while a query is active.
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const appAgents = Object.values(agents);
    return sortedTeams
      .map((item) => ({ item, row: teamListRow(item) }))
      .filter(({ row }) => matchesTeamQuery(row, teamMemberIds(appAgents, row.name), query));
  }, [sortedTeams, agents, query]);
  const filteredTeams = useMemo(() => filtered.map((f) => f.item), [filtered]);
  const rows = useMemo(() => filtered.map((f) => f.row), [filtered]);
  const filteredRef = useRef<Array<Record<string, unknown>>>(filteredTeams);
  filteredRef.current = filteredTeams;

  // Keep the entity selected through insertion/reordering, including the first
  // render of refreshed rows, so its detail/form identity never flashes to a neighbor.
  const selectedRef = useRef<{ name: string | null; cursor: number }>({ name: null, cursor: teamCursor });
  const effectiveCursor = useMemo(() => {
    const { name, cursor } = selectedRef.current;
    const at = name !== null && teamCursor === cursor ? rows.findIndex(row => row.name === name) : -1;
    return rows.length === 0 ? 0 : Math.min(rows.length - 1, at >= 0 ? at : teamCursor);
  }, [rows, teamCursor]);
  useEffect(() => {
    const cur = appStore.getState().teamCursor;
    if (effectiveCursor !== cur) appStore.dispatch({ type: "teamCursor", delta: effectiveCursor - cur });
    selectedRef.current = { name: rows[effectiveCursor]?.name ?? null, cursor: effectiveCursor };
  }, [rows, effectiveCursor]);

  const ownerState = useMemo(
    () => ({ agents, agentOrder, collapsed, teams, mainConductorId }),
    [agents, agentOrder, collapsed, teams, mainConductorId],
  );

  const detailName = detail ? str(detail.spec["name"]) : null;
  const detailQueue = detail && typeof detail.spec["queue"] === "string" ? (detail.spec["queue"] as string) : null;

  // per-role instructions expand/collapse (screen-local, keyed by role name;
  // resets when the selected team changes so a stale team's expansion state
  // doesn't leak onto the next one)
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
  useEffect(() => { setExpandedRoles(new Set()); }, [detailName]);
  function toggleRole(roleName: string): void {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(roleName)) next.delete(roleName); else next.add(roleName);
      return next;
    });
  }

  // B8: merge the live (running-only) team.status agents with the app's own agents
  // map filtered to this team's membership, so a recently-drained member with a
  // terminal state still shows. Live rows stay authoritative. A ref keeps the
  // mounted-once keymap handlers (move/drill) indexing the SAME merged list.
  const mergedAgents = useMemo(
    () => (detail ? mergeTeamAgents(detail.agents, Object.values(agents), detailName ?? "") : []),
    [detail, agents, detailName],
  );
  const mergedRef = useRef<Array<Record<string, unknown>>>(mergedAgents);
  mergedRef.current = mergedAgents;

  // Bound-queue task records for the AgentInspector ("queue → task tX · try
  // n/m") — fetched alongside the drill, re-fetched on relevant events.
  const [queueInfo, setQueueInfo] = useState<{ retryLimit: number; tasks: Array<Record<string, unknown>> } | null>(null);
  useEffect(() => {
    if (!detailQueue) { setQueueInfo(null); return undefined; }
    let alive = true;
    void coord.queueStatus(detailQueue)
      .then((qs) => { if (alive) setQueueInfo({ retryLimit: num(qs.spec["retryLimit"]), tasks: qs.tasks }); })
      .catch(() => { if (alive) setQueueInfo(null); });
    return () => { alive = false; };
  }, [detailQueue, coordSeq]);

  // tab entry + relevant events → refresh the list and any open drill
  useEffect(() => { void rolesCommands.loadRoles(); }, []);
  useEffect(() => { if (coordSeq > 0) void coord.refresh(); }, [coordSeq]);

  // Selection drives the detail fetch directly: whichever team is under the
  // cursor gets its team.status loaded immediately — a single click or an
  // arrow-key move is enough, no separate "drill" action required to see it.
  const selectedTeamName = (() => {
    const name = filteredTeams[effectiveCursor]?.["name"];
    return typeof name === "string" && name.length > 0 ? name : null;
  })();
  useEffect(() => {
    if (selectedTeamName) void coord.openTeamDetail(selectedTeamName);
    else coord.closeTeamDetail();
  }, [selectedTeamName]);

  // clamp/reset the agent selection when the drill payload changes
  useEffect(() => { setAgentIdx(0); }, [detailName]);

  // ---- keymap registrations (rows.coord.ts declares the chords) ----------
  useEffect(() => {
    const disposers = [
      registerActionHandler("teams.up", () => move(-1)),
      registerActionHandler("teams.down", () => move(1)),
      registerActionHandler("teams.drill", () => drill()),
      registerActionHandler("teams.new", () => toggleForm()),
      registerActionHandler("teams.edit", () => requestEdit()),
      registerActionHandler("teams.dissolve", () => requestDissolve()),
    ];
    return () => { for (const d of disposers) d(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read live state
  }, []);

  // esc exits keyboard focus FROM the agent table back to the team list —
  // the detail itself stays populated (it tracks selection, not focus); form/
  // confirm overlays capture esc themselves (OverlayCard) before the root
  // handler sees it.
  useEffect(() => {
    if (!agentFocused) return undefined;
    return registerActionHandler("global.escape", () => setAgentFocused(false));
  }, [agentFocused]);

  function move(delta: number): void {
    if (agentFocusedRef.current) {
      const n = mergedRef.current.length;
      setAgentIdx((i) => Math.max(0, Math.min(n - 1, i + delta)));
    } else {
      // clamp against the FILTERED length, not the raw store length — a
      // query in effect must keep ↑↓ within the visible rows.
      const n = filteredRef.current.length;
      const cur = appStore.getState().teamCursor;
      const next = n === 0 ? 0 : Math.max(0, Math.min(n - 1, cur + delta));
      if (next !== cur) appStore.dispatch({ type: "teamCursor", delta: next - cur });
    }
  }

  // enter — a "focus INTO the agent table" action, not what SHOWS the detail
  // (selection already does that): first press moves keyboard focus onto the
  // agent table, a second press (now focused) drills into that agent.
  function drill(): void {
    if (agentFocusedRef.current) {
      const rec = mergedRef.current[agentIdxRef.current];
      const id = rec?.["agentId"];
      if (typeof id === "string") coord.openAgent(id);
    } else if (mergedRef.current.length > 0) {
      setAgentFocused(true);
    }
  }

  function toggleForm(): void {
    const state = appStore.getState();
    const wasEditing = editingTeamRef.current !== null;
    setEditingTeam(null);   // mod+o always means CREATE, even while an edit form is open
    appStore.dispatch({ type: "setMode", mode: state.mode === "teamForm" && !wasEditing ? "normal" : "teamForm" });
  }

  function closeForm(): void {
    setEditingTeam(null);
    appStore.dispatch({ type: "setMode", mode: "normal" });
  }

  /** mod+e — open the SAME create card prefilled from the selected/drilled
   * team's current spec (coverage B8 action chips). */
  function requestEdit(): void {
    const state = appStore.getState();
    const name = state.teamDetail ? state.teamDetail.spec["name"] : filteredRef.current[state.teamCursor]?.["name"];
    if (typeof name !== "string") return;
    setEditingTeam(name);
    appStore.dispatch({ type: "setMode", mode: "teamForm" });
  }

  function requestDissolve(): void {
    const state = appStore.getState();
    const name = state.teamDetail ? state.teamDetail.spec["name"] : filteredRef.current[state.teamCursor]?.["name"];
    if (typeof name === "string") appStore.dispatch({ type: "confirm", confirm: { kind: "dissolveTeam", name } });
  }

  const selectTeam = (i: number): void => {
    const cur = appStore.getState().teamCursor;
    if (i === cur) { setTeamDetailCollapsed((c) => toggleCollapsed(i, cur, c)); return; }
    appStore.dispatch({ type: "teamCursor", delta: i - cur });
    setAgentFocused(false); // a click on the team list hands ↑↓ back to it
  };

  // W16: the chip row's target — the drilled team while a detail is open,
  // else the list cursor's row (SAME resolution requestEdit/requestDissolve
  // already use).
  const targetName = detailName ?? rows[effectiveCursor]?.name ?? null;
  const targetRunning = detail ? detail.running : rows[effectiveCursor]?.running ?? 0;
  const editSpec = editingTeam
    ? (detail && detailName === editingTeam ? detail.spec : teams.items.find((t) => t["name"] === editingTeam))
    : undefined;

  // ---- render -------------------------------------------------------------
  return (
    <div className={styles.screen}>
    <div data-screen-layout="split" className={styles.row} {...pane.rowProps}>
      <Panel
        label={<>teams <span className={styles.countMeta}>({teamStatus.loaded ? sortedTeams.length : "…"})</span></>}
        className={styles.master}
      >
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="search teams (name · purpose · role · member id)"
          count={teamStatus.loaded ? { shown: rows.length, total: sortedTeams.length, noun: "teams" } : undefined}
          dataAttr="teams-search"
        />
        <div className={styles.colHead}>
          <div className={styles.colTeam}>team</div>
          <div className={styles.colRoles}>roles</div>
          <div className={styles.colRunning}>running</div>
          <div className={styles.colQueue}>queue</div>
        </div>
        <div className={styles.teamsBody} data-team-list role="region" aria-label="Teams list" tabIndex={0}>
        <LoadStatusNote status={teamStatus} what="teams" hasRows={sortedTeams.length > 0} onRetry={() => { void coord.loadTeams(); }} />
        {teamStatus.unsupported ? (
          <div className={styles.emptyHint}>teams require a Phase 2 daemon</div>
        ) : rows.length === 0 ? (
          teamStatus.loaded && !teamStatus.error ? <div className={styles.emptyHint}>{query.trim() ? "no teams match" : `no teams — ${displayChord("mod+o")} creates one`}</div> : null
        ) : (
          rows.map((t, i) => (
            <div
              key={t.name}
              className={i === effectiveCursor ? styles.rowSelected : styles.rowItem}
              onClick={() => selectTeam(i)}
              onDoubleClick={() => { selectTeam(i); setAgentFocused(true); }}
              onKeyDown={onRowKeyDown(() => selectTeam(i))}
              role="button"
              tabIndex={0}
              data-team-row={t.name}
            >
              <div className={styles.colTeam}>
                <span className={i === effectiveCursor ? undefined : styles.softName}>{t.name}</span>
                {t.owner !== null && <span className={styles.ownerMeta}> · {ownerLabel(ownerState, t.name) ?? shortId(t.owner)}</span>}
              </div>
              <div className={`${styles.colRoles} ${styles.mutedCell}`}>{t.roleCount}</div>
              <div className={styles.colRunning}>
                {t.running > 0 ? (
                  <>
                    <span className={styles.toneSuccess}>◐ {t.running}</span>
                    <span className={styles.faintCell}>/{t.maxConcurrent}</span>
                  </>
                ) : (
                  <span className={styles.faintCell}>idle</span>
                )}
              </div>
              <div className={`${styles.colQueue} ${styles.mutedCell}`}>{t.queue ?? "—"}</div>
            </div>
          ))
        )}
        </div>
        <PanelFooter>
          <div className={styles.footerRow}>
            <span>↑↓ select · enter focus agents</span>
            <ActionChipRow
              chips={[
                { key: displayChord("mod+o"), label: "new", onClick: toggleForm },
                { key: displayChord("mod+e"), label: "edit", onClick: requestEdit, disabled: targetName === null },
                { key: displayChord("mod+shift+x"), label: "dissolve", danger: true, onClick: requestDissolve, disabled: targetName === null },
              ]}
            />
          </div>
        </PanelFooter>
      </Panel>

      {/* PANE-RESIZE: the seam, in place of the gap. */}
      {pane.divider}
      <Panel label={detailName ? `team · ${detailName}` : "team"} className={styles.detail}>
        {detail === null ? (
          <div className={styles.emptyPane}>
            <div className={styles.emptyGlyph}>◆</div>
            <div className={styles.emptyHint}>no team selected</div>
          </div>
        ) : (
          <Collapse open={!teamDetailCollapsed} fill>
            <DetailBody
              detail={detail}
              library={roles.items}
              agents={mergedAgents}
              agentIdx={agentIdx}
              setAgentIdx={(i) => {
                const next = toggleIndex(i, agentIdxRef.current);
                setAgentIdx(next);
                setAgentFocused(next !== -1);
              }}
              queueInfo={queueInfo}
              owner={ownerLabel(ownerState, detailName ?? "")}
              expandedRoles={expandedRoles}
              onToggleRole={toggleRole}
            />
          </Collapse>
        )}
        {mode === "teamForm" && editingTeam !== null && editSpec !== undefined && (
          <TeamFormCard
            mode="edit"
            initial={teamFormValuesFromSpec(editSpec)}
            rolesLocked={targetRunning > 0}
            onSubmit={(patch) => coord.updateTeam(editingTeam, patch)}
            onClose={closeForm}
          />
        )}
        {mode === "teamForm" && editingTeam === null && (
          <TeamFormCard
            onSubmit={(spec) => coord.createTeam(spec)}
            onClose={closeForm}
          />
        )}
        {confirm?.kind === "dissolveTeam" && (
          <ConfirmCard
            title="⚠ dissolve team"
            meta={confirm.name}
            body={CONFIRMS.dissolveTeam(confirm.name).body}
            note={CONFIRMS.dissolveTeam(confirm.name).note}
            confirmLabel="confirm dissolve"
            onConfirm={() => {
              const name = confirm.name;
              appStore.dispatch({ type: "confirm", confirm: null });
              void coord.dissolveTeam(name);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        <OverlayOutlet host="teams" />
      </Panel>
    </div>
    </div>
  );
}

function DetailBody({ detail, library, agents, agentIdx, setAgentIdx, queueInfo, owner, expandedRoles, onToggleRole }: {
  detail: NonNullable<UiState["teamDetail"]>;
  // ROLES-BINDING-CORRECTNESS: the role library (role.list) — a binding's own fields
  // live under `overrides`, so the badges below must resolve against this to show a
  // role's actual effective config rather than reading the raw binding's (empty)
  // top-level fields.
  library: ReadonlyArray<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  agentIdx: number;
  setAgentIdx: (i: number) => void;
  queueInfo: { retryLimit: number; tasks: Array<Record<string, unknown>> } | null;
  owner: string | null;
  expandedRoles: Set<string>;
  onToggleRole: (roleName: string) => void;
}) {
  const spec = detail.spec;
  const name = str(spec["name"]);
  const selectedAgent = agents[agentIdx];
  const selectedAgentId = selectedAgent ? str(selectedAgent["agentId"]) : "";
  const roleSpecs = spec["roles"] && typeof spec["roles"] === "object" ? (spec["roles"] as Record<string, unknown>) : {};
  const roles = Object.keys(roleSpecs);
  const queue = typeof spec["queue"] === "string" ? (spec["queue"] as string) : null;
  const purpose = typeof spec["purpose"] === "string" ? (spec["purpose"] as string) : null;
  // PROJTEAM-T7: only a project-native team (T1's TeamSpec.projectNative) gets
  // the "+ add member" affordance — a plain team keeps using the existing "e"
  // edit form (single-role replace, unaffected by this change).
  const projectNative = typeof spec["projectNative"] === "string" ? (spec["projectNative"] as string) : null;
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberRole, setAddMemberRole] = useState("");
  const [addMemberError, setAddMemberError] = useState<string | null>(null);
  useEffect(() => { setAddMemberOpen(false); setAddMemberRole(""); setAddMemberError(null); }, [name]);

  // team.update replaces `roles` wholesale (D11) — cwd is derived from an
  // EXISTING role's template (every role in a project-native team shares the
  // project's path, per T3's materialize), not re-typed by hand. FLAT-SHAPE-
  // SWEEP: `roleSpecs` values are `{role, overrides}` BINDINGS, not flat specs
  // — reading `firstRole["cwd"]` directly (as this used to) always reads
  // undefined, since a binding's own fields live under `overrides`/the library
  // it references (same bug class as roleConfig's, see ui-state/roles.ts).
  // Resolve against the library instead, same as the role badges above.
  function submitAddMember(): void {
    const firstBinding = Object.values(roleSpecs)[0] as Record<string, unknown> | undefined;
    const resolved = resolvedRoleBindingSpec(firstBinding, library);
    const cwd = typeof resolved["cwd"] === "string" ? (resolved["cwd"] as string) : "";
    const values = { role: addMemberRole, cwd };
    const invalid = validateAddMemberForm(spec, values);
    if (invalid) { setAddMemberError(invalid); return; }
    setAddMemberError(null);
    const role = values.role.trim();
    // A fresh binding must reference a REAL library role (RoleBindingSchema, ROLES-
    // UNIFY §1 library-first) — unlike buildTeamSpec's role picker, this form's role
    // name is free text for a BRAND NEW role, so it must be defined first. role_create
    // rejects a duplicate name outright (surfaces as the form's inline error) rather
    // than silently producing a binding that can never resolve at spawn time.
    void rolesCommands.createRole({ name: role, cwd: values.cwd })
      .then(() => getCoordCommands(appStore, rpcCall).updateTeam(name, buildAddMemberPatch(spec, values)))
      .then(() => { setAddMemberOpen(false); setAddMemberRole(""); })
      .catch((err: unknown) => setAddMemberError(errorText(err)));
  }

  return (
    <>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{name}</span>
          <span className={styles.spacer} />
          <span className={styles.runningMeta}>{detail.running} running</span>
        </div>
        <div className={styles.chipRow}>
          <span className={styles.chip}>{roles.length} roles</span>
          <span className={styles.chip}>max {num(spec["maxConcurrent"]) || 1}</span>
          {queue !== null && <span className={styles.chip}>queue {queue}</span>}
          {owner !== null && <span className={styles.chip}>owner {owner}</span>}
          {/* TEAM-STATS: totalRuns is a real 0 for an untouched team (num()
              degrades an absent/older-daemon field the same honest way) — the
              chip always renders, never silently omitted. */}
          <span className={styles.chip} data-team-total-runs>{num(detail.totalRuns)} runs</span>
          {purpose !== null && <span className={styles.purpose}>purpose: {purpose}</span>}
        </div>
        <div className={styles.rolesSection}>
          {roles.map((roleName) => {
            const binding = roleSpecs[roleName] as Record<string, unknown> | undefined;
            // ROLES-BINDING-CORRECTNESS: a binding's own fields live under `overrides`
            // (ROLES-UNIFY §3.1's `{role, overrides}` shape) — reading it directly, as
            // this used to, always found nothing and reported "default config" for
            // every role regardless of what it actually overrides. Resolve against the
            // library instead (same merge RolesScreen's TeamRoleDetail already uses),
            // and mark which fields are PINNED (vs inherited) so showing the resolved
            // value doesn't trade one confusion for another.
            const cfg = roleConfig(resolvedRoleBindingSpec(binding, library));
            const pinned = new Set(overriddenFieldsOf(binding));
            const chipClass = (field: string): string => (pinned.has(field) ? styles.chipPinned! : styles.chip!);
            const expanded = expandedRoles.has(roleName);
            const discovered = isDiscoveredRole(spec, roleName);
            return (
              <div key={roleName} className={styles.roleBlock}>
                <div
                  className={styles.roleHeader}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  aria-label={`${roleName} role instructions`}
                  onClick={() => onToggleRole(roleName)}
                  onKeyDown={onRowKeyDown(() => onToggleRole(roleName))}
                >
                  <span className={styles.roleToggle}>{expanded ? "▾" : "▸"}</span>
                  <span className={styles.roleName}>{roleName}</span>
                  {discovered
                    ? <span className={styles.discoveredBadge} title="materialized from .claude/agents — read-only, kept in sync automatically" data-role-provenance={roleName}>from .claude</span>
                    : <span className={styles.chimeraBadge} title="added in chimera — survives re-sync" data-role-provenance={roleName}>chimera</span>}
                  <span className={styles.roleBadges} title="highlighted = pinned override, plain = inherited from the library role">
                    {cfg.model !== null && <span className={chipClass("model")}>{cfg.model}</span>}
                    {cfg.permissionProfile !== null && <span className={chipClass("permissionProfile")}>{cfg.permissionProfile}</span>}
                    {cfg.isolation !== null && <span className={chipClass("isolation")}>{cfg.isolation}</span>}
                    {cfg.maxTurns !== null && <span className={chipClass("maxTurns")}>maxTurns {cfg.maxTurns}</span>}
                    {cfg.turnLimitPolicy !== null && <span className={chipClass("turnLimitPolicy")}>{cfg.turnLimitPolicy}</span>}
                  </span>
                </div>
                <Collapse open={expanded}>
                  <div className={styles.rolePrompt}>{cfg.instructions ?? "no instructions set"}</div>
                  {/* ROLES-UNIFY §6.3, mounted here too: the per-team override editor was
                      reachable ONLY from the Roles tab, so the screen an operator is actually
                      looking at while thinking about a team could show which fields were pinned
                      but not change them. Same component, same atomic team.updateRoleBinding
                      RPC (whole-object replace, server-side RMW) — mounting it twice is safe
                      precisely because neither side does a client-side read-modify-write.
                      Discovered (.claude-materialized) bindings stay read-only: project sync
                      regenerates them, so an edit here would be clobbered on the next pass. */}
                  <RoleBindingOverrideEditor
                    key={`${name}/${roleName}`}
                    librarySpec={library.find((r) => r["name"] === (binding?.["role"] ?? roleName))}
                    overrides={(binding?.["overrides"] as Record<string, unknown> | undefined) ?? {}}
                    readOnly={discovered}
                    onSave={(next) =>
                      getRolesCommands(appStore, rpcCall).updateTeamRole(name, roleName, next)
                        .then(() => getCoordCommands(appStore, rpcCall).loadTeams())
                    }
                  />
                </Collapse>
              </div>
            );
          })}
          {projectNative !== null && (
            <div className={styles.addMemberRow}>
              {!addMemberOpen ? (
                <span className={styles.addMemberChip} onClick={() => setAddMemberOpen(true)} data-add-member>
                  + add member
                </span>
              ) : (
                <span className={styles.addMemberForm}>
                  <input
                    className={styles.addMemberInput}
                    value={addMemberRole}
                    placeholder="role name"
                    autoFocus
                    onChange={(e) => { setAddMemberRole(e.target.value); if (addMemberError) setAddMemberError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); submitAddMember(); }
                      if (e.key === "Escape") { e.preventDefault(); setAddMemberOpen(false); setAddMemberError(null); }
                    }}
                    data-add-member-input
                  />
                  <span className={styles.addMemberSubmit} onClick={submitAddMember} data-add-member-submit>add</span>
                  <span className={styles.addMemberCancel} onClick={() => { setAddMemberOpen(false); setAddMemberError(null); }}>esc cancel</span>
                  {addMemberError !== null && <span className={styles.addMemberError}>{addMemberError}</span>}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className={styles.agentTable} role="region" aria-label="Team workers" tabIndex={0} data-team-agent-table>
        <div className={styles.agentTableContent}>
          <div className={styles.agentHead} data-team-agent-head>
            <div className={styles.colState}>state</div>
            <div className={styles.colRole}>role</div>
            <div className={styles.colAgent}>agent</div>
            <div className={styles.colAcct}>acct</div>
            <div className={styles.colCost}>cost</div>
            <div className={styles.colActivity}>activity</div>
          </div>
          <div className={styles.agentsBody}>
          {agents.length === 0 ? (
            <div className={styles.emptyHint}>no workers yet — the scheduler spawns them as tasks drain</div>
          ) : (
            agents.map((rec, i) => {
              const agentId = str(rec["agentId"]);
              const state = str(rec["state"]) || "unknown";
              const visual = stateVisual(state);
              const membership = rec["membership"] && typeof rec["membership"] === "object" ? (rec["membership"] as Record<string, unknown>) : undefined;
              const account = str(rec["accountName"]);
              const selected = i === agentIdx;
              return (
                <div key={agentId || i}>
                  <div
                    className={selected ? styles.agentRowSelected : styles.agentRow}
                    onClick={() => setAgentIdx(i)}
                    onDoubleClick={() => agentId && getCoordCommands(appStore, rpcCall).openAgent(agentId)}
                    onKeyDown={onRowKeyDown(() => setAgentIdx(i))}
                    role="button"
                    tabIndex={0}
                    data-team-agent={agentId}
                  >
                    <div className={styles.colState}>
                      <span className={toneClass[visual.tone]}>{visual.glyph}</span>
                      <span className={styles.mutedCell}> {state}</span>
                    </div>
                    <div className={`${styles.colRole} ${styles.mutedCell}`}>{str(membership?.["role"]) || "—"}</div>
                    <div className={styles.colAgent}>
                      <span className={selected ? undefined : styles.softName} title={agentId ? `${agentName(agentId)} · ${agentId}` : undefined}>{agentId ? agentName(agentId) : "—"}</span>
                      {agentId && <span className={styles.idMeta}> {shortId(agentId)}</span>}
                    </div>
                    <div className={styles.colAcct}>
                      {account && (
                        <>
                          <span style={{ color: `var(${accountToneVar(account)})` }}>▪</span>
                          <span className={styles.mutedCell}> {account}</span>
                        </>
                      )}
                    </div>
                    <div className={`${styles.colCost} ${styles.mutedCell}`}>{fmtCost(num(rec["costUsd"]))}</div>
                    <div className={styles.colActivity} title={str(rec["resultText"]) || agentActivity(rec)}>{agentActivity(rec)}</div>
                  </div>
                </div>
              );
            })
          )}
          </div>
        </div>
      </div>
      <Collapse open={selectedAgent !== undefined} className={styles.workerInspector}>
        {selectedAgent ? (
          <AgentInspector
            key={selectedAgentId}
            record={selectedAgent}
            task={queueInfo && selectedAgentId ? taskForAgent(queueInfo.tasks, selectedAgentId) : null}
            retryLimit={queueInfo?.retryLimit ?? 0}
            owner={owner}
            queue={queue}
          />
        ) : null}
      </Collapse>
      <PanelFooter>click agent → drill into transcript · esc back · {displayChord("mod+e")} edit · {displayChord("mod+shift+x")} dissolve</PanelFooter>
    </>
  );
}
