import type { MemoryBacklink, MemoryLink, MemoryRecord } from "@chimera/protocol";

// MEM-1 (PLAN-MEMORY.md §3): the [[wiki-link]] parser + derived link index. Nothing here is
// persisted — memory.json stays the single source of truth. The forward map (recordId →
// parsed targets) is maintained incrementally on load/add/edit/delete; backlinks and target
// resolution are computed on demand against a title map (trivial at the ≤2000-note cap).

// [[target]] and the Obsidian alias form [[target|display]]. Character classes forbid the
// bracket/pipe metacharacters inside so "[[a]] [[b]]" stays two links and never one greedy match.
const LINK_RE = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
const MAX_LINKS_PER_NOTE = 64;   // §3 cap — a pathological note can't blow up the index
const SNIPPET_RADIUS = 80;       // §3: ±80 chars around a backlink mention

// An id-form target: ≥8 leading hex chars, then more hex optionally hyphen-joined — covers both
// today's 8-hex short-id prose habit AND a full record UUID (hyphens included). This is the
// id-prefix candidate test AND the classifier that separates a dangling *missing* id-link
// (deleted/evicted debris) from a dangling *ghost* title-link (a title worth writing).
const ID_FORM_RE = /^[0-9a-f]{8,}(-[0-9a-f]+)*$/i;

export type ParsedLink = {
  target: string;    // the resolution key (alias display text stripped), trimmed
  start: number;     // index of the leading "[[" in the source text (for snippet extraction)
  end: number;       // index just past the trailing "]]"
};

// Parse up to MAX_LINKS_PER_NOTE [[…]] mentions out of a note's text. Empty/whitespace-only
// targets are skipped (a bare "[[]]" or "[[ | x]]" is not a link).
export function parseLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const target = m[1].trim();
    if (target.length === 0) continue;
    out.push({ target, start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_LINKS_PER_NOTE) break;
  }
  return out;
}

// Precomputed resolution context over a records snapshot: id set for exact/prefix matching and
// a title map (lowercased title → most-recently-updated record, so collisions resolve
// deterministically per §3).
type ResolveCtx = {
  byId: Map<string, MemoryRecord>;
  ids: string[];                       // for the id-prefix scan
  byTitle: Map<string, MemoryRecord>;  // key = title.trim().toLowerCase()
};

function buildCtx(records: Iterable<MemoryRecord>): ResolveCtx {
  const byId = new Map<string, MemoryRecord>();
  const byTitle = new Map<string, MemoryRecord>();
  for (const r of records) {
    byId.set(r.id, r);
    if (r.title != null) {
      const key = r.title.trim().toLowerCase();
      if (key.length > 0) {
        const prev = byTitle.get(key);
        // Collision → most-recently-updated wins (deterministic, §3).
        if (!prev || r.updatedAt >= prev.updatedAt) byTitle.set(key, r);
      }
    }
  }
  return { byId, ids: [...byId.keys()], byTitle };
}

// Resolve one raw target to a MemoryLink, following the §3 precedence:
//   ① exact record id  ② unambiguous id-prefix (≥8 hex)  ③ case-insensitive title match.
// Failing all three, classify the dangling link: an id-form target → missing (both null);
// any other text → ghost (resolvedTitle carries the intended title, resolvedId null).
function resolveTarget(target: string, ctx: ResolveCtx): MemoryLink {
  // ① exact id
  const exact = ctx.byId.get(target);
  if (exact) return { target, resolvedId: exact.id, resolvedTitle: exact.title };

  // ② id-prefix — only for id-form targets; unambiguous (exactly one) match wins.
  if (ID_FORM_RE.test(target)) {
    const lower = target.toLowerCase();
    let hit: MemoryRecord | undefined;
    let ambiguous = false;
    for (const id of ctx.ids) {
      if (id.toLowerCase().startsWith(lower)) {
        if (hit) { ambiguous = true; break; }
        hit = ctx.byId.get(id);
      }
    }
    if (hit && !ambiguous) return { target, resolvedId: hit.id, resolvedTitle: hit.title };
  }

  // ③ title (case-insensitive)
  const byTitle = ctx.byTitle.get(target.trim().toLowerCase());
  if (byTitle) return { target, resolvedId: byTitle.id, resolvedTitle: byTitle.title };

  // dangling: id-form ⇒ missing (debris), else ⇒ ghost (a title worth writing)
  return ID_FORM_RE.test(target)
    ? { target, resolvedId: null, resolvedTitle: null }
    : { target, resolvedId: null, resolvedTitle: target };
}

// ±SNIPPET_RADIUS chars around a mention, with ellipses when clipped.
function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.length, end + SNIPPET_RADIUS);
  return (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "");
}

export class MemoryLinkIndex {
  // recordId → its parsed forward links. Only records that actually contain links have an
  // entry, so this stays tiny for the link-free majority.
  private forward = new Map<string, ParsedLink[]>();

  // Rebuild the whole forward map from a records snapshot (called on store load).
  rebuild(records: Iterable<MemoryRecord>): void {
    this.forward.clear();
    for (const r of records) this.set(r);
  }

  // Add or re-index one record (add/edit). A record whose text lost all links drops its entry.
  set(record: MemoryRecord): void {
    const links = parseLinks(record.text);
    if (links.length > 0) this.forward.set(record.id, links);
    else this.forward.delete(record.id);
  }

  remove(id: string): void {
    this.forward.delete(id);
  }

  // Resolved outbound links for one record, in source order.
  resolveLinks(record: MemoryRecord, records: Iterable<MemoryRecord>): MemoryLink[] {
    const ctx = buildCtx(records);
    return (this.forward.get(record.id) ?? []).map((l) => resolveTarget(l.target, ctx));
  }

  // MEM-2 (PLAN-MEMORY.md §4): resolve EVERY linking record's outbound links against ONE shared
  // resolution ctx. The graph builder needs all records' links at once; calling resolveLinks per
  // record would rebuild ctx each time — O(n²) at the 2000-note cap. Returns only records that
  // actually contain links (the forward map's key set), each mapping to its resolved links in
  // source order (order preserved so the caller can dedup/weight deterministically).
  resolveAll(records: Iterable<MemoryRecord>): Map<string, MemoryLink[]> {
    const ctx = buildCtx(records);
    const out = new Map<string, MemoryLink[]>();
    for (const [id, links] of this.forward)
      out.set(id, links.map((l) => resolveTarget(l.target, ctx)));
    return out;
  }

  // Inbound backlinks to `id`: every record whose forward links resolve to it, each with a
  // snippet around the mention. A record that links to `id` more than once contributes one
  // backlink per mention (each mention is a distinct navigable site).
  backlinks(id: string, records: Iterable<MemoryRecord>): MemoryBacklink[] {
    const recs = [...records];
    const ctx = buildCtx(recs);
    const out: MemoryBacklink[] = [];
    for (const rec of recs) {
      const links = this.forward.get(rec.id);
      if (!links) continue;
      for (const l of links) {
        if (resolveTarget(l.target, ctx).resolvedId === id) {
          out.push({
            id: rec.id, title: rec.title, kind: rec.kind, folder: rec.folder,
            snippet: snippet(rec.text, l.start, l.end),
          });
        }
      }
    }
    return out;
  }
}
