// CHRONICLE-SEMANTIC — the persisted semantic index over distilled event history.
//
// This is what lets an agent that has been compacted (repeatedly) go back and ask "what did I
// already try?" — the events survived, but the agent's own context did not.
//
// SHAPE, and why:
//
//  * SEGMENTED, like the event log itself. Docs arrive in seq order and are evicted in seq order,
//    so the store is a FIFO — which means eviction is "delete the oldest segment file" and there is
//    NO compaction pass to get wrong. A single append-only file would have needed one.
//
//  * TEXT ON DISK, vectors and metadata in RAM. Measured on a real segment, a distilled doc averages
//    494 chars; keeping text resident would roughly double the index's memory for data that is only
//    ever needed for the handful of hits actually returned. Text is read back by byte offset.
//
//  * INT8 VECTORS. The provider emits L2-normalized float32, so every component is in [-1,1] and ONE
//    global scale (127) works — no per-vector scale to store or reason about. Cosine order is
//    preserved because dot(int8_doc, float_query) is the true dot times a positive constant. 4x
//    smaller than float32 for a recall difference that does not show up at this corpus size.
//
//  * OUTLIVES THE EVENT LOG. The log prunes at ~3 days; this index has its own, larger bound. That
//    is the entire point — an agent cleaned up and forgotten still leaves searchable history. It
//    also means a hit can refer to an event whose raw form is GONE, which the response marks
//    explicitly rather than pretending it can still be fetched.
//
//  * DEGRADES, NEVER BLOCKS. Same contract as MemoryVectorIndex: no embedder ⇒ lexical-only results,
//    not an error. The embedder resolves lazily, never at boot, so a daemon that never searches
//    touches no network and every unit test stays hermetic.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { EventKind } from "@chimera/protocol";
import { embedQueryVector, type EmbeddingProvider } from "./memory-embed.js";
import type { ChronicleDoc } from "./chronicle-distill.js";
import { scanTopK, type ScanBlock } from "./chronicle-scan.js";

export type EmbeddingProviderFactory = () => Promise<EmbeddingProvider | null>;

export const VECTOR_DIM = 384;
/** L2-normalized components live in [-1,1]; 127 maps them onto the full int8 range. */
export const QUANT_SCALE = 127;

/** Default corpus bound. At ~490 B of on-disk text and 384 B of resident vector per doc, 150k docs
 *  is ≈58 MB of resident vectors and ≈75 MB on disk — and, at this machine's measured event rate,
 *  roughly a week of history against the event log's own three days. Raising it costs ≈0.5 KB of
 *  RAM per doc, linearly, and the search scan grows linearly too (measured: 59 ms at 150k, 169 ms at
 *  400k — which is why the scan runs off-thread). */
export const DEFAULT_MAX_DOCS = 150_000;
/** Docs per segment file. Eviction granularity: the index overshoots its cap by at most this much. */
export const DEFAULT_DOCS_PER_SEGMENT = 10_000;

const EMBED_BATCH = 16;

/** Everything about a doc EXCEPT its text, which stays on disk. */
type DocMeta = {
  seq: number;
  ts: number;
  engineId: string;
  agentId: string;
  kind: EventKind;
  treeId: string | null;
  team: string | null;
  /** Byte offset + length of this doc's JSON line inside its segment file. */
  offset: number;
  length: number;
  /** false until the background embedder has filled this doc's vector slot. */
  embedded: boolean;
};

type Segment = {
  index: number;             // monotonically increasing segment number
  docs: DocMeta[];
  vectors: Int8Array;        // docs.length * VECTOR_DIM, slot i ⇔ docs[i]
  file: string;
  vecFile: string;
  /** Sealed segments never take another doc; only the newest is open. */
  sealed: boolean;
  dirty: boolean;
};

export type ChronicleScope = {
  agentIds?: readonly string[];
  treeIds?: readonly string[];
  teams?: readonly string[];
  kinds?: readonly EventKind[];
  fromTs?: number;
  toTs?: number;
};

export type ChronicleHit = {
  seq: number;
  ts: number;
  engineId: string;
  agentId: string;
  kind: EventKind;
  score: number;
  snippet: string;
  /** True when the raw event has been pruned from the event log and only this distilled doc
   *  remains — the caller must not promise the full event is fetchable. */
  distilledOnly: boolean;
};

export type ChronicleIndexOptions = {
  maxDocs?: number;
  docsPerSegment?: number;
};

export class ChronicleIndex {
  private dir: string;
  private factory: EmbeddingProviderFactory;
  private maxDocs: number;
  private docsPerSegment: number;

  private segments: Segment[] = [];   // oldest → newest
  private nextSegmentIndex = 0;
  private bySeq = new Map<number, { seg: Segment; i: number }>();

  private provider: EmbeddingProvider | null = null;
  private providerPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private processing = false;
  private scheduled = false;
  private loadedModel: string | null = null;

  constructor(dir: string, factory: EmbeddingProviderFactory, opts: ChronicleIndexOptions = {}) {
    this.dir = dir;
    this.factory = factory;
    this.maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
    this.docsPerSegment = opts.docsPerSegment ?? DEFAULT_DOCS_PER_SEGMENT;
  }

  // --- ingest -------------------------------------------------------------

  /** Append a distilled doc. Cheap and synchronous: the doc becomes searchable LEXICALLY at once,
   *  and its vector is filled in by the background embedder. Making this await the embedder would
   *  put model inference on the event-append path. */
  add(doc: ChronicleDoc): void {
    if (this.bySeq.has(doc.seq)) return;   // replay/restart re-delivery
    const seg = this.openSegment();
    const line = JSON.stringify(doc) + "\n";
    const buf = Buffer.from(line, "utf8");
    const offset = segmentBytes(seg);
    seg.docs.push({
      seq: doc.seq, ts: doc.ts, engineId: doc.engineId, agentId: doc.agentId, kind: doc.kind,
      treeId: doc.treeId, team: doc.team, offset, length: buf.byteLength, embedded: false,
    });
    seg.vectors = growVectors(seg.vectors, seg.docs.length);
    seg.dirty = true;
    this.pendingWrites.push({ seg, buf });
    this.bySeq.set(doc.seq, { seg, i: seg.docs.length - 1 });
    if (seg.docs.length >= this.docsPerSegment) seg.sealed = true;
    this.evictOverflow();
    // Only kick embedding once the provider is already warm — a fresh event on a daemon that has
    // never searched must not trigger a model download (keeps boot and tests network-free).
    if (this.provider) this.scheduleProcess();
  }

  private pendingWrites: Array<{ seg: Segment; buf: Buffer }> = [];

  /** Flush appended doc lines and dirty vector files to disk. */
  flushWrites(): void {
    if (this.pendingWrites.length === 0 && !this.segments.some((s) => s.dirty)) return;
    mkdirSync(this.dir, { recursive: true });
    const byFile = new Map<string, Buffer[]>();
    for (const { seg, buf } of this.pendingWrites) {
      const list = byFile.get(seg.file) ?? [];
      list.push(buf);
      byFile.set(seg.file, list);
    }
    this.pendingWrites = [];
    for (const [file, bufs] of byFile) {
      try { appendFileSync(file, Buffer.concat(bufs)); } catch (err) { this.lastError = String((err as Error)?.message ?? err); }
    }
    for (const seg of this.segments) {
      if (!seg.dirty) continue;
      try {
        writeFileSync(`${seg.vecFile}.tmp`, Buffer.from(seg.vectors.buffer, seg.vectors.byteOffset, seg.docs.length * VECTOR_DIM));
        renameSync(`${seg.vecFile}.tmp`, seg.vecFile);
        seg.dirty = false;
      } catch (err) { this.lastError = String((err as Error)?.message ?? err); }
    }
  }

  private openSegment(): Segment {
    const last = this.segments[this.segments.length - 1];
    if (last && !last.sealed) return last;
    const index = this.nextSegmentIndex++;
    const seg: Segment = {
      index, docs: [], vectors: new Int8Array(0),
      file: join(this.dir, `docs.${String(index).padStart(6, "0")}.jsonl`),
      vecFile: join(this.dir, `docs.${String(index).padStart(6, "0")}.vec`),
      sealed: false, dirty: false,
    };
    this.segments.push(seg);
    return seg;
  }

  /** Drop whole oldest segments until the corpus is back under its bound. Segment-granular on
   *  purpose: it is what makes eviction a file delete instead of a rewrite. */
  private evictOverflow(): void {
    while (this.docCount() > this.maxDocs && this.segments.length > 1) {
      const dead = this.segments.shift()!;
      for (const d of dead.docs) this.bySeq.delete(d.seq);
      try { rmSync(dead.file, { force: true }); rmSync(dead.vecFile, { force: true }); } catch { /* disposable */ }
    }
  }

  docCount(): number {
    let n = 0;
    for (const seg of this.segments) n += seg.docs.length;
    return n;
  }

  // --- background embedding ----------------------------------------------

  /** Resolve the embedder once, lazily. Awaited by status/reindex; kicked (unawaited) by search, so
   *  the FIRST semantic query is served lexically while the model warms rather than blocking on a
   *  possible one-time model download. */
  ensureProvider(): Promise<void> {
    if (!this.providerPromise) {
      this.providerPromise = (async () => {
        const p = await this.factory();
        this.provider = p;
        if (p) {
          // A sidecar embedded by a DIFFERENT model is not comparable to this one's vectors — mixing
          // them degrades cosine silently. Drop the vectors (never the docs: the text is still good
          // for lexical search and for chronicle_get) and let the backfill re-embed.
          if (this.loadedModel && this.loadedModel !== p.model) this.invalidateVectors();
          this.loadedModel = p.model;
          this.writeModelStamp(p.model);
          this.scheduleProcess();
        }
      })().catch((e) => { this.lastError = String((e as Error)?.message ?? e); });
    }
    return this.providerPromise;
  }

  private invalidateVectors(): void {
    for (const seg of this.segments) {
      seg.vectors.fill(0);
      for (const d of seg.docs) d.embedded = false;
      seg.dirty = true;
    }
  }

  private scheduleProcess(): void {
    if (this.scheduled || this.processing) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; void this.processPending(); }, 0).unref?.();
  }

  /** Embed everything still unembedded, oldest-first, in batches. Never throws: a provider failure
   *  leaves the docs lexical-only and records the reason. */
  async processPending(): Promise<void> {
    if (this.processing || !this.provider) return;
    this.processing = true;
    try {
      for (;;) {
        const batch: Array<{ seg: Segment; i: number }> = [];
        for (const seg of this.segments) {
          for (let i = 0; i < seg.docs.length && batch.length < EMBED_BATCH; i++) {
            if (!seg.docs[i]!.embedded) batch.push({ seg, i });
          }
          if (batch.length >= EMBED_BATCH) break;
        }
        if (batch.length === 0) break;
        const texts = await this.readTexts(batch.map(({ seg, i }) => ({ seg, meta: seg.docs[i]! })));
        let vectors: Float32Array[];
        try {
          vectors = await this.provider.embed(texts);
          this.lastError = null;
        } catch (err) {
          this.lastError = String((err as Error)?.message ?? err);
          break;   // leave them pending; a later query retries
        }
        batch.forEach(({ seg, i }, n) => {
          const vec = vectors[n];
          if (!vec || vec.length !== VECTOR_DIM) return;
          quantizeInto(vec, seg.vectors, i * VECTOR_DIM);
          seg.docs[i]!.embedded = true;
          seg.dirty = true;
        });
        this.flushWrites();
      }
    } finally {
      this.processing = false;
    }
  }

  // --- search -------------------------------------------------------------

  /** Hybrid retrieval: a cosine order and a BM25 order, fused with RRF.
   *
   *  RRF fuses ORDER, never raw scores — which is what makes an int8 dot product and a BM25 weight
   *  combinable at all, and what makes the switch to a model with a narrower cosine band (e5) free.
   *
   *  SCOPE is applied to metadata BEFORE ranking, and the scan strategy adapts to how much survives:
   *  a narrow scope is scanned inline over just its docs (cheaper than a full scan), a wide one goes
   *  to the worker. Filtering after a fixed top-K would have starved narrow scopes of results. */
  async search(query: string, scope: ChronicleScope, limit: number): Promise<{ hits: ChronicleHit[]; searched: number; semantic: boolean }> {
    const allowed: Array<{ seg: Segment; i: number }> = [];
    for (const seg of this.segments) {
      for (let i = 0; i < seg.docs.length; i++) if (inScope(seg.docs[i]!, scope)) allowed.push({ seg, i });
    }
    if (allowed.length === 0) return { hits: [], searched: 0, semantic: false };

    void this.ensureProvider();   // warm for next time; this call may still be lexical-only
    const orders: number[][] = [];
    let semantic = false;

    if (this.provider) {
      try {
        const qvec = await embedQueryVector(this.provider, query);
        const ranked = await this.semanticOrder(qvec, allowed);
        if (ranked.length) { orders.push(ranked); semantic = true; }
      } catch (err) {
        this.lastError = String((err as Error)?.message ?? err);   // lexical alone still answers
      }
    }

    // The lexical channel reads text for a BOUNDED pool: the semantic winners plus the most recent
    // in-scope docs. Reading every candidate's text would put the whole corpus through disk on
    // every query, which is the cost the on-disk layout exists to avoid.
    const poolIdx = new Set<number>(orders[0]?.slice(0, LEXICAL_POOL) ?? []);
    for (let i = allowed.length - 1; i >= 0 && poolIdx.size < LEXICAL_POOL; i--) poolIdx.add(i);
    const pool = [...poolIdx];
    const texts = await this.readTexts(pool.map((n) => ({ seg: allowed[n]!.seg, meta: allowed[n]!.seg.docs[allowed[n]!.i]! })));
    orders.push(bm25Order(query, pool, texts));

    const fused = rrf(orders);
    const top = [...fused.entries()].sort((a, b) => b[1] - a[1] || allowed[b[0]]!.seg.docs[allowed[b[0]]!.i]!.ts - allowed[a[0]]!.seg.docs[allowed[a[0]]!.i]!.ts).slice(0, limit);
    const textByIdx = new Map(pool.map((n, k) => [n, texts[k] ?? ""]));
    const missing = top.filter(([n]) => !textByIdx.has(n)).map(([n]) => n);
    if (missing.length) {
      const extra = await this.readTexts(missing.map((n) => ({ seg: allowed[n]!.seg, meta: allowed[n]!.seg.docs[allowed[n]!.i]! })));
      missing.forEach((n, k) => textByIdx.set(n, extra[k] ?? ""));
    }
    const hits = top.map(([n, score]) => {
      const { seg, i } = allowed[n]!;
      const meta = seg.docs[i]!;
      return {
        seq: meta.seq, ts: meta.ts, engineId: meta.engineId, agentId: meta.agentId, kind: meta.kind,
        score, snippet: snippetOf(textByIdx.get(n) ?? "", query),
        distilledOnly: false,   // set by the engine, which is what knows the log's retained range
      };
    });
    return { hits, searched: allowed.length, semantic };
  }

  /** Cosine order over `allowed`, returned as indices INTO `allowed`. */
  private async semanticOrder(qvec: Float32Array, allowed: Array<{ seg: Segment; i: number }>): Promise<number[]> {
    const wantK = Math.max(LEXICAL_POOL, 200);
    // NARROW-SCOPE FAST PATH: scanning only the allowed docs beats scanning everything and then
    // discarding, and — more importantly — it cannot return "nothing in scope made the top K".
    if (allowed.length <= NARROW_SCOPE_DOCS) {
      const scored: Array<{ id: number; score: number }> = [];
      for (let n = 0; n < allowed.length; n++) {
        const { seg, i } = allowed[n]!;
        if (!seg.docs[i]!.embedded) continue;
        let dot = 0;
        const base = i * VECTOR_DIM;
        for (let d = 0; d < VECTOR_DIM; d++) dot += seg.vectors[base + d]! * qvec[d]!;
        if (dot > 0) scored.push({ id: n, score: dot });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, wantK).map((s) => s.id);
    }
    // Wide scope: one off-thread pass over every segment, then map global slots back to `allowed`.
    const blocks: ScanBlock[] = [];
    const bases = new Map<Segment, number>();
    let base = 0;
    for (const seg of this.segments) {
      bases.set(seg, base);
      blocks.push({ vectors: seg.vectors, count: seg.docs.length, base });
      base += seg.docs.length;
    }
    const globalToAllowed = new Map<number, number>();
    allowed.forEach(({ seg, i }, n) => globalToAllowed.set(bases.get(seg)! + i, n));
    const scanned = await scanTopK(blocks, qvec, wantK * 4);
    const out: number[] = [];
    for (const r of scanned) {
      const n = globalToAllowed.get(r.id);
      if (n !== undefined) { out.push(n); if (out.length >= wantK) break; }
    }
    return out;
  }

  /** Full distilled docs for specific event seqs — the second half of the two-step retrieval that
   *  keeps a search from re-flooding the context it was called to repair. */
  async getDocs(seqs: readonly number[]): Promise<ChronicleDoc[]> {
    const found = seqs.map((seq) => this.bySeq.get(seq)).filter((x): x is { seg: Segment; i: number } => Boolean(x));
    const lines = await this.readLines(found.map(({ seg, i }) => ({ seg, meta: seg.docs[i]! })));
    const out: ChronicleDoc[] = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line) as ChronicleDoc); } catch { /* a torn line is skipped, never fatal */ }
    }
    return out;
  }

  /** AGENT-FORGET: drop every document belonging to `agentIds`.
   *
   *  This index deliberately OUTLIVES the event log's own pruning — that is the whole point of a
   *  long memory. It does not outlive an explicit delete. When an operator says they are done with
   *  an agent, an index that kept answering questions about it would make "forget" a lie: the
   *  agent's work would still surface in chronicle_search after its events were erased.
   *
   *  Rewrites only the segments that actually hold one of these agents; offsets are recomputed for
   *  the whole surviving segment because they are byte positions into the file being rewritten. */
  forgetAgent(agentIds: readonly string[]): number {
    const targets = new Set(agentIds.filter((id) => id.length > 0));
    if (targets.size === 0) return 0;
    this.flushWrites();   // anything appended this tick must be on disk before we rewrite the file
    let removed = 0;

    for (const seg of this.segments) {
      if (!seg.docs.some((d) => targets.has(d.agentId))) continue;
      const lines = this.readSegmentLines(seg);
      const keptDocs: DocMeta[] = [];
      const keptLines: string[] = [];
      const keptVectors = new Int8Array(new SharedArrayBuffer(Math.max(seg.docs.length, 1) * VECTOR_DIM));
      let offset = 0;
      seg.docs.forEach((d, i) => {
        if (targets.has(d.agentId)) { removed++; this.bySeq.delete(d.seq); return; }
        const line = lines[i] ?? "";
        // Offsets are byte positions INTO THE FILE — every surviving doc after a removal shifts,
        // so they are all recomputed rather than patched.
        const length = Buffer.byteLength(line, "utf8");
        keptVectors.set(seg.vectors.subarray(i * VECTOR_DIM, (i + 1) * VECTOR_DIM), keptDocs.length * VECTOR_DIM);
        keptDocs.push({ ...d, offset, length });
        keptLines.push(line);
        offset += length;
      });
      seg.docs = keptDocs;
      seg.vectors = keptVectors;
      try {
        writeFileSync(seg.file, keptLines.join(""));
        writeFileSync(seg.vecFile, Buffer.from(keptVectors.buffer, keptVectors.byteOffset, keptDocs.length * VECTOR_DIM));
      } catch (err) { this.lastError = String((err as Error)?.message ?? err); }
    }
    // bySeq holds a (segment, index) pair, and every index after a removal moved.
    this.bySeq.clear();
    for (const seg of this.segments) seg.docs.forEach((d, i) => this.bySeq.set(d.seq, { seg, i }));
    return removed;
  }

  /** Raw JSON lines of a segment, in doc order — used by forgetAgent, which needs the bytes it is
   *  about to rewrite rather than the parsed text. */
  private readSegmentLines(seg: Segment): string[] {
    try {
      const raw = readFileSync(seg.file);
      return seg.docs.map((d) => raw.subarray(d.offset, d.offset + d.length).toString("utf8"));
    } catch {
      return seg.docs.map(() => "");
    }
  }

  has(seq: number): boolean { return this.bySeq.has(seq); }

  // --- persistence --------------------------------------------------------

  /** Read the sidecar back. Cheap per segment (a line scan for offsets + one binary vector read);
   *  a segment that fails to parse is dropped rather than poisoning the whole index. */
  load(): void {
    if (!existsSync(this.dir)) return;
    try { this.loadedModel = JSON.parse(readFileSync(join(this.dir, "model.json"), "utf8")).model ?? null; } catch { this.loadedModel = null; }
    const files = readdirSync(this.dir).filter((f) => /^docs\.\d{6}\.jsonl$/.test(f)).sort();
    for (const file of files) {
      const index = Number(file.slice(5, 11));
      const seg = this.loadSegment(index, join(this.dir, file));
      if (seg) this.segments.push(seg);
      this.nextSegmentIndex = Math.max(this.nextSegmentIndex, index + 1);
    }
    for (const seg of this.segments) seg.docs.forEach((d, i) => this.bySeq.set(d.seq, { seg, i }));
    this.evictOverflow();
  }

  private loadSegment(index: number, file: string): Segment | null {
    try {
      const raw = readFileSync(file);
      const docs: DocMeta[] = [];
      let offset = 0;
      for (;;) {
        const nl = raw.indexOf(10, offset);
        if (nl < 0) break;
        const line = raw.subarray(offset, nl).toString("utf8");
        try {
          const d = JSON.parse(line) as ChronicleDoc;
          docs.push({ seq: d.seq, ts: d.ts, engineId: d.engineId, agentId: d.agentId, kind: d.kind,
            treeId: d.treeId ?? null, team: d.team ?? null, offset, length: nl - offset + 1, embedded: false });
        } catch { /* skip a torn line; the rest of the segment is still good */ }
        offset = nl + 1;
      }
      const vecFile = join(this.dir, `docs.${String(index).padStart(6, "0")}.vec`);
      let vectors = new Int8Array(new SharedArrayBuffer(Math.max(docs.length, 1) * VECTOR_DIM));
      if (existsSync(vecFile)) {
        const buf = readFileSync(vecFile);
        const usable = Math.min(buf.byteLength, vectors.length);
        vectors.set(new Int8Array(buf.buffer, buf.byteOffset, usable));
        const embeddedCount = Math.floor(usable / VECTOR_DIM);
        for (let i = 0; i < embeddedCount && i < docs.length; i++) docs[i]!.embedded = true;
      }
      return { index, docs, vectors, file, vecFile, sealed: docs.length >= this.docsPerSegment, dirty: false };
    } catch {
      return null;
    }
  }

  private writeModelStamp(model: string): void {
    try { mkdirSync(this.dir, { recursive: true }); writeFileSync(join(this.dir, "model.json"), JSON.stringify({ model })); }
    catch { /* the stamp is an optimization; losing it only costs a re-embed */ }
  }

  status(): { docs: number; embedded: number; pending: number; segments: number; model: string | null; maxDocs: number; error: string | null; oldestTs: number | null } {
    let embedded = 0;
    for (const seg of this.segments) for (const d of seg.docs) if (d.embedded) embedded++;
    const docs = this.docCount();
    return { docs, embedded, pending: docs - embedded, segments: this.segments.length,
      model: this.provider?.model ?? this.loadedModel, maxDocs: this.maxDocs, error: this.lastError,
      oldestTs: this.segments[0]?.docs[0]?.ts ?? null };
  }

  // --- disk reads ---------------------------------------------------------

  private async readLines(items: Array<{ seg: Segment; meta: DocMeta }>): Promise<string[]> {
    this.flushWrites();   // a doc appended this tick may not be on disk yet
    const out = new Array<string>(items.length).fill("");
    const bySeg = new Map<Segment, number[]>();
    items.forEach((it, n) => { const l = bySeg.get(it.seg) ?? []; l.push(n); bySeg.set(it.seg, l); });
    for (const [seg, idxs] of bySeg) {
      let fh;
      try { fh = await open(seg.file, "r"); } catch { continue; }
      try {
        for (const n of idxs) {
          const { meta } = items[n]!;
          const buf = Buffer.allocUnsafe(meta.length);
          const { bytesRead } = await fh.read(buf, 0, meta.length, meta.offset);
          out[n] = buf.subarray(0, bytesRead).toString("utf8");
        }
      } finally { await fh.close(); }
    }
    return out;
  }

  private async readTexts(items: Array<{ seg: Segment; meta: DocMeta }>): Promise<string[]> {
    const lines = await this.readLines(items);
    return lines.map((line) => {
      try { return (JSON.parse(line) as ChronicleDoc).text ?? ""; } catch { return ""; }
    });
  }
}

// --- ranking ------------------------------------------------------------

/** How many docs the lexical channel reads text for. Bounded because reading is the expensive part
 *  of the on-disk layout; everything above this rank is decided by cosine alone. */
const LEXICAL_POOL = 300;
/** At or below this many in-scope docs, the cosine scan runs inline over just them — measured at
 *  ~2 ms for 20k, well under the cost of dispatching to the worker. */
const NARROW_SCOPE_DOCS = 20_000;

/** Reciprocal Rank Fusion. Same k=60 and the same reasoning as memory-search.ts's rrfFuse — kept
 *  local because this fuses NUMERIC indices into a candidate array, not memory record ids. */
const RRF_K = 60;
function rrf(orders: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const order of orders) order.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  return scores;
}

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** BM25 over the candidate pool's text. A local, text-only implementation on purpose: memory's
 *  LexicalRanker scores a MemoryRecord and adds tag/kind bonuses that have no meaning here. */
function bm25Order(query: string, ids: number[], texts: string[]): number[] {
  const K1 = 1.2, B = 0.75;
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0) return [];
  const docTerms = texts.map(tokenize);
  const avgLen = docTerms.reduce((a, t) => a + t.length, 0) / Math.max(1, docTerms.length);
  const df = new Map<string, number>();
  for (const terms of docTerms) for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docTerms.length;
  const scored: Array<{ id: number; score: number }> = [];
  docTerms.forEach((terms, k) => {
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (terms.length / Math.max(1, avgLen))));
    }
    if (score > 0) scored.push({ id: ids[k]!, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}

const SNIPPET_LEN = 240;
/** A snippet centred on the first query term that appears, so the caller can see WHY it matched
 *  without paying for the whole doc — the cheap half of the two-step retrieval. */
function snippetOf(text: string, query: string): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of tokenize(query)) { const n = lower.indexOf(t); if (n >= 0 && (at < 0 || n < at)) at = n; }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, start + SNIPPET_LEN);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function inScope(d: DocMeta, s: ChronicleScope): boolean {
  if (s.agentIds && !s.agentIds.includes(d.agentId)) return false;
  if (s.treeIds && (d.treeId === null || !s.treeIds.includes(d.treeId))) return false;
  if (s.teams && (d.team === null || !s.teams.includes(d.team))) return false;
  if (s.kinds && !s.kinds.includes(d.kind)) return false;
  if (s.fromTs !== undefined && d.ts < s.fromTs) return false;
  if (s.toTs !== undefined && d.ts > s.toTs) return false;
  return true;
}

/** float32 (L2-normalized, so components are in [-1,1]) → int8, in place. */
function quantizeInto(vec: Float32Array, into: Int8Array, at: number): void {
  for (let d = 0; d < VECTOR_DIM; d++) {
    const q = Math.round(vec[d]! * QUANT_SCALE);
    into[at + d] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
}

// --- small helpers ------------------------------------------------------

function segmentBytes(seg: Segment): number {
  const last = seg.docs[seg.docs.length - 1];
  return last ? last.offset + last.length : 0;
}

/** Grow the per-segment vector store geometrically; slots for not-yet-embedded docs stay zero,
 *  and a zero vector scores 0 against every query, so an unembedded doc is simply absent from the
 *  semantic order rather than ranked wrongly. */
function growVectors(v: Int8Array, docCount: number): Int8Array {
  const need = docCount * VECTOR_DIM;
  if (v.length >= need) return v;
  // SharedArrayBuffer, not a plain one: the scan worker maps this exact memory instead of receiving
  // a per-query copy that would cost more than the scan itself.
  const next = new Int8Array(new SharedArrayBuffer(Math.max(need, v.length * 2, VECTOR_DIM * 256)));
  next.set(v);
  return next;
}

