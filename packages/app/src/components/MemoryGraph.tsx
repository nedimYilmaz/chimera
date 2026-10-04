import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphResult, MemoryKind } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { onDaemonEvent } from "../rpc/bridge";
import { buildSimData } from "../memory-graph/build";
import { resolvePalette } from "../memory-graph/palette";
import { GraphRenderer } from "../memory-graph/renderer";
import type { ColorMode } from "../memory-graph/types";
import { errorText } from "../state/errorText";
import styles from "./MemoryGraph.module.css";

// MEM-6 §5 — the neural graph view. A thin React shell around the framework-free
// GraphRenderer (renderer.ts): it fetches memory.graph (MEM-2 RPC), resolves the
// CSS token palette once, owns the canvas sizing, and forwards the shared search
// query as lit-node matches. All the physics/drawing/perf lives in renderer.ts.

export interface MemoryGraphHandle {
  /** enter in the search box → animate to the best match (§5.2). */
  focusSearch(): void;
  /** clear the selection ring + status readout — used when a host-rendered
   *  detail panel over the canvas is dismissed, so the canvas doesn't keep
   *  showing a selection the panel no longer reflects. */
  deselect(): void;
}

interface MemoryGraphProps {
  query: string; // shared search box text — lights matching nodes
  active: boolean; // graph mode visible? (gates the fetch/mount)
  onSelectNode?: (node: MemoryGraphNode | null) => void;
  folder?: string; // folder-rail filter (MEM-5) — optional, forward-compatible
  kind?: MemoryKind;
}

const KIND_LEGEND: { kind: MemoryKind; label: string }[] = [
  { kind: "decision", label: "decision" },
  { kind: "fact", label: "fact" },
  { kind: "todo", label: "todo" },
  { kind: "question", label: "question" },
  { kind: "note", label: "note" },
];

function matchIds(nodes: MemoryGraphNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return new Set();
  const out = new Set<string>();
  for (const n of nodes) {
    const hay = `${n.label} ${n.folder ?? ""} ${n.tags.join(" ")} ${n.id}`.toLowerCase();
    if (hay.includes(q)) out.add(n.id);
  }
  return out;
}

export const MemoryGraph = forwardRef<MemoryGraphHandle, MemoryGraphProps>(function MemoryGraph(
  { query, active, onSelectNode, folder, kind },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const nodesRef = useRef<MemoryGraphNode[]>([]);
  // Latest search query, read inside the async load() closure (the effect deps
  // deliberately exclude `query`, so the closure would otherwise see the stale
  // mount-time value on a memory:* refetch and mis-light the active search).
  const queryRef = useRef(query);
  queryRef.current = query;
  const [colorMode, setColorMode] = useState<ColorMode>("kind");
  const [cluster, setCluster] = useState(false);
  // MEM-7 (§4, §5.2): similarity edges are off by default and OPT-IN — turning them on is what
  // asks the server to compute top-3-neighbor cosine pairs, so unlike colorMode/cluster (pure
  // client-side rendering toggles) this one is a `load()` dependency below, not a renderer-only
  // setter: toggling it refetches with `semanticEdges: true` so the data actually exists to draw.
  const [showSemantic, setShowSemantic] = useState(false);
  const [selected, setSelected] = useState<MemoryGraphNode | null>(null);
  const [count, setCount] = useState<{ nodes: number; edges: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => rendererRef.current?.focusBestMatch(),
    deselect: () => {
      rendererRef.current?.setSelected(null);
      setSelected(null);
    },
  }), []);

  // Create the renderer once the canvas exists and graph mode is active. The
  // renderer is disposed on unmount (removes listeners, stops the scheduler → no
  // idle rAF leaks when you leave graph mode).
  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const palette = resolvePalette((name) => getComputedStyle(canvas).getPropertyValue(name));
    const renderer = new GraphRenderer(canvas, {
      palette,
      onSelect: (id) => {
        const node = id ? nodesRef.current.find((n) => n.id === id) ?? null : null;
        setSelected(node);
        onSelectNode?.(node);
      },
    });
    renderer.setShowSemantic(showSemantic);
    rendererRef.current = renderer;

    const applySize = (): void => {
      const rect = host.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(host);

    let disposed = false;
    // The initial fetch fits + lays out the whole graph; a background memory:*
    // refetch preserves the user's current pan/zoom and reconciles node positions
    // by id (no snap-back to whole-graph fit, no full re-layout).
    let loaded = false;
    const load = async (): Promise<void> => {
      try {
        const params: Record<string, unknown> = {};
        if (folder) params.folder = folder;
        if (kind) params.kind = kind;
        if (showSemantic) params.semanticEdges = true;
        const result = await rpcCall<MemoryGraphResult>("memory.graph", params);
        if (disposed) return;
        nodesRef.current = result.nodes;
        setCount({ nodes: result.nodes.length, edges: result.edges.length });
        setError(null);
        renderer.setData(buildSimData(result), { preserveView: loaded });
        loaded = true;
        renderer.setSearchMatches(matchIds(result.nodes, queryRef.current));
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
    };
    void load();

    // §4 freshness: refetch on memory edit/delete events (agentId "memory:*").
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const offEvent = onDaemonEvent((ev) => {
      if (!ev.agentId?.startsWith("memory:")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 300);
    });

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      offEvent();
      ro.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, folder, kind, showSemantic]);

  // live search: relight matches whenever the shared query changes
  useEffect(() => {
    rendererRef.current?.setSearchMatches(matchIds(nodesRef.current, query));
  }, [query]);

  useEffect(() => rendererRef.current?.setColorMode(colorMode), [colorMode]);
  useEffect(() => rendererRef.current?.setClusterByFolder(cluster), [cluster]);

  return (
    <div className={styles.host} ref={hostRef} data-memory-graph>
      <canvas ref={canvasRef} className={styles.canvas} data-testid="memory-graph-canvas" />

      <div className={styles.toolbar}>
        <button
          type="button"
          className={colorMode === "folder" ? styles.toggleOn : styles.toggle}
          onClick={() => setColorMode((m) => (m === "folder" ? "kind" : "folder"))}
          title="color nodes by folder instead of kind"
        >
          tint: {colorMode}
        </button>
        <button
          type="button"
          className={cluster ? styles.toggleOn : styles.toggle}
          onClick={() => setCluster((c) => !c)}
          title="pull each folder's notes into its own cluster"
        >
          cluster {cluster ? "on" : "off"}
        </button>
        <button
          type="button"
          className={showSemantic ? styles.toggleOn : styles.toggle}
          onClick={() => setShowSemantic((s) => !s)}
          title="dashed edges between semantically-similar notes (needs the vector index ready)"
        >
          similarity {showSemantic ? "on" : "off"}
        </button>
      </div>

      <div className={styles.legend}>
        {KIND_LEGEND.map((l) => (
          <span key={l.kind} className={styles.legendItem}>
            <span className={styles.dot} data-kind={l.kind} />
            {l.label}
          </span>
        ))}
      </div>

      <div className={styles.status}>
        {error ? (
          <span className={styles.err}>graph unavailable · {error}</span>
        ) : selected ? (
          <span>
            <span className={styles.selKind} data-kind={selected.kind ?? "ghost"}>
              {selected.ghost ? "ghost" : selected.kind}
            </span>
            {selected.folder ? <span className={styles.selFolder}>{selected.folder}</span> : null}
            <span className={styles.selLabel}>{selected.label}</span>
          </span>
        ) : count ? (
          <span className={styles.hint}>
            {count.nodes} nodes · {count.edges} edges · scroll zoom · drag pin · dbl-click focus
          </span>
        ) : (
          <span className={styles.hint}>loading graph…</span>
        )}
      </div>
    </div>
  );
});
