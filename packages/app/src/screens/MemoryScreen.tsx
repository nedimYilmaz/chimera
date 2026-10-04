import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MemorySearchMode, MemoryGetResult, MemoryStatsResult } from "@chimera/protocol";
import type { MemoryHit, UiState } from "@chimera/ui-state";
import {
  CAPACITY_HELP, SCOPE_HELP, cycleScopeSel, nextOutSummary, pinnedSummary, scopeNames,
  scopeSelLabel, scopeSummary, scopeToken,
} from "@chimera/ui-state";
import { onRowKeyDown } from "../a11y";
import { displayChord, registerActionHandler, runAction } from "../keymap";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getCoordCommands, type MemoryIndexView } from "../state/commands.coord";
import { memoryFormValuesFromRecord, memoryRowView, memoryLabel, buildFolderTree, unfiledCount, fmtMemDate } from "../state/selectors.coord";
import { CONFIRMS } from "../copy";
import { errorText } from "../state/errorText";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { FolderRail } from "../components/FolderRail";
import { MemoryNoteCard } from "../components/MemoryNoteCard";
import { MemoryNoteEditor } from "../components/MemoryNoteEditor";
import { MemoryGraph, type MemoryGraphHandle } from "../components/MemoryGraph";
import { MessageBody, WikiLinkProvider, type WikiLinkResolution } from "../components/MessageBody";
import { ConfirmCard } from "../components/ConfirmCard";
import { ActionChipRow } from "../components/ActionChipRow";
import { Collapse } from "../components/Collapse";
import { toggleCollapsed } from "../state/selectionToggle";
import styles from "./MemoryScreen.module.css";
import { usePaneRow } from "../components/PaneDivider";

// W5 / MEM-5 — the Memory tab. Three zones: a folder rail (memory.stats-derived
// tree), the note list (title column + "/" live search + a mode chip), and a
// detail pane that renders the selected note (title/folder header, markdown body
// with click-navigable [[wiki-links]], and links→/backlinks← sections from
// memory.get). All mouse affordances dispatch the SAME keymap action ids the
// hotkeys do (keyboard-parity rule).

const coord = getCoordCommands(appStore, rpcCall);
const MODE_CYCLE: MemorySearchMode[] = ["hybrid", "lexical", "semantic"];

export function MemoryScreen() {
  // PANE-RESIZE: two seams on one row, so two keys and two custom properties — the rail's width
  // and the list's. Both dividers measure against the SAME row element, which is why the ref is
  // created here and shared rather than owned by each hook.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const rail = usePaneRow("memory.rail", { cssVar: "--pane-rail-w", ref: rowRef });
  const list = usePaneRow("memory", { ref: rowRef });
  const memory = useStore((s: UiState) => s.memory);
  const cursor = useStore((s: UiState) => s.memoryCursor);
  const mode = useStore((s: UiState) => s.mode);
  const [stats, setStats] = useState<MemoryStatsResult | null>(null);
  const [titles, setTitles] = useState<Array<{ title: string; id: string }>>([]);
  const [index, setIndex] = useState<MemoryIndexView | null>(null);
  const [detail, setDetail] = useState<MemoryGetResult | null>(null);
  const [navStack, setNavStack] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navStackRef = useRef<string[]>([]);
  navStackRef.current = navStack;
  // F34.UI: the scope-cycle handler is registered ONCE (like cycleMode), so the
  // list of project scopes has to reach it through a ref, not the render closure.
  const scopeNamesRef = useRef<string[]>([]);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  // MEM-6: mod+r swaps the middle+detail panes for the neural graph view.
  // Screen-local (like editingNoteId) — the graph is a self-contained canvas
  // surface fed by the memory.graph RPC; the shared search box + folder rail
  // keep filtering/lighting it, and a node click drives the same cursor->detail.
  const [graphMode, setGraphMode] = useState(false);
  const graphRef = useRef<MemoryGraphHandle | null>(null);
  // MEM-6 fix: a clicked node opens a detail panel OVER the canvas (graph stays
  // interactive underneath). A real note reuses the SAME memory.get-backed
  // `detail`/cursor plumbing list mode uses (cursorToId below already fetches
  // it); a ghost has no record to fetch, so it's tracked here for a title-only
  // placeholder. null = panel closed.
  const [graphSelection, setGraphSelection] = useState<{ kind: "ghost"; label: string } | { kind: "note" } | null>(null);
  const closeGraphPanel = (): void => {
    setGraphSelection(null);
    graphRef.current?.deselect?.();
  };

  const [noteCollapsed, setNoteCollapsed] = useState(false);
  useEffect(() => setNoteCollapsed(false), [cursor]);

  // The detail note = the row under the cursor. Link navigation moves the cursor
  // (see navTo), so the detail always mirrors the highlighted row.
  const activeId = memory.items[cursor]?.record.id ?? null;

  const titleStrings = useMemo(() => titles.map((t) => t.title), [titles]);
  const knownFolders = useMemo(
    () => (stats?.byFolder ?? []).map((f) => f.folder).filter((f): f is string => f != null).sort(),
    [stats],
  );
  const folderTree = useMemo(() => buildFolderTree(stats?.byFolder ?? []), [stats]);

  const refreshMeta = (): void => {
    void coord.memoryStats().then(setStats).catch(() => {});
    void coord.memoryTitles().then(setTitles).catch(() => {});
    void coord.memoryIndexStatus().then(setIndex).catch(() => setIndex(null));
  };

  // tab entry: list + rail/total + autocomplete titles + index status
  useEffect(() => {
    void coord.loadMemory();
    refreshMeta();
  }, []);

  // detail (links/backlinks) follows the active note; a deleted/absent id clears it
  useEffect(() => {
    if (activeId == null) { setDetail(null); return; }
    let live = true;
    void coord.memoryGet(activeId).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [activeId]);

  // --- navigation (link / backlink / wiki-chip → move cursor, push history) ---
  // A jump target usually sits in the current list, but a link/backlink can point
  // OUT of the folder-filtered, limit-capped page (memory.get resolves against the
  // whole store). When it's off-list we clear the filter and reload wide, then
  // select the target once it lands — so a resolved link is never a dead click.
  const pendingNavRef = useRef<string | null>(null);

  const selectIfPresent = (id: string): boolean => {
    const items = appStore.getState().memory.items;
    const idx = items.findIndex((h) => h.record.id === id);
    if (idx < 0) return false;
    const cur = appStore.getState().memoryCursor;
    if (idx !== cur) appStore.dispatch({ type: "memoryCursor", delta: idx - cur });
    return true;
  };

  const cursorToId = (id: string, pushHistory: boolean): void => {
    if (pushHistory) {
      const items = appStore.getState().memory.items;
      const curId = items[appStore.getState().memoryCursor]?.record.id;
      if (curId && curId !== id) setNavStack((s) => [...s, curId]);
    }
    if (selectIfPresent(id)) return;
    // off-list: reset the filter to surface the target, reload wide, select on arrival.
    pendingNavRef.current = id;
    appStore.dispatch({ type: "memoryQuery", query: "" });
    appStore.dispatch({ type: "memoryFolder", folder: { kind: "all" } });
    void coord.memorySearch({ query: "", limit: 100 });
  };

  // Resolve a queued off-list jump on the NEXT list change — that change is the
  // wide reload we just triggered, so it's the one and only chance to land on the
  // target. Clear the ref unconditionally (one-shot) so a later, unrelated search
  // whose results happen to include the id can't jump the cursor unexpectedly.
  useEffect(() => {
    const pending = pendingNavRef.current;
    if (!pending) return;
    pendingNavRef.current = null;
    selectIfPresent(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.items]);
  const navBack = (): void => {
    const s = navStackRef.current;
    if (s.length === 0) return;
    const prev = s[s.length - 1]!;
    setNavStack(s.slice(0, -1));
    cursorToId(prev, false);
  };

  const cycleMode = (): void => {
    // Read the CURRENT mode from the store, not the render-closure `memory.mode`
    // — this same fn is registered once as the mod+k keymap handler, so a
    // closed-over value would freeze at the first-render mode and never advance.
    const cur = appStore.getState().memory.mode;
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length]!;
    appStore.dispatch({ type: "memoryMode", mode: next });
    void coord.memorySearch({});
  };
  // F34.UI: all → @global → each project scope → all. Purely a VIEW narrowing:
  // memory.search still ranks (scope ∪ global), the command layer post-filters.
  const cycleScope = (): void => {
    const cur = appStore.getState().memory.scope;
    appStore.dispatch({ type: "memoryScope", scope: cycleScopeSel(cur, scopeNamesRef.current) });
    setNavStack([]);
    void coord.memorySearch({});
  };
  const selectFolder = (folder: UiState["memory"]["folder"]): void => {
    appStore.dispatch({ type: "memoryFolder", folder });
    setNavStack([]);
    void coord.memorySearch({});
    refreshMeta();
  };

  // keymap registrations (rows.coord.ts declares the chords)
  useEffect(() => {
    const disposers = [
      registerActionHandler("memory.up", () => appStore.dispatch({ type: "memoryCursor", delta: -1 })),
      registerActionHandler("memory.down", () => appStore.dispatch({ type: "memoryCursor", delta: 1 })),
      registerActionHandler("memory.expand", () => {}),
      registerActionHandler("memory.new", () => {
        const s = appStore.getState();
        setEditingNoteId(null);
        appStore.dispatch({ type: "setMode", mode: s.mode === "memoryForm" ? "normal" : "memoryForm" });
      }),
      registerActionHandler("memory.edit", () => {
        const s = appStore.getState();
        const hit = s.memory.items[s.memoryCursor];
        if (!hit) return;
        setEditingNoteId(hit.record.id);
        appStore.dispatch({ type: "setMode", mode: "memoryForm" });
      }),
      registerActionHandler("memory.delete", () => {
        const s = appStore.getState();
        const hit = s.memory.items[s.memoryCursor];
        if (hit) setConfirmDeleteId(hit.record.id);
      }),
      registerActionHandler("memory.mode", cycleMode),
      registerActionHandler("memory.scope", cycleScope),
      registerActionHandler("memory.back", navBack),
      // MEM-6: toggle list ⇄ graph within the Memory tab (was a MEM-5 no-op stub).
      registerActionHandler("memory.graph", () => setGraphMode((g) => !g)),
      // F36.UI: pin/unpin the selected note. Pinning is the ONLY operator control over
      // what value-ranked eviction keeps, so it must be reachable from the seat that
      // watches the store fill — not just from inside an agent's memory_edit call.
      registerActionHandler("memory.pin", () => {
        const s = appStore.getState();
        const hit = s.memory.items[s.memoryCursor];
        if (!hit) return;
        const pinned = !hit.record.pinned;
        const label = memoryLabel(hit.record.title, hit.record.text);
        // No `author` in the patch — pinning is not authorship, and sending one would
        // re-stamp the note as written by the app.
        void coord.memoryUpdate({ id: hit.record.id, pinned })
          .then(() => {
            refreshMeta();                                  // pinned count + nextToEvict move with it
            appStore.dispatch({ type: "notice", message: pinned
              ? `pinned "${label}" — kept when memory fills`
              : `unpinned "${label}" — can be dropped when memory fills` });
          })
          // The daemon refuses a 51st pin per scope (conflict); its message names the cap.
          .catch((err: unknown) => appStore.dispatch({ type: "notice", message: `pin failed — ${errorText(err)}` }));
      }),
    ];
    return () => { for (const d of disposers) d(); };
    // cycleMode/navBack close over memory.mode/navStack via refs+getState, so a
    // one-time registration is correct (no stale-closure re-register needed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode === "normal") inputRef.current?.focus();
  }, [mode]);

  // esc closes the graph node-detail panel — a window-level listener since a
  // canvas click (opening the panel) doesn't leave focus in the search input.
  useEffect(() => {
    if (!graphMode || !graphSelection) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        closeGraphPanel();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphMode, graphSelection]);

  const onQueryChange = (q: string): void => {
    appStore.dispatch({ type: "memoryQuery", query: q });
    void coord.memorySearch({ query: q });
  };

  const onInputKeyDown = (ev: React.KeyboardEvent): void => {
    const run = (action: string): void => { ev.preventDefault(); runAction(action, appStore); };
    // MEM-6: in graph mode, enter animates a pan/zoom to the best search hit
    // (§5.2) instead of the list's no-op expand.
    if (ev.key === "Enter" && graphMode) { ev.preventDefault(); graphRef.current?.focusSearch(); return; }
    if (ev.key === "ArrowUp") return run("memory.up");
    if (ev.key === "ArrowDown") return run("memory.down");
    if (ev.key === "Enter") return run("memory.expand");
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) return run("memory.new");
    if (ev.key.toLowerCase() === "e" && (ev.ctrlKey || ev.metaKey)) return run("memory.edit");
    if (ev.key.toLowerCase() === "d" && (ev.ctrlKey || ev.metaKey)) return run("memory.delete");
    if (ev.key.toLowerCase() === "k" && ev.shiftKey && (ev.ctrlKey || ev.metaKey)) return run("memory.scope");
    if (ev.key.toLowerCase() === "m" && (ev.ctrlKey || ev.metaKey)) return run("memory.mode");
    if (ev.key.toLowerCase() === "g" && (ev.ctrlKey || ev.metaKey)) return run("memory.graph");
    if (ev.key.toLowerCase() === "p" && (ev.ctrlKey || ev.metaKey)) return run("memory.pin");
    if (ev.key === "ArrowLeft" && ev.altKey) return run("memory.back");
    if (ev.key === "Tab") return run(ev.shiftKey ? "tab.prev" : "tab.next");
    if (ev.key === "Escape" && appStore.getState().memory.query.length > 0) {
      ev.preventDefault();
      onQueryChange("");
    }
  };

  const detailHit = memory.items[cursor];
  const editHit = editingNoteId !== null ? memory.items.find((h) => h.record.id === editingNoteId) : undefined;

  const selectNote = (i: number): void => {
    const cur = appStore.getState().memoryCursor;
    if (i === cur) { setNoteCollapsed((c) => toggleCollapsed(i, cur, c)); return; }
    setNavStack([]);
    appStore.dispatch({ type: "memoryCursor", delta: i - cur });
  };

  const afterMutate = (): void => { refreshMeta(); };

  // wiki-link resolver/navigator for the detail body (from the note's links).
  const wikiResolve = (target: string): WikiLinkResolution | null => {
    const link = detail?.links.find((l) => l.target === target);
    return link ? { resolvedId: link.resolvedId, resolvedTitle: link.resolvedTitle } : null;
  };
  const wikiNavigate = (target: string): void => {
    const link = detail?.links.find((l) => l.target === target);
    if (link?.resolvedId) cursorToId(link.resolvedId, true);
  };

  const total = stats?.total ?? null;
  // F36: an older daemon answers memory.stats WITHOUT capacity — the app only casts
  // the reply, it never parses it — so this reads defensively and renders no chip.
  const capacity = stats?.capacity ?? null;
  // F34.UI: an older daemon answers memory.stats WITHOUT byScope (the app only
  // casts the reply, it never parses it) — every read defaults to [].
  const byScope = stats?.byScope ?? [];
  const projectScopes = scopeNames(byScope);
  scopeNamesRef.current = projectScopes;
  const scopeSel = memory.scope;
  const indexing = index && index.state === "building" ? `◍ indexing ${index.embedded}/${index.total}` : null;
  const degraded = index?.degraded === true || (index?.state === "off" && memory.mode !== "lexical");

  // MEM-7 (§8): re-embed everything from scratch. memoryIndexRebuild resolves immediately with the
  // "building" status (the embed itself runs in the background) — reflect that right away rather
  // than waiting for the next tab-entry refreshMeta().
  const handleIndexRebuild = (): void => {
    if (rebuilding) return;
    setRebuilding(true);
    void coord
      .memoryIndexRebuild()
      .then(setIndex)
      .catch((err: unknown) => appStore.dispatch({ type: "notice", message: `rebuild failed — ${errorText(err)}` }))
      .finally(() => setRebuilding(false));
  };

  return (
    <div data-screen-layout="memory" className={styles.row} ref={rowRef} style={{ ...rail.rowProps.style, ...list.rowProps.style }}>
      <FolderRail
        tree={folderTree}
        total={stats?.total ?? memory.items.length}
        unfiled={unfiledCount(stats?.byFolder ?? [])}
        selected={memory.folder}
        onSelect={selectFolder}
      />
      {/* PANE-RESIZE: memory has TWO seams — rail | list | detail. */}
      {rail.divider}
      <Panel
        label={<>memory <span className={styles.labelMeta}>· shared notes</span></>}
        className={styles.master}
      >
        <div className={styles.searchRow}>
          <span className={styles.slash}>/</span>
          <input
            ref={inputRef}
            className={styles.searchInput}
            value={memory.query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="type to search"
            data-memory-search
          />
          <span
            className={styles.modeChip}
            onClick={cycleMode}
            role="button"
            tabIndex={-1}
            title={`${displayChord("mod+k")} · cycle search mode`}
            data-memory-mode={memory.mode}
          >
            {memory.mode}
          </span>
          <span className={styles.countMeta}>
            {memory.items.length}{total !== null ? ` of ${total}` : ""} notes
          </span>
          {capacity && (
            <span
              className={capacity.alarming ? styles.capacityAlarm : styles.countMeta}
              data-memory-capacity={capacity.alarming ? "alarm" : "ok"}
              title={capacity.nextToEvict.length > 0
                ? `next out: ${capacity.nextToEvict.map((c) => c.title ?? c.id.slice(0, 8)).join(", ")}`
                : "nothing evictable yet"}
            >
              {capacity.total}/{capacity.limit} · {Math.round(capacity.fill * 100)}% full
              {capacity.alarming && capacity.nextToEvict[0]
                ? ` · next out: ${capacity.nextToEvict[0].title ?? capacity.nextToEvict[0].id.slice(0, 8)}`
                : ""}
            </span>
          )}
        </div>
        {/* F34.UI (QA §6b/§6c): the scope axis gets its own row — a cycle chip and
            the memory.stats byScope summary. A ROW rather than more text in the
            search line so F36's capacity chip lands beside it additively. */}
        <div className={styles.scopeRow}>
          <span
            className={projectScopes.length === 0 ? styles.scopeChipDisabled : styles.scopeChip}
            onClick={projectScopes.length === 0 ? undefined : cycleScope}
            role="button"
            aria-disabled={projectScopes.length === 0}
            tabIndex={-1}
            title={projectScopes.length === 0
              ? `every note is global — nothing to filter yet. ${SCOPE_HELP}`
              : `${displayChord("mod+shift+k")} · cycle scope filter. ${SCOPE_HELP}`}
            data-memory-scope-filter={scopeSel.kind === "scope" ? scopeSel.name : scopeSel.kind}
          >
            {scopeSelLabel(scopeSel)}
          </span>
          <span className={styles.scopeSummary} title={SCOPE_HELP} data-memory-scope-summary>
            {stats === null ? "scopes…" : scopeSummary(byScope)}
          </span>
        </div>
        {/* F36.UI (QA F36 "UI gaps" 1+4): eviction was hover-only, and only while
            alarming — so the operator learned what was about to be dropped by
            hovering a chip they had no reason to hover. The queue is now a visible
            row, always, in the same shape as the scope row above it. */}
        {(stats === null || capacity) && (
          <div className={styles.scopeRow} data-memory-capacity-row>
            <span
              className={capacity?.alarming ? styles.capacityAlarm : styles.countMeta}
              title={CAPACITY_HELP}
              data-memory-pinned={capacity?.pinned ?? 0}
            >
              {stats === null ? "capacity…" : pinnedSummary(capacity)}
            </span>
            <span className={styles.scopeSummary} title={CAPACITY_HELP} data-memory-next-out>
              {stats === null ? "" : nextOutSummary(capacity)}
            </span>
          </div>
        )}
        {index && (
          <div className={styles.indexRow}>
            {indexing && <span className={styles.indexing}>{indexing}</span>}
            {degraded && <span className={styles.degraded}>semantic off — lexical</span>}
            {index.provider && (
              <span className={styles.indexMeta}>{index.provider} · {index.model}</span>
            )}
            <span className={styles.filler} />
            <span
              className={styles.indexRebuild}
              onClick={rebuilding ? undefined : handleIndexRebuild}
              role="button"
              aria-disabled={rebuilding}
              tabIndex={-1}
              title={rebuilding ? "rebuild in progress…" : "re-embed every note from scratch"}
              data-memory-index-rebuild
              data-rebuilding={rebuilding || undefined}
            >
              {rebuilding ? "rebuilding…" : "rebuild"}
            </span>
          </div>
        )}
        <div className={styles.colHead}>
          <div className={styles.colText}>title</div>
          <div className={styles.colTime}>time</div>
          <div className={styles.colKind}>kind</div>
        </div>
        <div className={styles.body}>
          {memory.items.length === 0 ? (
            <div className={styles.emptyHint}>
              {scopeSel.kind !== "all"
                ? `no notes in ${scopeSelLabel(scopeSel)} — ${displayChord("mod+shift+k")} widens the scope filter`
                : memory.query ? "no notes match" : `no notes yet — ${displayChord("mod+o")} adds one`}
            </div>
          ) : (
            memory.items.map((hit, i) => {
              const label = memoryLabel(hit.record.title, hit.record.text);
              const selected = i === cursor;
              return (
                <div
                  key={hit.record.id}
                  className={selected ? styles.rowSelected : styles.rowItem}
                  onClick={() => selectNote(i)}
                  onKeyDown={onRowKeyDown(() => selectNote(i))}
                  role="button"
                  tabIndex={0}
                  data-memory-row={hit.record.id}
                >
                  <div className={styles.colText}>
                    {/* F36.UI (QA gap 3): the pin budget is 50 per scope and a note's
                        survival depends on it — so pinned state is on the ROW, not
                        only in the detail pane. Same ★ the events tab pins with. */}
                    {hit.record.pinned && (
                      <span className={styles.pinMark} title="pinned — kept when memory fills" data-memory-pinned-row>★ </span>
                    )}
                    <span className={selected ? undefined : styles.softText}>{label || "—"}</span>
                  </div>
                  <div className={styles.colTime}>{fmtMemDate(hit.record.updatedAt)}</div>
                  <div className={styles.colKind}>{hit.record.kind}</div>
                </div>
              );
            })
          )}
        </div>
        <PanelFooter>
          <div className={styles.footerRow}>
            <span>{`type to search · ↑↓ record · ${displayChord("mod+k")} mode`}</span>
            <ActionChipRow
              chips={[
                { key: displayChord("mod+r"), label: graphMode ? "list" : "graph", onClick: () => runAction("memory.graph", appStore) },
                { key: displayChord("mod+o"), label: "note", onClick: () => runAction("memory.new", appStore) },
                { key: displayChord("mod+e"), label: "edit", onClick: () => runAction("memory.edit", appStore), disabled: memory.items.length === 0 },
                { key: displayChord("mod+p"), label: detailHit?.record.pinned ? "unpin" : "pin", onClick: () => runAction("memory.pin", appStore), disabled: memory.items.length === 0 },
                { key: displayChord("mod+shift+x"), label: "delete", danger: true, onClick: () => runAction("memory.delete", appStore), disabled: memory.items.length === 0 },
              ]}
            />
          </div>
        </PanelFooter>
      </Panel>

      {list.divider}
      <Panel
        label={graphMode ? <>graph <span className={styles.labelMeta}>· neurons</span></> : detailHit ? `note · ${detailHit.record.kind}` : "note"}
        className={styles.detail}
      >
        {/* MEM-6: graph mode takes over the detail pane. The folder rail filters
            the graph (folder prefix), the shared search box lights matches, and
            clicking a node runs the same cursorToId → memory.get detail nav MEM-5
            uses for links (so leaving the graph lands on the selected note). A
            node click ALSO opens a detail panel over the canvas (below) showing
            the full note — a ghost has no record, so it just gets a label. */}
        {graphMode ? (
          <>
            <MemoryGraph
              ref={graphRef}
              active={graphMode}
              query={memory.query}
              folder={memory.folder.kind === "folder" ? memory.folder.path : undefined}
              onSelectNode={(node) => {
                if (!node) { setGraphSelection(null); return; }
                if (node.ghost) { setGraphSelection({ kind: "ghost", label: node.label }); return; }
                setGraphSelection({ kind: "note" });
                cursorToId(node.id, true);
              }}
            />
            {graphSelection && (
              <div className={styles.graphDetailPanel} data-graph-detail-panel>
                {graphSelection.kind === "ghost" ? (
                  <div className={styles.graphGhostPanel}>
                    <div className={styles.detailTitleRow}>
                      <span className={styles.detailTitle}>{graphSelection.label}</span>
                      <span className={styles.spacer} />
                      <span className={styles.closeChip} onClick={closeGraphPanel} role="button" tabIndex={-1} title="esc · close">×</span>
                    </div>
                    <div className={styles.emptyHint}>ghost — no note yet</div>
                  </div>
                ) : detailHit ? (
                  <WikiLinkProvider value={{ resolve: wikiResolve, onNavigate: wikiNavigate }}>
                    <DetailBody
                      hit={detailHit}
                      detail={detail}
                      canBack={navStack.length > 0}
                      onBack={navBack}
                      onNavigate={(id) => cursorToId(id, true)}
                      onClose={closeGraphPanel}
                      footer="esc close · [[ ]] links · alt+← back"
                    />
                  </WikiLinkProvider>
                ) : (
                  <div className={styles.emptyHint}>loading…</div>
                )}
              </div>
            )}
          </>
        ) : editingNoteId !== null && editHit ? (
          <MemoryNoteEditor
            key={editingNoteId}
            noteId={editingNoteId}
            initial={memoryFormValuesFromRecord(editHit.record)}
            titles={titleStrings}
            folders={knownFolders}
            onSave={(params) => coord.memoryUpdate(params).then(afterMutate)}
            onClose={() => { setEditingNoteId(null); appStore.dispatch({ type: "setMode", mode: "normal" }); }}
          />
        ) : !detailHit ? (
          <div className={styles.emptyPane}>
            <div className={styles.emptyGlyph}>◆</div>
            <div className={styles.emptyHint}>no note selected</div>
          </div>
        ) : (
          <Collapse open={!noteCollapsed} fill>
            <WikiLinkProvider value={{ resolve: wikiResolve, onNavigate: wikiNavigate }}>
              <DetailBody
                hit={detailHit}
                detail={detail}
                canBack={navStack.length > 0}
                onBack={navBack}
                onNavigate={(id) => cursorToId(id, true)}
              />
            </WikiLinkProvider>
          </Collapse>
        )}
        {mode === "memoryForm" && editingNoteId === null && (
          <MemoryNoteCard
            titles={titleStrings}
            folders={knownFolders}
            onSubmit={async (params) => {
              await coord.memoryAdd(params);
              afterMutate();
            }}
            onClose={() => appStore.dispatch({ type: "setMode", mode: "normal" })}
          />
        )}
        {confirmDeleteId !== null && (() => {
          const hit = memory.items.find((h) => h.record.id === confirmDeleteId);
          const label = hit ? memoryLabel(hit.record.title, hit.record.text) : confirmDeleteId;
          return (
            <ConfirmCard
              title="⚠ delete note"
              meta={confirmDeleteId}
              body={CONFIRMS.deleteMemory(label).body}
              note={CONFIRMS.deleteMemory(label).note}
              confirmLabel="confirm delete"
              onConfirm={() => {
                const id = confirmDeleteId;
                setConfirmDeleteId(null);
                void coord.memoryDelete(id).then(afterMutate);
              }}
              onClose={() => setConfirmDeleteId(null)}
            />
          );
        })()}
        <OverlayOutlet host="memory" />
      </Panel>
    </div>
  );
}

function DetailBody({ hit, detail, canBack, onBack, onNavigate, onClose, footer }: {
  hit: MemoryHit;
  detail: MemoryGetResult | null;
  canBack: boolean;
  onBack: () => void;
  onNavigate: (id: string) => void;
  /** present only for the graph-mode overlay — renders a × chip that dismisses the panel. */
  onClose?: () => void;
  /** overrides the default list-mode footer hint (graph overlay mentions esc close instead). */
  footer?: ReactNode;
}) {
  const row = memoryRowView(hit);
  const tags = row.tags.length > 0 ? row.tags.split(",").filter(Boolean) : [];
  const links = detail?.links ?? [];
  const backlinks = detail?.backlinks ?? [];
  return (
    <>
      <div className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          {canBack && (
            <span className={styles.backChip} onClick={onBack} role="button" tabIndex={-1} title="alt+← back">←</span>
          )}
          <span className={styles.detailTitle}>{row.label || "—"}</span>
          <span className={styles.spacer} />
          <span className={styles.timeMeta}>{fmtMemDate(row.ts)}</span>
          {onClose && (
            <span className={styles.closeChip} onClick={onClose} role="button" tabIndex={-1} title="esc · close">×</span>
          )}
        </div>
        <div className={styles.chipRow}>
          <span className={styles.detailKindTag}>{row.kind}</span>
          <span className={styles.pathMeta} title="folder — where this note is filed">{row.folder ?? "unfiled"}</span>
          {/* F34.UI (QA §6a/§6c): the scope keeps its own chip on EVERY note —
              suppressing it for unscoped records would make "written before
              scoping existed" look identical to "this UI doesn't show scope" —
              but wears an @ sigil so a note filed in a folder NAMED "global" can
              never be mistaken for a note whose scope is global. */}
          <span className={styles.scopeMeta} title={SCOPE_HELP} data-memory-scope={row.scope ?? "global"}>
            {scopeToken(row.scope)}
          </span>
          <span className={styles.pathMeta} title="author — the agent that wrote it">{row.author}</span>
          {/* Keyboard-parity rule: this chip dispatches the SAME memory.pin action mod+p does. */}
          <span
            className={hit.record.pinned ? styles.pinChipOn : styles.pinChip}
            onClick={() => runAction("memory.pin", appStore)}
            onKeyDown={onRowKeyDown(() => runAction("memory.pin", appStore))}
            role="button"
            tabIndex={0}
            aria-pressed={hit.record.pinned}
            title={`${displayChord("mod+p")} · ${hit.record.pinned
              ? "unpin — this note can be dropped when memory fills"
              : "pin — keep this note when memory fills"}`}
            data-memory-pin={hit.record.pinned ? "on" : "off"}
          >
            {hit.record.pinned ? "★ pinned" : "☆ pin"}
          </span>
          {tags.map((t) => <span key={t} className={styles.chip}>{t}</span>)}
        </div>
      </div>
      <div className={styles.detailBody}>
        <MessageBody text={row.text} done rawView={false} />
        {(links.length > 0 || backlinks.length > 0) && (
          <div className={styles.linksPane}>
            {links.length > 0 && (
              <div className={styles.linkGroup}>
                <div className={styles.linkHead}>links →</div>
                {links.map((l, i) => {
                  const kind = l.resolvedId ? "resolved" : l.resolvedTitle ? "ghost" : "missing";
                  const clickable = l.resolvedId != null;
                  return (
                    <div
                      key={`${l.target}-${i}`}
                      className={clickable ? styles.linkRow : styles.linkRowDim}
                      onClick={clickable ? () => onNavigate(l.resolvedId!) : undefined}
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={clickable ? onRowKeyDown(() => onNavigate(l.resolvedId!)) : undefined}
                      data-memory-link={l.resolvedId ?? l.target}
                    >
                      <span className={styles.linkLabel}>{l.resolvedTitle ?? l.target}</span>
                      {kind !== "resolved" && <span className={styles.linkTag}>{kind}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {backlinks.length > 0 && (
              <div className={styles.linkGroup}>
                <div className={styles.linkHead}>backlinks ←</div>
                {backlinks.map((b) => (
                  <div
                    key={b.id}
                    className={styles.linkRow}
                    onClick={() => onNavigate(b.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={onRowKeyDown(() => onNavigate(b.id))}
                    data-memory-backlink={b.id}
                  >
                    <span className={styles.linkLabel}>{b.title ?? memoryLabel(null, b.snippet)}</span>
                    <span className={styles.linkSnippet}>{b.snippet}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <PanelFooter>{footer ?? "type to search · ↑↓ record · [[ ]] links · alt+← back"}</PanelFooter>
    </>
  );
}
