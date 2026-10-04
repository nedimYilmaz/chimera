// MEM-6 §5.3 — headless perf harness (NOT part of the app build; lives outside
// src/ so it is excluded from tsc + the copy guard). Bundled by run-bench.mjs
// and run in real headless Chrome to MEASURE the acceptance numbers:
//   • 60fps sustained during interaction at 2k nodes / 4k edges;
//   • zero idle rAF work after the sim settles.
// It drives a continuous synthetic drag (physics + hit-test + draw every frame,
// the true worst case), samples real rAF frame deltas, then verifies the
// renderer schedules NO frames once idle. Results POST to /result.
import type { MemoryGraphResult } from "@chimera/protocol";
import { GraphRenderer } from "../src/memory-graph/renderer";
import { buildSimData } from "../src/memory-graph/build";
import { resolvePalette } from "../src/memory-graph/palette";

// deterministic LCG so every run builds the identical graph
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

function makeGraph(nNodes: number, nEdges: number): MemoryGraphResult {
  const rnd = lcg(12345);
  const kinds = ["decision", "fact", "todo", "question", "note"] as const;
  const nodes = Array.from({ length: nNodes }, (_, i) => ({
    id: `n${i}`,
    title: null as string | null,
    label: `note ${i} — a memory record label of realistic length`,
    kind: kinds[Math.floor(rnd() * kinds.length)],
    folder: i % 4 === 0 ? `folder/${i % 12}` : null,
    tags: [] as string[],
    degree: 0,
    updatedAt: i,
  }));
  const edges: MemoryGraphResult["edges"] = [];
  const bump = (id: string): void => {
    const n = nodes[+id.slice(1)];
    if (n) n.degree++;
  };
  for (let e = 0; e < nEdges; e++) {
    // bias ~10% of edges toward low-index "hub" nodes for a realistic degree tail
    const a = e % 10 === 0 ? Math.floor(rnd() * 40) : Math.floor(rnd() * nNodes);
    let b = Math.floor(rnd() * nNodes);
    if (b === a) b = (b + 1) % nNodes;
    edges.push({ source: `n${a}`, target: `n${b}`, kind: "link", weight: 1 });
    bump(`n${a}`);
    bump(`n${b}`);
  }
  return { nodes, edges };
}

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function post(data: unknown): Promise<void> {
  try {
    await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  } catch {
    /* ignore */
  }
  (document.title as string) = "DONE";
}

async function main(): Promise<void> {
  const N = 2000;
  const E = 4000;
  const result = makeGraph(N, E);
  const palette = resolvePalette((n) => getComputedStyle(document.documentElement).getPropertyValue(n));
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const renderer = new GraphRenderer(canvas, { palette });
  renderer.setSize(1400, 900, dpr);
  renderer.setData(buildSimData(result));

  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + 700;
  const cy = rect.top + 450;
  const pe = (type: string, x: number, y: number): PointerEvent =>
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true });

  // grab a node near center and drag it in a circle for the measurement window,
  // keeping physics + hit-testing + draw busy every single frame.
  canvas.dispatchEvent(pe("pointerdown", cx, cy));

  const MEASURE_MS = 4000;
  const deltas: number[] = [];
  let last = performance.now();
  const start = last;
  let angle = 0;
  while (performance.now() - start < MEASURE_MS) {
    const now = await raf();
    deltas.push(now - last);
    last = now;
    angle += 0.06;
    canvas.dispatchEvent(pe("pointermove", cx + Math.cos(angle) * 260, cy + Math.sin(angle) * 190));
  }
  canvas.dispatchEvent(pe("pointerup", cx, cy));

  // drop warmup frames, then compute stats
  const warm = deltas.slice(8).sort((a, b) => a - b);
  const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
  const p95 = warm[Math.floor(warm.length * 0.95)];
  const p99 = warm[Math.floor(warm.length * 0.99)];
  const max = warm[warm.length - 1];

  // wait for the sim to settle (poll isIdle), then prove idle rAF = 0 over 1.2s
  const settleStart = performance.now();
  while (!renderer.isIdle() && performance.now() - settleStart < 8000) await raf();
  const settledIn = performance.now() - settleStart;
  const fcBefore = renderer.frameCount();
  await sleep(1200);
  const idleFrames = renderer.frameCount() - fcBefore;

  await post({
    nodes: N,
    edges: E,
    dpr,
    sampleFrames: warm.length,
    meanMs: +mean.toFixed(2),
    p95Ms: +p95.toFixed(2),
    p99Ms: +p99.toFixed(2),
    maxMs: +max.toFixed(2),
    fps: +(1000 / mean).toFixed(1),
    settledInMs: +settledIn.toFixed(0),
    idleFrames,
  });
}

main().catch((e) => post({ error: String((e && (e as Error).stack) || e) }));
