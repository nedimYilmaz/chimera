import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { emptyCanvasLayout, type CanvasNode } from "@chimera/protocol";
import { CanvasController, type CanvasRequest } from "../state/canvas-controller";
import { canvasPositions, canvasDelta, visibleCanvasNodes, filterCanvasNodes, zoomCanvas, NODE_WIDTH, NODE_HEIGHT } from "../state/canvas-layout";
import { useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getProjectsCommands } from "../state/commands.projects";
import { openReviewRoom } from "../state/commands.evidence";
import { CanvasTaskInspector } from "./CanvasTaskInspector";
import { artifactsLocal } from "../state/commands.artifacts";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { ContextLinks } from "./ContextLinks";
import styles from "./ProjectCanvas.module.css";

function openEntity(node: CanvasNode) {
  if (node.kind === "artifact") { artifactsLocal.set({ previewId: node.entityId }); return; }
  if (node.kind === "task" || node.kind === "issue") {
    void openReviewRoom(appStore, rpcCall, node.entityId);
  } else if (node.agentId) {
    getProjectsCommands(appStore, rpcCall).openSession(node.agentId);
  }
}

export default function ProjectCanvas({ projectId, mode, request = rpcCall, onOpen = openEntity, projectDetails }: { projectDetails?: ReactNode; projectId: string; mode: "list" | "canvas"; request?: CanvasRequest; onOpen?: (node: CanvasNode) => void }) {
  const controller = useMemo(() => new CanvasController(projectId, request), [projectId, request]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState), status = useLoadStatus(controller.status);
  const selectedAgent = useStore(s => state.graph?.nodes.find(n => n.ref === state.selected)?.agentId ? s.agents[state.graph.nodes.find(n => n.ref === state.selected)!.agentId!] : undefined);
  const connected = useStore(s => s.connected);
  const [size, setSize] = useState({ width: 600, height: 430 });
  const [query, setQuery] = useState("");
  const [reset, setReset] = useState(false), [groupTitle, setGroupTitle] = useState("");
  const surface = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef<{ id: number; startX: number; startY: number; x: number; y: number; ref: string | null; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const positions = useMemo(() => canvasPositions(state.graph?.nodes ?? [], state.graph?.edges ?? [], state.layout), [state.graph, state.layout]);
  const selected = state.graph?.nodes.find(n => n.ref === state.selected);
  const filtered = filterCanvasNodes(state.graph?.nodes ?? [], query);
  const nodes = visibleCanvasNodes(filtered, positions, state.layout.viewport, size.width, size.height, state.selected);
  const nodeRefs = new Set(nodes.map(n => n.ref));
  const update = (layout: typeof state.layout, ref?: string) => controller.update(layout, ref);
  const setView = (view: typeof state.layout.viewport) => update({ ...controller.getState().layout, viewport: view });
  useEffect(() => {
    controller.activate();
    let previous = appStore.getState().connected;
    if (previous) void controller.load();
    const off = appStore.subscribe(() => { const next = appStore.getState().connected; if (previous && !next) controller.interrupt(); if (!previous && next) void controller.load(); previous = next; });
    const events = onDaemonEvent(e => {
      if (!["status", "agent_started", "agent_result", "artifact_created", "task_state_changed", "context_link_changed"].includes(e.kind)) return;
      if (timer.current) return;
      timer.current = setTimeout(() => { timer.current = null; if (appStore.getState().connected) void controller.load(); }, 500);
    });
    return () => { off(); events(); if (timer.current) clearTimeout(timer.current); controller.dispose(); };
  }, [controller]);
  useEffect(() => {
    if (!state.dirty || state.saveError || !connected || state.saving) return;
    const handle = setTimeout(() => void controller.save(), 700); return () => clearTimeout(handle);
  }, [controller, state.layout, state.dirty, state.saveError, state.saving, connected]);
  useEffect(() => {
    const element = surface.current; if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => { const r = entries[0]?.contentRect; if (r) setSize({ width: r.width, height: r.height }); }); observer.observe(element); return () => observer.disconnect();
  }, [mode]);
  function pointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input,textarea,select")) return;
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-canvas-node]");
    const ref = button?.dataset.canvasNode ?? null, p = ref ? positions[ref]! : state.layout.viewport;
    dragging.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: p.x, y: p.y, ref, moved: false }; if (!ref) e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragging.current; if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) e.currentTarget.setPointerCapture(e.pointerId);
    drag.moved = true;
    const layout = controller.getState().layout;
    if (drag.ref && !drag.ref.startsWith("cluster:")) { const d = canvasDelta(dx, dy, layout.viewport.zoom); update({ ...layout, positions: { ...layout.positions, [drag.ref]: { ...layout.positions[drag.ref], x: drag.x + d.x, y: drag.y + d.y } } }, drag.ref); }
    else setView({ ...layout.viewport, x: drag.x + dx, y: drag.y + dy });
  }
  function select(node: CanvasNode, activate = false) {
    controller.select(node.ref);
    if (activate && (node.kind === "task" || node.kind === "issue" || node.kind === "artifact")) onOpen(node);
    if (node.agentId) appStore.dispatch({ type: "selectAgent", agentId: node.agentId });
  }
  return <section className={styles.root} data-project-canvas={projectId}>
    <LoadStatusNote status={status} what="project graph" hasRows={!!state.graph?.nodes.length} onRetry={() => void controller.load()} />
    {status.unsupported && <p role="status">Project Canvas is unavailable on this daemon. Use the project list.</p>}
    {!connected && <p role="status">Disconnected · last loaded graph; arrangement retained.</p>}
    {state.graph && <>
      <div className={styles.toolbar}>
        <button type="button" disabled={!connected || status.loading} onClick={() => void controller.load()}>Refresh graph</button>
        {mode === "canvas" && <><button type="button" aria-label="Zoom out" onClick={() => setView(zoomCanvas(state.layout.viewport, state.layout.viewport.zoom / 1.2, { x: size.width / 2, y: size.height / 2 }))}>−</button><span data-canvas-zoom>{Math.round(state.layout.viewport.zoom * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => setView(zoomCanvas(state.layout.viewport, state.layout.viewport.zoom * 1.2, { x: size.width / 2, y: size.height / 2 }))}>+</button></>}
        <button type="button" data-canvas-save disabled={!connected || !state.dirty || state.saving || state.graph.readOnly || status.loading} onClick={() => void controller.save()}>{state.saving ? "Saving…" : "Save layout"}</button>
        <details><summary>Arrange</summary><div className={styles.arrange}>
          <label>Group title<input value={groupTitle} maxLength={120} onChange={e => setGroupTitle(e.target.value)} /></label>
          <button type="button" disabled={!selected || selected.kind === "cluster" || !groupTitle.trim() || state.layout.groups.length >= 50 || state.graph.readOnly} onClick={() => { const id = `group-${Date.now()}`; update({ ...state.layout, groups: [...state.layout.groups, { id, title: groupTitle.trim() }], positions: { ...state.layout.positions, [selected!.ref]: { ...positions[selected!.ref]!, group: id } } }, selected!.ref); setGroupTitle(""); }}>Group selected</button>
          {selected && selected.kind !== "cluster" && <label>Selected group<select aria-label="Selected canvas group" value={state.layout.positions[selected.ref]?.group ?? ""} onChange={e => update({ ...state.layout, positions: { ...state.layout.positions, [selected.ref]: { ...positions[selected.ref]!, group: e.target.value || undefined } } }, selected.ref)}><option value="">Ungrouped</option>{state.layout.groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>}
          <button type="button" data-canvas-reset disabled={state.graph.readOnly} onClick={() => setReset(true)}>Reset arrangement…</button>
          {reset && <span>Reset positions, groups and viewport? Entities stay intact. <button type="button" data-canvas-reset-confirm onClick={() => { const layout = { ...emptyCanvasLayout(), stickies: state.layout.stickies }; for (const ref of Object.keys(state.layout.positions)) controller.update(layout, ref); controller.update(layout); setReset(false); }}>Reset layout</button><button type="button" onClick={() => setReset(false)}>Cancel</button></span>}
        </div></details>
      </div>
      <label>Filter included entities<input aria-label="Filter included canvas entities" maxLength={120} value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, ID, type or status" /></label>
      {query.trim() && <p role="status" data-canvas-filter-count>{filtered.length} of {state.graph.nodes.length} included entities match. Clear filter to show all included entities.</p>}
      {state.saveError && <p role="alert" data-canvas-save-error>{state.saveError}</p>}
      {state.graph.readOnly && <p role="status">Layout is read-only (unsupported file version or scoped caller).</p>}
      {state.graph.truncated && <p role="status" data-canvas-truncated>Showing at most 300 entities and 1,000 links. {state.graph.nodes.find(n => n.kind === "cluster")?.count ?? 0} additional entities are omitted from this graph; existing screens contain the full lists. Viewport buttons are separately limited to 80; List contains all included entities.</p>}
      {!state.graph.nodes.length && <p>No entities in this project yet.</p>}
      {mode === "list" ? <div className={styles.list} aria-label="Project graph list" role="region" tabIndex={0} data-canvas-list>{filtered.map(n => <button type="button" key={n.ref} data-canvas-list-node={n.ref} onFocus={() => select(n)} onClick={() => select(n, true)} onDoubleClick={() => onOpen(n)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onOpen(n); } }}><span>{n.kind} · {n.label}</span><span>{n.status}</span></button>)}</div> : <div ref={surface} className={styles.surface} tabIndex={0} aria-label="Project canvas. Arrow keys pan, plus and minus zoom. Tab selects visible nodes; Enter opens the entity. List view includes every graph node." data-canvas-surface data-canvas-x={state.layout.viewport.x} data-canvas-y={state.layout.viewport.y}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={e => { suppressClick.current = !!dragging.current?.moved; setTimeout(() => { suppressClick.current = false; }, 0); dragging.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { dragging.current = null; suppressClick.current = true; }}
        onKeyDown={e => { if ((e.target as HTMLElement).closest("input,textarea,select") || e.altKey || e.ctrlKey || e.metaKey) return; const view = controller.getState().layout.viewport;
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); const direction = e.key.slice(5); if (e.shiftKey && selected && selected.kind !== "cluster") { const p = positions[selected.ref]!; update({ ...state.layout, positions: { ...state.layout.positions, [selected.ref]: { ...state.layout.positions[selected.ref], x: p.x + (direction === "Right" ? 20 : direction === "Left" ? -20 : 0), y: p.y + (direction === "Down" ? 20 : direction === "Up" ? -20 : 0) } } }, selected.ref); } else setView({ ...view, x: view.x + (direction === "Right" ? -40 : direction === "Left" ? 40 : 0), y: view.y + (direction === "Down" ? -40 : direction === "Up" ? 40 : 0) }); }
          else if (["+", "=", "-"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); setView(zoomCanvas(view, view.zoom * (e.key === "-" ? 1 / 1.2 : 1.2), { x: size.width / 2, y: size.height / 2 })); }
        }}>
        <div className={styles.world} >
          <svg className={styles.edges} aria-hidden="true">{state.graph.edges.filter(e => nodeRefs.has(e.from) && nodeRefs.has(e.to)).slice(0, 200).map((e, i) => { const a = positions[e.from]!, b = positions[e.to]!; return <g key={`${e.from}-${e.to}-${i}`} transform={`translate(${state.layout.viewport.x},${state.layout.viewport.y}) scale(${state.layout.viewport.zoom})`} data-canvas-edge={e.kind}><path d={`M ${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT / 2} L ${b.x + NODE_WIDTH / 2} ${b.y + NODE_HEIGHT / 2}`} /><text x={(a.x + b.x) / 2 + NODE_WIDTH / 2} y={(a.y + b.y) / 2 + NODE_HEIGHT / 2}>{e.label ?? e.kind}</text></g>; })}</svg>
          {nodes.map(n => <button type="button" key={n.ref} className={styles.node} aria-pressed={state.selected === n.ref} data-canvas-node={n.ref} data-canvas-world-x={positions[n.ref]!.x} data-canvas-world-y={positions[n.ref]!.y} style={{ left: positions[n.ref]!.x * state.layout.viewport.zoom + state.layout.viewport.x, top: positions[n.ref]!.y * state.layout.viewport.zoom + state.layout.viewport.y, transform: `scale(${state.layout.viewport.zoom})`, transformOrigin: "0 0" }} onFocus={() => select(n)} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } select(n, true); }} onDoubleClick={() => onOpen(n)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onOpen(n); } }}><span>{n.kind} · {n.status}</span><strong>{n.label}</strong>{state.layout.positions[n.ref]?.group && <small>{state.layout.groups.find(g => g.id === state.layout.positions[n.ref]?.group)?.title}</small>}</button>)}
          {state.layout.stickies.map(s => <div key={s.id} className={styles.sticky} style={{ left: s.x * state.layout.viewport.zoom + state.layout.viewport.x, top: s.y * state.layout.viewport.zoom + state.layout.viewport.y, transform: `scale(${state.layout.viewport.zoom})`, transformOrigin: "0 0" }}>Private layout note · {s.text}</div>)}
        </div>
      </div>}
      {selected && <aside className={styles.selection} data-canvas-selection={selected.ref}><strong>{selected.kind} · {selected.label}</strong>{selected.kind !== "cluster" && <button type="button" data-canvas-open onClick={() => onOpen(selected)}>Open {selected.kind === "agent" || selected.kind === "worktree" ? "transcript" : "entity"}</button>}
        {(selected.kind === "task" || selected.kind === "issue") && selected.queue ? <CanvasTaskInspector key={`${selected.queue}:${selected.entityId}`} taskId={selected.entityId} queue={selected.queue} request={request} /> : selected.kind === "context-link" && selected.agentId ? <ContextLinks agentId={selected.agentId} request={request} /> : selectedAgent && <AgentDetailPanel agent={selectedAgent} status={null} loading={false} onClose={() => controller.select(null)} />}
      </aside>}
      {mode === "list" && projectDetails && <details data-canvas-project-details><summary>Project sessions and files</summary><div className={styles.projectDetails}>{projectDetails}</div></details>}
      <p className={styles.hint}>Drag to arrange or pan · arrows pan · +/− zoom · Shift+arrows move selection · Tab selects visible nodes · Enter opens · List includes every graph entity</p>
    </>}
  </section>;
}
