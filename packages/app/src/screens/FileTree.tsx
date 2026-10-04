import { useEffect, useMemo, useState } from "react";
import type { FsDirState } from "../state/commands.projects";
import { getProjectsCommands, projectsLocal, useProjectsLocal } from "../state/commands.projects";
import { registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { SearchBox } from "../components/SearchBox";
import styles from "./FileTree.module.css";

// FILEBROWSER-T6 (PROJECT-FILE-BROWSER, PM 031b5a82): the lazy file tree,
// self-contained over T5's store exactly like ProjectsScreen owns its own
// `commands`/`detail` — DetailBody wiring is T8's job, but this component
// needs no props: `detail` comes straight off projectsLocal (whatever
// openDetail/refresh last populated), and expandDir/selectFile go through the
// SAME getProjectsCommands(appStore, rpcCall) singleton ProjectsScreen uses,
// so a T8 mount and this file's own tests observe the identical store.
// filesIdx/filesFocused live in that shared store (not component state) —
// same convention as sessionIdx/sessionFocused — so a future owner (T8) can
// read/steer them from outside this component too. Expand/collapse and the
// filter are pure view state (never persisted) —
// mirrors FlowPane's local `collapsed` set for the same reason: re-expanding
// an already-fetched dir must never re-fetch (that cache lives in the store;
// this is just which of the cached dirs are currently unfolded).

const GIT_MARK: Record<string, { glyph: string; tone: string }> = {
  // Tone convention borrowed from MessageBody's CI hex guard (add→success,
  // modify→warn, delete/unknown→danger, everything else→faint).
  staged: { glyph: "●", tone: "success" },
  modified: { glyph: "M", tone: "warn" },
  untracked: { glyph: "U", tone: "danger" },
  ignored: { glyph: "I", tone: "faint" },
};

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  faint: styles.toneFaint!,
};

type FlatRow =
  | { type: "entry"; path: string; name: string; depth: number; isDir: boolean; gitStatus: string | null; expanded: boolean }
  | { type: "truncated"; path: string; depth: number }
  | { type: "error"; path: string; depth: number; message: string }
  | { type: "loading"; path: string; depth: number };

// FILEBROWSER-T9: fs.list's own daemon-side refusals (fsbrowse.ts's
// ProjectPathError, always {code:"protocol"} regardless of the underlying
// errno today) come through as free-text messages — this maps the two shapes
// worth a friendlier inline label onto themselves; anything else (escapes,
// "not a directory", ...) passes through verbatim rather than inventing a
// misleading label for a case it can't actually distinguish.
export function classifyFsError(message: string): string {
  if (/no such file or directory/i.test(message)) return "path unavailable";
  if (/eacces|permission denied/i.test(message)) return "permission denied";
  return message;
}

// Sorted dirs-first-then-alpha for a stable, scannable tree — fsbrowse.ts
// hands back raw readdir order, so this is purely a presentation concern.
function sortedEntries(state: FsDirState): Array<{ name: string; kind: string; gitStatus: string | null }> {
  if (state.status !== "ok") return [];
  return [...state.entries].sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Pure — recursively flattens the fetched/expanded subtree into visible rows,
 * applying the ignored-files toggle and the (already-debounced) filter query.
 * A dir survives a non-empty filter if ITS OWN name matches OR any row within
 * its currently-fetched+expanded subtree does — collapsed/unfetched subtrees
 * are never searched (this narrows what's already loaded, it never fetches). */
export function flattenFileTree(dirs: Record<string, FsDirState>, expanded: ReadonlySet<string>, filterQuery: string, showIgnored: boolean): FlatRow[] {
  const q = filterQuery.trim().toLowerCase();

  function visitEntry(name: string, kind: string, gitStatus: string | null, path: string, depth: number): FlatRow[] | null {
    const selfMatch = !q || name.toLowerCase().includes(q);
    const isDir = kind === "dir";
    const isExpanded = isDir && expanded.has(path);
    const childRows = isExpanded ? visitDir(path, depth + 1) : [];
    if (!selfMatch && childRows.length === 0) return null;
    const row: FlatRow = { type: "entry", path, name, depth, isDir, gitStatus, expanded: isExpanded };
    return [row, ...childRows];
  }

  function visitDir(path: string, depth: number): FlatRow[] {
    const state = dirs[path];
    // fetch still in flight — root is always populated by the time `detail`
    // exists (openDetail awaits it), so this only fires for a lazy expandDir.
    if (!state) return [{ type: "loading", path, depth }];
    if (state.status === "error") return [{ type: "error", path, depth, message: classifyFsError(state.message) }];
    let entries = sortedEntries(state);
    if (!showIgnored) entries = entries.filter((e) => e.gitStatus !== "ignored");
    const out: FlatRow[] = [];
    for (const e of entries) {
      const childPath = path ? `${path}/${e.name}` : e.name;
      const rows = visitEntry(e.name, e.kind, e.gitStatus, childPath, depth);
      if (rows) out.push(...rows);
    }
    if (state.truncated && (!q || out.length > 0 || entries.length > 0)) out.push({ type: "truncated", path, depth });
    return out;
  }

  return visitDir("", 0);
}

function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const commands = getProjectsCommands(appStore, rpcCall);

export function FileTree() {
  const detail = useProjectsLocal((s) => s.detail);
  const filesIdx = useProjectsLocal((s) => s.filesIdx);
  const project = detail ? String(detail.spec["name"] ?? "") : "";
  const dirs = detail?.files.dirs ?? {};
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filterInput, setFilterInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);

  // A project switch invalidates every bit of this view state — an expanded
  // dir path or a cursor index from the PREVIOUS project's tree means nothing here.
  useEffect(() => {
    setExpanded(new Set());
    setFilterInput("");
    setFilterQuery("");
    projectsLocal.set({ filesIdx: 0 });
  }, [project]);

  // debounce: the input updates immediately, the actual narrowing lags ~150ms
  useEffect(() => {
    const t = setTimeout(() => setFilterQuery(filterInput), 150);
    return () => clearTimeout(t);
  }, [filterInput]);

  const rows = useMemo(
    () => flattenFileTree(dirs, expanded, filterQuery, showIgnored),
    [dirs, expanded, filterQuery, showIgnored],
  );
  // the SAME currently-loaded tree, unfiltered — SearchBox's "N of M" count
  const unfilteredRows = useMemo(
    () => flattenFileTree(dirs, expanded, "", showIgnored),
    [dirs, expanded, showIgnored],
  );

  // clamp the cursor whenever the visible row count shrinks (filter, collapse)
  useEffect(() => {
    if (rows.length === 0 && filesIdx !== 0) projectsLocal.set({ filesIdx: 0 });
    else if (filesIdx > rows.length - 1) projectsLocal.set({ filesIdx: Math.max(0, rows.length - 1) });
  }, [rows.length, filesIdx]);

  // Claims the projects-scope up/down/enter actions WHILE MOUNTED — the same
  // "last registration wins, shadowing the screen's own handler" precedent
  // mod+e/the FlowPane fold rows already use — plus the two NEW left/right
  // rows (rows.projects.ts) this task adds since the master list never bound them.
  useEffect(() => {
    projectsLocal.set({ filesFocused: true });

    const at = (i: number): FlatRow | undefined => rows[i];

    const move = (delta: number) => () => {
      const s = projectsLocal.getState();
      projectsLocal.set({ filesIdx: Math.max(0, Math.min(rows.length - 1, s.filesIdx + delta)) });
    };

    const openOrExpand = () => {
      const row = at(projectsLocal.getState().filesIdx);
      if (!row || row.type !== "entry") return;
      if (row.isDir) toggleDir(row.path, row.expanded);
      else void commands.selectFile(row.path);
    };

    const collapseOrParent = () => {
      const row = at(projectsLocal.getState().filesIdx);
      if (!row || row.type !== "entry") return;
      if (row.isDir && row.expanded) {
        toggleDir(row.path, true);
        return;
      }
      const target = parentPath(row.path);
      const parentIdx = rows.findIndex((r) => r.type === "entry" && r.path === target);
      if (parentIdx >= 0) projectsLocal.set({ filesIdx: parentIdx });
    };

    const expandOrDescend = () => {
      const row = at(projectsLocal.getState().filesIdx);
      if (!row || row.type !== "entry" || !row.isDir) return;
      if (!row.expanded) toggleDir(row.path, false);
    };

    const offs = [
      registerActionHandler("projects.up", move(-1)),
      registerActionHandler("projects.down", move(1)),
      registerActionHandler("projects.drill", openOrExpand),
      registerActionHandler("projects.filesLeft", collapseOrParent),
      registerActionHandler("projects.filesRight", expandOrDescend),
    ];
    return () => {
      for (const off of offs) off();
      projectsLocal.set({ filesFocused: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read live state via projectsLocal.getState()
  }, [rows]);

  function toggleDir(path: string, isExpanded: boolean): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isExpanded) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!isExpanded) void commands.expandDir(path);
  }

  const selected = rows[filesIdx];
  const crumbBase = selected?.type === "entry" ? (selected.isDir ? selected.path : parentPath(selected.path)) : "";
  const crumbSegments = crumbBase ? crumbBase.split("/") : [];

  if (!detail) {
    return <div className={styles.emptyHint}>no project selected</div>;
  }

  return (
    <div className={styles.wrap}>
      <SearchBox
        value={filterInput}
        onChange={setFilterInput}
        placeholder="filter files"
        count={{
          shown: rows.filter((r) => r.type === "entry").length,
          total: unfilteredRows.filter((r) => r.type === "entry").length,
          noun: "entries",
        }}
        dataAttr="project-files-filter"
      >
        <span
          className={showIgnored ? styles.ignoredToggleOn : styles.ignoredToggle}
          onClick={() => setShowIgnored((v) => !v)}
          data-project-files-ignored-toggle=""
          title="toggle .gitignore-d entries"
          role="button"
        >
          {showIgnored ? "☑" : "☐"} ignored
        </span>
      </SearchBox>
      <div className={styles.breadcrumb} data-project-files-breadcrumb="">
        <span className={styles.crumbRoot}>{project}</span>
        {crumbSegments.map((seg, i) => (
          <span key={i}>
            <span className={styles.crumbSep}> / </span>
            <span>{seg}</span>
          </span>
        ))}
      </div>
      <div className={styles.body}>
        {rows.length === 0 ? (
          <div className={styles.emptyHint}>no files</div>
        ) : (
          rows.map((row, i) => {
            const rowSelected = i === filesIdx;
            if (row.type === "truncated") {
              return (
                <div key={`${row.path}:trunc`} className={styles.noteRow} style={{ paddingLeft: 14 + row.depth * 14 }}>
                  showing first 1000
                </div>
              );
            }
            if (row.type === "error") {
              return (
                <div key={`${row.path}:err`} className={`${styles.noteRow} ${styles.toneDanger}`} style={{ paddingLeft: 14 + row.depth * 14 }}>
                  {row.message}
                </div>
              );
            }
            if (row.type === "loading") {
              return (
                <div key={`${row.path}:loading`} className={styles.noteRow} style={{ paddingLeft: 14 + row.depth * 14 }} data-project-file-loading={row.path}>
                  loading…
                </div>
              );
            }
            const mark = row.gitStatus ? GIT_MARK[row.gitStatus] : undefined;
            return (
              <div
                key={row.path}
                className={rowSelected ? styles.rowSelected : styles.rowItem}
                style={{ paddingLeft: 14 + row.depth * 14 }}
                onClick={() => projectsLocal.set({ filesIdx: i })}
                onDoubleClick={() => (row.isDir ? toggleDir(row.path, row.expanded) : void commands.selectFile(row.path))}
                data-project-file-row={row.path}
              >
                {row.isDir ? (
                  <span className={styles.chevron}>{row.expanded ? "▾" : "▸"}</span>
                ) : (
                  <span className={styles.chevron} />
                )}
                <span className={row.isDir ? undefined : styles.fileGlyph}>{row.isDir ? "" : "·"}</span>
                <span className={rowSelected ? undefined : styles.softName}>{row.name}</span>
                {mark ? <span className={`${styles.gitMark} ${toneClass[mark.tone]}`}>{mark.glyph}</span> : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
