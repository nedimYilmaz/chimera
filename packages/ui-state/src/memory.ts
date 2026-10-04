// MEM-8 (PLAN-MEMORY.md §9): pure, UI-framework-free helpers for the honest-minimal
// TUI memory fallback. Kept here (not in the tui package) so the reducer can reuse the
// jump-target derivation for its cursor clamp and both live under one vitest suite.
import type { MemoryGetResult, MemorySearchMode } from "@chimera/protocol";
import type { MemoryCapacityView, MemoryScopeSel } from "./types.js";

// The TUI search row is a plain echo (App owns the keystrokes), so structured filters
// ride in as space-delimited `folder:` / `mode:` prefixes parsed client-side and stripped
// before the remaining words become the memory.search `query`. Prefixes may appear
// anywhere in the string; the LAST occurrence of each kind wins; an unrecognized `mode:`
// value is dropped (search falls back to the server default), and a bare `folder:` clears
// the filter rather than filtering on the empty path.
export type ParsedMemoryQuery = { query?: string; folder?: string; mode?: MemorySearchMode; scope?: MemoryScopeSel };

const MODES = new Set<MemorySearchMode>(["lexical", "semantic", "hybrid"]);

export function parseMemoryQuery(raw: string): ParsedMemoryQuery {
  let folder: string | undefined;
  let mode: MemorySearchMode | undefined;
  let scope: MemoryScopeSel | undefined;
  const rest: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.startsWith("folder:")) { folder = tok.slice(7) || undefined; continue; }
    // F34.UI: `scope:` is the TUI's keyboard reach to the scope axis (the app has
    // a chip). `scope:global` selects the UNSCOPED records — which means a project
    // literally named "global" is not addressable by this token; scoping is a
    // ranking default, not access control, so the widening `scope:*` on the RPC is
    // still the way to see everything.
    if (lower.startsWith("scope:")) {
      const v = tok.slice(6);
      if (v) scope = v.toLowerCase() === "global" ? { kind: "global" } : { kind: "scope", name: v };
      continue;                                           // bare `scope:` clears (folder: parity)
    }
    if (lower.startsWith("mode:")) {
      const v = lower.slice(5) as MemorySearchMode;
      if (MODES.has(v)) mode = v;                       // ignore garbage → server default
      continue;
    }
    rest.push(tok);
  }
  const query = rest.join(" ").trim();
  return { ...(query ? { query } : {}), ...(folder ? { folder } : {}), ...(mode ? { mode } : {}), ...(scope ? { scope } : {}) };
}

// The ordered list of records a note's detail region can jump to via `enter`: resolved
// outbound links first (in link order), then inbound backlinks. Ghost/missing links carry
// no target id, so they render but are NOT navigable and are excluded here. The detail
// cursor indexes into THIS array; the pane highlights the rendered row whose jump index
// matches. This is the terminal's whole graph story — a per-note adjacency walk.
export type MemoryJumpTarget = { id: string; label: string };

export function memoryJumpTargets(detail: MemoryGetResult | null): MemoryJumpTarget[] {
  if (!detail) return [];
  const out: MemoryJumpTarget[] = [];
  for (const l of detail.links) {
    if (l.resolvedId) out.push({ id: l.resolvedId, label: l.resolvedTitle ?? l.target });
  }
  for (const b of detail.backlinks) out.push({ id: b.id, label: b.title ?? b.id.slice(0, 8) });
  return out;
}

// ---------------------------------------------------------------------------
// F34.UI — memory SCOPE presentation + filtering (shared by the app chip row and
// the TUI caption so the two never drift).
// ---------------------------------------------------------------------------

/** The one-sentence, plain-words explanation the scope affordances carry (title
 * attribute in the app; the TUI has no tooltips and says the short form inline). */
export const SCOPE_HELP =
  "scope = the project an agent was in when it wrote the note. Agents see their own project plus global by default. It is a ranking default, not access control — nothing is hidden.";

/** `@global` / `@alpha`. The `@` sigil is what keeps a note FILED in a folder
 * named "global" visually distinct from a note whose SCOPE is global (QA F34 §6a);
 * folder chips never carry it. */
export function scopeToken(scope: string | null): string {
  return `@${scope ?? "global"}`;
}

export function scopeSelLabel(sel: MemoryScopeSel): string {
  return sel.kind === "all" ? "all scopes" : sel.kind === "global" ? "@global" : `@${sel.name}`;
}

/** Case-insensitive (memory.search's own scope match is case-insensitive). */
export function scopeMatches(sel: MemoryScopeSel, scope: string | null): boolean {
  if (sel.kind === "all") return true;
  if (sel.kind === "global") return scope == null;
  return scope != null && scope.toLowerCase() === sel.name.toLowerCase();
}

/** The distinct project scopes present in memory.stats, sorted; the null entry
 * (unscoped/global) is NOT one of them. */
export function scopeNames(byScope: Array<{ scope: string | null; count: number }> | undefined): string[] {
  return (byScope ?? []).filter((e) => e.scope != null).map((e) => e.scope as string).sort();
}

/** The header line. On day one every record is unscoped, so "0 scopes · 1641
 * global" would be a riddle — say that state in words instead. */
export function scopeSummary(byScope: Array<{ scope: string | null; count: number }> | undefined): string {
  const entries = byScope ?? [];
  const globalCount = entries.find((e) => e.scope == null)?.count ?? 0;
  const names = scopeNames(byScope);
  if (names.length === 0) return `all ${globalCount} global · no project scopes yet`;
  return `${names.length} scope${names.length === 1 ? "" : "s"} · ${globalCount} global`;
}

/** all → @global → each project scope → all. */
export function cycleScopeSel(sel: MemoryScopeSel, names: string[]): MemoryScopeSel {
  const ring: MemoryScopeSel[] = [{ kind: "all" }, { kind: "global" }, ...names.map((name) => ({ kind: "scope" as const, name }))];
  const at = ring.findIndex((r) => scopeSelLabel(r) === scopeSelLabel(sel));
  return ring[(at + 1) % ring.length] ?? { kind: "all" };
}

/** The memory.search params a scope selection contributes. F34-SCOPE-FILTER added a real
 * server-side exact-membership filter (`scopeMode`), so paging/limit math is correct straight
 * from the RPC now — callers should still run `scopeMatches` over the page as a no-op safety
 * net (an older daemon without `scopeMode` silently ignores the field and falls back to the
 * pre-F34-SCOPE-FILTER "scope ∪ global" widening, which the client-side filter still corrects). */
export function scopeSearchParam(sel: MemoryScopeSel): Record<string, unknown> {
  if (sel.kind === "global") return { scopeMode: "global" };
  if (sel.kind === "scope") return { scope: sel.name, scopeMode: "project" };
  return {};
}

// ---------------------------------------------------------------------------
// F36.UI — memory CAPACITY presentation. The eviction machinery is otherwise
// invisible: a note leaves and nothing on screen ever said it would. These are the
// one source of the words both the app chip and the TUI capacity row render, so the
// two surfaces can never describe the same store differently.
// ---------------------------------------------------------------------------

/** The one-sentence, plain-words explanation the capacity affordances carry — no
 * code knowledge assumed: an operator should learn what a "value" is from here. */
export const CAPACITY_HELP =
  "shared memory holds a fixed number of notes. When it fills, the least valuable notes are dropped (oldest first, and pinned or decision notes last) — each one is archived to memory-evicted.jsonl before it goes. Pin a note to keep it.";

/** What one eviction candidate is CALLED on screen — an untitled note has only its id. */
export function evictionCandidateLabel(c: { title: string | null; id: string }): string {
  return c.title ?? c.id.slice(0, 8);
}

/** `1586/2000 · 79% full` — the exact F36.2 chip text (acceptance criterion 14
 * asserts it), lifted out of the screen so the TUI row says the same words. */
export function capacityLabel(cap: MemoryCapacityView): string {
  return `${cap.total}/${cap.limit} · ${Math.round(cap.fill * 100)}% full`;
}

/** The at-a-glance tone. "alarm" once the daemon's own threshold is crossed —
 * never a second client-side threshold, which could disagree with the event log. */
export function capacityTone(cap: MemoryCapacityView): "ok" | "alarm" {
  return cap.alarming ? "alarm" : "ok";
}

/** The next-to-evict preview, most-doomed first (the daemon sends it ascending by
 * value — the SAME order prune() takes them in). Empty when nothing is evictable. */
export function nextOutLabels(cap: MemoryCapacityView | null | undefined, limit = 5): string[] {
  return (cap?.nextToEvict ?? []).slice(0, limit).map(evictionCandidateLabel);
}

/** The header for the next-out preview. Says the state in words on day one (an
 * empty list is "nothing to drop yet", not an empty box). */
export function nextOutSummary(cap: MemoryCapacityView | null | undefined): string {
  const n = cap?.nextToEvict.length ?? 0;
  if (n === 0) return "nothing to drop yet";
  return `next out: ${nextOutLabels(cap).join(" · ")}`;
}

/** Plain-words status for the pin budget — MAX_PINS_PER_SCOPE is 50 per scope and
 * a 51st pin is REFUSED, so the count is an operator's only warning before that. */
export function pinnedSummary(cap: MemoryCapacityView | null | undefined): string {
  const n = cap?.pinned ?? 0;
  return n === 1 ? "1 pinned" : `${n} pinned`;
}

/** F36.UI: the operator-readable line for the memory events that carry NO curated
 * topic and would otherwise read as a raw data blob in the feed. Returns null for
 * every other kind so the caller falls through to its generic summarizer.
 *
 * memory_evicted arrives in TWO shapes — one per record, plus a single `{truncated,
 * total}` SUMMARY when a pass evicts more records than it will emit events for
 * (MAX_EVICTION_EVENTS_PER_PASS). The summary is matched FIRST: it has no title, so
 * the per-record branch would render it as an eviction of nothing. */
export function memoryEventLine(kind: string, data: Record<string, unknown>): string | null {
  const num = (k: string): number | null => (typeof data[k] === "number" ? (data[k] as number) : null);
  const str = (k: string): string | null => (typeof data[k] === "string" ? (data[k] as string) : null);
  if (kind === "memory_pressure") {
    const total = num("total"), limit = num("limit"), fill = num("fill");
    const head = total !== null && limit !== null
      ? `shared memory ${fill !== null ? `${Math.round(fill * 100)}% full` : "near full"} (${total}/${limit})`
      : "shared memory near full";
    const next = data["nextToEvict"] as { title?: unknown; id?: unknown } | null | undefined;
    const name = next && typeof next === "object"
      ? evictionCandidateLabel({
          title: typeof next.title === "string" ? next.title : null,
          id: typeof next.id === "string" ? next.id : "",
        })
      : null;
    return name ? `${head} — next out: ${name}` : `${head} — notes will start being dropped`;
  }
  if (kind === "memory_evicted") {
    // F36.FIX: `archived` is the daemon's own answer to "did the pre-delete archive write land?".
    // Absent (undefined) on events persisted before that field existed — those keep the old,
    // contract-derived wording rather than being downgraded to a scary one.
    const archived = data["archived"];
    const failed = archived === false;
    const truncated = num("truncated"), total = num("total");
    if (truncated !== null && total !== null)
      return `dropped ${total} notes to free space (${truncated} not listed individually)${failed ? " — ARCHIVE WRITE FAILED, these notes are gone" : ""}`;
    const name = evictionCandidateLabel({ title: str("title"), id: str("id") ?? "" });
    const noteKind = str("kind");
    return `dropped ${noteKind ? `${noteKind} ` : ""}note "${name}"${failed ? " — ARCHIVE WRITE FAILED, this note is gone" : " — archived, not lost"}`;
  }
  if (kind === "memory_added") {
    const noteKind = str("kind") ?? "note";
    const author = str("author");
    return `new ${noteKind}${author ? ` from ${author}` : ""}`;
  }
  return null;
}
