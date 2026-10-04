import { useEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { displayChord, registerActionHandler, runAction } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getProjectsCommands, projectsLocal, useProjectsLocal, type ProjectDetail } from "../state/commands.projects";
import { conductorAccountPin, filterProjects, latestSessionSeq, projectStatus, sessionRow, type ProjectRow } from "../state/selectors.projects";
import { agentName, conductorLabel, fmtClock, shortId, stateVisual } from "../state/selectors";
import { checkpointLabel, triggerLabel } from "../state/selectors.checkpoints";
import { CONFIRMS } from "../copy";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { SearchBox } from "../components/SearchBox";
import { ImportCard } from "../components/ImportCard";
import { ConfirmCard } from "../components/ConfirmCard";
import { Collapse } from "../components/Collapse";
import { toggleCollapsed } from "../state/selectionToggle";
import { systemCommands } from "../state/commands.system";
import { errorText } from "../state/errorText";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import styles from "./ProjectsScreen.module.css";
import { usePaneRow } from "../components/PaneDivider";

// W7 — the Projects screen (mock s_projects 493-563, coverage B12): 430px
// master list (project/teams/sessions/status; ⇣ git import marker when origin
// is set; ● active when live sessions > 0, idle otherwise, ◌ paused when
// archived) + detail pane (path · origin header with the live "● active · N
// sessions" meta; team chips with live ◐ counts from project.status;
// "+ assign team ▾" menu → project.assignTeam; "queue X · N pending" chip;
// sessions table = project.status sessions with gitBranch). Data lives in the
// W7 local store (commands.projects.ts) — refresh on tab entry + relevant
// events (agent_started/status/result/error), no polling timers.

const commands = getProjectsCommands(appStore, rpcCall);

function invokeProjectTool(rpc: "project.unarchive" | "checkpoint.create", params: Record<string, unknown>, project: string): void {
  void systemCommands(appStore, rpcCall).mcpInvoke(rpc, params)
    .then(() => commands.openDetail(project))
    .catch((error: unknown) => {
      appStore.dispatch({ type: "commandError", message: errorText(error) });
    });
}

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
  faint: styles.faintCell!,
};

export function ProjectsScreen() {
  // PANE-RESIZE: the row carries the width and is the drag ceiling.
  const pane = usePaneRow("projects");
  const items = useProjectsLocal((s) => s.items);
  const cursor = useProjectsLocal((s) => s.cursor);
  const query = useProjectsLocal((s) => s.query);
  const detail = useProjectsLocal((s) => s.detail);
  const sessionIdx = useProjectsLocal((s) => s.sessionIdx);
  const teamIdx = useProjectsLocal((s) => s.teamIdx);
  const formOpen = useProjectsLocal((s) => s.formOpen);
  const importDirHint = useProjectsLocal((s) => s.importDirHint);
  const assignOpen = useProjectsLocal((s) => s.assignOpen);
  const confirmArchive = useProjectsLocal((s) => s.confirmArchive);
  const confirmDelete = useProjectsLocal((s) => s.confirmDelete);
  const confirmDeleteFiles = useProjectsLocal((s) => s.confirmDeleteFiles);
  const deleteError = useProjectsLocal((s) => s.deleteError);
  const teams = useStore((s: UiState) => s.teams);
  const sessionSeq = useStore((s: UiState) => latestSessionSeq(s.events));

  // the master list's visible rows — the cursor, selection, detail fetch and
  // archive all index into THIS, never the raw `items`, so a query can never
  // leave the cursor pointing at a hidden row.
  const shown = useMemo(() => filterProjects(items, query), [items, query]);

  const detailRef = useRef(detail);
  detailRef.current = detail;

  const sessionFocused = useProjectsLocal((s) => s.sessionFocused);

  // F-TOGGLE-ANIM: clicking the already-selected project row again collapses
  // the detail pane (animated); any real cursor move reopens it.
  const [projectDetailCollapsed, setProjectDetailCollapsed] = useState(false);
  useEffect(() => setProjectDetailCollapsed(false), [cursor]);

  // tab entry + relevant events → refresh the list and any open drill
  useEffect(() => { void commands.loadProjects(); }, []);
  // FILEBROWSER-T9: debounced — a burst of session/git events (several agents
  // starting/finishing close together) must collapse into ONE refresh, not
  // one fs.list-thrashing refresh per event.
  useEffect(() => { if (sessionSeq > 0) commands.refreshDebounced(); }, [sessionSeq]);

  // Selection drives the detail fetch directly: whichever project is under
  // the cursor gets its project.status loaded immediately — a single click or
  // an arrow-key move is enough, no separate "drill" action required to see it.
  const selectedProjectName = shown[cursor]?.name ?? null;
  useEffect(() => {
    if (selectedProjectName) void commands.openDetail(selectedProjectName);
    else commands.closeDetail();
  }, [selectedProjectName]);

  // ---- keymap registrations (rows.projects.ts declares the chords) --------
  useEffect(() => {
    const offs = [
      registerActionHandler("projects.up", () => move(-1)),
      registerActionHandler("projects.down", () => move(1)),
      registerActionHandler("projects.drill", () => drill()),
      registerActionHandler("projects.new", () => toggleForm()),
      registerActionHandler("projects.archive", () => requestArchive()),
      registerActionHandler("projects.delete", () => requestDelete()),
      registerActionHandler("projects.run", () => { void commands.runTeam(); }),
    ];
    return () => { for (const off of offs) off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read live state
  }, []);

  // esc exits keyboard focus FROM the sessions table back to the project list
  // — the detail itself stays populated (it tracks selection, not focus); the
  // form/confirm overlays capture esc themselves (OverlayCard) before the root
  // handler sees it.
  useEffect(() => {
    if (!sessionFocused) return undefined;
    return registerActionHandler("global.escape", () => projectsLocal.set({ sessionFocused: false }));
  }, [sessionFocused]);

  function move(delta: number): void {
    const s = projectsLocal.getState();
    if (s.sessionFocused) {
      const n = s.detail?.sessions.length ?? 0;
      projectsLocal.set({ sessionIdx: Math.max(0, Math.min(n - 1, s.sessionIdx + delta)) });
    } else {
      const visible = filterProjects(s.items, s.query).length;
      projectsLocal.set({ cursor: Math.max(0, Math.min(visible - 1, s.cursor + delta)) });
    }
  }

  // enter — a "focus INTO the sessions table" action, not what SHOWS the
  // detail (selection already does that): first press moves keyboard focus
  // onto the sessions table, a second press (now focused) drills into it.
  function drill(): void {
    const s = projectsLocal.getState();
    if (s.sessionFocused) {
      const rec = s.detail?.sessions[s.sessionIdx];
      const id = rec?.["agentId"];
      if (typeof id === "string") commands.openSession(id);
    } else if (s.detail && s.detail.sessions.length > 0) {
      projectsLocal.set({ sessionFocused: true });
    }
  }

  function toggleForm(): void {
    const opening = !projectsLocal.getState().formOpen;
    projectsLocal.set({ formOpen: opening });
    if (opening) void commands.loadImportDirHint();   // refresh the blank-create path preview
  }

  function requestArchive(): void {
    const s = projectsLocal.getState();
    const name = s.detail ? String(s.detail.spec["name"] ?? "") : filterProjects(s.items, s.query)[s.cursor]?.name;
    if (name) projectsLocal.set({ confirmArchive: name });
  }

  // Delete is offered for archived projects too (the natural cleanup path) —
  // unlike requestArchive, no "already archived" gate here.
  function requestDelete(): void {
    const s = projectsLocal.getState();
    const name = s.detail ? String(s.detail.spec["name"] ?? "") : filterProjects(s.items, s.query)[s.cursor]?.name;
    if (name) projectsLocal.set({ confirmDelete: name, confirmDeleteFiles: false, deleteError: null });
  }

  const selectProject = (i: number): void => {
    if (i === cursor) { setProjectDetailCollapsed((c) => toggleCollapsed(i, cursor, c)); return; }
    projectsLocal.set({ cursor: i, sessionFocused: false });
  };
  const detailName = detail ? String(detail.spec["name"] ?? "") : null;

  return (
    <div data-screen-layout="split" className={styles.row} {...pane.rowProps}>
      <Panel label={<>projects <span className={styles.countMeta}>({items.length})</span></>} className={styles.master}>
        <SearchBox
          value={query}
          onChange={(q) => commands.setQuery(q)}
          placeholder="search projects (name · path)"
          count={{ shown: shown.length, total: items.length, noun: "projects" }}
          dataAttr="projects-search"
        />
        <div className={styles.colHead}>
          <div className={styles.colProject}>project</div>
          <div className={styles.colTeams}>teams</div>
          <div className={styles.colSessions}>sessions</div>
          <div className={styles.colStatus}>status</div>
        </div>
        {items.length === 0 ? (
          <div className={styles.emptyHint}>{`no projects — ${displayChord("mod+o")} imports one`}</div>
        ) : shown.length === 0 ? (
          <div className={styles.emptyHint}>no projects match</div>
        ) : (
          shown.map((p, i) => <MasterRow key={p.name} p={p} selected={i === cursor} onSelect={() => selectProject(i)} onOpen={() => { selectProject(i); projectsLocal.set({ sessionFocused: true }); }} />)
        )}
        <div className={styles.filler} />
        <PanelFooter>↑↓ select · enter focus sessions · {displayChord("mod+o")} import/new · {displayChord("mod+k")} archive · {displayChord("mod+shift+x")} delete</PanelFooter>
      </Panel>

      {/* PANE-RESIZE: the seam, in place of the gap. */}
      {pane.divider}
      <Panel label={detailName ? `project · ${detailName}` : "project"} className={styles.detail}>
        {detail === null ? (
          <div className={styles.emptyPane}>
            <div className={styles.emptyGlyph}>◆</div>
            <div className={styles.emptyHint}>no project selected</div>
          </div>
        ) : (
          <Collapse open={!projectDetailCollapsed} fill>
            <DetailBody
              detail={detail}
              sessionIdx={sessionIdx}
              teamIdx={teamIdx}
              assignOpen={assignOpen}
              teamCatalog={teams.items}
              onSelectSession={(i) => projectsLocal.set({ sessionIdx: i, sessionFocused: true })}
            />
          </Collapse>
        )}
        {formOpen && (
          <ImportCard
            teams={teams.items.map((t) => (typeof t["name"] === "string" ? (t["name"] as string) : "")).filter(Boolean)}
            importDirHint={importDirHint}
            onSubmit={(v) => commands.importProject(v)}
            onClose={() => projectsLocal.set({ formOpen: false })}
          />
        )}
        {confirmArchive !== null && (
          <ConfirmCard
            title="⚠ archive project"
            meta={confirmArchive}
            body={CONFIRMS.archiveProject(confirmArchive).body}
            note={CONFIRMS.archiveProject(confirmArchive).note}
            confirmLabel="confirm archive"
            onConfirm={() => {
              const name = confirmArchive;
              projectsLocal.set({ confirmArchive: null });
              void commands.archiveProject(name);
            }}
            onClose={() => projectsLocal.set({ confirmArchive: null })}
          />
        )}
        {confirmDelete !== null && (
          <ConfirmCard
            title="⚠ delete project"
            meta={confirmDelete}
            body={CONFIRMS.deleteProject(confirmDelete).body}
            note={CONFIRMS.deleteProject(confirmDelete).note}
            confirmLabel="confirm delete"
            onConfirm={() => { void commands.deleteProject(confirmDelete, confirmDeleteFiles); }}
            onClose={() => projectsLocal.set({ confirmDelete: null, confirmDeleteFiles: false, deleteError: null })}
          >
            <span
              className={confirmDeleteFiles ? styles.settingsToggleOn : styles.settingsToggleOff}
              role="switch"
              aria-checked={confirmDeleteFiles}
              onClick={() => projectsLocal.set({ confirmDeleteFiles: !confirmDeleteFiles, deleteError: null })}
              data-delete-files-toggle={confirmDeleteFiles ? "on" : "off"}
            >
              {confirmDeleteFiles ? "◉" : "◯"} also delete files on disk
            </span>
            {confirmDeleteFiles && (
              <div className={styles.deleteFilesWarning} data-delete-files-warning>
                ⚠ the project directory will be permanently removed from disk — this cannot be undone.
              </div>
            )}
            {deleteError !== null && (
              <div className={styles.deleteErrorNote} data-delete-error>{deleteError}</div>
            )}
          </ConfirmCard>
        )}
        <OverlayOutlet host="projects" />
      </Panel>
    </div>
  );
}

function MasterRow({ p, selected, onSelect, onOpen }: { p: ProjectRow; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const status = projectStatus(p);
  return (
    <div className={selected ? styles.rowSelected : styles.rowItem} onClick={onSelect} onDoubleClick={onOpen} data-project-row={p.name}>
      <div className={styles.colProject}>
        <span className={selected ? undefined : styles.softName}>{p.name}</span>{" "}
        <span className={styles.pathMeta}>{p.origin !== null ? "⇣ git import" : p.path}</span>
      </div>
      <div className={`${styles.colTeams} ${styles.mutedCell}`}>{p.teams.length}</div>
      <div className={styles.colSessions}>
        {p.sessions > 0 ? <span className={styles.toneSuccess}>◐ {p.sessions}</span> : <span className={styles.faintCell}>—</span>}
      </div>
      <div className={styles.colStatus}>
        {status.glyph ? (
          <>
            <span className={toneClass[status.tone]}>{status.glyph}</span>
            <span className={styles.mutedCell}> {status.word}</span>
          </>
        ) : (
          <span className={styles.faintCell}>{status.word}</span>
        )}
      </div>
    </div>
  );
}

// F26.UI: the daemon runs this command through hooks.ts:splitCommand and execs it directly —
// there is NO shell, so a pipe/redirect/&&/$( ) is not "advanced usage", it is handed to the
// program as a literal argument and the hook fails in a way that looks like the program's fault.
// splitCommand DOES honour single/double quotes, so quoting stays legal here.
const HOOK_SHELL_META = /(&&|\|\||[|;<>`]|\$\()/;
export function hookCommandProblem(command: string): string | null {
  if (HOOK_SHELL_META.test(command)) return "no shell here — pipes, redirects and && are passed to the program as literal text. Point the hook at a script instead.";
  if (command.length > 2000) return "command is too long (max 2000 characters).";
  return null;
}

function DetailBody({ detail, sessionIdx, teamIdx, assignOpen, teamCatalog, onSelectSession }: {
  detail: ProjectDetail;
  sessionIdx: number;
  teamIdx: number;
  assignOpen: boolean;
  teamCatalog: Array<Record<string, unknown>>;
  onSelectSession: (i: number) => void;
}) {
  const spec = detail.spec;
  const name = String(spec["name"] ?? "");
  const path = String(spec["path"] ?? "");
  const origin = typeof spec["origin"] === "string" ? (spec["origin"] as string) : null;
  const queue = typeof spec["queue"] === "string" ? (spec["queue"] as string) : null;
  const archived = spec["archived"] === true;
  // PROJTEAM-T7: defaults true (ProjectSpecSchema) — an absent/malformed field
  // never reads as OFF.
  const loadProjectSettings = spec["loadProjectSettings"] !== false;
  // F26: worktreeSetup is null/absent for "no hook configured" — distinct from
  // an hook object with enabled:false (configured but paused).
  const worktreeSetupRaw = spec["worktreeSetup"];
  const hookSpec = worktreeSetupRaw && typeof worktreeSetupRaw === "object" ? (worktreeSetupRaw as Record<string, unknown>) : null;
  const hookCommand = hookSpec && typeof hookSpec["command"] === "string" ? (hookSpec["command"] as string) : "";
  // 300 mirrors WorktreeSetupHookSchema.timeoutSec's own default (protocol/src/index.ts) — the app
  // always sends timeoutSec explicitly, so a smaller literal here would silently override the
  // schema default and SIGTERM a cold `pnpm install` bootstrap (the row's own placeholder) mid-run,
  // refusing the spawn fail-closed for a hook that was merely slow.
  const hookTimeoutSec = hookSpec && typeof hookSpec["timeoutSec"] === "number" ? (hookSpec["timeoutSec"] as number) : 300;
  const hookEnabled = hookSpec !== null && hookSpec["enabled"] !== false;
  const [editingHook, setEditingHook] = useState(false);
  const [editingHookTimeout, setEditingHookTimeout] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);
  // F26.UI (QA gap 4): both inline editors save on Enter AND on blur, and detaching a focused
  // input dispatches blur in some engines — so Escape (or Enter) could round-trip through submit
  // a second time, turning "cancel" into "save" and one edit into two RPCs. A single-shot latch,
  // armed when an editor opens and set before every unmount, makes each editing session settle
  // exactly once.
  const hookSettled = useRef(false);
  useEffect(() => { setEditingHook(false); setEditingHookTimeout(false); setHookError(null); }, [name]);
  // PROJECT-CONDUCTOR-ACCOUNT: accounts.list is the picker's option list (multiple
  // rows can share one provider, so a provider-level picker could never target the
  // SECOND account on a provider — same reasoning as SpawnCard's account select).
  const [accountRows, setAccountRows] = useState<ReadonlyArray<{ name: string; provider: string }>>([]);
  useEffect(() => {
    let alive = true;
    rpcCall<Array<Record<string, unknown>>>("accounts.list", {}).then((rows) => {
      if (!alive || !Array.isArray(rows)) return;
      setAccountRows(rows.map((r) => ({ name: String(r["name"] ?? ""), provider: String(r["provider"] ?? "") })).filter((r) => r.name));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const pin = conductorAccountPin(spec, detail.sessions);
  const writePin = (account: string | null, model: string | null, permissionProfile?: string | null) => {
    void getProjectsCommands(appStore, rpcCall).setConductorAccount(name, account, model, permissionProfile);
  };
  const openHookEditor = (which: "command" | "timeout") => {
    hookSettled.current = false;
    setHookError(null);
    if (which === "command") { setEditingHook(true); setEditingHookTimeout(false); }
    else { setEditingHookTimeout(true); setEditingHook(false); }
  };
  const cancelHookEdit = () => {
    hookSettled.current = true;
    setEditingHook(false);
    setEditingHookTimeout(false);
    setHookError(null);
  };
  const writeHook = (hook: { command: string; timeoutSec: number; enabled: boolean } | null) => {
    void getProjectsCommands(appStore, rpcCall).setSetupHook(name, hook);
  };
  const submitHook = (raw: string) => {
    if (hookSettled.current) return;
    const trimmed = raw.trim();
    const problem = trimmed ? hookCommandProblem(trimmed) : null;
    // Keep the editor open on a rejected value: the operator still has their text and the reason
    // sits right under it, instead of the row silently reverting to the old command.
    if (problem) { setHookError(problem); return; }
    hookSettled.current = true;
    setEditingHook(false);
    setHookError(null);
    // QA gap 3: preserve the paused state. Fixing a typo on a hook the operator deliberately
    // paused must not put it back in the spawn path with no signal; only a hook created from
    // scratch starts enabled.
    writeHook(trimmed ? { command: trimmed, timeoutSec: hookTimeoutSec, enabled: hookSpec ? hookEnabled : true } : null);
  };
  const submitHookTimeout = (raw: string) => {
    if (hookSettled.current) return;
    const n = Number(raw.trim());
    // Mirrors WorktreeSetupHookSchema.timeoutSec (int, 1..900) — reject here so the operator sees
    // the bound instead of a zod error toast from the daemon.
    if (!Number.isInteger(n) || n < 1 || n > 900) { setHookError("timeout must be a whole number of seconds, 1–900."); return; }
    hookSettled.current = true;
    setEditingHookTimeout(false);
    setHookError(null);
    writeHook({ command: hookCommand, timeoutSec: n, enabled: hookEnabled });
  };
  const sessions = useMemo(() => detail.sessions.map(sessionRow), [detail.sessions]);
  // Match the agents tab's naming so a project conductor reads the same in both
  // places (conductorLabel: project-name/suffix aware) instead of a literal "main".
  const agents = useStore((s: UiState) => s.agents);
  const live = sessions.filter((s) => s.state === "running" || s.state === "paused").length;
  const assignable = teamCatalog
    .map((t) => (typeof t["name"] === "string" ? (t["name"] as string) : ""))
    .filter((n) => n && !detail.teams.some((a) => a.name === n));
  return (
    <>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.detailName}>{name}</span>
          <span className={styles.pathMeta}>{path}{origin ? ` · origin ${origin}` : ""}</span>
          <span className={styles.spacer} />
          {live > 0
            ? <span className={styles.liveMeta}>● active · {live} session{live === 1 ? "" : "s"}</span>
            : <span className={styles.idleMeta}>idle</span>}
          {archived ? (
            <span
              className={styles.unarchiveChip}
              onClick={() => invokeProjectTool("project.unarchive", { name }, name)}
              data-project-action="project_unarchive"
            >
              unarchive
            </span>
          ) : (
            <span
              className={styles.archiveChip}
              onClick={() => runAction("projects.archive", appStore)}
              data-project-action="projects.archive"
            >
              archive
            </span>
          )}
          <span
            className={styles.deleteChip}
            onClick={() => projectsLocal.set({ confirmDelete: name, confirmDeleteFiles: false, deleteError: null })}
            data-delete-project
          >
            ✕ delete
          </span>
        </div>
        <div className={styles.settingsRow}>
          <span
            className={loadProjectSettings ? styles.settingsToggleOn : styles.settingsToggleOff}
            role="switch"
            aria-checked={loadProjectSettings}
            onClick={() => { void getProjectsCommands(appStore, rpcCall).setLoadProjectSettings(name, !loadProjectSettings); }}
            data-load-project-settings-toggle={loadProjectSettings ? "on" : "off"}
          >
            {loadProjectSettings ? "◉" : "◯"} load project &amp; global skills
          </span>
          <span className={styles.settingsHint}>
            Loads this project&apos;s .claude skills/commands + your global ~/.claude skills into project agents. Off = isolated (today&apos;s behavior).
          </span>
        </div>
        <div className={styles.settingsRow}>
          <span className={styles.faintCell}>conductor account</span>
          <select
            className={styles.accountSelect}
            value={pin.account ?? ""}
            onChange={(e) => {
              const next = e.target.value || null;
              writePin(next, next ? pin.model : null);
            }}
            data-conductor-account-select
          >
            <option value="">auto (global default)</option>
            {accountRows.map((a) => <option key={a.name} value={a.name}>{a.name} · {a.provider}</option>)}
          </select>
          <input
            // Re-keyed on the saved value so a refresh after the RPC re-seeds the
            // uncontrolled input instead of leaving the operator's stale text behind.
            key={`${name}:${pin.model ?? ""}`}
            className={`${styles.hookInput} ${styles.hookTimeoutInput}`}
            defaultValue={pin.model ?? ""}
            placeholder="model (optional)"
            title="the model this project's conductor is born on — blank = the provider's default"
            onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (pin.model ?? "")) writePin(pin.account, v || null); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            data-conductor-model-input
          />
          <select
            className={styles.accountSelect}
            value={pin.permissionProfile ?? ""}
            onChange={(e) => writePin(pin.account, pin.model, e.target.value || null)}
            title="Permissions for the next project conductor start; full is supported by Claude and Codex"
            data-conductor-profile-select
          >
            <option value="">profile: global default</option>
            <option value="readOnly">readOnly</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="full">full</option>
          </select>
          {pin.restartRequired && (
            <span className={styles.conductorPinWarn} data-conductor-pin-restart>
              live conductor still on {pin.liveAccount} — stop &amp; start it to apply
            </span>
          )}
          <span className={styles.settingsHint}>
            Account, model and permissions for the next conductor start. Every project conductor has full autonomy and team management enabled. Changes apply after stopping and starting the conductor.
          </span>
        </div>
        <div className={styles.settingsRow}>
          {editingHook ? (
            <input
              className={styles.hookInput}
              autoFocus
              defaultValue={hookCommand}
              placeholder="node scripts/setup-worktree-modules.mjs"
              onBlur={(e) => submitHook(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitHook(e.currentTarget.value);
                else if (e.key === "Escape") cancelHookEdit();
              }}
              data-worktree-setup-hook-input
            />
          ) : editingHookTimeout ? (
            <input
              className={`${styles.hookInput} ${styles.hookTimeoutInput}`}
              autoFocus
              defaultValue={String(hookTimeoutSec)}
              placeholder="300"
              title="seconds before the hook is killed and the spawn refused (1–900)"
              onBlur={(e) => submitHookTimeout(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitHookTimeout(e.currentTarget.value);
                else if (e.key === "Escape") cancelHookEdit();
              }}
              data-worktree-setup-hook-timeout-input
            />
          ) : (
            <>
              <span
                className={hookEnabled ? styles.settingsToggleOn : styles.settingsToggleOff}
                role="switch"
                aria-checked={hookEnabled}
                title={hookSpec ? (hookEnabled ? "click to pause — spawns stop running it" : "click to resume") : "click to set a bootstrap command"}
                onClick={() => {
                  if (hookSpec) {
                    writeHook({ command: hookCommand, timeoutSec: hookTimeoutSec, enabled: !hookEnabled });
                  } else {
                    openHookEditor("command");
                  }
                }}
                data-worktree-setup-hook={hookEnabled ? "on" : hookSpec ? "off" : "unset"}
              >
                {hookEnabled ? "◉" : "◯"} {hookSpec ? "worktree setup hook" : "no worktree setup hook"}
              </span>
              {hookSpec && !hookEnabled && (
                // A configured-but-paused hook otherwise looked identical to "no hook" apart from
                // one glyph — say the word, since a paused hook is a spawn that WON'T be bootstrapped.
                <span className={styles.toneWarn} data-worktree-setup-hook-paused>paused</span>
              )}
              {hookSpec && (
                // Deliberately .hookCommand, not the plan's .pathMeta (QA gap 5): this span is a
                // control — it needs the pointer cursor + hover brighten that .pathMeta must not have.
                <span className={styles.hookCommand} onClick={() => openHookEditor("command")} title="click to edit the command" data-worktree-setup-hook-command>
                  {hookCommand.length > 60 ? `${hookCommand.slice(0, 59)}…` : hookCommand}
                </span>
              )}
              {hookSpec && (
                <span className={styles.hookCommand} onClick={() => openHookEditor("timeout")} title="click to edit the timeout — the hook is killed and the spawn refused after this" data-worktree-setup-hook-timeout>
                  {hookTimeoutSec}s timeout
                </span>
              )}
            </>
          )}
          {hookError && (
            <span className={styles.hookError} role="alert" data-worktree-setup-hook-error>{hookError}</span>
          )}
          <span className={styles.settingsHint}>
            Runs before every worktree spawn in this project — once per new worktree, and again after you change the command. A non-zero exit, a timeout, or a missing program refuses the spawn, so nothing launches. Runs with the daemon&apos;s own privileges, a scrubbed environment and no shell. Operator-set only — agents cannot change it.
          </span>
        </div>
        <div className={styles.chipRow}>
          <span className={styles.faintCell}>teams</span>
          {detail.teams.map((t, i) => (
            <span
              key={t.name}
              className={i === teamIdx ? styles.chipSelected : styles.chip}
              title="r runs this team in this project"
              onClick={() => {
                projectsLocal.set({ teamIdx: i });
                runAction("projects.run", appStore);
              }}
              data-team-chip={t.name}
              data-project-action="projects.run"
            >
              {t.name} {t.running > 0 ? <span className={styles.toneSuccess}>◐{t.running}</span> : <span className={styles.faintCell}>idle</span>}
            </span>
          ))}
          <span className={styles.assignWrap}>
            <span className={styles.assignChip} onClick={() => projectsLocal.set({ assignOpen: !assignOpen })} data-assign-team>
              + assign team ▾
            </span>
            {assignOpen && (
              <span className={styles.assignMenu}>
                {assignable.length === 0 ? (
                  <span className={styles.assignEmpty}>no unassigned teams</span>
                ) : (
                  assignable.map((t) => (
                    <span key={t} className={styles.assignItem} onClick={() => { void getProjectsCommands(appStore, rpcCall).assignTeam(name, t); }} data-assign-item={t}>
                      {t}
                    </span>
                  ))
                )}
              </span>
            )}
          </span>
          <span className={styles.spacer} />
          {queue !== null && (
            <span className={styles.chip}>queue {queue}{detail.queuePending !== null ? ` · ${detail.queuePending} pending` : ""}</span>
          )}
        </div>
      </div>
      <div className={styles.sessHead}>
        <div className={styles.colState}>state</div>
        <div className={styles.colSession}>session</div>
        <div className={styles.colTeamRole}>team · role</div>
        <div className={styles.colBranch}>branch</div>
        <div className={styles.colActivity}>last activity</div>
      </div>
      <div className={styles.sessBody}>
      {sessions.length === 0 ? (
        <div className={styles.emptyHint}>no sessions under {path} — r runs the assigned team here</div>
      ) : (
        sessions.map((s, i) => {
          const visual = s.conductor ? { glyph: "◆", tone: "muted" } : stateVisual(s.state);
          const selected = i === sessionIdx;
          return (
            <div
              key={s.agentId || i}
              className={selected ? styles.sessRowSelected : styles.sessRow}
              onClick={() => onSelectSession(i)}
              onDoubleClick={() => s.agentId && getProjectsCommands(appStore, rpcCall).openSession(s.agentId)}
              data-session-row={s.agentId}
            >
              <div className={styles.colState}>
                <span className={s.conductor ? styles.toneAccent : toneClass[visual.tone]}>{visual.glyph}</span>
                <span className={styles.mutedCell}> {s.conductor ? "conductor" : s.state}</span>
              </div>
              <div className={styles.colSession}>
                <span className={selected ? undefined : styles.softName}>{s.conductor ? conductorLabel(agents, s.agentId, name) : agentName(s.agentId)}</span>
                {!s.conductor && s.agentId && <span className={styles.idMeta}> {shortId(s.agentId)}</span>}
              </div>
              <div className={`${styles.colTeamRole} ${s.team ? styles.mutedCell : styles.faintCell}`}>
                {s.team ? `${s.team} · ${s.role ?? "?"}` : "—"}
              </div>
              <div className={`${styles.colBranch} ${s.branch ? styles.mutedCell : styles.faintCell}`}>{s.branch ?? "—"}</div>
              <div className={styles.colActivity}>{s.activity}</div>
            </div>
          );
        })
      )}
      </div>
      {detail.checkpoints !== null && (
        <div className={styles.checkpointsSection}>
          <div className={styles.checkpointsHead}>
            <span className={styles.faintCell}>checkpoints</span>
            <span className={styles.spacer} />
            <span className={styles.faintCell}>{detail.checkpoints.length}</span>
            <button
              type="button"
              className={styles.checkpointAction}
              onClick={() => invokeProjectTool("checkpoint.create", { cwd: path, trigger: "manual" }, name)}
              data-project-action="checkpoint_create"
            >
              checkpoint now
            </button>
          </div>
          <div className={styles.checkpointsBody}>
            {detail.checkpoints.length === 0 ? (
              <div className={styles.emptyHint}>no checkpoints yet</div>
            ) : (
              detail.checkpoints.map((row) => (
                <div key={row.id} className={styles.checkpointRow} data-project-checkpoint-row={row.id}>
                  <span className={styles.checkpointMark}>⚑</span>
                  <span>{checkpointLabel(row.id)}</span>
                  <span className={styles.faintCell}>{triggerLabel(row)}</span>
                  <span className={styles.spacer} />
                  <span className={styles.faintCell}>{fmtClock(row.ts)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className={styles.filesSection}>
        <div className={styles.filesHead}>
          <span className={styles.faintCell}>files</span>
        </div>
        <div className={styles.filesBody}>
          <FileTree />
        </div>
      </div>
      {detail.files.selected !== null && (
        <FileViewer selected={detail.files.selected} onClose={() => commands.closeFile()} />
      )}
      <PanelFooter>
        enter session → transcript · {displayChord("mod+r")} run team in this project · {displayChord("mod+k")} archive (locked while sessions run) ·
        {" "}{displayChord("mod+shift+x")} delete · files ↑↓←→ browse/expand · enter open/expand · esc close viewer
      </PanelFooter>
    </>
  );
}
