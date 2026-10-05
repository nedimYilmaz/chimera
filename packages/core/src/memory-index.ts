// MEM-4 (PLAN-MEMORY.md §6.3): the local, sidecar-persisted vector index behind hybrid/semantic
// memory search. It is DERIVED, OPTIONAL state — a pure accelerator over the lexical ranker:
//   - Search NEVER blocks on it. A cold/absent embedder just means cosine order is empty and
//     results fall back to lexical (the query embed is skipped until the provider is warm).
//   - The embedder resolves LAZILY (first semantic/hybrid query, or a memory.index call) — never at
//     boot — so a daemon that never searches semantically (and every unit test) touches no network.
//   - The sidecar ($CHIMERA_HOME/memory-index/) is disposable: any corruption or model change ⇒
//     delete + re-embed. Unlike memory.json (quarantined), losing it costs only recompute.
//
// Invariants: `desired` is the authoritative "what should be represented" map (fed by the store on
// add/edit/load); `vectors`/`hashes` are what IS embedded (id ∈ hashes ⟺ id ∈ vectors). An id is
// PENDING iff hashes[id] !== desired[id].hash. Vectors are stored L2-normalized, so cosine == dot.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndexResult } from "@chimera/protocol";
import { embedQueryVector, type EmbeddingProvider } from "./memory-embed.js";

export type IndexableRecord = { id: string; title: string | null; text: string };
export type EmbeddingProviderFactory = () => Promise<EmbeddingProvider | null>;

const SIDECAR_VERSION = 1;
const EMBED_BATCH = 16;   // records per provider.embed() call during backfill

// What we embed per record: title (if any) then text. The provider truncates further; hashing the
// full input is fine (cheap) and detects any edit that would change the embedding.
export function embedInput(rec: IndexableRecord): string {
  return (rec.title ? rec.title + "\n" : "") + rec.text;
}
function hashInput(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

type LoadedMeta = { provider: string; model: string; dim: number };

export class MemoryVectorIndex {
  private dir: string;
  private metaFile: string;
  private vectorsFile: string;
  private factory: EmbeddingProviderFactory;

  private desired = new Map<string, { input: string; hash: string }>();
  private vectors = new Map<string, Float32Array>();
  private hashes = new Map<string, string>();   // embedded hash; id ∈ hashes ⟺ id ∈ vectors

  private provider: EmbeddingProvider | null = null;
  private providerReady = false;
  private providerPromise: Promise<void> | null = null;   // memoized resolution
  private loadedMeta: LoadedMeta | null = null;
  private lastError: string | null = null;
  private processing = false;
  private scheduled = false;

  constructor(dir: string, factory: EmbeddingProviderFactory) {
    this.dir = dir;
    this.metaFile = join(dir, "meta.json");
    this.vectorsFile = join(dir, "vectors.bin");
    this.factory = factory;
  }

  // --- store-driven mutations (all cheap, network-free) ---

  // Register/update a record. Only kicks background embedding if the provider is ALREADY warm — a
  // fresh add on a never-searched daemon must not trigger a probe (keeps boot/tests network-free).
  enqueue(rec: IndexableRecord): void {
    const input = embedInput(rec);
    this.desired.set(rec.id, { input, hash: hashInput(input) });
    if (this.providerReady) this.scheduleProcess();
  }

  drop(id: string): void {
    this.desired.delete(id);
    this.vectors.delete(id);
    this.hashes.delete(id);
  }

  // Prune everything not in `ids` — called after load to shed sidecar rows for records deleted or
  // evicted while the daemon was down.
  retain(ids: Set<string>): void {
    for (const id of [...this.vectors.keys()]) if (!ids.has(id)) this.drop(id);
    for (const id of [...this.desired.keys()]) if (!ids.has(id)) this.drop(id);
  }

  // --- graph support (MEM-7, PLAN-MEMORY.md §4) ---

  // Top-`k` nearest-neighbor cosine pairs among `ids` that carry a current vector (ids without one —
  // unembedded or ghost — are silently skipped, never an error), scored above `minScore`, symmetrized:
  // a pair survives if EITHER side nominates the other as a top-k neighbor, so a popular note doesn't
  // lose its edge just because it has more than k close neighbors of its own. Vectors are stored
  // L2-normalized (class comment), so cosine == dot. This is O(n²·dim) — a stricter cost than
  // queryOrder's O(n·dim) per-query scan. Unlike a query embed this only runs when the app
  // opts into semantic graph edges, not on every search keystroke. Larger configured capacities
  // should use filtered subsets: the historical ≤2000-record cost assumption no longer holds.
  neighborPairs(ids: string[], k = 3, minScore = 0.6): Array<{ a: string; b: string; score: number }> {
    const embedded = ids.filter((id) => this.vectors.has(id));
    const topK = new Map<string, Array<{ id: string; score: number }>>();
    const offer = (from: string, to: string, score: number): void => {
      const list = topK.get(from) ?? [];
      list.push({ id: to, score });
      list.sort((x, y) => y.score - x.score);
      if (list.length > k) list.length = k;
      topK.set(from, list);
    };
    for (let i = 0; i < embedded.length; i++) {
      const va = this.vectors.get(embedded[i])!;
      for (let j = i + 1; j < embedded.length; j++) {
        const vb = this.vectors.get(embedded[j])!;
        let dot = 0;
        for (let d = 0; d < va.length; d++) dot += va[d] * vb[d];
        if (dot > minScore) {
          offer(embedded[i], embedded[j], dot);
          offer(embedded[j], embedded[i], dot);
        }
      }
    }
    const pairs = new Map<string, number>();   // key "a\0b" (a<b, dedup'd) → best-seen score
    for (const [from, neighbors] of topK) {
      for (const n of neighbors) {
        const key = from < n.id ? `${from}\0${n.id}` : `${n.id}\0${from}`;
        const prev = pairs.get(key);
        if (prev === undefined || n.score > prev) pairs.set(key, n.score);
      }
    }
    return [...pairs.entries()].map(([key, score]) => {
      const [a, b] = key.split("\0");
      return { a, b, score };
    });
  }

  // --- query path (the only place a query is embedded) ---

  // Cosine ranking of `candidateIds` for `query`, best-first. Returns null (⇒ caller uses lexical
  // only) when the embedder isn't warm yet or the query embed fails — NEVER blocks on a cold start:
  // it kicks resolution in the background and serves lexical for THIS query.
  async queryOrder(query: string, candidateIds: string[]): Promise<string[] | null> {
    if (!this.provider) {
      void this.ensureProvider();   // warm up for next time; lexical for now
      return null;
    }
    void this.scheduleProcess();    // keep backfilling while we serve queries
    let qvec: Float32Array;
    try {
      // ASYMMETRIC-EMBEDDING: a query must go through embedQueryVector, not embed() —
      // embed() is the PASSAGE path, and encoding a query as a passage is exactly the
      // silent quality loss the e5 prefixes exist to prevent.
      qvec = l2normalize(await embedQueryVector(this.provider, query));
      this.lastError = null;
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      return null;
    }
    const scored: Array<{ id: string; score: number }> = [];
    for (const id of candidateIds) {
      const v = this.vectors.get(id);
      if (!v || v.length !== qvec.length) continue;   // unembedded record ⇒ lexical-only, excluded here
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qvec[i];
      if (dot > 0) scored.push({ id, score: dot });   // orthogonal/opposite = no semantic evidence — drop it
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.id);
  }

  // --- memory.index RPC surface ---

  // Resolve the provider if not yet tried (memoized). Awaited by the memory.index handler so status
  // reflects the real embedder; also kicked (unawaited) from the query path.
  ensureProvider(): Promise<void> {
    if (!this.providerPromise) {
      this.providerPromise = (async () => {
        const p = await this.factory();
        this.provider = p;
        this.providerReady = p !== null;
        if (p) {
          // A sidecar written by a DIFFERENT model/dim is useless — drop the embedded vectors (keep
          // `desired`) so everything re-embeds under the current provider.
          if (this.loadedMeta && (this.loadedMeta.model !== p.model || this.loadedMeta.dim !== p.dim)) {
            this.vectors.clear();
            this.hashes.clear();
          }
          this.scheduleProcess();
        }
      })().catch((e) => { this.lastError = String((e as Error)?.message ?? e); });
    }
    return this.providerPromise;
  }

  // Discard every vector and re-embed from scratch in the background. `records` is the current store
  // set (the store owns the records; the index is derived).
  async rebuild(records: Iterable<IndexableRecord>): Promise<void> {
    this.vectors.clear();
    this.hashes.clear();
    this.desired.clear();
    this.lastError = null;
    try { rmSync(this.metaFile, { force: true }); rmSync(this.vectorsFile, { force: true }); } catch { /* derived — ignore */ }
    for (const rec of records) {
      const input = embedInput(rec);
      this.desired.set(rec.id, { input, hash: hashInput(input) });
    }
    await this.ensureProvider();
    this.scheduleProcess();
  }

  // Resolve the embedder and drain the embed queue to completion. Used by callers/tests that need a
  // synchronous, fully-warm index (the normal path is lazy + background — search never awaits this).
  async flush(): Promise<void> {
    await this.ensureProvider();
    let guard = 0;
    while (this.provider && this.hasPending() && guard++ < 10_000) {
      if (this.processing) { await new Promise((r) => setTimeout(r, 0)); continue; }
      await this.processQueue();
      // A persistently-failing embedder leaves records pending forever; stop draining rather than
      // spin (the failure is surfaced via status().state === "error"). Transient callers re-flush.
      if (this.lastError) break;
    }
  }

  status(total: number): MemoryIndexResult {
    let embedded = 0;
    for (const [id, d] of this.desired) if (this.hashes.get(id) === d.hash) embedded++;
    const pending = this.desired.size - embedded;
    const state: MemoryIndexResult["state"] = this.provider === null
      ? (this.lastError ? "error" : "off")
      : this.lastError
        ? "error"
        : pending > 0 || this.processing
          ? "building"
          : "ready";
    return {
      state,
      provider: this.provider?.id ?? null,
      model: this.provider?.model ?? null,
      dim: this.provider?.dim ?? 0,
      embedded,
      total,
      pending,
      degraded: this.provider === null || state === "error",
      error: this.lastError,
    };
  }

  // --- persistence ---

  // Read the sidecar into `vectors`/`hashes` and remember the model it was written under (validated
  // against the resolved provider later). Corrupt/short ⇒ delete + start empty (derived state).
  load(): void {
    if (!existsSync(this.metaFile) || !existsSync(this.vectorsFile)) return;
    try {
      const meta = JSON.parse(readFileSync(this.metaFile, "utf8")) as {
        version: number; provider: string; model: string; dim: number;
        rows: Array<{ id: string; hash: string }>;
      };
      if (meta.version !== SIDECAR_VERSION || !Array.isArray(meta.rows) || typeof meta.dim !== "number") {
        throw new Error("unrecognized sidecar meta");
      }
      const buf = readFileSync(this.vectorsFile);
      const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      if (floats.length !== meta.rows.length * meta.dim) throw new Error("vectors.bin size mismatch");
      meta.rows.forEach((row, i) => {
        this.vectors.set(row.id, floats.slice(i * meta.dim, (i + 1) * meta.dim));
        this.hashes.set(row.id, row.hash);
      });
      this.loadedMeta = { provider: meta.provider, model: meta.model, dim: meta.dim };
    } catch {
      // Disposable: nuke the sidecar and boot empty — everything re-embeds on demand.
      this.vectors.clear();
      this.hashes.clear();
      this.loadedMeta = null;
      try { rmSync(this.metaFile, { force: true }); rmSync(this.vectorsFile, { force: true }); } catch { /* ignore */ }
    }
  }

  private save(): void {
    if (!this.provider) return;   // nothing meaningful to persist without a model identity
    const ids = [...this.vectors.keys()];
    const dim = this.provider.dim;
    const rows = ids.map((id) => ({ id, hash: this.hashes.get(id)! }));
    const packed = new Float32Array(ids.length * dim);
    ids.forEach((id, i) => {
      const v = this.vectors.get(id)!;
      if (v.length === dim) packed.set(v, i * dim);
    });
    try {
      mkdirSync(this.dir, { recursive: true });
      const meta = { version: SIDECAR_VERSION, provider: this.provider.id, model: this.provider.model, dim, rows };
      const tmpMeta = `${this.metaFile}.tmp`;
      const tmpVec = `${this.vectorsFile}.tmp`;
      writeFileSync(tmpVec, Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength));
      writeFileSync(tmpMeta, JSON.stringify(meta));
      renameSync(tmpVec, this.vectorsFile);
      renameSync(tmpMeta, this.metaFile);
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);   // a failed sidecar write never breaks search
    }
  }

  // --- background embedding queue ---

  private scheduleProcess(): void {
    if (this.processing || this.scheduled || !this.provider) return;
    const pending = this.hasPending();
    if (!pending) return;
    this.scheduled = true;
    // Defer to a macrotask so a burst of enqueue()s coalesces into one drain.
    setTimeout(() => { this.scheduled = false; void this.processQueue(); }, 0);
  }

  private hasPending(): boolean {
    for (const [id, d] of this.desired) if (this.hashes.get(id) !== d.hash) return true;
    return false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.provider) return;
    this.processing = true;
    try {
      while (this.provider) {
        // Snapshot the current pending ids + the exact hash we're about to embed for each, so an edit
        // that lands mid-embed doesn't get overwritten with a stale vector.
        const batch: Array<{ id: string; input: string; hash: string }> = [];
        for (const [id, d] of this.desired) {
          if (this.hashes.get(id) === d.hash) continue;
          batch.push({ id, input: d.input, hash: d.hash });
          if (batch.length >= EMBED_BATCH) break;
        }
        if (batch.length === 0) break;
        let vecs: Float32Array[];
        try {
          vecs = await this.provider.embed(batch.map((b) => b.input));
          this.lastError = null;
        } catch (err) {
          this.lastError = String((err as Error)?.message ?? err);
          break;   // stop; a later kick retries
        }
        for (let i = 0; i < batch.length; i++) {
          const b = batch[i];
          const current = this.desired.get(b.id);
          if (!current || current.hash !== b.hash) continue;   // dropped or re-edited mid-flight → skip
          this.vectors.set(b.id, l2normalize(vecs[i]));
          this.hashes.set(b.id, b.hash);
        }
      }
    } finally {
      this.processing = false;
      this.save();
    }
  }
}
