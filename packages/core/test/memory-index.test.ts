import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryVectorIndex, type IndexableRecord } from "../src/memory-index.js";
import type { EmbeddingProvider } from "../src/memory-embed.js";

// MEM-4: direct coverage for MemoryVectorIndex's RECOVERY / INVALIDATION edges — the paths the
// hybrid/store tests reach only indirectly: corrupt-sidecar recovery (load() catch), model/dim-change
// vector invalidation (ensureProvider meta mismatch), and retain() shedding across a restart. The
// sidecar is DERIVED, disposable state, so every one of these degrades to "re-embed", never an error.

// Deterministic, network-free concept embedder (same shape as memory-hybrid's fake). Maps a few surface
// words onto a 3-dim one-hot-ish concept space so cosine order is meaningful without a model download.
const CONCEPTS = ["dog", "cat", "car"] as const;
const SYNONYMS: Record<string, (typeof CONCEPTS)[number]> = {
  dog: "dog", canine: "dog", puppy: "dog",
  cat: "cat", feline: "cat", kitten: "cat",
  car: "car", automobile: "car", vehicle: "car",
};
function conceptEmbed(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length);
  for (const tok of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const c = SYNONYMS[tok];
    if (c) v[CONCEPTS.indexOf(c)] += 1;
  }
  return v;
}
function providerWith(id: string, model: string, dim = CONCEPTS.length): EmbeddingProvider {
  return {
    id, model, dim,
    async embed(texts) {
      // Pad/truncate the concept vector to the declared dim so a dim CHANGE produces genuinely
      // wrong-length vectors (the invalidation trigger), while same-dim stays valid.
      return texts.map((t) => {
        const base = conceptEmbed(t);
        if (dim === base.length) return base;
        const out = new Float32Array(dim);
        out.set(base.subarray(0, Math.min(dim, base.length)));
        return out;
      });
    },
  };
}

function freshDir(): string { return join(mkdtempSync(join(tmpdir(), "chimera-mem4-idx-")), "memory-index"); }

describe("MEM-4 MemoryVectorIndex: corrupt-sidecar recovery", () => {
  it("nukes an unparseable sidecar and boots empty (load() catch)", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const metaFile = join(dir, "meta.json");
    const vectorsFile = join(dir, "vectors.bin");
    // Both files must exist for load() to attempt a parse; the meta is deliberately not JSON.
    writeFileSync(metaFile, "{ this is not json");
    writeFileSync(vectorsFile, Buffer.from([1, 2, 3, 4]));

    const idx = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts"));
    idx.load();

    // Disposable state → the torn sidecar is deleted, not left to poison the next boot.
    expect(existsSync(metaFile)).toBe(false);
    expect(existsSync(vectorsFile)).toBe(false);
    // Nothing was loaded; a fresh enqueue simply re-embeds under the current provider.
    idx.enqueue({ id: "a", title: null, text: "the dog" });
    await idx.flush();
    expect(idx.status(1).embedded).toBe(1);
  });

  it("recovers from a vectors.bin size mismatch (meta rows vs float count)", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const metaFile = join(dir, "meta.json");
    const vectorsFile = join(dir, "vectors.bin");
    // Well-formed meta claiming one 3-dim row, but the payload is far too short → throws in load().
    writeFileSync(metaFile, JSON.stringify({
      version: 1, provider: "fake", model: "concepts", dim: 3, rows: [{ id: "a", hash: "h" }],
    }));
    writeFileSync(vectorsFile, Buffer.from([0, 0]));

    const idx = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts"));
    idx.load();
    expect(existsSync(metaFile)).toBe(false);
    expect(existsSync(vectorsFile)).toBe(false);
    expect(idx.status(0).embedded).toBe(0);
  });

  it("ignores a sidecar written under a newer version and starts empty", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      version: 999, provider: "fake", model: "concepts", dim: 3, rows: [],
    }));
    writeFileSync(join(dir, "vectors.bin"), Buffer.from([]));

    const idx = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts"));
    idx.load();
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
  });
});

describe("MEM-4 MemoryVectorIndex: model/dim-change invalidation (ensureProvider)", () => {
  it("reuses same-model vectors but discards them when the model name changes", async () => {
    const dir = freshDir();
    const rec = { id: "a", title: null, text: "the dog" };

    const first = new MemoryVectorIndex(dir, async () => providerWith("fake", "model-A"));
    first.enqueue(rec);
    await first.flush();
    expect(first.status(1).embedded).toBe(1);

    // A NEW index over the same sidecar, resolved to a DIFFERENT model. load() reuses the row, so the
    // record reads as embedded BEFORE the provider is known...
    const second = new MemoryVectorIndex(dir, async () => providerWith("fake", "model-B"));
    second.load();
    second.enqueue(rec);
    expect(second.status(1).embedded).toBe(1);

    // ...but ensureProvider sees model-A ≠ model-B and drops the stale vector so it re-embeds.
    await second.ensureProvider();
    expect(second.status(1).embedded).toBe(0);
    expect(second.status(1).pending).toBe(1);

    await second.flush();
    const ready = second.status(1);
    expect(ready.embedded).toBe(1);
    expect(ready.model).toBe("model-B");
  });

  it("discards vectors when only the dimension changes under the same model name", async () => {
    const dir = freshDir();
    const rec = { id: "a", title: null, text: "the dog" };

    const first = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts", 3));
    first.enqueue(rec);
    await first.flush();

    // Same provider id + model name, but a different vector dimension → the old sidecar is useless.
    const second = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts", 5));
    second.load();
    second.enqueue(rec);
    await second.ensureProvider();
    expect(second.status(1).embedded).toBe(0);

    await second.flush();
    const ready = second.status(1);
    expect(ready.embedded).toBe(1);
    expect(ready.dim).toBe(5);
  });
});

// MEM-7 §4: direct coverage for neighborPairs — the graph() tests only exercise ≤3-node fixtures, so
// the k-truncation branch (a node with MORE than k close neighbors) and the symmetric-rescue branch
// (a pair kept because ONE side nominates the other even though it fell out of the other's top-k) are
// otherwise unreachable. A high-dim one-hot embedder gives exact, tunable cosine so we can seed a hub
// with a controllable number of equally/near-equally close neighbors without a model download.

// One-hot-per-token in a wide concept space: identical tokens ⇒ cosine 1, disjoint ⇒ 0. A weighted
// blend ("hub extra") lets a node sit close to several others at DISTINCT, orderable scores.
function orthoProviderWith(id: string, model: string, vocab: string[]): EmbeddingProvider {
  const dim = vocab.length;
  return {
    id, model, dim,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          const i = vocab.indexOf(tok);
          if (i >= 0) v[i] += 1;
        }
        return v;
      });
    },
  };
}

describe("MEM-7 MemoryVectorIndex.neighborPairs", () => {
  async function seed(recs: IndexableRecord[], vocab: string[]): Promise<MemoryVectorIndex> {
    const idx = new MemoryVectorIndex(freshDir(), async () => orthoProviderWith("fake", "ortho", vocab));
    for (const r of recs) idx.enqueue(r);
    await idx.flush();
    return idx;
  }

  it("k-truncation DROPS a pair that clears minScore but is outside top-k on BOTH sides", async () => {
    // k=2. Hub H is weakly linked (shared token "h") to five leaves; L3/L4/L5 also share a strong
    // "g g" group token making them a mutually-identical clique (cosine 1 to each other). Cosines to H:
    //   L1 "h"        → 1.00      (H's #1)
    //   L2 "h u2"     → 0.707     (H's #2)
    //   L3/L4/L5 "h g g" → 0.447  (all tied, BELOW H's top-2 cut)
    // and each of L3/L4/L5's OWN top-2 is the other two g-clique members (cosine 1), so none nominates H.
    // ⇒ H–L3/L4/L5 clear minScore (0.447 > 0.1) yet are excluded PURELY by k-truncation on both sides —
    // the branch graph()'s ≤3-node fixtures never reach.
    const vocab = ["h", "u2", "g"];
    const idx = await seed([
      { id: "H", title: null, text: "h" },
      { id: "L1", title: null, text: "h" },
      { id: "L2", title: null, text: "h u2" },
      { id: "L3", title: null, text: "h g g" },
      { id: "L4", title: null, text: "h g g" },
      { id: "L5", title: null, text: "h g g" },
    ], vocab);

    const pairs = idx.neighborPairs(["H", "L1", "L2", "L3", "L4", "L5"], 2, 0.1);
    const edgeKeys = new Set(pairs.map((p) => [p.a, p.b].sort().join("-")));

    // H keeps only its top-2 and no leaf rescues the rest:
    expect(edgeKeys.has("H-L1")).toBe(true);
    expect(edgeKeys.has("H-L2")).toBe(true);
    expect(edgeKeys.has("H-L3")).toBe(false);   // 0.447 > minScore — dropped by truncation, not score
    expect(edgeKeys.has("H-L4")).toBe(false);
    expect(edgeKeys.has("H-L5")).toBe(false);
    // The g-clique's own mutual edges (cosine 1) are unaffected:
    expect(edgeKeys.has("L3-L4")).toBe(true);
    expect(edgeKeys.has("L3-L5")).toBe(true);
    expect(edgeKeys.has("L4-L5")).toBe(true);
  });

  it("symmetric rescue: a pair survives when only ONE side nominates the other (k=1)", async () => {
    // A star: center C is close to A, B, D at descending scores. With k=1, C's single slot goes to
    // its BEST neighbor (A). B and D drop out of C's list — but each leaf's own single slot points
    // back at C, so B–C and D–C are RESCUED by the leaf side.
    const vocab = ["c", "a", "b", "d"];
    const idx = await seed([
      { id: "C", title: null, text: "c" },
      { id: "A", title: null, text: "c a" },
      { id: "B", title: null, text: "c b b b" },
      { id: "D", title: null, text: "c d d d d d d d" },
    ], vocab);

    const pairs = idx.neighborPairs(["C", "A", "B", "D"], 1, 0.05);
    const edgeKeys = new Set(pairs.map((p) => [p.a, p.b].sort().join("-")));
    // All three center-leaf edges present despite C's top-1 holding only A: B and D are rescued because
    // their OWN top-1 nominates C.
    expect(edgeKeys.has("A-C")).toBe(true);
    expect(edgeKeys.has("B-C")).toBe(true);
    expect(edgeKeys.has("C-D")).toBe(true);
    // No leaf-leaf edges: each leaf's single top-1 slot points at C (not another leaf), so A-B/A-D/
    // B-D are excluded by k=1 truncation on both sides — not because the leaves are orthogonal.
    expect(edgeKeys.has("A-B")).toBe(false);
    expect(edgeKeys.has("A-D")).toBe(false);
    expect(edgeKeys.has("B-D")).toBe(false);
  });

  it("deduplicates the two directed nominations into one undirected pair (a<b, best score)", async () => {
    const vocab = ["x"];
    const idx = await seed([
      { id: "p", title: null, text: "x" },
      { id: "q", title: null, text: "x" },
    ], vocab);
    const pairs = idx.neighborPairs(["p", "q"], 3, 0.05);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe("p");           // canonical order a<b
    expect(pairs[0]!.b).toBe("q");
    expect(pairs[0]!.score).toBeCloseTo(1);  // identical vectors → cosine 1
  });

  it("silently skips ids without a current vector (unembedded/ghost), never errors", async () => {
    const vocab = ["x"];
    const idx = await seed([
      { id: "p", title: null, text: "x" },
      { id: "q", title: null, text: "x" },
    ], vocab);
    // "ghost" was never enqueued/embedded → no vector; it must be dropped, not throw.
    const pairs = idx.neighborPairs(["p", "q", "ghost"], 3, 0.05);
    expect(pairs).toHaveLength(1);
    expect(pairs.some((p) => p.a === "ghost" || p.b === "ghost")).toBe(false);
  });

  it("excludes pairs at or below minScore (orthogonal notes produce no edge)", async () => {
    const vocab = ["x", "y"];
    const idx = await seed([
      { id: "p", title: null, text: "x" },
      { id: "q", title: null, text: "y" },   // orthogonal to p → cosine 0
    ], vocab);
    expect(idx.neighborPairs(["p", "q"], 3, 0.6)).toEqual([]);
  });
});

describe("MEM-4 MemoryVectorIndex: retain shedding across a restart", () => {
  it("drops sidecar rows for ids gone since the last boot", async () => {
    const dir = freshDir();
    const a = { id: "a", title: null, text: "the dog" };
    const b = { id: "b", title: null, text: "the car" };

    const first = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts"));
    first.enqueue(a);
    first.enqueue(b);
    await first.flush();
    expect(first.status(2).embedded).toBe(2);

    // Restart: b was deleted while the daemon was down, so only {a} is retained. b's vector must be
    // shed and MUST NOT surface in cosine ranking; a's vector is reused (no re-embed needed).
    const second = new MemoryVectorIndex(dir, async () => providerWith("fake", "concepts"));
    second.load();
    second.retain(new Set(["a"]));
    second.enqueue(a);
    await second.ensureProvider();

    expect(second.status(1).embedded).toBe(1);
    const order = await second.queryOrder("dog", ["a", "b"]);
    expect(order).toEqual(["a"]);   // b is gone; a matches the "dog" concept
  });
});
