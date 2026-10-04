// MEM-6 §5 — the hand-rolled canvas 2D renderer + d3-force physics for the
// neural graph view. The physics library is the only bought part (Barnes-Hut is
// real work); the DRAWING is in-house, where the premium look lives (§5.1).
//
// Perf discipline (§5.3), all load-bearing for the measured-60fps / zero-idle-rAF
// acceptance:
//   • one canvas, DPR-aware (capped at 2);
//   • the simulation is driven MANUALLY (sim.stop() + sim.tick() in our own
//     scheduler) so we own the freeze — no d3-timer running at idle;
//   • the draw loop runs ONLY while the sim is warm or an interaction/transition
//     is live (FrameScheduler); at rest it schedules nothing;
//   • glow via pre-rendered sprites (sprites.ts) — NO per-frame shadowBlur;
//   • edges batched into one path per style; labels only for hover/selection or
//     zoom>1.5 (text is the other canvas killer).
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { quadtree } from "d3-quadtree";
import { type ZoomTransform } from "d3-zoom";
import { applyNodeColors } from "./palette";
import { GlowSpriteCache, type CanvasFactory } from "./sprites";
import { FrameScheduler } from "./scheduler";
import {
  type Box,
  clampScale,
  fitToBox,
  interpolateTransform,
  easeCubicInOut,
  makeTransform,
  MAX_SCALE,
  MIN_SCALE,
  transformsClose,
  zoomToward,
} from "./view";
import type { ColorMode, GraphPalette, SimData, SimLink, SimNode } from "./types";

export interface RendererOptions {
  palette: GraphPalette;
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  // injectable for headless perf harness / tests
  raf?: (cb: (n: number) => void) => number;
  caf?: (h: number) => void;
  now?: () => number;
  createCanvas?: CanvasFactory; // offscreen-sprite factory (default: document)
}

const ALPHA_MIN = 0.005; // freeze threshold (a touch above d3's default so idle is crisp)
const FOCUS_MS = 400; // §5.2 animated search-focus duration
const DIM_ALPHA = 0.15; // §5.2 non-neighborhood dim
const LABEL_ZOOM = 1.5; // §5.3 labels for all lit nodes only past this zoom

export class GraphRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sprites: GlowSpriteCache;
  private readonly scheduler: FrameScheduler;
  private readonly now: () => number;

  private data: SimData = { nodes: [], links: [] };
  private sim: Simulation<SimNode, SimLink> | null = null;
  private adjacency = new Map<string, Set<string>>();
  private nodeById = new Map<string, SimNode>();
  private palette: GraphPalette;
  private colorMode: ColorMode = "kind";
  private clusterByFolder = false;
  private showSemantic = false;

  private cssW = 800;
  private cssH = 600;
  private dpr = 1;

  private transform: ZoomTransform = makeTransform(1, 400, 300);
  private focus: { from: ZoomTransform; to: ZoomTransform; start: number } | null = null;
  private pendingFit = false;
  private userInteracted = false;

  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private hoverEase = 0; // eased [0..1] toward 1 while a node is hovered
  private searchMatches: Set<string> | null = null;

  private dragId: string | null = null;
  private panning = false;
  private lastPointer: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly opts: RendererOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.palette = opts.palette;
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.sprites = new GlowSpriteCache(opts.createCanvas);
    this.scheduler = new FrameScheduler((n) => this.tick(n), opts.raf, opts.caf);
    this.attach();
  }

  // ---- public API ---------------------------------------------------------

  // `preserveView` (a background memory:* refetch) keeps the current pan/zoom and
  // interaction state, and reconciles surviving nodes' positions by id so the
  // layout doesn't rebuild from scratch or snap back to whole-graph fit. Omitted
  // (the initial load) → auto-fit + full cold layout.
  setData(data: SimData, opts: { preserveView?: boolean } = {}): void {
    if (opts.preserveView) {
      const prev = this.nodeById;
      for (const n of data.nodes) {
        const old = prev.get(n.id);
        if (old && old.x !== undefined) {
          n.x = old.x;
          n.y = old.y;
          n.vx = old.vx;
          n.vy = old.vy;
          if (old.fx != null) n.fx = old.fx;
          if (old.fy != null) n.fy = old.fy;
        }
      }
    }
    this.data = data;
    this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
    this.adjacency = buildAdjacency(data.links);
    applyNodeColors(data.nodes, this.palette, this.colorMode);
    this.buildSimulation();
    if (opts.preserveView) {
      // gentle local re-settle only (seeded positions barely move); keep transform
      if (this.sim) this.sim.alpha(0.3);
    } else {
      this.pendingFit = true;
      this.userInteracted = false;
      this.hoveredId = null;
      this.hoverEase = 0;
    }
    this.scheduler.wake();
  }

  setSize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(2, Math.max(1, dpr)); // §5.3 DPR cap 2
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.scheduler.wake();
  }

  setPalette(palette: GraphPalette): void {
    this.palette = palette;
    applyNodeColors(this.data.nodes, palette, this.colorMode);
    this.scheduler.wake();
  }

  setColorMode(mode: ColorMode): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    applyNodeColors(this.data.nodes, this.palette, mode);
    this.scheduler.wake();
  }

  setClusterByFolder(on: boolean): void {
    if (on === this.clusterByFolder) return;
    this.clusterByFolder = on;
    if (this.sim) this.applyCenteringForces(this.sim);
    this.reheat(0.6);
  }

  setShowSemantic(on: boolean): void {
    this.showSemantic = on;
    this.scheduler.wake();
  }

  setSearchMatches(ids: Set<string> | null): void {
    this.searchMatches = ids && ids.size > 0 ? ids : null;
    this.scheduler.wake();
  }

  /** enter in the search box: animate a 400ms pan/zoom to the best (highest-
   *  degree) match (§5.2). No-op if there are no matches with positions. */
  focusBestMatch(): void {
    if (!this.searchMatches) return;
    let best: SimNode | null = null;
    for (const id of this.searchMatches) {
      const n = this.nodeById.get(id);
      if (!n || n.x === undefined) continue;
      if (!best || n.degree > best.degree) best = n;
    }
    if (best && best.x !== undefined && best.y !== undefined) {
      this.animateTo(this.centerOn(best.x, best.y, Math.max(this.transform.k, 1.4)));
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.scheduler.wake();
  }

  /** True when no frame is scheduled — the "idle rAF = 0" invariant the
   *  acceptance measures. At rest the scheduler holds no rAF handle at all. */
  isIdle(): boolean {
    return !this.scheduler.isScheduled();
  }

  frameCount(): number {
    return this.scheduler.frameCount;
  }

  currentTransform(): ZoomTransform {
    return this.transform;
  }

  dispose(): void {
    this.disposed = true;
    this.scheduler.stop();
    if (this.sim) this.sim.stop();
    this.detach();
  }

  // ---- simulation ---------------------------------------------------------

  private buildSimulation(): void {
    if (this.sim) this.sim.stop();
    const sim = forceSimulation<SimNode, SimLink>(this.data.nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(this.data.links)
          .id((d) => d.id)
          .distance((l) => (l.kind === "semantic" ? 80 : 40))
          .strength((l) => (l.kind === "semantic" ? 0.08 : 0.5)),
      )
      .force("charge", forceManyBody<SimNode>().strength(-30))
      .force("collide", forceCollide<SimNode>().radius((d) => d.radius + 2))
      .alphaMin(ALPHA_MIN);
    this.applyCenteringForces(sim);
    sim.stop(); // we drive .tick() ourselves — no d3-timer at idle
    this.sim = sim;
  }

  // Weak center pull by default; when "cluster by folder" is on, each node is
  // pulled toward its folder's anchor on a ring (§5.2).
  private applyCenteringForces(sim: Simulation<SimNode, SimLink>): void {
    if (this.clusterByFolder) {
      const anchors = folderAnchors(this.data.nodes);
      sim
        .force("x", forceX<SimNode>((d) => anchors.get(d.folder ?? "")?.x ?? 0).strength(0.09))
        .force("y", forceY<SimNode>((d) => anchors.get(d.folder ?? "")?.y ?? 0).strength(0.09));
    } else {
      sim.force("x", forceX<SimNode>(0).strength(0.02)).force("y", forceY<SimNode>(0).strength(0.02));
    }
  }

  private reheat(alpha: number): void {
    if (this.sim) this.sim.alpha(Math.max(this.sim.alpha(), alpha));
    this.scheduler.wake();
  }

  // ---- frame loop ---------------------------------------------------------

  private tick(nowArg: number): boolean {
    if (this.disposed) return false;
    const now = nowArg || this.now();

    // 1) focus transition
    let transitioning = false;
    if (this.focus) {
      const e = easeCubicInOut((now - this.focus.start) / FOCUS_MS);
      this.transform = interpolateTransform(this.focus.from, this.focus.to, e);
      if (e >= 1 || transformsClose(this.transform, this.focus.to)) {
        this.transform = this.focus.to;
        this.focus = null;
      } else {
        transitioning = true;
      }
    }

    // 2) hover ease toward target
    const hoverTarget = this.hoveredId ? 1 : 0;
    let hovering = false;
    if (Math.abs(this.hoverEase - hoverTarget) > 0.01) {
      this.hoverEase += (hoverTarget - this.hoverEase) * 0.25;
      hovering = true;
    } else {
      this.hoverEase = hoverTarget;
    }

    // 3) physics
    let warm = false;
    if (this.sim) {
      const a = this.sim.alpha();
      if (a >= ALPHA_MIN || this.dragId !== null) {
        this.sim.tick();
        warm = this.sim.alpha() >= ALPHA_MIN || this.dragId !== null;
      }
      // one-shot auto-fit the first time the graph settles after setData
      if (!warm && this.pendingFit && !this.userInteracted) {
        this.pendingFit = false;
        const box = this.contentBox();
        if (box) this.animateTo(fitToBox(box, this.cssW, this.cssH));
      }
    }

    this.draw();
    return warm || transitioning || hovering || this.focus !== null;
  }

  // ---- drawing ------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    const t = this.transform;
    const k = t.k * this.dpr;
    // clear (device space)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // world → device: worldUnit = k device px; origin at (t.x, t.y) css px
    ctx.setTransform(k, 0, 0, k, t.x * this.dpr, t.y * this.dpr);

    const lit = this.litSet();
    this.drawEdges(ctx, t, lit);
    this.drawNodes(ctx, t, lit);
    this.drawSelectionRing(ctx, t);
    this.drawLabels(ctx, t, lit);
  }

  // The lit (full-opacity) neighborhood: hover 1-hop wins, else search matches,
  // else null ⇒ everything lit.
  private litSet(): Set<string> | null {
    if (this.hoveredId) {
      const s = new Set<string>([this.hoveredId]);
      for (const n of this.adjacency.get(this.hoveredId) ?? []) s.add(n);
      return s;
    }
    return this.searchMatches;
  }

  private drawEdges(ctx: CanvasRenderingContext2D, t: ZoomTransform, lit: Set<string> | null): void {
    const hair = 1 / t.k; // keep ~1px on screen regardless of zoom
    const links = this.data.links;
    // partition into dim/lit only when a highlight is active (else one batch)
    const drawBatch = (predicate: (l: SimLink) => boolean, alpha: number, dashed: boolean): void => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = dashed ? this.palette.muted : this.palette.fg;
      ctx.lineWidth = hair;
      ctx.setLineDash(dashed ? [4 * hair, 4 * hair] : []);
      ctx.beginPath();
      let any = false;
      for (const l of links) {
        if (l.kind === "semantic" && !this.showSemantic) continue;
        if (dashed !== (l.kind === "semantic")) continue;
        if (!predicate(l)) continue;
        const s = l.source as SimNode;
        const d = l.target as SimNode;
        if (s.x === undefined || d.x === undefined) continue;
        ctx.moveTo(s.x, s.y as number);
        ctx.lineTo(d.x, d.y as number);
        any = true;
      }
      if (any) ctx.stroke();
    };
    const isLit = (l: SimLink): boolean =>
      lit === null || (lit.has((l.source as SimNode).id) && lit.has((l.target as SimNode).id));
    if (lit === null) {
      drawBatch(() => true, 0.1, false);
      if (this.showSemantic) drawBatch(() => true, 0.06, true);
    } else {
      drawBatch((l) => !isLit(l), 0.04, false);
      drawBatch((l) => isLit(l), 0.16, false);
      if (this.showSemantic) drawBatch((l) => isLit(l), 0.06, true);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawNodes(ctx: CanvasRenderingContext2D, _t: ZoomTransform, lit: Set<string> | null): void {
    for (const n of this.data.nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      const isLit = lit === null || lit.has(n.id);
      const isHover = n.id === this.hoveredId;
      const r = n.radius * (isHover ? 1 + 0.3 * this.hoverEase : 1); // hover +30% ease
      ctx.globalAlpha = isLit ? 1 : DIM_ALPHA;
      if (n.ghost) {
        // hollow ring, dim (§5.2)
        ctx.strokeStyle = this.palette.ghost;
        ctx.lineWidth = Math.max(0.6, r * 0.28);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const half = GlowSpriteCache.destHalf(r);
        const sprite = this.sprites.get(n.color);
        ctx.drawImage(sprite as CanvasImageSource, n.x - half, n.y - half, half * 2, half * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawSelectionRing(ctx: CanvasRenderingContext2D, t: ZoomTransform): void {
    if (!this.selectedId) return;
    const n = this.nodeById.get(this.selectedId);
    if (!n || n.x === undefined || n.y === undefined) return;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.palette.fg;
    ctx.lineWidth = 1.5 / t.k;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + 5 / t.k, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Labels are expensive at scale — draw them ONLY for the hovered/selected node
  // always, and for all lit nodes once zoomed past LABEL_ZOOM (§5.3). Even then,
  // cap the count so a zoomed-out-but-lit huge set can't tank a frame.
  private drawLabels(ctx: CanvasRenderingContext2D, t: ZoomTransform, lit: Set<string> | null): void {
    const targets: SimNode[] = [];
    const push = (id: string | null): void => {
      if (!id) return;
      const n = this.nodeById.get(id);
      if (n && n.x !== undefined && !targets.includes(n)) targets.push(n);
    };
    push(this.hoveredId);
    push(this.selectedId);
    if (t.k > LABEL_ZOOM) {
      for (const n of this.data.nodes) {
        if (targets.length >= 60) break; // hard cap — text is a canvas killer
        if (n.x === undefined) continue;
        if (lit === null || lit.has(n.id)) targets.push(n);
      }
    }
    if (targets.length === 0) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.palette.fg;
    ctx.font = `${12 / t.k}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const n of targets) {
      const label = n.label.length > 40 ? n.label.slice(0, 39) + "…" : n.label;
      ctx.fillText(label, (n.x as number) + n.radius + 4 / t.k, n.y as number);
    }
  }

  // ---- geometry helpers ---------------------------------------------------

  private contentBox(): Box | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.data.nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      minX = Math.min(minX, n.x - n.radius);
      minY = Math.min(minY, n.y - n.radius);
      maxX = Math.max(maxX, n.x + n.radius);
      maxY = Math.max(maxY, n.y + n.radius);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  private centerOn(wx: number, wy: number, k: number): ZoomTransform {
    const nk = clampScale(k);
    return makeTransform(nk, this.cssW / 2 - wx * nk, this.cssH / 2 - wy * nk);
  }

  private animateTo(to: ZoomTransform): void {
    this.focus = { from: this.transform, to, start: this.now() };
    this.scheduler.wake();
  }

  // ---- interaction --------------------------------------------------------

  private attach(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDblClick);
  }

  private detach(): void {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("dblclick", this.onDblClick);
  }

  private cssPointer(ev: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private pickNode(px: number, py: number): SimNode | null {
    const wx = this.transform.invertX(px);
    const wy = this.transform.invertY(py);
    const qt = quadtree<SimNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(this.data.nodes.filter((n) => n.x !== undefined));
    const slop = 6 / this.transform.k; // ~6px screen grab radius
    const found = qt.find(wx, wy, 40 / this.transform.k);
    if (!found || found.x === undefined || found.y === undefined) return null;
    const dx = found.x - wx;
    const dy = found.y - wy;
    return Math.hypot(dx, dy) <= found.radius + slop ? found : null;
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    this.userInteracted = true;
    const p = this.cssPointer(ev);
    this.lastPointer = p;
    const hit = this.pickNode(p.x, p.y);
    if (hit) {
      this.dragId = hit.id;
      hit.fx = hit.x;
      hit.fy = hit.y;
      this.reheat(0.3); // §5.2 drag re-warms the sim briefly
      this.setSelectedInternal(hit.id);
    } else {
      this.panning = true;
    }
    this.canvas.setPointerCapture?.(ev.pointerId);
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const p = this.cssPointer(ev);
    if (this.dragId) {
      const n = this.nodeById.get(this.dragId);
      if (n) {
        n.fx = this.transform.invertX(p.x);
        n.fy = this.transform.invertY(p.y);
        this.reheat(0.3);
      }
      this.lastPointer = p;
      return;
    }
    if (this.panning && this.lastPointer) {
      const dx = p.x - this.lastPointer.x;
      const dy = p.y - this.lastPointer.y;
      this.transform = makeTransform(this.transform.k, this.transform.x + dx, this.transform.y + dy);
      this.lastPointer = p;
      this.scheduler.wake();
      return;
    }
    // hover
    const hit = this.pickNode(p.x, p.y);
    const id = hit?.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.canvas.style.cursor = id ? "pointer" : "default";
      this.opts.onHover?.(id);
      this.scheduler.wake();
    }
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (this.dragId) {
      const n = this.nodeById.get(this.dragId);
      // keep the node PINNED where dropped (fx/fy stay set) — §5.2 "drag: pin node"
      if (n) {
        this.setSelectedInternal(this.dragId);
        // a click without meaningful drag also just selects (fx/fy == position)
      }
      this.dragId = null;
      if (this.sim) this.sim.alphaTarget(0);
    } else if (this.panning) {
      // treat a no-drag press on empty space as "clear selection"
      this.setSelectedInternal(null);
    }
    this.panning = false;
    this.lastPointer = null;
    this.canvas.releasePointerCapture?.(ev.pointerId);
  };

  private readonly onPointerLeave = (): void => {
    if (this.hoveredId) {
      this.hoveredId = null;
      this.opts.onHover?.(null);
      this.scheduler.wake();
    }
  };

  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.userInteracted = true;
    const p = this.cssPointer(ev);
    const factor = Math.exp(-ev.deltaY * 0.001);
    const nk = clampScale(this.transform.k * factor);
    if (nk === this.transform.k) return;
    this.transform = zoomToward(this.transform, nk, p.x, p.y);
    this.focus = null; // a manual zoom cancels any running focus animation
    this.scheduler.wake();
  };

  // double-click: focus mode — animate to fit the hovered node's 2-hop subgraph
  private readonly onDblClick = (ev: MouseEvent): void => {
    const p = this.cssPointer(ev);
    const hit = this.pickNode(p.x, p.y);
    if (!hit) return;
    const box = this.twoHopBox(hit.id);
    if (box) this.animateTo(fitToBox(box, this.cssW, this.cssH, 80));
  };

  private twoHopBox(id: string): Box | null {
    const set = new Set<string>([id]);
    for (const a of this.adjacency.get(id) ?? []) {
      set.add(a);
      for (const b of this.adjacency.get(a) ?? []) set.add(b);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const nid of set) {
      const n = this.nodeById.get(nid);
      if (!n || n.x === undefined || n.y === undefined) continue;
      minX = Math.min(minX, n.x - n.radius);
      minY = Math.min(minY, n.y - n.radius);
      maxX = Math.max(maxX, n.x + n.radius);
      maxY = Math.max(maxY, n.y + n.radius);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  private setSelectedInternal(id: string | null): void {
    this.selectedId = id;
    this.opts.onSelect?.(id);
    this.scheduler.wake();
  }
}

// ---- pure helpers (exported for tests) ------------------------------------

export function buildAdjacency(links: SimLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    let s = adj.get(a);
    if (!s) {
      s = new Set();
      adj.set(a, s);
    }
    s.add(b);
  };
  for (const l of links) {
    const s = typeof l.source === "string" ? l.source : l.source.id;
    const d = typeof l.target === "string" ? l.target : l.target.id;
    add(s, d);
    add(d, s);
  }
  return adj;
}

// Distinct folders (excluding unfiled) placed on a ring; unfiled sits at center.
// Radius grows with folder count so clusters don't overlap. Deterministic order.
export function folderAnchors(nodes: SimNode[]): Map<string, { x: number; y: number }> {
  const folders = Array.from(new Set(nodes.map((n) => n.folder).filter((f): f is string => f !== null))).sort();
  const anchors = new Map<string, { x: number; y: number }>();
  anchors.set("", { x: 0, y: 0 }); // unfiled
  const R = 120 + folders.length * 24;
  folders.forEach((f, i) => {
    const theta = (i / folders.length) * Math.PI * 2;
    anchors.set(f, { x: Math.cos(theta) * R, y: Math.sin(theta) * R });
  });
  return anchors;
}

export { MAX_SCALE, MIN_SCALE };
