import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";
import { MemoryVectorIndex } from "../src/memory-index.js";
import { rrfFuse } from "../src/memory-search.js";
import type { EmbeddingProvider } from "../src/memory-embed.js";

// MEM-4: a DETERMINISTIC fake embedder — no model download, no network. It maps a few surface words
// to shared "concept" dimensions so a query can be semantically close to a doc that shares NO literal
// terms (the paraphrase case BM25 cannot catch). Vectors are one-hot-ish over the concept space.
const CONCEPTS = ["dog", "cat", "vehicle"] as const;
const SYNONYMS: Record<string, (typeof CONCEPTS)[number]> = {
  dog: "dog", canine: "dog", puppy: "dog", hound: "dog",
  cat: "cat", feline: "cat", kitten: "cat",
  vehicle: "vehicle", automobile: "vehicle", car: "vehicle", truck: "vehicle",
};
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length);
  for (const tok of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const concept = SYNONYMS[tok];
    if (concept) v[CONCEPTS.indexOf(concept)] += 1;
  }
  return v;
}
const fakeProvider: EmbeddingProvider = {
  id: "fake", model: "fake-concepts", dim: CONCEPTS.length,
  async embed(texts) { return texts.map(fakeEmbed); },
};

function freshDir(): string { return mkdtempSync(join(tmpdir(), "chimera-mem4-")); }

// Store wired with the fake index. `nullProvider` simulates "no embedder available" (degrade path);
// `provider` injects a custom one (e.g. a throwing embedder to exercise the error state).
function makeStore(opts?: { nullProvider?: boolean; provider?: EmbeddingProvider }) {
  const dir = freshDir();
  const resolved = opts?.nullProvider ? null : (opts?.provider ?? fakeProvider);
  const index = new MemoryVectorIndex(join(dir, "memory-index"), async () => resolved);
  const store = new MemoryStore(dir, undefined, undefined, index);
  return { dir, index, store };
}

// An embedder that resolves but throws on every embed — drives the "error" state + query degrade.
const throwingProvider: EmbeddingProvider = {
  id: "boom", model: "boom", dim: 3,
  async embed() { throw new Error("embed backend exploded"); },
};

describe("MEM-4 hybrid search", () => {
  it("hybrid beats lexical on a paraphrase query (no shared terms)", async () => {
    const { store, index } = makeStore();
    // A is added FIRST → oldest → lexical (no query match) puts it LAST. Only semantics can lift it.
    const a = store.add({ author: "t", text: "the dog is a loyal companion" });
    store.add({ author: "t", text: "the automobile drives quickly on the road" });
    store.add({ author: "t", text: "feline pets are quite independent" });
    await index.flush();

    const q = { query: "canine", mode: "hybrid" as const, limit: 10 };
    const hybrid = await store.searchHybrid(q);
    // "canine" appears in NO document text, so BM25 alone can't find the dog note — semantics must.
    expect(hybrid[0].record.id).toBe(a.id);

    const lexical = await store.searchHybrid({ ...q, mode: "lexical" });
    // Pure lexical can't rank the dog note first for "canine" (zero term overlap).
    expect(lexical[0].record.id).not.toBe(a.id);
  });

  it("unembedded records still surface lexically under hybrid", async () => {
    const { store, index } = makeStore();
    const auto = store.add({ author: "t", text: "the automobile is red" });
    await index.flush();
    // Added AFTER flush → has NO vector yet, but contains the literal term "vehicle".
    const reg = store.add({ author: "t", text: "vehicle registration renewal notice" });

    const res = await store.searchHybrid({ query: "vehicle", mode: "hybrid", limit: 10 });
    const ids = res.map((r) => r.record.id);
    expect(ids).toContain(reg.id);   // surfaced by lexical (literal "vehicle") despite no vector
    expect(ids).toContain(auto.id);  // surfaced by cosine (automobile → vehicle concept)
  });

  it("with the embedder off, hybrid is byte-identical to lexical", async () => {
    const { store, index } = makeStore({ nullProvider: true });
    store.add({ author: "t", text: "the dog barks" });
    store.add({ author: "t", text: "the cat sleeps" });
    await index.flush();   // provider resolves to null → nothing embedded

    const q = { query: "dog", limit: 10 };
    const hybrid = await store.searchHybrid({ ...q, mode: "hybrid" });
    const lexical = await store.searchHybrid({ ...q, mode: "lexical" });
    expect(hybrid.map((r) => r.record.id)).toEqual(lexical.map((r) => r.record.id));
  });

  it("semantic mode ranks by cosine and keeps unembedded records as a tail", async () => {
    const { store, index } = makeStore();
    const dog = store.add({ author: "t", text: "the dog is loyal" });
    store.add({ author: "t", text: "the automobile is fast" });
    await index.flush();
    // Added AFTER flush → no vector; semantic must still include it (as the lexical tail), not drop it.
    const later = store.add({ author: "t", text: "unrelated gardening note" });

    const res = await store.searchHybrid({ query: "canine", mode: "semantic", limit: 10 });
    expect(res[0].record.id).toBe(dog.id);                    // cosine-primary: canine → dog concept
    expect(res.map((r) => r.record.id)).toContain(later.id);  // unembedded record surfaces in the tail
  });

  it("surfaces an embedder failure as state:error and still degrades search to lexical", async () => {
    const { store, index } = makeStore({ provider: throwingProvider });
    const rec = store.add({ author: "t", text: "the dog barks loudly" });
    await index.flush();   // provider resolves, embed() throws → error recorded

    const status = await store.indexStatus();
    expect(status.state).toBe("error");
    expect(status.degraded).toBe(true);
    expect(status.error).toContain("exploded");

    // A hybrid query must not throw — the query embed fails, so it falls back to lexical.
    const res = await store.searchHybrid({ query: "dog", mode: "hybrid", limit: 10 });
    expect(res.map((r) => r.record.id)).toContain(rec.id);
  });

  it("sync search() is unchanged and independent of the index", async () => {
    const { store, index } = makeStore();
    store.add({ author: "t", text: "the dog is loyal" });
    await index.flush();
    // The legacy sync path never consults the vector index — pure lexical, exactly as before MEM-4.
    const sync = store.search({ query: "dog", limit: 10 });
    expect(sync.length).toBe(1);
    expect(sync[0].record.text).toContain("dog");
  });
});

describe("MEM-4 memory.index status/rebuild", () => {
  it("reports off when no index is attached", async () => {
    const dir = freshDir();
    const store = new MemoryStore(dir);   // no index
    const status = await store.indexStatus();
    expect(status.state).toBe("off");
    expect(status.provider).toBeNull();
    expect(status.degraded).toBe(true);
  });

  it("transitions off → ready as records embed, and counts correctly", async () => {
    const { store, index } = makeStore();
    store.add({ author: "t", text: "the dog runs" });
    store.add({ author: "t", text: "the car drives" });

    await index.flush();
    const status = await store.indexStatus();
    expect(status.state).toBe("ready");
    expect(status.provider).toBe("fake");
    expect(status.model).toBe("fake-concepts");
    expect(status.dim).toBe(CONCEPTS.length);
    expect(status.embedded).toBe(2);
    expect(status.total).toBe(2);
    expect(status.pending).toBe(0);
    expect(status.degraded).toBe(false);
  });

  it("off provider reports state off even with records present", async () => {
    const { store, index } = makeStore({ nullProvider: true });
    store.add({ author: "t", text: "hello" });
    await index.flush();
    const status = await store.indexStatus();
    expect(status.state).toBe("off");
    expect(status.embedded).toBe(0);
    expect(status.total).toBe(1);
  });

  it("rebuild re-embeds every record", async () => {
    const { store, index } = makeStore();
    store.add({ author: "t", text: "the dog" });
    store.add({ author: "t", text: "the cat" });
    // rebuild() kicks a BACKGROUND re-embed and returns immediately ("building") — it must never block
    // the RPC on a full backfill. Draining via flush() then reaches "ready".
    const building = await store.rebuildIndex();
    expect(building.state).toBe("building");
    await index.flush();
    const ready = await store.indexStatus();
    expect(ready.state).toBe("ready");
    expect(ready.embedded).toBe(2);
  });

  it("editing a note re-embeds it; deleting drops its vector", async () => {
    const { store, index } = makeStore();
    const rec = store.add({ author: "t", text: "the dog" });
    await index.flush();
    expect((await store.indexStatus()).embedded).toBe(1);

    store.edit(rec.id, { text: "the cat now" });
    // Edit changes the embed input → the record goes pending until re-embedded.
    expect((await store.indexStatus()).pending).toBe(1);
    await index.flush();
    expect((await store.indexStatus()).pending).toBe(0);

    store.delete(rec.id);
    const after = await store.indexStatus();
    expect(after.total).toBe(0);
    expect(after.embedded).toBe(0);
  });
});

describe("MEM-4 index persistence", () => {
  it("reuses valid vectors from the sidecar across a reload (no re-embed)", async () => {
    const dir = freshDir();
    const mk = () => {
      const index = new MemoryVectorIndex(join(dir, "memory-index"), async () => fakeProvider);
      return { index, store: new MemoryStore(dir, undefined, undefined, index) };
    };
    const first = mk();
    first.store.add({ author: "t", text: "the dog" });
    await first.index.flush();
    expect((await first.store.indexStatus()).embedded).toBe(1);

    // A second store over the SAME dir loads memory.json + the sidecar; the unchanged note's vector
    // is reused, so it is already embedded (pending 0) after ensureProvider, without a fresh embed.
    const second = mk();
    const status = await second.store.indexStatus();
    expect(status.total).toBe(1);
    expect(status.embedded).toBe(1);
    expect(status.pending).toBe(0);
  });
});

describe("MEM-4 rrfFuse", () => {
  it("fuses ranked lists with k=60; agreement at the top wins", () => {
    const lexical = ["a", "b", "c"];
    const cosine = ["a", "c", "b"];
    const fused = rrfFuse([lexical, cosine]);
    // a is rank 0 in BOTH lists → strictly highest; b and c are symmetric (ranks {1,2} vs {2,1}).
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
    expect(fused.get("b")!).toBeCloseTo(fused.get("c")!, 10);
  });

  it("an id present in only one list still scores from that list", () => {
    const fused = rrfFuse([["x"], ["y"]]);
    expect(fused.get("x")!).toBeCloseTo(1 / 61, 10);
    expect(fused.get("y")!).toBeCloseTo(1 / 61, 10);
  });
});
