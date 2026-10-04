import type { MemoryRecord } from "@chimera/protocol";

// F33 (docs/superpowers/research/harness-2026-09/plans/F33-entity-linking-rrf-signal.md):
// a deterministic, model-free identifier harvester + a lazily-cached per-record entity index
// that produces a third RRF signal for MemoryStore.searchHybrid. Structured after
// memory-links.ts (module constants → pure parser → index class). No write-path hook, no
// persistence — the index is derived at search time, exactly like MemoryLinkIndex.

const HARVEST_MAX_CHARS = 20000;   // bounds per-record regex work; mirrors MAX_LINKS_PER_NOTE
export const MAX_ENTITIES_PER_RECORD = 48;  // over-harvest cap; first-seen order, deduped
export const MAX_ENTITIES_PER_QUERY = 16;   // a query is short; longer is pasted noise
export const ENTITY_ORDER_MAX = 50;         // beyond rank 50 an RRF contribution is <1/111 — noise
const MIN_ENTITY_LEN = 4;          // drops "e.g", "a/b"
const MAX_CACHE_ENTRIES = 4000;    // 2x MAX_MEMORY_RECORDS (memory.ts) before a full cache clear

// Repo path: >=1 slash segment, kept only if it has >=2 slashes or a known code/doc extension
// (checked below) — rejects "and/or", "read/write" while keeping "packages/core/src/memory.ts"
// and "docs/superpowers/research/harness-2026-09".
const PATH_RE = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_.-]+)+(?::\d+(?:-\d+)?)?/g;

// bare "file.ext[:line]" — an extension allowlist (not a generic \.\w+) is what keeps English
// prose out. The trailing \b is load-bearing: the alternation is ordered, so without it "ts"
// wins on "Component.tsx" and the entity truncates to "component.ts" — colliding with a real
// Component.ts. The boundary forces a backtrack to the longest valid extension.
const FILE_RE = /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|rs|toml|ya?ml|sh)(?::\d+(?:-\d+)?)?\b/g;

// hex SHA, 7-40 chars. The digit lookahead is deliberate: "defaced" and "acceded" are 7-char
// all-hex English words. It costs ~5% of real 7-hex prefixes and buys a clean prose reject.
const SHA_RE = /\b(?=[0-9a-f]{7,40}\b)(?=[a-z0-9]*\d)[0-9a-f]{7,40}\b/gi;

// camelCase / PascalCase with >=1 internal hump: setupWorktreeNodeModules, MemoryLinkIndex, rrfFuse
const CAMEL_RE = /\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g;

// snake_case / SCREAMING_SNAKE: MAX_MEMORY_RECORDS, memory_search, CHIMERA_AGENT_ID
const SNAKE_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;

// dotted.path: memory.search, index.queryOrder (MIN_ENTITY_LEN drops "e.g")
const DOTTED_RE = /\b[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+\b/g;

const CODE_DOC_EXT_RE = /\.(?:ts|tsx|js|mjs|cjs|json|md|py|rs|toml|ya?ml|sh)(?::\d+(?:-\d+)?)?$/;

// PATH_RE's segment class contains "." and "-", so a path that ends a sentence swallows the
// period ("lives in docs/a/harness-2026-09." harvested as "…-09."). That silently voids the whole
// signal: the query form of the same path has no trailing dot, so overlap is zero and, for an
// extensionless directory path, no shorter FILE_RE fallback entity exists either. Stripped BEFORE
// the >=2-slash/extension filter runs, because CODE_DOC_EXT_RE is $-anchored and would reject
// "a/memory.ts." outright.
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

// Extract identifier-like tokens from free text: repo paths, file:line refs, hex SHAs, and
// camel/snake/dotted identifiers. Lowercased, deduped, first-seen order preserved, capped at
// `max` (default MAX_ENTITIES_PER_RECORD). Pure and deterministic — no Date.now/Math.random,
// no map-iteration-order dependence beyond insertion order.
export function harvestEntities(text: string, max: number = MAX_ENTITIES_PER_RECORD): string[] {
  const slice = text.slice(0, HARVEST_MAX_CHARS);
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): boolean => {
    const v = raw.toLowerCase();
    if (v.length < MIN_ENTITY_LEN || seen.has(v)) return out.length < max;
    seen.add(v);
    out.push(v);
    return out.length < max;
  };

  const scan = (
    re: RegExp,
    filter?: (m: string) => boolean,
    normalize?: (m: string) => string,
  ): boolean => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      const hit = normalize ? normalize(m[0]) : m[0];
      if (filter && !filter(hit)) continue;
      if (!add(hit)) return false;
    }
    return true;
  };

  if (!scan(PATH_RE, (hit) => {
    const withoutLineRef = hit.replace(/:\d+(?:-\d+)?$/, "");
    const slashes = (withoutLineRef.match(/\//g) ?? []).length;
    return slashes >= 2 || CODE_DOC_EXT_RE.test(hit);
  }, (hit) => hit.replace(TRAILING_PUNCT_RE, ""))) return out;
  if (!scan(FILE_RE)) return out;
  if (!scan(SHA_RE)) return out;
  if (!scan(CAMEL_RE)) return out;
  if (!scan(SNAKE_RE)) return out;
  if (!scan(DOTTED_RE)) return out;

  return out;
}

// QA-of-2a1673a4 finding A: tags are added record-side verbatim (below), but the generic
// harvester deliberately never emits kebab-case (plan §2.1: "bare kebab … flood every record"),
// so a query like "harness-2026-09" could never land in qEnts and the tag signal was inert. This
// is query-side only, and matches a CLOSED, curated vocabulary (the candidates' own tags) rather
// than a regex over prose — so it does not reintroduce the kebab-flood risk the plan ruled out.
// A namespaced tag ("team:chimera-harness") is also matched on its value part alone, since that
// is how a human actually types the query.
function matchQueryTags(query: string, candidates: MemoryRecord[]): string[] {
  const tagVocab = new Set<string>();
  for (const rec of candidates) for (const tag of rec.tags) tagVocab.add(tag.toLowerCase());
  if (tagVocab.size === 0) return [];

  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(TRAILING_PUNCT_RE, "").replace(/^[.,;:!?]+/, ""))
      .filter((t) => t.length >= MIN_ENTITY_LEN),
  );
  if (queryTokens.size === 0) return [];

  const hits: string[] = [];
  for (const tag of tagVocab) {
    const colon = tag.lastIndexOf(":");
    const valuePart = colon >= 0 ? tag.slice(colon + 1) : null;
    if (queryTokens.has(tag) || (valuePart && queryTokens.has(valuePart))) hits.push(tag);
  }
  return hits;
}

type CacheEntry = { updatedAt: number; entities: string[] };

// Lazily-cached entity index over a candidate set, built at search time (no write-path hook —
// an edit self-invalidates because MemoryStore.edit() already bumps updatedAt). Produces a
// positive-overlap-only ranked id order, IDF-weighted over the candidate set, using the same
// BM25 IDF formula and non-negative guard as LexicalRanker (memory-search.ts).
export class MemoryEntityIndex {
  private cache = new Map<string, CacheEntry>();
  private harvestCount = 0;

  private harvestRecord(rec: MemoryRecord): string[] {
    const cached = this.cache.get(rec.id);
    if (cached && cached.updatedAt === rec.updatedAt) return cached.entities;

    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.clear();

    const entities = harvestEntities(`${rec.title ?? ""}\n${rec.text}`);
    // tags are already curated identifiers — added verbatim (lowercased) as entities. Bare
    // kebab-case is deliberately not harvested from prose (English hyphenation would flood
    // every record), but a tag is not prose. rec.folder is never harvested: the verdict fixes
    // folder as a pre-ranking prefix filter, not a ranking signal.
    for (const tag of rec.tags) {
      const v = tag.toLowerCase();
      if (v.length >= MIN_ENTITY_LEN && !entities.includes(v) && entities.length < MAX_ENTITIES_PER_RECORD) {
        entities.push(v);
      }
    }

    this.harvestCount++;
    this.cache.set(rec.id, { updatedAt: rec.updatedAt, entities });
    return entities;
  }

  // Positive-overlap-only, IDF-ordered candidate ids for `query`. Empty query entities or zero
  // overlap ⇒ [] (never inject a zero-evidence record into fusion, matching lexicalHits).
  order(query: string, candidates: MemoryRecord[]): string[] {
    const qEnts = harvestEntities(query, MAX_ENTITIES_PER_QUERY);
    const tagHits = matchQueryTags(query, candidates);
    for (const hit of tagHits) {
      if (qEnts.length >= MAX_ENTITIES_PER_QUERY) break;
      if (!qEnts.includes(hit)) qEnts.push(hit);
    }
    if (qEnts.length === 0) return [];

    const recEntities = new Map<string, string[]>();
    const df = new Map<string, number>();
    for (const rec of candidates) {
      const ents = this.harvestRecord(rec);
      recEntities.set(rec.id, ents);
      const entSet = new Set(ents);
      for (const e of qEnts) if (entSet.has(e)) df.set(e, (df.get(e) ?? 0) + 1);
    }

    const n = candidates.length;
    const idf = (e: string): number => {
      const d = df.get(e) ?? 0;
      // An entity in EVERY candidate carries zero discriminating information, and here it must
      // score exactly 0, not merely "≈ 0": rrfFuse consumes ORDER, not magnitude, so any score > 0
      // admits the record — and since every candidate then ties, the sort collapses to the
      // candidate array position, i.e. pure newest-first recency, which RRF would weigh as a full
      // peer of the BM25 order. (LexicalRanker's Math.max(0, …) is enough for BM25 because tf still
      // differentiates records on an all-shared term; entity overlap is binary, so it does not.)
      if (d >= n) return 0;
      // Otherwise: identical formula + non-negative guard as LexicalRanker (memory-search.ts) so
      // the two signals cannot disagree about what "common" means.
      return Math.max(0, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
    };

    const scored: { id: string; score: number; pos: number }[] = [];
    candidates.forEach((rec, pos) => {
      const ents = new Set(recEntities.get(rec.id));
      let score = 0;
      for (const e of qEnts) if (ents.has(e)) score += idf(e);
      if (score > 0) scored.push({ id: rec.id, score, pos });
    });

    scored.sort((a, b) => b.score - a.score || a.pos - b.pos);
    return scored.slice(0, ENTITY_ORDER_MAX).map((s) => s.id);
  }

  stats(): { harvests: number; cached: number } {
    return { harvests: this.harvestCount, cached: this.cache.size };
  }
}
