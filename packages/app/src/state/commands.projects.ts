// W7 — Projects/A2A/Plugins command wrappers + their screen-local store.
// project.list/status/import/assignTeam/archive and plugins.list/toggle over
// the ONE rpc door, with dispatches into (a) the shared ui-state store (toasts
// via commandError, cross-screen navigation via selectAgent/selectTab) and
// (b) a module-local projections store — the projects master/detail payloads,
// the plugins card state and the slash-popup project-command cache have NO
// ui-state slots (the W7 ui-state grant is TabId + unseen only), so they live
// here exactly like commands.agents.ts's composerLocal. Structured like
// commands.coord.ts: a PURE factory over injected deps (no bridge import) so
// the behaviors are unit-testable against stub stores; screens bind the
// singleton with the real appStore + rpcCall via getProjectsCommands.
import { useSyncExternalStore } from "react";
import type { UiStore } from "@chimera/ui-state";
import type { CheckpointRecord, CheckpointStatus, FsEntry, FsListResult, FsReadResult, ProjectSpec } from "@chimera/protocol";
import type { RequestFn } from "./commands.coord";
import { buildCreateParams, buildImportParams, catalogRows, filterProjects, isBlankProjectForm, projectRow, type ImportFormValues, type PluginRowView, type ProjectRow } from "./selectors.projects";
import { checkpointRow, type CheckpointRow } from "./selectors.checkpoints";

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// ---------------------------------------------------------------------------
// the W7 local store
// ---------------------------------------------------------------------------

// FILEBROWSER-T5 (PROJECT-FILE-BROWSER, PM 031b5a82): a single directory
// listing, keyed by its RELATIVE path ("" = project root) in ProjectFilesState.dirs.
// Modeled as a tagged union (not entries+error side-by-side) so a stale listing
// can never leak through alongside its own failure.
export type FsDirState =
  | { status: "ok"; entries: FsEntry[]; truncated: boolean }
  | { status: "error"; message: string };

// The selected-file viewer's state — same tagged-union discipline as FsDirState,
// `null` when no file is open.
export type FsSelectedFile =
  | { path: string; status: "ok"; result: FsReadResult }
  | { path: string; status: "error"; message: string };

export type ProjectFilesState = {
  /** every listing fetched so far: "" (root) plus one entry per expanded dir —
   * doubles as the "which dirs are expanded" set for refresh() to re-list. */
  dirs: Record<string, FsDirState>;
  selected: FsSelectedFile | null;
};

export type ProjectDetail = {
  spec: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  teams: Array<{ name: string; running: number }>;
  /** pending count of the spec's bound queue (queue.status), null when none. */
  queuePending: number | null;
  /** P3-T4 (PLAN-PROJECT-CONDUCTOR-ROUTING.md): this PROJECT's checkpoint
   * history (checkpoint.status/list over spec.path) — a project-focused
   * surface independent of agent selection. `null` means the section renders
   * nothing: a non-git project path (D16/F20 "non-git cwd stays dark") or a
   * failed fetch. `[]` is the supported-but-empty case ("no checkpoints yet"). */
  checkpoints: CheckpointRow[] | null;
  /** FILEBROWSER-T5: the file-browser panel's data — root listing, the
   * lazily-fetched expanded-dir cache, and the selected-file viewer state. */
  files: ProjectFilesState;
};

export type ProjectsLocalState = {
  items: ProjectRow[];
  cursor: number;
  /** free-text SearchBox query over the master list (name + path); lives here
   * (not React state) so move()/requestArchive() — which read live state
   * outside React's render cycle — see it too. */
  query: string;
  detail: ProjectDetail | null;
  sessionIdx: number;
  /** keyboard focus INTO the sessions table (arrows move sessionIdx there) vs
   * on the master project list (arrows move cursor) — selection alone shows
   * `detail`; this only gates which sub-list ↑↓ steers. Set by enter/dblclick. */
  sessionFocused: boolean;
  /** which assigned team `r` runs / the chip row highlights (index into spec.teams). */
  teamIdx: number;
  formOpen: boolean;          // ImportCard
  /** PROJECT-DEFAULT-DIR: config.projectImportDir, fetched lazily when the
   * ImportCard opens — lets it preview the resolved <dir>/<name> path for a
   * blank (no-source) create. null while unloaded OR when unset server-side
   * (falls back to the literal "$CHIMERA_HOME/projects" hint, same as Settings). */
  importDirHint: string | null;
  assignOpen: boolean;        // "+ assign team ▾" menu
  confirmArchive: string | null;  // project name awaiting the ConfirmCard gate
  confirmDelete: string | null;   // project name awaiting the delete ConfirmCard gate
  confirmDeleteFiles: boolean;    // the delete card's "also delete files on disk" toggle (default OFF)
  /** DOUBLE-SUBMIT-SWEEP: true for the whole project.delete round-trip. Unlike
   * archiveProject/dissolveTeam/etc, deleteProject deliberately keeps the
   * ConfirmCard mounted (and confirmDelete non-null) on a refusal so the
   * inline deleteError can render (B12) — so confirmDelete's presence can't
   * double as the re-entrancy guard here the way it does elsewhere. This
   * flag is that guard. */
  deleting: boolean;
  /** the delete card's INLINE error (mirrors ImportCard's formError) — a
   * {code:"conflict"} refusal keeps the card open with this message shown,
   * instead of just the global commandError toast, so the operator sees the
   * daemon's reason without losing the dialog. Never auto-retried. */
  deleteError: string | null;
  // a2a
  a2aHistoryOpen: boolean;
  // plugins card
  pluginsOpen: boolean;
  pluginIdx: number;
  pluginDetail: boolean;      // enter — expand the selected row's full source/id line
  pluginCatalog: PluginRowView[];   // plugins.list rows (global + project commands)
  pluginProjectLabel: string | null; // label of the project whose cwd fed {cwd}
  /** session-local toggle replies for NON-cataloged ids (spawn-spec skill rows). */
  pluginOverrides: Record<string, boolean>;
  /** slash-popup cache: ENABLED project commands for the SELECTED agent's cwd. */
  commandsForAgent: { agentId: string; rows: PluginRowView[] } | null;
  // files panel (FILEBROWSER-T6) — index into FileTree's own flattened row
  // list + whether it currently owns keyboard focus, same store-index/focus-flag
  // convention as sessionIdx/sessionFocused above. Expand/collapse + filter
  // state stay LOCAL to FileTree (pure view concerns); only the cursor position
  // and focus ownership live here, so a future mount point (T8) can read them.
  filesIdx: number;
  filesFocused: boolean;
};

const initialLocal: ProjectsLocalState = {
  items: [],
  cursor: 0,
  query: "",
  detail: null,
  sessionIdx: 0,
  sessionFocused: false,
  teamIdx: 0,
  formOpen: false,
  importDirHint: null,
  assignOpen: false,
  confirmArchive: null,
  confirmDelete: null,
  confirmDeleteFiles: false,
  deleting: false,
  deleteError: null,
  a2aHistoryOpen: false,
  pluginsOpen: false,
  pluginIdx: 0,
  pluginDetail: false,
  pluginCatalog: [],
  pluginProjectLabel: null,
  pluginOverrides: {},
  commandsForAgent: null,
  filesIdx: 0,
  filesFocused: false,
};

export type ProjectsLocalStore = {
  getState(): ProjectsLocalState;
  set(patch: Partial<ProjectsLocalState>): void;
  subscribe(fn: () => void): () => void;
  reset(): void;
};

export function createProjectsLocal(): ProjectsLocalStore {
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
    reset() {
      state = initialLocal;
      for (const fn of listeners) fn();
    },
  };
}

/** The ONE app-wide W7 local store (module singleton — pure, no IO). */
export const projectsLocal: ProjectsLocalStore = createProjectsLocal();

/** React binding — same selector discipline as useStore (read existing refs). */
export function useProjectsLocal<T>(selector: (s: ProjectsLocalState) => T): T {
  return useSyncExternalStore(projectsLocal.subscribe, () => selector(projectsLocal.getState()));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type ProjectsCommands = ReturnType<typeof createProjectsCommands>;

export function createProjectsCommands(local: ProjectsLocalStore, store: UiStore, request: RequestFn) {
  /** Fire-and-forget guard for keybinding-driven calls: an RPC rejection
   * surfaces as lastError (the toast/footer channel), never as a crash. */
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  const loadProjects = (): Promise<void> =>
    guarded(async () => {
      const items = (await request<Array<Record<string, unknown>>>("project.list", {})).map(projectRow);
      // clamp against the FILTERED count — the cursor indexes into whatever the
      // active query leaves visible, never the raw list.
      const visible = filterProjects(items, local.getState().query).length;
      const cursor = Math.max(0, Math.min(local.getState().cursor, visible - 1));
      local.set({ items, cursor });
    });

  // P3-T4: this PROJECT's checkpoint history (D16's checkpoint.status/list,
  // keyed off the project's OWN path — never an agent's spec.cwd, which is
  // what makes this surface project-focused rather than selection-driven).
  // Mirrors the strip's own dark-on-non-git / dark-on-failure guard
  // (commands.checkpoints.ts's refreshStatus): `null` for either case, `[]`
  // for a supported-but-empty repo.
  const fetchCheckpoints = async (path: string): Promise<CheckpointRow[] | null> => {
    try {
      const status = await request<CheckpointStatus>("checkpoint.status", { cwd: path });
      if (!status.supported) return null;
      const rows = await request<CheckpointRecord[]>("checkpoint.list", { cwd: path });
      return rows.map(checkpointRow);
    } catch {
      return null;
    }
  };

  // FILEBROWSER-T5: one dir listing, never throws — an fs.list failure (bad
  // path, daemon-side guard refusal, ...) degrades to the tagged-union error
  // branch so the tree can render an inline message instead of crashing the drill.
  const fetchDir = async (project: string, path: string): Promise<FsDirState> => {
    try {
      const result = await request<FsListResult>("fs.list", { project, path });
      return { status: "ok", entries: result.entries, truncated: result.truncated };
    } catch (err) {
      return { status: "error", message: errMessage(err) };
    }
  };

  // Refetches every path in `paths` (always including the root ""), in
  // parallel — used both for the initial root-only fetch (openDetail) and a
  // refresh that must re-list every dir the user has expanded so far.
  // `priorSelected` rides through UNCHANGED: a refresh must not silently
  // re-read (or drop) the open file viewer.
  const fetchFiles = async (project: string, paths: string[], priorSelected: FsSelectedFile | null): Promise<ProjectFilesState> => {
    const keys = paths.includes("") ? paths : ["", ...paths];
    const pairs = await Promise.all(keys.map(async (path): Promise<[string, FsDirState]> => [path, await fetchDir(project, path)]));
    return { dirs: Object.fromEntries(pairs), selected: priorSelected };
  };

  const fetchDetail = async (name: string, priorFiles?: ProjectFilesState): Promise<ProjectDetail> => {
    const status = await request<{ spec: Record<string, unknown>; sessions: Array<Record<string, unknown>>; teams: Array<{ name: string; running: number }> }>(
      "project.status", { name },
    );
    // "queue X · N pending" chip — resolved alongside the drill; a failed
    // queue.status (ghost queue) degrades to a count-less chip, never an error.
    let queuePending: number | null = null;
    const queue = status.spec["queue"];
    if (typeof queue === "string") {
      try {
        const qs = await request<{ counts?: Record<string, number> }>("queue.status", { queue });
        queuePending = typeof qs.counts?.["pending"] === "number" ? qs.counts["pending"] : 0;
      } catch { /* count-less chip */ }
    }
    const path = status.spec["path"];
    const checkpoints = typeof path === "string" && path ? await fetchCheckpoints(path) : null;
    // Sessions NEWEST-FIRST (user request): the daemon returns them oldest→newest;
    // sort by createdAt desc so the most recent session is at the top of the
    // table. Sorted HERE at the source so the rendered rows AND the keyboard
    // cursor (which indexes into detail.sessions) share one order — no desync.
    const sessions = [...status.sessions].sort(
      (a, b) => (Number(b["createdAt"]) || 0) - (Number(a["createdAt"]) || 0),
    );
    const files = await fetchFiles(name, priorFiles ? Object.keys(priorFiles.dirs) : [""], priorFiles?.selected ?? null);
    return { spec: status.spec, sessions, teams: status.teams, queuePending, checkpoints, files };
  };

  const openDetail = (name: string): Promise<void> =>
    guarded(async () => {
      local.set({ detail: await fetchDetail(name), sessionIdx: 0, teamIdx: 0, assignOpen: false });
    });

  const refresh = (): Promise<void> =>
    guarded(async () => {
      await loadProjects();
      const open = local.getState().detail;
      const name = open?.spec["name"];
      if (open && typeof name === "string") {
        // keep cursors — a live refresh must not yank the selection
        local.set({ detail: await fetchDetail(name, open.files) });
      }
    });

  // FILEBROWSER-T9: the sessionSeq-driven refresh (ProjectsScreen) fires on
  // every agent_started/status/result/error event — a burst of those (several
  // agents starting/finishing close together) would otherwise re-list every
  // expanded dir once PER event. Trailing-debounce collapses a burst into one
  // refresh(); `refresh()` itself stays undebounced for direct callers (the
  // "bind just changed the workflow" pattern elsewhere re-fetches on demand
  // and expects it to run immediately).
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const REFRESH_DEBOUNCE_MS = 300;
  const refreshDebounced = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  return {
    loadProjects,
    openDetail,
    refresh,
    refreshDebounced,

    closeDetail: (): void => local.set({ detail: null, assignOpen: false }),

    /** SearchBox onChange — a fresh query invalidates the old cursor position
     * (it pointed at a row that may no longer be visible), so it resets to the
     * top of whatever the new query leaves shown. */
    setQuery: (query: string): void => local.set({ query, cursor: 0 }),

    /** PROJECT-DEFAULT-DIR: config.projectImportDir, for the ImportCard's
     * resolved-path preview on a blank (no-source) create. Best-effort — a
     * failed fetch just leaves the hint null (the card falls back to the
     * literal "$CHIMERA_HOME/projects" placeholder, same as Settings). */
    loadImportDirHint: async (): Promise<void> => {
      try {
        const cfg = await request<{ projectImportDir?: unknown }>("config.get", {});
        local.set({ importDirHint: typeof cfg?.projectImportDir === "string" ? cfg.projectImportDir : null });
      } catch { /* leave the previous hint (or null) */ }
    },

    /** project.import (source given) or project.create (source left empty —
     * PROJECT-DEFAULT-DIR blank project, path defaults server-side under the
     * configured import dir). REJECTS on failure so ImportCard shows the error
     * inline; the toast channel (commandError) fires too per the brief
     * ("clone errors surface inline + toast"). */
    importProject: async (values: ImportFormValues): Promise<void> => {
      let spec: ProjectSpec | undefined;
      try {
        spec = isBlankProjectForm(values)
          ? await request<ProjectSpec>("project.create", buildCreateParams(values))
          : await request<ProjectSpec>("project.import", buildImportParams(values));
      } catch (err) {
        store.dispatch({ type: "commandError", message: errMessage(err) });
        throw err;
      }
      await loadProjects();
      // NEW-PROJECT-CONDUCTOR-WINDOW: a fresh (auto-conductor) project eager-spawns its
      // conductor server-side (core PROJECT-EAGER-CONDUCTOR), so project.create/import
      // returns a spec already carrying its conductorId. Surface it as a talkable window
      // right away — the SAME selectAgent+selectTab pair openSession uses — so creating a
      // project drops you straight into its conductor's transcript instead of leaving the
      // Agents tab empty of any window to type into. The conductor's agent_started may still
      // be in flight; the reducer tolerates an auto-select target that isn't in state.agents
      // yet (see selectAgent), so the row lights up selected the instant it lands. A project
      // created with autoConductor:false returns conductorId:null → no navigation (nothing
      // to focus), preserving today's behavior.
      if (spec?.conductorId) {
        store.dispatch({ type: "selectAgent", agentId: spec.conductorId });
        store.dispatch({ type: "selectTab", tab: "agents" });
      }
    },

    /** "+ assign team ▾" → project.assignTeam, then refresh the drill. */
    assignTeam: (project: string, team: string): Promise<void> =>
      guarded(async () => {
        await request("project.assignTeam", { project, team });
        local.set({ assignOpen: false });
        await refresh();
      }),

    /** PROJTEAM-T7: the detail pane's "load project & global skills" switch —
     * project.setLoadProjectSettings, then refresh so the switch reflects the
     * daemon's authoritative value. Takes effect on the NEXT conductor spawn /
     * project-native team sync, never retroactively on live sessions. */
    setLoadProjectSettings: (project: string, value: boolean): Promise<void> =>
      guarded(async () => {
        await request("project.setLoadProjectSettings", { project, value });
        await refresh();
      }),

    /** PROJECT-CONDUCTOR-ACCOUNT: the detail pane's conductor account/model pin —
     * project.setConductorAccount, then refresh so the row shows the daemon's
     * authoritative value (and the reply's restartRequired hint re-derives from
     * the fresh spec + sessions). `account: null` clears the pin back to the
     * global default. NEVER retroactive: a live conductor keeps its account
     * until project_conductor_stop → project_conductor_start. */
    setConductorAccount: (
      project: string, account: string | null, model: string | null,
      permissionProfile?: string | null,
    ): Promise<void> =>
      guarded(async () => {
        // permissionProfile is OMITTED unless the caller passes one — the RPC reads an absent
        // key as "leave it alone", and this pane must not wipe a project's profile just because
        // the operator came here to change the account.
        await request("project.setConductorAccount", {
          project, account, model,
          ...(permissionProfile !== undefined ? { permissionProfile } : {}),
        });
        await refresh();
      }),

    /** F26: the detail pane's worktree setup hook — project.setSetupHook, then refresh so the
     * row reflects the daemon's authoritative value. Takes effect on the NEXT worktree spawn. */
    setSetupHook: (project: string, hook: { command: string; timeoutSec: number; enabled: boolean } | null): Promise<void> =>
      guarded(async () => {
        await request("project.setSetupHook", { project, hook });
        await refresh();
      }),

    /** Destructive — only ever reached through the ConfirmCard gate. The
     * daemon REFUSES with {code:"conflict"} while live sessions run under the
     * path; guarded() surfaces that refusal as the error toast (B12). */
    archiveProject: (name: string): Promise<void> =>
      guarded(async () => {
        await request("project.archive", { name });
        const open = local.getState().detail;
        if (open?.spec["name"] === name) local.set({ detail: null });
        await loadProjects();
      }),

    /** Destructive — permanently frees the project's name (project.delete),
     * optionally wiping its on-disk directory too (deleteFiles). Same conflict
     * guard as archive (any live session under the path refuses); UNLIKE
     * archiveProject/guarded(), a refusal does NOT just toast — it also sets
     * deleteError so the ConfirmCard stays open with the daemon's reason shown
     * inline (B12 conflict-surface requirement). Never auto-retried; the
     * operator must close the card or act on the message themselves. */
    deleteProject: async (name: string, deleteFiles: boolean): Promise<void> => {
      if (local.getState().deleting) return;
      local.set({ deleting: true });
      let result: { orphanedTeams?: Array<{ team: string; queue?: string }> } | undefined;
      try {
        result = await request("project.delete", { name, ...(deleteFiles ? { deleteFiles: true } : {}) }) as typeof result;
      } catch (err) {
        const message = errMessage(err);
        local.set({ deleting: false, deleteError: message });
        store.dispatch({ type: "commandError", message });
        return;
      }
      const open = local.getState().detail;
      if (open?.spec["name"] === name) local.set({ detail: null });
      local.set({ deleting: false, confirmDelete: null, confirmDeleteFiles: false, deleteError: null });
      // ORPHANED-TEAMS-ON-DELETE: the project is gone but its teams and their bound queues are
      // not — they keep draining work that now belongs to no project. Said out loud, because the
      // way this surfaced instead was a fleet whose queue workers rendered under an unrelated
      // conductor, which reads as a broken tree rather than as a dangling team.
      const orphaned = result?.orphanedTeams ?? [];
      if (orphaned.length > 0) {
        const named = orphaned.map((t) => (t.queue ? `${t.team} (queue ${t.queue})` : t.team)).join(", ");
        store.dispatch({
          type: "notice",
          message: `project "${name}" is gone, but ${orphaned.length} team(s) outlived it and still drain their queues: ${named}. Reassign them to another project or dissolve them.`,
        });
      }
      await loadProjects();
    },

    /** `r` — run the selected assigned team IN this project (coverage B12:
     * "team roles cwd=proje path'i ile spawn"). HONEST MECHANISM (documented):
     * the scheduler only ever spawns workers FOR QUEUE TASKS (scheduler.ts
     * spawnForTask — that is also the only path that stamps membership), so:
     *   * team WITH a bound queue → one queue.push per role with overrides
     *     {cwd: project.path, isolation:"none"} — the scheduler drains them
     *     into role spawns whose cwd IS the project path (isolation:"none"
     *     keeps the session physically under the path, the same locked
     *     decision conductors use — a worktree checkout would land outside it
     *     and vanish from the sessions table), with team·role membership
     *     stamped, so the sessions table fills with real team rows.
     *   * team WITHOUT a queue → direct agent.spawn per role from the role
     *     template (poolSize/persistent stripped — a persistent pool without
     *     a queue to drain is scheduler-owned machinery). Coverage B12b: the
     *     spawn carries the same {team, role} membership the scheduler's queued
     *     path stamps (SpawnParams.membership → supervisor.spawn), so these
     *     sessions fill the sessions-table team·role column instead of "—".
     * REJECTS with a notice when the project has no assigned team. */
    runTeam: (): Promise<void> =>
      guarded(async () => {
        const s = local.getState();
        const detail = s.detail;
        if (!detail) return;
        const project = String(detail.spec["name"] ?? "");
        const path = String(detail.spec["path"] ?? "");
        const teams = Array.isArray(detail.spec["teams"]) ? (detail.spec["teams"] as string[]) : [];
        const team = teams[Math.min(s.teamIdx, Math.max(0, teams.length - 1))];
        if (!team) {
          store.dispatch({ type: "commandError", message: `project "${project}" has no assigned team — assign one first (+ assign team ▾)` });
          return;
        }
        const specs = await request<Array<Record<string, unknown>>>("team.list", {});
        const teamSpec = specs.find((t) => t["name"] === team);
        if (!teamSpec) throw new Error(`unknown team "${team}"`);
        const roles = teamSpec["roles"] && typeof teamSpec["roles"] === "object" ? (teamSpec["roles"] as Record<string, Record<string, unknown>>) : {};
        const queue = typeof teamSpec["queue"] === "string" ? (teamSpec["queue"] as string) : null;
        for (const [role, template] of Object.entries(roles)) {
          const prompt = `[project ${project}] ${role}: work in ${path} — review the repo state and take up your role's next task.`;
          if (queue) {
            await request("queue.push", {
              queue, prompt, role,
              overrides: { cwd: path, isolation: "none" },
              pushedBy: "app",
            });
          } else {
            const { poolSize: _p, persistent: _q, ...rest } = template as Record<string, unknown> & { poolSize?: unknown; persistent?: unknown };
            await request("agent.spawn", { spec: { ...rest, prompt, cwd: path, isolation: "none" }, membership: { team, role } });
          }
        }
        store.dispatch({ type: "notice", message: `team ${team} started in ${project} (${Object.keys(roles).length} role${Object.keys(roles).length === 1 ? "" : "s"})` });
        await refresh();
      }),

    /** Sessions-table enter / a2a row click → that agent's transcript on the
     * Agents tab (the ONE selectTab+selectAgent pair, PLAN §0.4 parity). */
    openSession: (agentId: string): void => {
      store.dispatch({ type: "selectAgent", agentId });
      store.dispatch({ type: "selectTab", tab: "agents" });
    },

    // ---- FILEBROWSER-T5: files panel ---------------------------------------

    /** Tree expand → fs.list for that dir ONLY IF not already cached — a
     * re-expand of an already-open dir is a pure UI toggle (T6's concern),
     * never a refetch. Re-reads `detail` after the await (stale-selection
     * guard): if the user switched projects mid-flight, the reply is dropped. */
    expandDir: (path: string): Promise<void> =>
      guarded(async () => {
        const detail = local.getState().detail;
        if (!detail || path in detail.files.dirs) return;
        const name = String(detail.spec["name"] ?? "");
        const dir = await fetchDir(name, path);
        const current = local.getState().detail;
        if (!current || current.spec["name"] !== name) return;
        local.set({ detail: { ...current, files: { ...current.files, dirs: { ...current.files.dirs, [path]: dir } } } });
      }),

    /** File row click → fs.read; drives the FileViewer (T7). Same
     * stale-selection guard as expandDir — a slow read for a project the user
     * has since navigated away from must never clobber the new detail. */
    selectFile: (path: string): Promise<void> =>
      guarded(async () => {
        const detail = local.getState().detail;
        if (!detail) return;
        const name = String(detail.spec["name"] ?? "");
        let selected: FsSelectedFile;
        try {
          const result = await request<FsReadResult>("fs.read", { project: name, path });
          selected = { path, status: "ok", result };
        } catch (err) {
          selected = { path, status: "error", message: errMessage(err) };
        }
        const current = local.getState().detail;
        if (!current || current.spec["name"] !== name) return;
        local.set({ detail: { ...current, files: { ...current.files, selected } } });
      }),

    /** Viewer close — pure local state, no RPC. */
    closeFile: (): void => {
      const current = local.getState().detail;
      if (!current) return;
      local.set({ detail: { ...current, files: { ...current.files, selected: null } } });
    },

    // ---- plugins card ------------------------------------------------------

    /** Load the card's catalog: plugins.list with the SELECTED AGENT's cwd
     * (agent.status → spec.cwd) so project commands for the repo the agent is
     * actually in appear; no selection (or a ghost) degrades to the global
     * catalog. The project label for command rows is the cwd's project match
     * (items list) or its basename. */
    loadPluginCatalog: (): Promise<void> =>
      guarded(async () => {
        const selected = store.getState().selectedAgentId;
        let cwd: string | null = null;
        if (selected) {
          try {
            const status = await request<Record<string, unknown>>("agent.status", { agentId: selected });
            const spec = status["spec"] && typeof status["spec"] === "object" ? (status["spec"] as Record<string, unknown>) : null;
            cwd = spec && typeof spec["cwd"] === "string" ? (spec["cwd"] as string) : null;
          } catch { /* ghost/remote agent → global catalog only */ }
        }
        const entries = await request<Array<Record<string, unknown>>>("plugins.list", cwd ? { cwd } : {});
        const label = cwd
          ? local.getState().items.find((p) => cwd === p.path || cwd.startsWith(`${p.path}/`))?.name ?? cwd.split("/").filter(Boolean).pop() ?? null
          : null;
        const catalog = catalogRows(entries, label);
        local.set({
          pluginCatalog: catalog,
          pluginProjectLabel: label,
          pluginIdx: Math.max(0, Math.min(local.getState().pluginIdx, catalog.length - 1)),
          // the slash-popup cache rides the SAME fetch (enabled command rows only)
          ...(selected ? { commandsForAgent: { agentId: selected, rows: catalog.filter((r) => r.kind === "command") } } : {}),
        });
      }),

    /** space — plugins.toggle (persisted daemon-side; NEW spawns only, the
     * card's own footer states the rule verbatim). The row list refreshes
     * from the RPC's authoritative reply. */
    togglePlugin: (id: string, enabled: boolean): Promise<void> =>
      guarded(async () => {
        const res = await request<{ id: string; enabled: boolean }>("plugins.toggle", { id, enabled });
        const patch = (rows: PluginRowView[]): PluginRowView[] =>
          rows.map((r) => (r.id === res.id ? { ...r, enabled: res.enabled } : r));
        const s = local.getState();
        local.set({
          pluginCatalog: patch(s.pluginCatalog),
          commandsForAgent: s.commandsForAgent ? { ...s.commandsForAgent, rows: patch(s.commandsForAgent.rows) } : null,
          // non-cataloged ids (spawn-spec skill rows) re-render through this map
          pluginOverrides: { ...s.pluginOverrides, [res.id]: res.enabled },
        });
      }),
  };
}

// The app-side singleton: bound lazily by the first caller with the deps IT
// imports — this module itself stays free of bridge/store imports for tests.
let singleton: ProjectsCommands | null = null;
export function getProjectsCommands(store: UiStore, request: RequestFn): ProjectsCommands {
  if (!singleton) singleton = createProjectsCommands(projectsLocal, store, request);
  return singleton;
}
