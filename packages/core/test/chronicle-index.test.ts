import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronicleIndex } from "../src/chronicle-index.js";
import { stopScanWorker } from "../src/chronicle-scan.js";
import type { ChronicleDoc } from "../src/chronicle-distill.js";
import type { EmbeddingProvider } from "../src/memory-embed.js";

// CHRONICLE-SEMANTIC — index behaviour, hermetically. The embedder is a STUB: no model, no
// download, no network. What the stub gives up (real semantics) is covered by the opt-in live test;
// what it pins here is everything the index itself owns — persistence, scope, eviction, the
// lexical-only degradation, and the two-step retrieval contract.

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "chron-")); dirs.push(d); return d; };
afterEach(() => { stopScanWorker(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

let seq = 0;
const doc = (text: string, over: Partial<ChronicleDoc> = {}): ChronicleDoc => ({
  seq: ++seq, ts: 1_000 + seq, engineId: "local", agentId: "agent-a", kind: "message_complete",
  text, treeId: "tree-1", team: "team-x", ...over,
});

/** A deterministic stub: the vector is a one-hot bucket of the doc's first token, so "same first
 *  word ⇒ similar" — enough to prove the semantic channel is wired without pretending to be a model. */
const stubProvider = (): EmbeddingProvider => ({
  id: "stub", model: "stub-v1", dim: 384,
  embed: async (texts) => texts.map((t) => oneHot(t)),
  embedQuery: async (t) => oneHot(t),
});
function oneHot(t: string): Float32Array {
  const v = new Float32Array(384);
  const word = t.toLowerCase().replace(/^[a-z_]+:\s*/, "").split(/\s+/)[0] ?? "";
  let h = 0;
  for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  v[h % 384] = 1;   // already L2-normalized
  return v;
}

describe("ChronicleIndex", () => {
  it("finds a doc by its words with no embedder at all — lexical is the floor, not an error", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    ix.add(doc("kuyruga koydugum gorevler pending de bekledi"));
    ix.add(doc("dugun icin cicek siparisi verildi"));
    const { hits, semantic } = await ix.search("gorevler pending", {}, 5);
    expect(semantic).toBe(false);
    expect(hits[0]?.snippet).toContain("pending");
  });

  it("uses the semantic channel when an embedder is present", async () => {
    const ix = new ChronicleIndex(tmp(), async () => stubProvider());
    ix.add(doc("kuyruk hakkinda bir sey"));
    ix.add(doc("cicek hakkinda bir sey"));
    await ix.ensureProvider();
    await ix.processPending();
    const { semantic, hits } = await ix.search("kuyruk", {}, 5);
    expect(semantic).toBe(true);
    expect(hits[0]?.snippet).toContain("kuyruk");
  });

  it("survives a restart — docs, offsets and vectors all come back from disk", async () => {
    const dir = tmp();
    const a = new ChronicleIndex(dir, async () => stubProvider());
    const written = doc("kalici olmasi gereken bir kayit");
    a.add(written);
    await a.ensureProvider();
    await a.processPending();
    a.flushWrites();

    const b = new ChronicleIndex(dir, async () => stubProvider());
    b.load();
    expect(b.docCount()).toBe(1);
    expect(b.status().embedded).toBe(1);   // the vector file came back too, not just the text
    const [got] = await b.getDocs([written.seq]);
    expect(got?.text).toContain("kalici");
  });

  it("returns full docs only for the seqs asked for — the two-step contract", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    const first = doc("birinci kayit metni");
    const second = doc("ikinci kayit metni");
    ix.add(first); ix.add(second);
    const got = await ix.getDocs([second.seq]);
    expect(got.map((d) => d.text)).toEqual([second.text]);
    // a seq that was never indexed is simply absent, never an error
    expect(await ix.getDocs([999_999])).toEqual([]);
  });

  it("honours scope — an agent asking about its own tree cannot see another's", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    ix.add(doc("gizli kalmasi gereken kuyruk kaydi", { agentId: "other", treeId: "tree-2", team: "team-y" }));
    ix.add(doc("benim kuyruk kaydim", { treeId: "tree-1", team: "team-x" }));
    const mine = await ix.search("kuyruk", { treeIds: ["tree-1"] }, 10);
    expect(mine.hits).toHaveLength(1);
    expect(mine.hits[0]?.agentId).toBe("agent-a");
    // and a doc with NO tree is not swept in by a tree filter
    ix.add(doc("kuyruk ama agacsiz", { treeId: null }));
    expect((await ix.search("kuyruk", { treeIds: ["tree-1"] }, 10)).hits).toHaveLength(1);
  });

  it("evicts oldest-first at the cap, and the evicted docs stop being retrievable", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null, { maxDocs: 4, docsPerSegment: 2 });
    const added = Array.from({ length: 8 }, (_, n) => { const d = doc(`kayit ${n}`); ix.add(d); return d; });
    expect(ix.docCount()).toBeLessThanOrEqual(6);   // segment-granular: overshoots by <1 segment
    expect(ix.has(added[0]!.seq)).toBe(false);      // the oldest is gone
    expect(ix.has(added[7]!.seq)).toBe(true);       // the newest is not
    expect(await ix.getDocs([added[0]!.seq])).toEqual([]);
  });

  it("ignores a re-delivered seq instead of double-indexing it", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    const d = doc("bir kere sayilmali");
    ix.add(d); ix.add(d); ix.add({ ...d });
    expect(ix.docCount()).toBe(1);
  });

  it("drops vectors, but never text, when the model changes underneath it", async () => {
    const dir = tmp();
    const a = new ChronicleIndex(dir, async () => stubProvider());
    const written = doc("model degisse de kalmali");
    a.add(written);
    await a.ensureProvider();
    await a.processPending();
    a.flushWrites();

    const other: EmbeddingProvider = { ...stubProvider(), model: "stub-v2" };
    const b = new ChronicleIndex(dir, async () => other);
    b.load();
    await b.ensureProvider();
    // mixing vectors from two models inside one index degrades cosine silently — so they go...
    expect(b.status().pending).toBe(1);
    // ...but the doc itself is untouched and still searchable/lexically rankable.
    expect(b.docCount()).toBe(1);
    expect((await b.getDocs([written.seq]))[0]?.text).toContain("model degisse");
  });

  it("reports what it is doing, including that nothing is embedded yet", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null, { maxDocs: 99 });
    ix.add(doc("bir"));
    const s = ix.status();
    expect(s).toMatchObject({ docs: 1, embedded: 0, pending: 1, maxDocs: 99 });
  });
});

// AGENT-FORGET — this index deliberately OUTLIVES the event log's own pruning; that is the point of
// a long memory. It must not outlive an explicit delete: an index that kept answering questions
// about a forgotten agent would make "forget" a lie, since the work would still surface in
// chronicle_search after the events were erased.
describe("forgetting an agent", () => {
  it("drops that agent's documents and keeps everyone else's", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    const mine = doc("benim kaydim", { agentId: "gone" });
    const theirs = doc("baskasinin kaydi", { agentId: "kept" });
    ix.add(mine); ix.add(theirs);

    expect(ix.forgetAgent(["gone"])).toBe(1);
    expect(ix.has(mine.seq)).toBe(false);
    expect(ix.has(theirs.seq)).toBe(true);
    expect(await ix.getDocs([mine.seq])).toEqual([]);
    expect((await ix.getDocs([theirs.seq]))[0]?.text).toContain("baskasinin");
  });

  it("stops returning it from SEARCH, which is the whole point", async () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    ix.add(doc("kuyruk hakkinda gizli kayit", { agentId: "gone" }));
    expect((await ix.search("kuyruk", {}, 5)).hits).toHaveLength(1);
    ix.forgetAgent(["gone"]);
    expect((await ix.search("kuyruk", {}, 5)).hits).toEqual([]);
  });

  it("leaves the SURVIVORS readable — their byte offsets move when a doc is removed", async () => {
    // Offsets are positions into the segment file, so every doc after a removal shifts. Not
    // recomputing them would leave the remaining docs returning garbage or nothing.
    const ix = new ChronicleIndex(tmp(), async () => null);
    const a = doc("birinci kayit", { agentId: "gone" });
    const b = doc("ikinci kayit uzun bir metin", { agentId: "kept" });
    const c = doc("ucuncu", { agentId: "kept" });
    ix.add(a); ix.add(b); ix.add(c);
    ix.forgetAgent(["gone"]);
    expect((await ix.getDocs([b.seq]))[0]?.text).toContain("ikinci kayit uzun bir metin");
    expect((await ix.getDocs([c.seq]))[0]?.text).toContain("ucuncu");
  });

  it("survives a reopen — the removal is on disk, not just in memory", async () => {
    const dir = tmp();
    const a = new ChronicleIndex(dir, async () => null);
    const gone = doc("silinecek", { agentId: "gone" });
    const kept = doc("kalacak", { agentId: "kept" });
    a.add(gone); a.add(kept);
    a.forgetAgent(["gone"]);
    a.flushWrites();

    const b = new ChronicleIndex(dir, async () => null);
    b.load();
    expect(b.docCount()).toBe(1);
    expect((await b.getDocs([kept.seq]))[0]?.text).toContain("kalacak");
  });

  it("is a no-op for an empty request", () => {
    const ix = new ChronicleIndex(tmp(), async () => null);
    ix.add(doc("x"));
    expect(ix.forgetAgent([])).toBe(0);
    expect(ix.forgetAgent([""])).toBe(0);
    expect(ix.docCount()).toBe(1);
  });
});
