import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MemoryRecordSchema, MemoryMaxRecordsSchema, DEFAULT_MEMORY_MAX_RECORDS,
  type MemoryGetResult, type MemoryGraphEdge, type MemoryGraphNode,
  type MemoryGraphParams, type MemoryGraphResult, type MemoryIndexResult, type MemoryKind,
  type MemoryRecord, type MemorySearchMode, type MemoryStatsResult,
} from "@chimera/protocol";
import type { EventLog } from "./events.js";
import { LexicalRanker, demoteSuperseded, rrfFuse, type Ranker, type ScoredRecord } from "./memory-search.js";
import { MemoryLinkIndex } from "./memory-links.js";
import { MemoryEntityIndex } from "./memory-entities.js";
import type { IndexableRecord, MemoryVectorIndex } from "./memory-index.js";

export class UnknownMemoryError extends Error { code = "protocol" as const; name = "UnknownMemoryError"; }

// MEMORY-NO-DUPLICATES: a refusal that carries the record it collided with, so the caller can
// act on it in one step instead of searching for what it just tripped over.
export class DuplicateMemoryError extends Error {
  code = "conflict" as const;
  name = "DuplicateMemoryError";
  constructor(message: string, readonly duplicateOf: string) { super(message); }
}

// F35: refusing a FORK. A record has at most one successor, which is what makes "the current
// version of this fact" a total function instead of a search over a branching history. The
// refusal names the tip so the caller's retry is a one-token edit, not another lookup.
export class SupersededTargetError extends Error {
  code = "conflict" as const;
  name = "SupersededTargetError";
  constructor(message: string, readonly currentId: string) { super(message); }
}

// MEMORY-NO-DUPLICATES: how similar two notes must be before an add is refused as a second copy.
// Deliberately LEXICAL and synchronous — the vector index is optional and its embedder resolves
// lazily over the network, so keying the guarantee on it would mean "no duplicates, except on
// the machines where there is no embedder", which is not a guarantee. Jaccard over the token
// SET (not sequence) is what makes a reworded restatement of the same fact collide with the
// original: "the boot stall is the event-log integrity scan" and "event log integrity scan
// causes the slow boot" share nearly every token while sharing no phrasing.
const DUPLICATE_SIMILARITY = 0.7;
// Below this, Jaccard is noise — two very short notes can share most of their content words and
// mean entirely different things, so a short note must match EXACTLY to count as a duplicate.
const MIN_TOKENS_FOR_FUZZY_MATCH = 6;

// The words that carry no topic and appear in nearly every sentence. Comparing raw token sets
// measured GRAMMAR as much as content: a restatement of the same fact rewrites exactly these
// ("caused by" -> "causes", "which is what") and so scored as different, while two unrelated
// notes both full of "the/is/a" scored as more alike than they are.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "for", "from", "had",
  "has", "have", "how", "in", "into", "is", "it", "its", "not", "of", "on", "one", "or", "our",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your", "if",
  "so", "than", "too", "very", "just", "only", "also", "does", "do", "did", "no", "yes", "up",
]);

// Crude suffix folding, NOT a real stemmer — enough to make "runs"/"running", "caused"/"causes"
// and "scan"/"scans" the same token, which is where a genuine restatement differs from its
// original. A real stemmer would be a dependency and more precision than a duplicate check needs.
function fold(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

function contentTokens(title: string | null, text: string): Set<string> {
  const raw = `${title ?? ""} ${text}`.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(raw.filter((t) => !STOPWORDS.has(t)).map(fold));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// F36: the pin cap refusal. Conflict-coded like DuplicateMemoryError above — the caller asked for
// something the store's bound will not allow, and the message says exactly how to make room.
export class PinCapError extends Error { code = "conflict" as const; name = "PinCapError"; }

export class MemoryCapacityError extends Error { code = "conflict" as const; name = "MemoryCapacityError"; }

const MAX_TOP_TAGS = 50;           // MEM-1 stats: cap the topTags list (folksonomy has ~60 distinct tags today)

// F35: bound the supersession walk. The WRITE path cannot create a cycle (a successor is always
// newer than the record it supersedes, and its target must already exist), so this guards a
// hand-edited or torn memory.json only — but the walk runs on every memory_get, so it must be
// total regardless of what is on disk.
const MAX_SUPERSESSION_HOPS = 32;
// F35: the excerpt length of the "current version" backlink snippet — chosen to match what the
// [[link]] backlink path already produces (±SNIPPET_RADIUS = 80 either side, memory-links.ts).
const SUPERSEDED_SNIPPET_MAX = 160;

// F36 eviction weights. Every number below is justified by a direct read of the live store on
// 2026-09-02 (1,586/2,000 records; kinds fact 791 / decision 700 / todo 77 / note 16 / question 2;
// 1,018 [[link]] mentions of which 940 resolve; 436 records with >=1 inbound, max 13).
//
// W_INBOUND: the only EARNED signal — another agent chose to reference this note. Capped, because a
// single note can emit 64 links (memory-links.ts) and an uncapped count would let five notes make
// any target permanent. INBOUND_CAP=10 sits just under the live max of 13, so the cap binds on
// almost nothing today and bounds the adversarial case completely.
const W_INBOUND = 1;
const INBOUND_CAP = 10;
// W_DECISION: a decision is worth five inbound mentions. Decisions are 44.1% of the live store but
// 52.5% of its OLDEST 200 records — precisely the class insertion-order eviction deletes first, which
// is the whole reason this exists. Not higher: 700 decisions cannot all be protected inside a
// 2,000 cap, so this is a tilt, not an exemption.
const W_DECISION = 5;
// W_PIN: strictly greater than the maximum achievable unpinned score (W_DECISION + INBOUND_CAP = 15),
// so an operator's explicit pin outranks every earned signal combined. A finite number and NOT an
// exemption on purpose: a store of nothing but pins still evicts in a defined order rather than
// growing without bound — which is what would happen if a pin skipped prune() entirely.
const W_PIN = 1000;
// F36: pins are capped PER SCOPE (F34's record.scope; null = global). 50 is 2.5% of the cap — enough
// for a project's genuine contracts, small enough that pinning cannot dilute the ranking.
const MAX_PINS_PER_SCOPE = 50;
// F36: how many per-record eviction events one pass may emit before it summarizes. The normal path
// evicts exactly 1 record per save; this bounds the pathological path (a hand-edited memory.json,
// a lowered cap) without ever silently dropping the count.
const MAX_EVICTION_EVENTS_PER_PASS = 50;
// F36: the eviction archive. A value function's first production act is an irreversible delete on a
// 5.3 MB knowledge base, so the record is ARCHIVED before it is dropped. 500 entries is ~1.7 MB at
// the live 3.3 KB mean record, and ~13 days of eviction at the measured 37 records/day.
const MAX_ARCHIVED_EVICTIONS = 500;
// F36: re-arm band below evictionAlarmAt — checkPressure() is edge-triggered (fires once per
// crossing) and won't fire again until fill drops a full 0.05 under the threshold, so hovering
// exactly at the line can't spam an alarm per add/delete pair.
const PRESSURE_HYSTERESIS = 0.05;
// F36.FIX (QA finding 4): a store parked AT the cap never drops a full hysteresis band below the
// threshold, so the edge-triggered alarm above was effectively ONE-SHOT per daemon process — the
// second pressure episode of a long-lived daemon was silent. Re-arm every N evicted records so
// each subsequent episode is announced at a digest cadence instead of once per add.
const PRESSURE_REARM_EVICTIONS = 100;

// MEM-1 (PLAN-MEMORY.md §2): a folder is a slash-delimited materialized path. Normalize on
// write — trim each segment, drop empty segments (this also collapses "//" and strips
// leading/trailing "/") — case preserved (matching is case-insensitive elsewhere). An input
// that reduces to nothing ⇒ null (the virtual "unfiled" folder).
export function normalizeFolder(input: string | null | undefined): string | null {
  if (input == null) return null;
  const parts = input.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join("/") : null;
}

// F34: the widening escape token. Never a stored scope — normalizeScope maps it to null on the
// write path too, so a project could not smuggle itself into "every scope" by being named "*".
export const SCOPE_ALL = "*";

// F34: a scope is a trimmed project name; empty or SCOPE_ALL ⇒ null. On the WRITE path null means
// "global"; on the SEARCH path null means "do not narrow" — one function serves both because the
// escape and the absence want the same behaviour.
export function normalizeScope(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = input.trim();
  return s.length > 0 && s !== SCOPE_ALL ? s : null;
}

// MEM-1 (§3): a title is a trimmed short name; empty ⇒ null. The 120-char cap is enforced by
// the schema on parse.
function normalizeTitle(input: string | null | undefined): string | null {
  if (input == null) return null;
  const t = input.trim();
  return t.length > 0 ? t : null;
}

// MEM-4: the shape the vector index embeds — just id + the fields that form the embed input.
function toIndexable(r: MemoryRecord): IndexableRecord {
  return { id: r.id, title: r.title, text: r.text };
}

// MEM-2 (§4): the graph node/list label is the title when present, else the note's first
// non-empty line truncated to ~40 chars. Computed server-side so the app never fetches full
// texts for the graph.
const GRAPH_LABEL_MAX = 40;
function firstLineExcerpt(text: string, max = GRAPH_LABEL_MAX): string {
  // First non-blank line; fall back to the whole (whitespace-only) text collapsed to "".
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

// F36: the eviction value of one record. Pure and synchronous by construction — never the embedder
// (a guarantee that only holds where an embedder exists is not a guarantee) and never a model call.
// Higher = kept longer. `inbound` is the record's inbound backlink count, computed once per pass by
// the caller. F35's `supersededBy` is deliberately NOT a term (QA F35-E — the earlier text here
// promised one): a superseded record is precisely what answers "why did we change our mind?", and
// evicting it first would delete the history the feature exists to keep. Search demotion
// (demoteSuperseded()) already keeps it out of the reader's way, which is the whole cost of being
// obsolete; paying for it twice, once irreversibly, is not the trade this store makes.
export function memoryValue(record: MemoryRecord, inbound: number): number {
  return (record.pinned ? W_PIN : 0)
    + (record.kind === "decision" ? W_DECISION : 0)
    + W_INBOUND * Math.min(inbound, INBOUND_CAP);
}

export type MemoryAddInput = {
  author: string; text: string;
  title?: string | null; folder?: string | null;
  // F34: supplied by the ENGINE from the author's own project binding, never by the MCP surface
  // (MemoryAddParams is .strict() and has no `scope` key). A store-level caller with no agent
  // identity omits it and gets a global record.
  scope?: string | null;
  tags?: string[]; kind?: MemoryKind;
  treeId?: string | null; taskId?: string | null;
  // MEMORY-NO-DUPLICATES: the deliberate escape. A caller that has SEEN the collision and means
  // a genuinely distinct note says so explicitly; the default is refusal, so a second copy can
  // only ever be created on purpose.
  allowDuplicate?: boolean;
  // F35: the id of the record this note replaces. Validated in add() BEFORE the duplicate check.
  supersedes?: string | null;
};
// title/folder use `undefined` = leave untouched, `null` = clear (mirrors MemoryEditParams).
export type MemoryEditInput = {
  text?: string; title?: string | null; folder?: string | null;
  tags?: string[]; kind?: MemoryKind;
  // F36: the eviction pin. Edit-only (MemoryAddParams has no `pinned`) — a note is pinned once it
  // has PROVED durable, which is not a birth property.
  pinned?: boolean;
};
export type MemorySearchFilters = {
  query?: string; tags?: string[]; author?: string; kind?: MemoryKind; treeId?: string;
  folder?: string; mode?: MemorySearchMode; limit?: number;
  scope?: string;   // F34: undefined ⇒ no narrowing; SCOPE_ALL ⇒ no narrowing; else that scope + global
  // F34-SCOPE-FILTER: exact-membership narrowing applied AFTER the `scope` widen filter above —
  // undefined/"all" changes nothing; "global" keeps only unscoped records; "project" drops unscoped
  // records (narrowed further to `scope`'s value when given).
  scopeMode?: "global" | "project" | "all";
};

// Shared structured note store — Pattern B (atomic temp+rename snapshot), copied from
// QueueStore. add() deliberately emits only ONE event kind (memory_added, PLAN-HOOKS.md §5,
// HOOK-1) rather than a general-purpose `status` event: main.ts snapshots state.json on every
// event, and chatty memory writes would amplify those snapshots (design §concurrency) — the
// single lean event exists purely so a subscription/hook can react to new notes, and carries
// no extra persistence of its own (memory.json's own write path below is unchanged). edit()/
// delete() (D11) are comparatively rare and emit a full `status` event — UIs need a signal to
// refresh from instead of polling the shared pool.
export class MemoryStore {
  private records = new Map<string, MemoryRecord>();   // Map preserves insertion order → stable prune/eviction
  // MEM-1: derived [[link]] index (nothing persisted). Rebuilt from `records` on load and
  // maintained incrementally on add/edit/delete — memory.json stays the sole source of truth.
  private links = new MemoryLinkIndex();
  // F33: derived like `links`, but built lazily at search time — deliberately takes no
  // write-path hook (self-invalidates on updatedAt change instead).
  private entities = new MemoryEntityIndex();
  private file: string;
  private archiveFile: string;   // F36: memory-evicted.jsonl — the pre-delete archive, never loaded at boot

  // F36: capacity alarm state. maxRecords/alarmAt follow the config defaults; pressureArmed
  // starts true so a store that boots already over threshold (e.g. alarmAt lowered after the
  // fact) still alarms once on its first save() rather than staying silent forever.
  private maxRecords: number;
  private alarmAt: number;
  private pressureArmed = true;
  private evictedSinceAlarm = 0;   // F36.FIX: records evicted since the last alarm; see PRESSURE_REARM_EVICTIONS

  // MEM-4: optional local vector index for hybrid/semantic search. Absent ⇒ pure lexical (today's
  // exact behavior); present ⇒ derived accelerator, maintained on add/edit/delete/prune below.
  constructor(dir: string, private events?: EventLog, private ranker: Ranker = new LexicalRanker(), private index?: MemoryVectorIndex,
              opts: { alarmAt?: number; maxRecords?: number } = {}) {
    this.maxRecords = MemoryMaxRecordsSchema.parse(opts.maxRecords ?? DEFAULT_MEMORY_MAX_RECORDS);
    this.entities.setCapacity(this.maxRecords);
    this.alarmAt = opts.alarmAt ?? 0.9;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "memory.json");
    this.archiveFile = join(dir, "memory-evicted.jsonl");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { records: unknown[] };
        for (const r of raw.records) { const rec = MemoryRecordSchema.parse(r); this.records.set(rec.id, rec); }
      } catch (err) {
        // AUDIT-2: unlike teams.json/toolpolicy.json (security-relevant, fail-fast on
        // purpose), memory.json is operational state — crash-looping the daemon over a
        // torn/corrupt file would just make things worse. Quarantine it (rename with a
        // timestamp so it's preserved for inspection) and boot with an empty store,
        // mirroring events.ts's tolerant handling of torn lines.
        this.records.clear();
        const quarantined = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, quarantined);
        console.warn(`chimerad: corrupt coordination state in ${this.file}: ${(err as Error).message} — quarantined to ${quarantined}, booting with an empty memory store`);
      }
    }
    this.links.rebuild(this.records.values());   // MEM-1: seed the derived link index from the loaded records
    if (this.index) {
      // MEM-4: seed the vector index from the loaded records. load() reads the sidecar (reusing
      // still-valid vectors), retain() sheds rows for records gone since last boot, and enqueue()
      // registers every record as "desired" — but the embedder resolves LAZILY (first semantic
      // search / memory.index call), so this is network-free and cheap.
      this.index.load();
      this.index.retain(new Set(this.records.keys()));
      for (const r of this.records.values()) this.index.enqueue(toIndexable(r));
    }
  }

  // F36: inbound backlink count for EVERY record, in one pass. resolveAll builds a single shared
  // resolution ctx — the same O(total-links) trick memory.graph() already relies on — so this is one
  // ctx build plus one resolution per mention (1,018 live), not one ctx build per record the way
  // backlinks() would be. Called at most ONCE per prune pass and once per stats() call.
  private inboundCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    // A SELF-mention never scores. Inbound is the only earned signal (W_INBOUND above) precisely
    // because someone ELSE chose to reference the note; a record whose text carries [[its own
    // title]] would otherwise hand itself up to INBOUND_CAP points that no eviction can ever revoke,
    // because evicting the linker means evicting the beneficiary. Link spam from a third record is
    // self-correcting (the spammer scores 0 and dies first); a self-link is not.
    for (const [source, links] of this.links.resolveAll(this.records.values()))
      for (const l of links)
        if (l.resolvedId && l.resolvedId !== source) counts.set(l.resolvedId, (counts.get(l.resolvedId) ?? 0) + 1);
    return counts;
  }

  // F36: every record in EVICTION ORDER — ascending value, ties broken by insertion order (oldest
  // first). The tie-break is what keeps the order TOTAL and keeps pre-F36 behaviour intact on a
  // corpus with no signals: with no pins, no decisions and no links every value is 0 and this is
  // exactly the insertion-order slice it replaced. Public because prune() and stats() must read the
  // same order — two implementations of "what goes next" is how the operator's preview starts lying.
  // F35's `record.supersededBy !== null` is NOT one of the signals — see memoryValue() for why an
  // obsolete record is still worth keeping. FIFO already tends to evict superseded records first
  // (they are older by construction); that stays incidental, deliberately.
  evictionOrder(): Array<{ record: MemoryRecord; value: number; inbound: number }> {
    const inbound = this.inboundCounts();
    return [...this.records.values()]
      .map((record, i) => ({ record, i, inbound: inbound.get(record.id) ?? 0 }))
      .map((x) => ({ ...x, value: memoryValue(x.record, x.inbound) }))
      .sort((a, b) => a.value - b.value || a.i - b.i)
      .map(({ record, value, inbound }) => ({ record, value, inbound }));
  }

  private prune(): void {
    const overflow = this.records.size - this.maxRecords;
    if (overflow <= 0) return;   // unchanged fast path: no scoring cost below the cap
    const doomed = this.evictionOrder().slice(0, overflow);
    // F36.FIX (QA finding 6): the archive is written ONCE for the whole pass, not once per record —
    // the per-record form read+trimmed+rewrote the whole jsonl per victim, which is quadratic when a
    // lowered cap dooms hundreds at once. Serialization still happens INSIDE the loop: spliceOutOfChain
    // re-`set`s freshly parsed NEIGHBOUR objects, so a victim stringified after the pass would carry
    // chain pointers the pass itself rewrote.
    const archiveLines: string[] = [];
    const evicted: Array<{ record: MemoryRecord; value: number; inbound: number }> = [];
    for (const { record: doomedSnapshot, value, inbound } of doomed) {
      // F35 (QA F35-F): evictionOrder() snapshots every record BEFORE the first delete, but a
      // splice below rewrites chain pointers mid-pass — so when two links of one chain are evicted
      // together the later victim's snapshot is stale and would repair against a dead id. Re-read.
      const record = this.records.get(doomedSnapshot.id) ?? doomedSnapshot;
      archiveLines.push(JSON.stringify(record));
      this.records.delete(record.id);
      this.spliceOutOfChain(record);   // F35 (QA): eviction of a successor must repair its chain
      this.links.remove(record.id);   // MEM-1: don't leak forward-link entries for evicted records
      this.index?.drop(record.id);    // MEM-4: drop the evicted record's vector too
      evicted.push({ record, value, inbound });
    }
    // ARCHIVE BEFORE THE RECORDS ARE DURABLE — save() rewrites memory.json only after prune()
    // returns, so a crash between here and there leaves the victims still in the live file.
    const archived = this.archiveEvictions(archiveLines);
    for (const [n, { record, value, inbound }] of evicted.entries()) {
      if (n >= MAX_EVICTION_EVENTS_PER_PASS) break;
      this.events?.append({ agentId: `memory:${record.id}`, kind: "memory_evicted", data: {
        id: record.id, title: record.title, kind: record.kind, author: record.author,
        folder: record.folder, scope: record.scope, value, inbound, pinned: record.pinned,
        // F36.FIX (QA finding 5): whether the pre-delete archive write actually SUCCEEDED. The UI
        // said "archived, not lost" from the contract; now it can say it from the event.
        archived } });
    }
    // The count is never silently dropped: past the per-pass cap the pass says how many it withheld.
    if (doomed.length > MAX_EVICTION_EVENTS_PER_PASS)
      this.events?.append({ agentId: "memory", kind: "memory_evicted",
        data: { truncated: doomed.length - MAX_EVICTION_EVENTS_PER_PASS, total: doomed.length, archived } });
    // F36.FIX (QA finding 4): a store parked at the cap can never re-arm by fill alone, so every
    // PRESSURE_REARM_EVICTIONS lost records earns one more alarm — announced by the NEXT save(),
    // which calls checkPressure() before prune().
    this.evictedSinceAlarm += doomed.length;
    if (this.evictedSinceAlarm >= PRESSURE_REARM_EVICTIONS) {
      this.pressureArmed = true;
      this.evictedSinceAlarm = 0;
    }
  }

  // F36: an evicted record is ARCHIVED, not deleted. memory-evicted.jsonl is append-only, one JSON
  // record per line, trimmed to the last MAX_ARCHIVED_EVICTIONS on write. Deliberately NOT an RPC
  // surface and NOT loaded at boot — it is a recovery file an operator reads with one `node -e` line,
  // and a store for it would be a second source of truth for what memory.json IS the source of truth
  // for. A write failure must never break an add: memory.json is the product, this is the safety net,
  // and a full disk should not take both — hence the boolean rather than a throw (the caller puts it
  // on the memory_evicted event so a reader learns the safety net failed).
  private archiveEvictions(lines: string[]): boolean {
    if (lines.length === 0) return true;
    try {
      const existing = existsSync(this.archiveFile)
        ? readFileSync(this.archiveFile, "utf8").split("\n").filter((l) => l.length > 0) : [];
      for (const line of lines) existing.push(line);   // not spread: a pathological pass can be huge
      const tmp = `${this.archiveFile}.tmp`;    // same temp+rename discipline as save()
      writeFileSync(tmp, existing.slice(-MAX_ARCHIVED_EVICTIONS).join("\n") + "\n");
      renameSync(tmp, this.archiveFile);
      return true;
    } catch (err) {
      console.warn(`chimerad: could not archive ${lines.length} evicted memory record(s): ${(err as Error).message}`);
      return false;
    }
  }

  // F36.FIX (QA finding 4): a live `memory` config change re-arms the alarm — a fresh threshold is a
  // fresh question about this store, and the old edge was answered against the old one. It emits
  // NOTHING itself: stats().capacity.alarming is computed live, so the UI is already truthful the
  // instant the config lands, and applyConfig() must stay synchronous and side-effect-light.
  setCapacity(opts: { alarmAt?: number; maxRecords?: number }): void {
    const alarmAt = opts.alarmAt ?? this.alarmAt;
    const maxRecords = MemoryMaxRecordsSchema.parse(opts.maxRecords ?? this.maxRecords);
    if (alarmAt === this.alarmAt && maxRecords === this.maxRecords) return;
    this.alarmAt = alarmAt;
    this.maxRecords = maxRecords;
    this.entities.setCapacity(maxRecords);
    this.pressureArmed = true;
    this.evictedSinceAlarm = 0;
  }

  // F36: fires memory_pressure BEFORE prune() so the EVENT LOG always carries the warning ahead of
  // the loss it warns about (F36.FIX: the memory.pressure topic makes that ordering visible to a
  // hook/subscribe caller too, not just to whoever reads the log or the memory.stats capacity
  // block). Edge-triggered with a hysteresis re-arm band (PRESSURE_HYSTERESIS)
  // so hovering at the threshold can't spam an alarm per add/delete pair; alarmAt <= 0 disables
  // it entirely. nextToEvict is evictionOrder()[0] — the SAME record prune() would take next, so the
  // warning and the loss can never name different notes.
  private checkPressure(): void {
    if (this.alarmAt <= 0) return;
    const fill = this.records.size / this.maxRecords;
    if (this.pressureArmed && fill >= this.alarmAt) {
      this.pressureArmed = false;
      this.evictedSinceAlarm = 0;
      const next = this.evictionOrder()[0];
      this.events?.append({ agentId: "memory", kind: "memory_pressure", data: {
        total: this.records.size, limit: this.maxRecords, fill, threshold: this.alarmAt,
        nextToEvict: next ? { id: next.record.id, title: next.record.title, value: next.value } : null,
      } });
    } else if (!this.pressureArmed && fill < this.alarmAt - PRESSURE_HYSTERESIS) {
      this.pressureArmed = true;
    }
  }

  private save(evictOverflow = false): void {
    this.checkPressure();
    // A reduced cap (including on restart) must never turn an edit/delete into bulk loss.
    // Only an add from at/below capacity may evict; over-cap additions are refused up front.
    if (evictOverflow) this.prune();
    const tmp = `${this.file}.tmp`;                // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify({ records: [...this.records.values()] }, null, 2));
    renameSync(tmp, this.file);
  }

  // MEMORY-NO-DUPLICATES: the near-duplicate this text would become a second copy of, or null.
  // Exposed so a caller can ask BEFORE writing (and so the behaviour is testable directly).
  findDuplicate(text: string, title?: string | null): MemoryRecord | null {
    const tokens = contentTokens(normalizeTitle(title), text);
    const normalizedText = text.trim().toLowerCase();
    let best: { record: MemoryRecord; score: number } | null = null;
    for (const r of this.records.values()) {
      // An identical body is a duplicate at any length — no threshold needed to know that.
      if (r.text.trim().toLowerCase() === normalizedText) return r;
      if (tokens.size < MIN_TOKENS_FOR_FUZZY_MATCH) continue;
      const score = jaccard(tokens, contentTokens(r.title, r.text));
      if (score >= DUPLICATE_SIMILARITY && (best === null || score > best.score)) best = { record: r, score };
    }
    return best?.record ?? null;
  }

  // F35: resolve and validate a supersession target. Three refusals, all deliberate:
  //   unknown id      → UnknownMemoryError. A dangling back-pointer is worse than a refusal:
  //                     demoteSuperseded() rank-shifts on this field, so a typo'd id would sink a
  //                     live record to the bottom of every search forever, with no backlink to
  //                     explain it (supersessionTip() ends its walk on the dead pointer).
  //   scope mismatch  → SupersededTargetError. See below.
  //   already superseded → SupersededTargetError naming the TIP. At most one successor per record
  //                     keeps the history a chain, which is what makes supersessionTip() total.
  //
  // F35-B (QA): the scope rule is AUDIENCE SUPERSET — supersede is allowed only when the new note
  // reaches everyone the old one reaches. A scope-narrowed search returns "that scope PLUS global"
  // (F34), so the successor's audience covers the target's iff the scopes are equal or the WRITER
  // is unscoped (global). Everything else is refused, for two harms QA reproduced: a `beta` agent
  // could demote an `alpha` record to the bottom of every alpha search with the cause invisible
  // from inside alpha (integrity), and get()'s synthetic backlink renders the successor's raw text
  // into the target's read — a channel out of beta into alpha (confidentiality).
  //
  // This is DELIBERATELY STRICTER than F35.md's proposal, which would also have allowed a scoped
  // note to supersede a GLOBAL one: that is the confidentiality leak in its worst form (every
  // scope reads the backlink), and "in beta it works differently" is a new scoped note, not a
  // replacement of the fact everyone else still holds. SCOPE_ALL needs no case of its own —
  // normalizeScope() folds "*" to null, so "global on either side" is the only form it takes.
  private resolveSupersedes(id: string, scope: string | null): MemoryRecord {
    const target = this.records.get(id);
    if (!target) throw new UnknownMemoryError(`cannot supersede unknown memory ${id}`);
    const targetScope = normalizeScope(target.scope);
    if (scope !== null && targetScope !== scope) {
      // Checked BEFORE the chain check on purpose: refusing across a scope boundary must not leak
      // the tip's id, which is the one piece of foreign state the chain refusal hands back.
      // A GLOBAL target has no owning scope to defer to, so "the owning scope's write" would be a
      // dead end no project-bound agent can ever act on, and "add your own note" alone leaves the
      // two contradictory notes supersedes exists to prevent. memory_edit DOES reach it: edit() is
      // scope-blind and the record stays global, so it stays visible to this caller afterwards.
      const exit = targetScope === null
        ? `If the fact changed EVERYWHERE, update that global note in place with memory_edit; if it ` +
          `differs only in \`${scope}\`, add that as its own note (allowDuplicate: true if it reads ` +
          `as a duplicate).`
        : `If the fact differs in \`${scope}\`, add that as its own note (allowDuplicate: true if it ` +
          `reads as a duplicate); if it changed everywhere, it is the owning scope's write to make.`;
      throw new SupersededTargetError(
        `memory ${id} is scoped to \`${targetScope ?? "global"}\` and you write in \`${scope}\` — a ` +
        `note cannot supersede one that readers of the old note would never see replaced. ${exit}`,
        target.id,
      );
    }
    if (target.supersededBy !== null) {
      const tip = this.supersessionTip(target) ?? target;
      throw new SupersededTargetError(
        `memory ${id} was already superseded by ${target.supersededBy} — supersede ${tip.id} ` +
        `(the current version of this fact) instead.`,
        tip.id,
      );
    }
    return target;
  }

  // F35: walk supersededBy to the CURRENT version of a fact; null when `from` is not superseded.
  // A pointer that no longer resolves (successor deleted, or evicted by prune) ENDS the walk and
  // the last live record wins — a broken chain degrades to "the newest one still here" instead of
  // throwing on a read. The visited set + hop cap bound a hand-edited cycle (see the constant).
  private supersessionTip(from: MemoryRecord): MemoryRecord | null {
    let cur = from;
    const seen = new Set<string>([from.id]);
    for (let hops = 0; cur.supersededBy !== null && hops < MAX_SUPERSESSION_HOPS; hops++) {
      const next = this.records.get(cur.supersededBy);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      cur = next;
    }
    return cur === from ? null : cur;
  }

  add(input: MemoryAddInput): MemoryRecord {
    if (this.records.size > this.maxRecords) {
      throw new MemoryCapacityError(`memory holds ${this.records.size} records above memory.maxRecords=${this.maxRecords}; raise the limit or explicitly delete notes before adding`);
    }
    // F35: validated up front — a bad supersedes id must not be masked by a duplicate refusal,
    // and the resolved target is what decides whether that refusal applies at all (below).
    // F34: the scope this write lands in — engine.ts stamps it from the caller's project binding,
    // so it is the caller's own scope, not a claim. Both the supersedes guard and the duplicate
    // refusal below reason about it.
    const callerScope = normalizeScope(input.scope);
    const supersedeTarget = input.supersedes != null
      ? this.resolveSupersedes(input.supersedes, callerScope) : null;
    // MEMORY-NO-DUPLICATES: enforced HERE, not in a prompt. An instruction telling agents not to
    // duplicate cannot work — an agent does not know what the pool already holds, every agent
    // judges "same fact" differently, and there are many of them writing concurrently. The store
    // is the only place that can see all of it, so the store is where the rule lives. What the
    // prompt does is explain the refusal; what makes it true is this check.
    if (!input.allowDuplicate) {
      const dup = this.findDuplicate(input.text, input.title);
      // F35: THE POINT OF THIS CARD. A note recording that a fact CHANGED is lexically
      // near-identical to the note recording the old fact, so this guard fires on exactly the
      // write it should let through — leaving only memory_edit (destroys the history) or
      // allowDuplicate (two contradictory notes, no ordering). `supersedes` is that write's
      // permission slip. It is scoped to the record it NAMES: superseding A must not smuggle a
      // second copy of an unrelated near-duplicate B into the store.
      if (dup && dup.id !== supersedeTarget?.id) {
        const label = dup.title ?? firstLineExcerpt(dup.text, 80);
        // F34-2 (QA finding, F34.md §3/§5(a)): a duplicate scoped to a DIFFERENT project than the
        // caller's is invisible to the caller's own default-scoped search — naming it is not
        // enough, the refusal must also say where to look. Option (ii): teach the search widener
        // rather than mutate `dup.scope` (that would break criterion 8's edit-time immutability).
        const scopeHint = dup.scope !== callerScope
          ? ` (that note is scoped to \`${dup.scope ?? "global"}\`; use \`memory_search {scope:"*"}\` to see it)`
          : "";
        // F35 (QA, deciding F34-2's open question): criterion 8 STANDS — edit() does not re-stamp
        // scope — so this message, not the write path, is where the cross-scope case is fixed. Two
        // of the three exits are closed across a boundary, and naming a closed one is how the note
        // got stranded: memory_edit keeps the record where it is, so it only helps when the caller
        // can still SEE it afterwards (dup global, dup in the caller's own scope, or an UNSCOPED
        // caller — engine.ts narrows nothing for one, so it reads every scope), and
        // supersedes obeys resolveSupersedes()'s audience-superset rule above. A same-scope
        // refusal is unchanged and still teaches all three.
        const editStaysVisible = callerScope === null || dup.scope === null || dup.scope === callerScope;
        const canSupersede = callerScope === null || dup.scope === callerScope;
        throw new DuplicateMemoryError(
          [
            `memory "${label}" (${dup.id}, by ${dup.author}) already covers this${scopeHint}.`,
            editStaysVisible
              ? `If it is still right, update THAT record with memory_edit instead of adding a second copy.`
              : null,
            canSupersede
              ? `If the FACT CHANGED, re-send with supersedes: "${dup.id}" — the new note is filed and ` +
                `the old one is marked superseded, kept and demoted, not deleted.`
              : null,
            `If this really is a distinct note, re-send with allowDuplicate: true.`,
          ].filter((s): s is string => s !== null).join(" "),
          dup.id,
        );
      }
    }
    const now = Date.now();
    const record = MemoryRecordSchema.parse({
      id: randomUUID(), author: input.author, text: input.text,
      title: normalizeTitle(input.title), folder: normalizeFolder(input.folder),
      scope: normalizeScope(input.scope),
      tags: input.tags ?? [], kind: input.kind ?? "note",
      treeId: input.treeId ?? null, taskId: input.taskId ?? null,
      supersedes: supersedeTarget?.id ?? null,
      createdAt: now, updatedAt: now,
    });
    this.records.set(record.id, record);
    if (supersedeTarget) {
      // F35: the back-pointer, denormalized so demoteSuperseded() and get() can read obsolescence
      // off the record in hand instead of scanning the corpus for a successor that names it.
      // Written IN PLACE (Map.set on an existing key preserves position), NOT delete+re-set the
      // way edit() does above — being superseded must not buy a record a prune reprieve.
      // updatedAt is NOT bumped either: it drives the no-query newest-first order and the
      // title-collision tie-break (memory-links.ts), so bumping it would float superseded
      // records to the TOP of a listing — the exact opposite of demoting them. Text and title are
      // unchanged, so neither links.set() nor index.enqueue() has anything to redo.
      this.records.set(supersedeTarget.id, MemoryRecordSchema.parse({ ...supersedeTarget, supersededBy: record.id }));
    }
    this.links.set(record);
    this.index?.enqueue(toIndexable(record));   // MEM-4: register for (lazy) embedding
    this.save(true);
    this.events?.append({ agentId: `memory:${record.id}`, kind: "memory_added",
      data: { id: record.id, kind: record.kind, tags: record.tags, author: record.author } });
    return record;
  }

  // D11: `editor`, when given, re-stamps `author` to the caller so the record reflects
  // who last touched it (mirrors memory_add's CHIMERA_AGENT_ID stamp). Absent → the
  // original author is preserved, e.g. a store-level call with no known caller identity.
  edit(id: string, patch: MemoryEditInput, editor?: string): MemoryRecord {
    const existing = this.records.get(id);
    if (!existing) throw new UnknownMemoryError(`unknown memory ${id}`);
    // F36: the pin cap, checked on the TRANSITION into pinned only (re-pinning an already-pinned
    // record, or unpinning, is always allowed). Scope-keyed (F34) so one project cannot spend
    // another's budget; O(n) over the record map on a rare write.
    if (patch.pinned === true && !existing.pinned) {
      let pins = 0;
      for (const r of this.records.values()) if (r.pinned && r.scope === existing.scope) pins++;
      if (pins >= MAX_PINS_PER_SCOPE)
        throw new PinCapError(
          `scope "${existing.scope ?? "global"}" already has ${pins} pinned notes (cap ${MAX_PINS_PER_SCOPE}) — ` +
          `unpin one with memory_edit {pinned:false} before pinning another.`);
    }
    const record = MemoryRecordSchema.parse({
      ...existing,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      // undefined = leave untouched; explicit null = clear (normalizeTitle/Folder(null) ⇒ null).
      ...(patch.title !== undefined ? { title: normalizeTitle(patch.title) } : {}),
      ...(patch.folder !== undefined ? { folder: normalizeFolder(patch.folder) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(editor !== undefined ? { author: editor } : {}),
      updatedAt: Date.now(),
    });
    // Touch: delete+re-set moves the record to the tail of insertion order so a recently
    // edited note survives prune eviction longer than untouched older records.
    this.records.delete(id);
    this.records.set(id, record);
    this.links.set(record);   // MEM-1: re-index — edited text may have changed its [[links]]
    this.index?.enqueue(toIndexable(record));   // MEM-4: re-embed if the embed input changed
    this.save();
    // D11: unlike add() (memory_added-only, see class comment), update/delete emit a full
    // `status` event — comparatively rare, and UIs need them to refresh from events instead of
    // polling.
    this.events?.append({ agentId: `memory:${id}`, kind: "status", data: { id, state: "updated", author: record.author } });
    return record;
  }

  // F35 (QA): a record leaves the store two ways — delete() and prune()'s eviction — and BOTH must
  // repair the chain it was a link in. `supersededBy` is not decoration: demoteSuperseded()
  // rank-shifts on it, so a target whose successor is gone would otherwise sit at the bottom of
  // every search forever while get() shows no backlink explaining why (supersessionTip() ends the
  // walk on the dead pointer and emits nothing).
  //
  // F35-F (QA): the repair is a SPLICE, not a clear. Removing B from A→B→C must leave A superseded
  // by C — C is the live current version of that fact, so clearing A's back-pointer would present
  // a stale record as current and leave C.supersedes dangling at a dead id. Only a removal with no
  // live successor hands the fact back to the target. Both sides written IN PLACE with no updatedAt
  // bump — same reason as the forward stamp in add(): updatedAt drives the no-query newest-first
  // order, so touching it here would float the repaired records to the top of every listing.
  private spliceOutOfChain(rec: MemoryRecord): void {
    if (rec.supersedes === null) return;
    const target = this.records.get(rec.supersedes);
    if (!target || target.supersededBy !== rec.id) return;
    const heir = rec.supersededBy !== null ? this.records.get(rec.supersededBy) ?? null : null;
    // A hand-edited cycle (A→B→A) would otherwise make A supersede itself, which supersessionTip()
    // survives but no reader can make sense of; treat it as "no successor" and hand the fact back.
    const next = heir && heir.id !== target.id ? heir : null;
    this.records.set(target.id, MemoryRecordSchema.parse({ ...target, supersededBy: next?.id ?? null }));
    if (next) this.records.set(next.id, MemoryRecordSchema.parse({ ...next, supersedes: target.id }));
  }

  // Idempotent: deleting an already-gone id returns false, not an error — the SAME
  // shared-pool visibility promise as edit()/add(): the deletion is live in `records`
  // (and thus absent from the very next search()) before this returns.
  delete(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    // F35: deleting a SUCCESSOR splices it out of its chain — its target inherits whatever
    // superseded it, or becomes current again when nothing did. Without this the back-pointer
    // dangles and that record stays demoted forever with nothing left to point a reader at.
    // (The reverse — deleting the OLDEST record of a chain — needs no repair: the successor's
    // `supersedes` becomes a dangling id, which is exactly the "missing" link semantics
    // memory-links.ts already defines for evicted debris.)
    this.spliceOutOfChain(rec);
    this.links.remove(id);
    this.index?.drop(id);   // MEM-4: drop the deleted record's vector
    this.save();
    this.events?.append({ agentId: `memory:${id}`, kind: "status", data: { id, state: "deleted" } });
    return true;
  }

  // Structured filters first (tags AND-match, author, kind, treeId, folder prefix), then reverse to
  // insertion-tail order so every downstream sort tie-breaks by most-recently-touched. Shared by the
  // sync lexical `search()` and the async `searchHybrid()`.
  private narrow(filters: MemorySearchFilters): { candidates: MemoryRecord[]; query: string | undefined } {
    let candidates = [...this.records.values()];
    if (filters.tags && filters.tags.length > 0)
      candidates = candidates.filter((r) => filters.tags!.every((t) => r.tags.includes(t)));
    if (filters.author !== undefined) candidates = candidates.filter((r) => r.author === filters.author);
    if (filters.kind !== undefined) candidates = candidates.filter((r) => r.kind === filters.kind);
    if (filters.treeId !== undefined) candidates = candidates.filter((r) => r.treeId === filters.treeId);
    // MEM-1 (§2): folder is a case-insensitive PREFIX filter — "ops" matches "ops" and any
    // "ops/…" descendant, but not "opsec". Normalized so "ops/" / "/ops" behave like "ops".
    const folder = normalizeFolder(filters.folder);
    if (folder !== null) {
      const f = folder.toLowerCase();
      candidates = candidates.filter((r) => {
        if (r.folder === null) return false;
        const rf = r.folder.toLowerCase();
        return rf === f || rf.startsWith(f + "/");
      });
    }
    // F34: scope narrowing — a pre-ranking candidate filter, exactly like the folder filter above.
    // It is not a ranking signal and not an access boundary. Three states, and the store never
    // guesses: undefined ⇒ no narrowing (the app/TUI path, and byte-identical to pre-F34);
    // SCOPE_ALL ⇒ the explicit escape, also no narrowing (normalizeScope folds it to null);
    // anything else ⇒ that scope PLUS global (r.scope === null), never that scope alone.
    const scope = normalizeScope(filters.scope);
    if (scope !== null) {
      const s = scope.toLowerCase();
      candidates = candidates.filter((r) => r.scope === null || r.scope.toLowerCase() === s);
    }
    // F34-SCOPE-FILTER: exact-membership narrowing, applied on top of the widen filter above so
    // "project" mode with a `scope` name is just "the widened set, minus the global members".
    if (filters.scopeMode === "global") {
      candidates = candidates.filter((r) => r.scope === null);
    } else if (filters.scopeMode === "project") {
      const s = scope?.toLowerCase();
      candidates = candidates.filter((r) => r.scope !== null && (s === undefined || r.scope.toLowerCase() === s));
    }
    // Reverse insertion order up front so BOTH paths' stable sort tie-breaks by
    // most-recently-touched (edit and add both move a record to the map tail). This keeps
    // ordering consistent whether there's no query, an all-punctuation query that tokenizes
    // to nothing, or genuine score ties — independent of sub-millisecond timestamps.
    candidates.reverse();
    return { candidates, query: filters.query?.trim() || undefined };
  }

  // BM25-lite (or newest-first when no query) — the lexical baseline every mode falls back to.
  private rankLexical(candidates: MemoryRecord[], query: string | undefined): ScoredRecord[] {
    if (query) {
      this.ranker.prepare?.(candidates);
      return candidates
        .map((record) => ({ record, score: this.ranker.score(query, record) }))
        .sort((a, b) => b.score - a.score);
    }
    return candidates
      .sort((a, b) => b.updatedAt - a.updatedAt)   // no query → newest-edited first
      .map((record) => ({ record, score: 0 }));
  }

  // F35: the ONE place a ranked list becomes a returned result. Demotion happens here and nowhere
  // else — after every ranker, before the limit — so lexical, semantic, hybrid and the no-query
  // path cannot disagree, and a future ranker cannot forget to apply it.
  private finish(hits: ScoredRecord[], limit: number): ScoredRecord[] {
    return demoteSuperseded(hits).slice(0, limit);
  }

  // Sync lexical search — the original contract, unchanged (used directly by tests/internal callers).
  // The RPC path goes through searchHybrid, which is byte-identical to this when there is no query
  // or mode is lexical. Since F33 "no vector index is live" is NO LONGER sufficient: the entity
  // order fires without an index, and hybrid degrades to this only when there is neither cosine
  // nor entity evidence.
  search(filters: MemorySearchFilters): ScoredRecord[] {
    const limit = Math.max(0, filters.limit ?? 20);   // guard: slice(0, -n) would silently drop the tail
    const { candidates, query } = this.narrow(filters);
    return this.finish(this.rankLexical(candidates, query), limit);
  }

  // MEM-4 (§6.3), F33: mode-aware search. `hybrid` (default) fuses the BM25 order with the cosine
  // order and the entity-overlap order (F33) of the SAME filtered candidates via RRF (k=60) —
  // three orders; `semantic` ranks by cosine, appending unembedded records (lexically ordered) so
  // nothing is dropped; `lexical` is the sync path above. When there is no query or mode is
  // lexical, this DEGRADES to lexical — byte-identical to search(). With no query embedding is
  // awaited (fast, warm); the corpus backfill runs in the background and never blocks a search.
  // The entity order fires even with no vector index live (the default under VITEST / embedder
  // "off"), so hybrid mode is never inert in the most common deployment shape.
  async searchHybrid(filters: MemorySearchFilters): Promise<ScoredRecord[]> {
    const limit = Math.max(0, filters.limit ?? 20);
    const { candidates, query } = this.narrow(filters);
    const mode: MemorySearchMode = filters.mode ?? "hybrid";
    const lexical = this.rankLexical(candidates, query);
    if (!query || mode === "lexical") return this.finish(lexical, limit);

    const cosineOrder = this.index ? await this.index.queryOrder(query, candidates.map((r) => r.id)) : null;
    const entityOrder = mode === "hybrid" ? this.entities.order(query, candidates) : [];
    // Byte-identical-to-search() guard: with neither cosine nor entity evidence, return the BM25
    // ScoredRecords untouched — RRF magnitudes must not replace BM25 magnitudes in the UI for a
    // query that gained no new signal.
    if (!cosineOrder?.length && entityOrder.length === 0) return this.finish(lexical, limit);

    const byId = new Map(candidates.map((r) => [r.id, r] as const));
    // Full lexical order (all candidates, newest-first among score ties) — the deterministic tie-break
    // and the source of the "no-evidence" tail. `lexicalHits` is only the records with a POSITIVE BM25
    // score: when a query matches nothing lexically, the zero-score order is just newest-first noise
    // that must NOT be fed into RRF (it would drown a perfect semantic match). cosineOrder is already
    // positive-similarity-only (queryOrder drops orthogonal/unembedded records).
    const fullOrder = lexical.map((s) => s.record.id);
    const fullRank = new Map(fullOrder.map((id, i) => [id, i] as const));
    const lexicalHits = lexical.filter((s) => s.score > 0).map((s) => s.record.id);

    if (mode === "semantic") {
      // Cosine-primary: similarity hits first, then everything else (unembedded / dissimilar) in the
      // lexical order — a semantic query never silently hides a note that just isn't embedded yet.
      // Guarded above: mode==="semantic" reaches here only when cosineOrder is non-empty (entityOrder
      // is always [] in this mode, so the "neither" guard could only have triggered on cosineOrder).
      const inCosine = new Set(cosineOrder!);
      const order = [...cosineOrder!, ...fullOrder.filter((id) => !inCosine.has(id))];
      return this.finish(order.map((id, i) => ({ record: byId.get(id)!, score: 1 / (i + 1) })), limit);
    }

    // hybrid: RRF of the lexical-hit order, the cosine order, and the entity order (F33) — up to
    // three meaningful rankings. Records with NO evidence in any of them are appended as a
    // newest-first tail so nothing is ever dropped, but they can't outrank a real match.
    // Deterministic tie-break by lexical position.
    const orders = [
      lexicalHits,
      ...(cosineOrder?.length ? [cosineOrder] : []),
      ...(entityOrder.length ? [entityOrder] : []),
    ];
    const fused = rrfFuse(orders);
    const fusedRanked = [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (fullRank.get(a[0])! - fullRank.get(b[0])!))
      .map(([id]) => id);
    const inFused = new Set(fused.keys());
    const tail = fullOrder.filter((id) => !inFused.has(id));   // zero-evidence records, newest-first
    return this.finish(
      [...fusedRanked, ...tail].map((id) => ({ record: byId.get(id)!, score: fused.get(id) ?? 0 })),
      limit,
    );
  }

  // MEM-4: memory.index status/rebuild surface. Both resolve the embedder (lazily) so the reported
  // state is real. With no index configured, a synthetic "off" status keeps the RPC total-correct.
  async indexStatus(): Promise<MemoryIndexResult> {
    if (!this.index) return this.offIndexStatus();
    await this.index.ensureProvider();
    return this.index.status(this.records.size);
  }
  async rebuildIndex(): Promise<MemoryIndexResult> {
    if (!this.index) return this.offIndexStatus();
    await this.index.rebuild([...this.records.values()].map(toIndexable));
    return this.index.status(this.records.size);
  }
  private offIndexStatus(): MemoryIndexResult {
    return { state: "off", provider: null, model: null, dim: 0, embedded: 0, total: this.records.size, pending: 0, degraded: true, error: null };
  }

  // MEM-1 (§3): one record plus its resolved outbound links and inbound backlinks. Resolution
  // is lazy (computed here against the current records), so a dangling [[Title]] self-heals the
  // moment a note with that title appears — no stored link state to invalidate. Unknown id
  // throws (protocol-coded), matching edit()'s contract.
  get(id: string): MemoryGetResult {
    const record = this.records.get(id);
    if (!record) throw new UnknownMemoryError(`unknown memory ${id}`);
    const backlinks = this.links.backlinks(id, this.records.values());
    // F35: supersession is a FIELD, not [[text]], so MemoryLinkIndex cannot see it — but "what
    // replaced this?" is the same question a backlink answers, and this is the list an agent
    // already reads. Points at the CHAIN TIP, not the next hop: reading a stale note must land on
    // the current fact in one step (the immediate successor is still on record.supersededBy).
    const tip = this.supersessionTip(record);
    if (tip) backlinks.push({
      id: tip.id, title: tip.title, kind: tip.kind, folder: tip.folder,
      snippet: `superseded by this note: ${firstLineExcerpt(tip.text, SUPERSEDED_SNIPPET_MAX)}`,
    });
    return {
      record,
      links: this.links.resolveLinks(record, this.records.values()),
      backlinks,
    };
  }

  // MEM-1 (§4): totals powering the folder-rail counts and the "N of M" fix (total was
  // previously read from a limit:100 search, so it saturated at 100). byFolder counts records
  // DIRECTLY in each exact path (null ⇒ unfiled); the client rolls up the hierarchy.
  stats(): MemoryStatsResult {
    const byKind: Record<string, number> = {};
    const folderCounts = new Map<string | null, number>();
    const scopeCounts = new Map<string | null, number>();
    const tagCounts = new Map<string, number>();
    for (const r of this.records.values()) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      folderCounts.set(r.folder, (folderCounts.get(r.folder) ?? 0) + 1);
      scopeCounts.set(r.scope, (scopeCounts.get(r.scope) ?? 0) + 1);
      for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const byFolder = [...folderCounts.entries()]
      .map(([folder, count]) => ({ folder, count }))
      // null (unfiled) first, then folders alphabetically — a stable, deterministic order.
      .sort((a, b) =>
        a.folder === null ? -1 : b.folder === null ? 1 : a.folder.localeCompare(b.folder));
    // F34: built exactly like byFolder — null (global, i.e. every pre-F34 record) first, then
    // scopes alphabetically. The only observable proof that stamping is happening at all.
    const byScope = [...scopeCounts.entries()]
      .map(([scope, count]) => ({ scope, count }))
      .sort((a, b) =>
        a.scope === null ? -1 : b.scope === null ? 1 : a.scope.localeCompare(b.scope));
    const topTags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, MAX_TOP_TAGS);
    // F36: the operator's pre-loss view, built from the SAME evictionOrder() prune() uses (one
    // resolveAll). This is an app-only RPC called on Memory-tab entry and refresh — not the write path.
    const order = this.evictionOrder();
    let pinned = 0;
    for (const r of this.records.values()) if (r.pinned) pinned++;
    const fill = this.records.size / this.maxRecords;
    const capacity = {
      limit: this.maxRecords, total: this.records.size, fill,
      alarmAt: this.alarmAt, alarming: this.alarmAt > 0 && fill >= this.alarmAt,
      pinned,
      nextToEvict: order.slice(0, 5).map(({ record, value, inbound }) => ({
        id: record.id, title: record.title, kind: record.kind, value, inbound, pinned: record.pinned })),
    };
    return { total: this.records.size, byKind, byFolder, byScope, topTags, capacity };
  }

  // MEM-2 (§4): the note graph for the app's force-directed view. Nodes = records passing the
  // filters (folder prefix / kind / tags AND-match — mirrors search narrowing) PLUS ghost nodes
  // for dangling [[Title]] links reached from included records. Edges: one per resolved [[link]]
  // whose target is ALSO included (self-loops skipped; a target filtered out drops the edge — a
  // clean subgraph), plus link edges to ghost targets. Missing id-links (evicted/deleted debris)
  // are excluded entirely (no node, no edge). Duplicate mentions of the same target from one
  // source collapse to a single edge whose weight is the mention count.
  //
  // Resolution runs against the FULL record set (so id-prefix/title targets resolve even to
  // excluded notes — we then decide inclusion), using resolveAll's single shared ctx to stay
  // O(total-links) rather than O(n²). semanticEdges (MEM-7, §4) adds top-3-neighbor cosine pairs
  // among the included REAL records (ghosts have no embedding) — only once the vector index has
  // fully caught up (a partially-embedded corpus would show a lopsided, misleading subset); it
  // never errors when the index is absent, cold, or still building.
  graph(params: MemoryGraphParams): MemoryGraphResult {
    const folder = normalizeFolder(params.folder);
    const f = folder?.toLowerCase() ?? null;
    const passesFilter = (r: MemoryRecord): boolean => {
      if (params.kind !== undefined && r.kind !== params.kind) return false;
      if (params.tags && params.tags.length > 0 && !params.tags.every((t) => r.tags.includes(t))) return false;
      if (f !== null) {
        if (r.folder === null) return false;
        const rf = r.folder.toLowerCase();
        if (rf !== f && !rf.startsWith(f + "/")) return false;
      }
      return true;
    };

    const included = new Map<string, MemoryRecord>();
    for (const r of this.records.values()) if (passesFilter(r)) included.set(r.id, r);

    const resolved = this.links.resolveAll(this.records.values());

    // Accumulate link edges keyed by source\0target (the escape, not a literal NUL byte — a raw NUL made grep treat this file as binary) so duplicate mentions bump weight. Ghost
    // nodes are collected lazily as their edges appear.
    const edgeAcc = new Map<string, MemoryGraphEdge>();
    const ghostNodes = new Map<string, MemoryGraphNode>();
    for (const src of included.values()) {
      const links = resolved.get(src.id);
      if (!links) continue;
      for (const l of links) {
        let target: string | null = null;
        if (l.resolvedId !== null) {
          // Resolved to a live record — only an edge if that record is in the included set and
          // it isn't a self-link (a note linking to itself adds no graph structure).
          if (l.resolvedId === src.id || !included.has(l.resolvedId)) continue;
          target = l.resolvedId;
        } else if (l.resolvedTitle !== null) {
          // Ghost (a [[Title]] with no note yet). Dedup by lowercased title into one ghost node.
          const gid = "ghost:" + l.resolvedTitle.toLowerCase();
          if (!ghostNodes.has(gid))
            ghostNodes.set(gid, {
              id: gid, title: l.resolvedTitle, label: l.resolvedTitle,
              kind: null, folder: null, tags: [], degree: 0, updatedAt: null, ghost: true,
            });
          target = gid;
        } else {
          continue;   // missing id-link (both null) — debris, excluded
        }
        const key = src.id + "\0" + target;
        const existing = edgeAcc.get(key);
        if (existing) existing.weight += 1;
        else edgeAcc.set(key, { source: src.id, target, kind: "link", weight: 1 });
      }
    }

    const edges = [...edgeAcc.values()];

    // MEM-7 (§4): similarity edges, gated on the index being fully caught up (status().state ===
    // "ready" — the same synchronous check the index.status()/memory.index RPC uses, so this never
    // triggers a provider probe of its own). Ghost nodes are excluded from the candidate set (no id
    // in `this.index`'s vectors, so neighborPairs would just skip them anyway).
    if (params.semanticEdges && this.index) {
      const status = this.index.status(this.records.size);
      if (status.state === "ready") {
        for (const { a, b, score } of this.index.neighborPairs([...included.keys()]))
          edges.push({ source: a, target: b, kind: "semantic", weight: score });
      }
    }

    // Degree = number of incident included edges (ghosts included). Computed after all edges exist.
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const nodes: MemoryGraphNode[] = [];
    for (const r of included.values())
      nodes.push({
        id: r.id, title: r.title, label: r.title ?? firstLineExcerpt(r.text),
        kind: r.kind, folder: r.folder, tags: r.tags,
        degree: degree.get(r.id) ?? 0, updatedAt: r.updatedAt,
      });
    for (const g of ghostNodes.values()) nodes.push({ ...g, degree: degree.get(g.id) ?? 0 });

    return { nodes, edges };
  }
}
