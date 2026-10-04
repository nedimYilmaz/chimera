import { describe, expect, it } from "vitest";
import type { MemoryGraphResult } from "@chimera/protocol";
import { buildSimData } from "../src/memory-graph/build";
import { resolvePalette } from "../src/memory-graph/palette";
import { GraphRenderer, buildAdjacency, folderAnchors } from "../src/memory-graph/renderer";
import type { CanvasLike } from "../src/memory-graph/sprites";
import type { SimLink, SimNode } from "../src/memory-graph/types";

// ---- fakes: a canvas + 2d ctx that swallow every draw call (no DOM) ---------
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    { get: () => () => undefined, set: () => true },
  ) as unknown as CanvasRenderingContext2D;
}
function fakeCanvas(): HTMLCanvasElement {
  const listeners: Record<string, unknown> = {};
  const el = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => fakeCtx(),
    addEventListener: (k: string, fn: unknown) => {
      listeners[k] = fn;
    },
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  return el as unknown as HTMLCanvasElement;
}
function spriteCtx(): CanvasRenderingContext2D {
  return {
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    set fillStyle(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;
}
const fakeSprite = (): CanvasLike => ({ width: 8, height: 8, getContext: () => spriteCtx() });

// manual rAF pump + virtual clock
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
  // run up to `cap` frames or until the queue drains, advancing the clock 16ms/frame
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

function grid(n: number): MemoryGraphResult {
  const kinds = ["decision", "fact", "todo", "question", "note"] as const;
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    title: null,
    label: `node ${i}`,
    kind: kinds[i % kinds.length],
    folder: i % 3 === 0 ? "ops" : null,
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
  // fix degrees for a couple hubs
  for (const e of edges) {
    const s = nodes.find((x) => x.id === e.source)!;
    const t = nodes.find((x) => x.id === e.target)!;
    s.degree++;
    t.degree++;
  }
  return { nodes, edges };
}

const palette = resolvePalette(() => "#9aa3f2");

describe("GraphRenderer — idle-freeze invariant (§5.3)", () => {
  it("settles to a frozen, zero-scheduled state after setData", () => {
    const h = harness();
    const r = new GraphRenderer(fakeCanvas(), {
      palette,
      raf: h.raf,
      caf: h.caf,
      now: h.nowFn,
      createCanvas: () => fakeSprite(),
    });
    r.setSize(800, 600, 2);
    r.setData(buildSimData(grid(120)));
    expect(r.isIdle()).toBe(false); // warm right after setData
    const frames = h.run(5000); // pump until it drains
    expect(h.pending()).toBe(0); // NOTHING scheduled at idle — the acceptance
    expect(r.isIdle()).toBe(true);
    expect(frames).toBeGreaterThan(50); // it actually simulated
    expect(frames).toBeLessThan(2000); // and converged (didn't spin forever)
    const settled = r.frameCount();
    // truly idle: running again does no work
    expect(h.run(10)).toBe(0);
    expect(r.frameCount()).toBe(settled);
    r.dispose();
  });

  it("an interaction (search match) wakes exactly one settling burst then re-freezes", () => {
    const h = harness();
    const r = new GraphRenderer(fakeCanvas(), {
      palette,
      raf: h.raf,
      caf: h.caf,
      now: h.nowFn,
      createCanvas: () => fakeSprite(),
    });
    r.setSize(800, 600, 1);
    r.setData(buildSimData(grid(60)));
    h.run(5000);
    expect(r.isIdle()).toBe(true);
    const before = r.frameCount();
    r.setSearchMatches(new Set(["n1", "n2"]));
    expect(h.pending()).toBe(1); // woke
    h.run(5000);
    expect(r.isIdle()).toBe(true); // and re-froze
    expect(r.frameCount()).toBeGreaterThan(before);
    r.dispose();
  });

  it("dispose stops the loop", () => {
    const h = harness();
    const r = new GraphRenderer(fakeCanvas(), { palette, raf: h.raf, caf: h.caf, now: h.nowFn, createCanvas: () => fakeSprite() });
    r.setData(buildSimData(grid(30)));
    r.dispose();
    expect(h.pending()).toBe(0);
    expect(r.isIdle()).toBe(true);
  });

  // F2 (code-review): a background memory:* refetch must NOT snap the view back
  // to whole-graph fit or re-layout from scratch — preserveView carries surviving
  // node positions over by id; a fresh (non-preserve) setData re-seeds.
  it("preserveView carries node positions across a refetch; fresh setData re-seeds", () => {
    const h = harness();
    const r = new GraphRenderer(fakeCanvas(), { palette, raf: h.raf, caf: h.caf, now: h.nowFn, createCanvas: () => fakeSprite() });
    r.setSize(800, 600, 1);
    const d1 = buildSimData(grid(40));
    r.setData(d1);
    h.run(5000);
    const sx = d1.nodes[5].x as number;
    const sy = d1.nodes[5].y as number;
    expect(sx).toBeTypeOf("number");

    // preserveView refetch: same ids → settled positions carried onto the new data
    const d2 = buildSimData(grid(40));
    expect(d2.nodes[5].x).toBeUndefined();
    r.setData(d2, { preserveView: true });
    expect(d2.nodes[5].x).toBeCloseTo(sx, 6);
    expect(d2.nodes[5].y).toBeCloseTo(sy, 6);

    // control: a non-preserve setData re-seeds (d3 phyllotaxis init), not settled
    const d3 = buildSimData(grid(40));
    r.setData(d3);
    expect(d3.nodes[5].x).toBeTypeOf("number");
    expect(d3.nodes[5].x).not.toBeCloseTo(sx, 3);
    r.dispose();
  });
});

describe("renderer pure helpers", () => {
  it("buildAdjacency is bidirectional over id/ref link forms", () => {
    const links: SimLink[] = [
      { source: "a", target: "b", kind: "link", weight: 1 },
      { source: { id: "b" } as SimNode, target: { id: "c" } as SimNode, kind: "link", weight: 1 },
    ];
    const adj = buildAdjacency(links);
    expect(adj.get("a")).toEqual(new Set(["b"]));
    expect(adj.get("b")).toEqual(new Set(["a", "c"]));
    expect(adj.get("c")).toEqual(new Set(["b"]));
  });

  it("folderAnchors puts unfiled at origin and distinct folders on a ring", () => {
    const nodes = [
      { folder: "ops" },
      { folder: "ops" },
      { folder: "tasks" },
      { folder: null },
    ] as SimNode[];
    const a = folderAnchors(nodes);
    expect(a.get("")).toEqual({ x: 0, y: 0 }); // unfiled
    expect(a.has("ops")).toBe(true);
    expect(a.has("tasks")).toBe(true);
    // distinct, non-origin anchors
    expect(a.get("ops")).not.toEqual(a.get("tasks"));
    expect(Math.hypot(a.get("ops")!.x, a.get("ops")!.y)).toBeGreaterThan(0);
    // deterministic
    expect(folderAnchors(nodes).get("ops")).toEqual(a.get("ops"));
  });
});
