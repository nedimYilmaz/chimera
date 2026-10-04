import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphResult } from "@chimera/protocol";
import { buildSimData } from "../src/memory-graph/build";
import { resolvePalette } from "../src/memory-graph/palette";
import { GraphRenderer } from "../src/memory-graph/renderer";
import type { CanvasLike } from "../src/memory-graph/sprites";
import type { SimData, SimNode } from "../src/memory-graph/types";

// MEM-6 §5.2 — pointer/wheel/dblclick interaction + focusBestMatch coverage for
// the hand-rolled renderer. The existing memory-graph-renderer.test.ts covers the
// idle-freeze invariant and the pure helpers; this file drives the DOM event
// handlers (pickNode hit-test, drag-pin fx/fy, wheel zoom-toward, hover set,
// dblclick two-hop focus) through a fake canvas that captures the listeners the
// renderer attaches, so we can synthesize events with no DOM.

interface FiringCanvas {
  el: HTMLCanvasElement;
  fire(type: string, ev: Record<string, unknown>): void;
}

function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
}
function spriteCtx(): CanvasRenderingContext2D {
  return {
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    set fillStyle(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;
}
const fakeSprite = (): CanvasLike => ({ width: 8, height: 8, getContext: () => spriteCtx() });

function firingCanvas(): FiringCanvas {
  const listeners: Record<string, (ev: unknown) => void> = {};
  const el = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => fakeCtx(),
    addEventListener: (k: string, fn: (ev: unknown) => void) => {
      listeners[k] = fn;
    },
    removeEventListener: (k: string) => {
      delete listeners[k];
    },
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  return {
    el: el as unknown as HTMLCanvasElement,
    fire: (type, ev) => {
      const fn = listeners[type];
      if (!fn) throw new Error(`no listener attached for ${type}`);
      fn(ev);
    },
  };
}

function harness() {
  let now = 0;
  let next = 1;
  const q: { h: number; cb: (n: number) => void }[] = [];
  const raf = (cb: (n: number) => void): number => {
    const h = next++;
    q.push({ h, cb });
    return h;
  };
  const caf = (h: number): void => {
    const i = q.findIndex((j) => j.h === h);
    if (i >= 0) q.splice(i, 1);
  };
  const run = (cap: number): number => {
    let frames = 0;
    while (q.length && frames < cap) {
      const job = q.shift()!;
      now += 16;
      job.cb(now);
      frames++;
    }
    return frames;
  };
  return { raf, caf, run, nowFn: () => now, pending: () => q.length };
}

// A short chain graph — chain topology means a middle node's 2-hop subgraph is a
// strict subset of the whole, so dblclick focus produces a distinct transform.
function chain(n: number): MemoryGraphResult {
  const kinds = ["decision", "fact", "todo", "question", "note"] as const;
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    title: null,
    label: `node ${i}`,
    kind: kinds[i % kinds.length],
    folder: null,
    tags: [] as string[],
    degree: 0,
    updatedAt: i,
  }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
    kind: "link" as const,
    weight: 1,
  }));
  for (const e of edges) {
    nodes.find((x) => x.id === e.source)!.degree++;
    nodes.find((x) => x.id === e.target)!.degree++;
  }
  return { nodes, edges };
}

const palette = resolvePalette(() => "#9aa3f2");

// Build a settled renderer + keep a reference to the (in-place-mutated) sim data
// so tests can read node positions after the sim freezes.
function settled(nodeCount = 12): {
  r: GraphRenderer;
  fc: FiringCanvas;
  h: ReturnType<typeof harness>;
  data: SimData;
  onSelect: ReturnType<typeof vi.fn>;
  onHover: ReturnType<typeof vi.fn>;
} {
  const h = harness();
  const fc = firingCanvas();
  const onSelect = vi.fn();
  const onHover = vi.fn();
  const r = new GraphRenderer(fc.el, {
    palette,
    onSelect,
    onHover,
    raf: h.raf,
    caf: h.caf,
    now: h.nowFn,
    createCanvas: () => fakeSprite(),
  });
  r.setSize(800, 600, 1);
  const data = buildSimData(chain(nodeCount));
  r.setData(data);
  h.run(5000); // settle the sim + finish the one-shot auto-fit animation
  expect(r.isIdle()).toBe(true);
  return { r, fc, h, data, onSelect, onHover };
}

// world → screen (css px), the exact inverse of the renderer's cssPointer +
// transform.invert path (rect origin is 0,0 in the fake canvas).
function screenOf(r: GraphRenderer, n: SimNode): { x: number; y: number } {
  const t = r.currentTransform();
  return { x: t.applyX(n.x as number), y: t.applyY(n.y as number) };
}

let live: GraphRenderer | null = null;
beforeEach(() => {
  live = null;
});
afterEach(() => {
  live?.dispose();
});

describe("GraphRenderer pointer hit-testing (pickNode)", () => {
  it("a pointerdown on a node's screen position selects that node", () => {
    const { r, fc, data, onSelect } = settled();
    live = r;
    const target = data.nodes[4]!;
    const p = screenOf(r, target);
    fc.fire("pointerdown", { clientX: p.x, clientY: p.y, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith(target.id);
  });

  it("a pointerdown on empty space (then release) clears the selection", () => {
    const { r, fc, onSelect } = settled();
    live = r;
    // far outside any node cluster — the quadtree find radius (40/k) misses
    fc.fire("pointerdown", { clientX: 5, clientY: 5, pointerId: 1 });
    fc.fire("pointerup", { clientX: 5, clientY: 5, pointerId: 1 });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe("GraphRenderer drag pins a node (fx/fy)", () => {
  it("pointerdown sets fx/fy to the node's position", () => {
    const { r, fc, data } = settled();
    live = r;
    const target = data.nodes[4]!;
    const p = screenOf(r, target);
    fc.fire("pointerdown", { clientX: p.x, clientY: p.y, pointerId: 1 });
    expect(target.fx).toBeCloseTo(target.x as number, 6);
    expect(target.fy).toBeCloseTo(target.y as number, 6);
  });

  it("pointermove during a drag moves fx/fy, and the pin survives pointerup", () => {
    const { r, fc, data } = settled();
    live = r;
    const target = data.nodes[4]!;
    const p = screenOf(r, target);
    fc.fire("pointerdown", { clientX: p.x, clientY: p.y, pointerId: 1 });
    const startFx = target.fx as number;
    // drag 50 screen px to the right
    fc.fire("pointermove", { clientX: p.x + 50, clientY: p.y, pointerId: 1 });
    expect(target.fx as number).toBeGreaterThan(startFx);
    fc.fire("pointerup", { clientX: p.x + 50, clientY: p.y, pointerId: 1 });
    // §5.2 "drag: pin node" — fx/fy stay set after release
    expect(target.fx).not.toBeUndefined();
    expect(target.fy).not.toBeUndefined();
  });
});

describe("GraphRenderer hover set", () => {
  it("hovering a node reports its id, and pointerleave clears the hover", () => {
    const { r, fc, data, onHover } = settled();
    live = r;
    const target = data.nodes[6]!;
    const p = screenOf(r, target);
    fc.fire("pointermove", { clientX: p.x, clientY: p.y, pointerId: 1 });
    expect(onHover).toHaveBeenLastCalledWith(target.id);
    fc.fire("pointerleave", {});
    expect(onHover).toHaveBeenLastCalledWith(null);
  });
});

describe("GraphRenderer wheel zoom-toward", () => {
  it("a negative-deltaY wheel zooms in and preventDefaults", () => {
    const { r, fc } = settled();
    live = r;
    const before = r.currentTransform().k;
    const preventDefault = vi.fn();
    fc.fire("wheel", { clientX: 400, clientY: 300, deltaY: -200, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(r.currentTransform().k).toBeGreaterThan(before);
  });

  it("a positive-deltaY wheel zooms out", () => {
    const { r, fc } = settled();
    live = r;
    const before = r.currentTransform().k;
    fc.fire("wheel", { clientX: 400, clientY: 300, deltaY: 200, preventDefault: () => {} });
    expect(r.currentTransform().k).toBeLessThan(before);
  });
});

describe("GraphRenderer dblclick two-hop focus", () => {
  it("dblclick on a node starts a focus animation (no longer idle)", () => {
    const { r, fc, data } = settled();
    live = r;
    const target = data.nodes[6]!;
    const p = screenOf(r, target);
    expect(r.isIdle()).toBe(true);
    fc.fire("dblclick", { clientX: p.x, clientY: p.y });
    // animateTo(fitToBox(twoHopBox)) sets a focus transition + wakes the loop
    expect(r.isIdle()).toBe(false);
  });

  it("dblclick on empty space is a no-op", () => {
    const { r, fc } = settled();
    live = r;
    expect(r.isIdle()).toBe(true);
    fc.fire("dblclick", { clientX: 5, clientY: 5 });
    expect(r.isIdle()).toBe(true);
  });
});

describe("GraphRenderer.focusBestMatch (§5.2 enter-to-focus)", () => {
  it("centers the highest-degree search match in the viewport", () => {
    const { r, h, data } = settled();
    live = r;
    // n1 is an interior chain node (degree 2); light it as the only match
    const best = data.nodes.find((n) => n.id === "n1")!;
    r.setSearchMatches(new Set(["n1"]));
    r.focusBestMatch();
    expect(r.isIdle()).toBe(false); // a 400ms focus animation is running
    h.run(5000);
    const t = r.currentTransform();
    // centerOn(wx,wy) ⇒ applyX(wx) === cssW/2, applyY(wy) === cssH/2 exactly
    expect(t.applyX(best.x as number)).toBeCloseTo(400, 3);
    expect(t.applyY(best.y as number)).toBeCloseTo(300, 3);
    expect(t.k).toBeGreaterThanOrEqual(1.4 - 1e-6);
  });

  it("is a no-op when there are no search matches", () => {
    const { r } = settled(); // no searchMatches set ⇒ default null
    live = r;
    const before = r.currentTransform();
    r.focusBestMatch();
    expect(r.isIdle()).toBe(true); // early-returned without scheduling a frame
    expect(r.currentTransform()).toBe(before);
  });
});
