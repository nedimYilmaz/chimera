import type { MemoryRecord } from "@chimera/protocol";

// A ranked search hit: the record plus its relevance score (0 when no query was given).
export type ScoredRecord = { record: MemoryRecord; score: number };

// Pluggable relevance scorer. `score(query, rec)` is the core contract; a corpus-aware
// ranker (BM25 needs IDF + avg doc length) precomputes those stats in the optional
// `prepare(records)` hook, called once over the candidate set before scoring. An
// EmbeddingRanker can drop in later behind the same interface (precompute vectors in
// prepare, cosine in score) without touching MemoryStore.
export interface Ranker {
  prepare?(records: MemoryRecord[]): void;
  score(query: string, rec: MemoryRecord): number;
}

// MEM-4 (PLAN-MEMORY.md §6.3): Reciprocal Rank Fusion. Given several ranked id lists (BM25 order,
// cosine order, entity order (F33), …), score each id by Σ 1/(k + rank) across the lists it
// appears in (rank 0-based).
// k=60 is the canonical default — it damps the top ranks so no single list dominates. Fusing ORDER
// (not raw scores) sidesteps the incomparable-scale problem of mixing BM25 and cosine magnitudes.
// An id present in only one list still scores (from that list alone), so an unembedded record that
// only appears in the lexical order is never dropped by adding a semantic order.
export const RRF_K = 60;
export function rrfFuse(orders: string[][], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const order of orders)
    order.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return scores;
}

// Split on any non-letter/non-digit run; the /u + \p{L}\p{N} keeps accented Latin,
// Cyrillic, CJK, etc. as terms (plain \W is ASCII-only and would drop them).
const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Zero-dependency lexical ranker: BM25-lite over the record text plus a flat bonus for
// query terms that hit a record's tags or kind (structured fields carry concept intent).
export class LexicalRanker implements Ranker {
  private static readonly K1 = 1.2;
  private static readonly B = 0.75;
  private static readonly TAG_BONUS = 2.0;   // query term found among a record's tags
  private static readonly KIND_BONUS = 1.0;  // query term equals the record's kind

  private n = 0;                              // corpus size
  private avgDocLen = 0;                      // mean text-token count
  private docFreq = new Map<string, number>(); // term → # of records whose text contains it

  // Precompute IDF inputs over the set of records about to be ranked.
  prepare(records: MemoryRecord[]): void {
    this.n = records.length;
    this.docFreq = new Map();
    let totalLen = 0;
    for (const rec of records) {
      const terms = tokenize(rec.text);
      totalLen += terms.length;
      for (const term of new Set(terms)) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
    this.avgDocLen = this.n > 0 ? totalLen / this.n : 0;
  }

  score(query: string, rec: MemoryRecord): number {
    const qTerms = new Set(tokenize(query));
    if (qTerms.size === 0) return 0;

    const docTerms = tokenize(rec.text);
    const docLen = docTerms.length;
    const tf = new Map<string, number>();
    for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);

    // Tokenized structured fields — a term hit here adds a flat bonus on top of BM25.
    const tagTerms = new Set(rec.tags.flatMap(tokenize));
    const kindTerms = new Set(tokenize(rec.kind));

    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term) ?? 0;
      if (f > 0) {
        const df = this.docFreq.get(term) ?? 1;
        // BM25 IDF with the +1 inside the log so it stays non-negative even for common
        // terms; the outer max(0,…) also holds the guarantee if score() is ever called
        // before prepare() (n=0 could otherwise drive it negative).
        const idf = Math.max(0, Math.log(1 + (this.n - df + 0.5) / (df + 0.5)));
        const denom = f + LexicalRanker.K1 * (1 - LexicalRanker.B + (LexicalRanker.B * docLen) / (this.avgDocLen || 1));
        score += idf * ((f * (LexicalRanker.K1 + 1)) / denom);
      }
      if (tagTerms.has(term)) score += LexicalRanker.TAG_BONUS;
      if (kindTerms.has(term)) score += LexicalRanker.KIND_BONUS;
    }
    return score;
  }
}

// F35: how far down a superseded record is pushed. A RANK shift, not a score penalty. BM25 scores
// (unbounded, LexicalRanker.score above) and RRF scores (~1/60, rrfFuse above) live on
// incomparable scales, so no single constant can mean the same thing in both — a rank shift means
// exactly the same thing in every mode. 10 is chosen against the DEFAULT limit of 20
// (MemorySearchParams.limit): a superseded record that WAS the top hit still comes back on the
// first page, below at most ten live records. Demoted, never removed — an audit trail that
// survives storage but not retrieval is not an audit trail.
export const SUPERSEDED_RANK_SHIFT = 10;

// Stable rank shift over an already-ranked list: each superseded hit moves down
// SUPERSEDED_RANK_SHIFT positions, ties broken by the incoming position, so the relative order
// WITHIN each group is preserved exactly. Scores are NOT rewritten — the returned ORDER is the
// contract, and inventing a comparable score across lexical/RRF/cosine is the thing this avoids.
export function demoteSuperseded(hits: ScoredRecord[], shift: number = SUPERSEDED_RANK_SHIFT): ScoredRecord[] {
  // Identity for the overwhelmingly common case (nothing superseded) — no allocation, and the
  // pre-F35 result object is returned unchanged.
  if (!hits.some((h) => h.record.supersededBy !== null)) return hits;
  return hits
    .map((hit, i) => ({ hit, i, key: i + (hit.record.supersededBy !== null ? shift : 0) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((e) => e.hit);
}
