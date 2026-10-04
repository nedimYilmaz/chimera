import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  StepJournalRowSchema, type StepJournalRow, type StepJournalEntry, type TaskRecord, type UsageScope,
} from "@chimera/protocol";

// F11 (durable step journal): append-only `${home}/journal/journal.jsonl`, two rows per step
// attempt (phase "open"/"close"), monthly rotation with rename-to-seal — the same discipline
// UsageLedger uses, deliberately ported rather than abstracted (one file, one shape, zero
// coupling between cost accounting and step history).
//
// WHY a separate file family at all: QueueStore.prune() evicts terminal tasks past
// MAX_TERMINAL_PER_QUEUE=200 and takes their whole stepHistory with them. This store is NOT a
// second source of truth for a LIVE task (stepHistory stays that) — it is the record that
// survives the prune. prune() is deliberately left untouched.
//
// Failure policy: journal writes are observability, never coordination. Every append is
// wrapped so a full disk or a bad row can never propagate into a queue mutation, and every
// read skips torn/corrupt lines instead of throwing.

const ACTIVE_FILE = "journal.jsonl";
const SEALED_FILE_RE = /^journal\.\d{4}-\d{2}\.jsonl$/;

// Retention is enforced ONLY at rotation and NEVER on the active segment: a daemon that runs
// for a year inside one month must not lose the month it is still writing, whatever its size.
const JOURNAL_RETAIN_MONTHS = 12;
const JOURNAL_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const QUERY_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const QUERY_DEFAULT_LIMIT = 50;
const QUERY_MAX_LIMIT = 500;

function pad2(n: number): string { return String(n).padStart(2, "0"); }

// The largest/smallest ms `new Date()` accepts before it goes Invalid (ECMA-262 20.4.1.1).
const MAX_DATE_MS = 8_640_000_000_000_000;

// LOCAL calendar month key — never toISOString (UTC), so rotation lines up with the operator's
// own calendar exactly like UsageLedger's. Clamped: callers legitimately pass sentinel bounds
// like `to: Number.MAX_SAFE_INTEGER` for "no upper limit" (it exceeds MAX_DATE_MS and would
// otherwise produce an Invalid Date, NaN month index, and an empty segment list).
function monthKey(ms: number): string {
  const clamped = Math.min(Math.max(ms, -MAX_DATE_MS), MAX_DATE_MS);
  const d = new Date(clamped);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function monthIndex(key: string): number {
  const [y, m] = key.split("-");
  return Number(y) * 12 + Number(m) - 1;
}

// F11 §2.5: the ONLY thing about a step's input that is ever persisted. One-way and truncated
// to 32 hex chars — enough to tell "same input, re-run" from "different input" without the
// journal ever becoming a place prompt text can leak from.
export function stepInputDigest(model: string | null | undefined, instructions: string | null | undefined, prompt: string | null | undefined): string {
  const hex = createHash("sha256").update(`${model ?? ""}\n${instructions ?? ""}\n${prompt ?? ""}`).digest("hex");
  return `sha256:${hex.slice(0, 32)}`;
}

// The agent-side context a row needs, resolved at write time against the live AgentRecord —
// the same "look up the live record" correlation UsageLedger does. costUsd/usage are the
// record's CUMULATIVE counters; this store stores them raw and subtracts on read.
export type StepAgentSnapshot = {
  model: string | null;
  account: string | null;
  provider: string | null;
  team: string | null;
  costUsd: number | null;
  usage: UsageScope | null;
  inputDigest: string | null;
};
export type ResolveStepAgent = (agentId: string) => StepAgentSnapshot | null;

export type StepJournalQuery = {
  from?: number;
  to?: number;
  taskId?: string;
  queue?: string;
  agentId?: string;
  team?: string;
  stepId?: string;
  // "open" is not a stored outcome — it selects entries that never got a close row.
  outcome?: "passed" | "failed" | "retried" | "open";
  cursor?: string | null;
  limit?: number;
};

// F11.QA item 2: the RPC-reachable filter set. Kept as a runtime array (not just the
// StepJournalQuery type) so a test can diff it against JournalQueryRequestSchema's own keys —
// `team` was in the type and filtered by query() but absent from the .strict() RPC schema for a
// whole review cycle before anyone noticed passing it was a hard validation error.
export const STEP_JOURNAL_QUERY_FILTER_KEYS = [
  "from", "to", "taskId", "queue", "agentId", "team", "stepId", "outcome", "cursor", "limit",
] as const;

export type StepJournalQueryResult = {
  entries: StepJournalEntry[];
  nextCursor: string | null;
  matched: number;
};

export class StepJournal {
  private readonly dir: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly resolveAgent: ResolveStepAgent;
  // Test seams only: retention is otherwise unobservable, since the real thresholds are a year
  // of wall-clock and a quarter-gigabyte of disk. Absent ⇒ byte-identical production behaviour.
  private readonly retainMonths: number;
  private readonly maxTotalBytes: number;
  private month: string;

  constructor(
    home: string,
    opts: { resolveAgent: ResolveStepAgent; now?: () => number; retainMonths?: number; maxTotalBytes?: number },
  ) {
    this.now = opts.now ?? Date.now;
    this.resolveAgent = opts.resolveAgent;
    this.retainMonths = opts.retainMonths ?? JOURNAL_RETAIN_MONTHS;
    this.maxTotalBytes = opts.maxTotalBytes ?? JOURNAL_MAX_TOTAL_BYTES;
    this.dir = join(home, "journal");
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, ACTIVE_FILE);
    this.month = this.deriveActiveMonth();
  }

  // The active file may already hold rows from a month that ended while the daemon was down
  // (rotation only runs on the next append) — derive the tracked month from the file's own
  // first row rather than assuming "now", so a late append rotates correctly. Reads only the
  // first line's worth of the file's text, never folds it.
  private deriveActiveMonth(): string {
    if (existsSync(this.file)) {
      try {
        const firstLine = readFileSync(this.file, "utf8").split("\n").find((l) => l.length > 0);
        if (firstLine) {
          const row = JSON.parse(firstLine) as { ts?: unknown };
          if (typeof row.ts === "number") return monthKey(row.ts);
        }
      } catch { /* unreadable/corrupt first line → fall back to the current month */ }
    }
    return monthKey(this.now());
  }

  private entryIdFor(taskId: string, stepIndex: number, startedAt: number): string {
    return `${taskId}:${stepIndex}:${startedAt}`;
  }

  private appendRow(row: StepJournalRow): void {
    try {
      const parsed = StepJournalRowSchema.safeParse(row);
      if (!parsed.success) return;
      this.rotateIfNeeded();
      appendFileSync(this.file, `${JSON.stringify(parsed.data)}\n`);
    } catch (err) {
      // A journal write must NEVER propagate into the queue mutation that triggered it.
      console.warn(`[step-journal] append failed: ${String(err)}`);
    }
  }

  private rotateIfNeeded(): void {
    const current = monthKey(this.now());
    if (current === this.month) return;
    if (existsSync(this.file)) {
      const sealedPath = join(this.dir, `journal.${this.month}.jsonl`);
      // A clock stepping BACKWARDS across a month boundary (NTP correction, restored store) can
      // revisit a month that already has a sealed segment. A plain renameSync would silently
      // clobber it — append the live bytes onto the existing seal instead, so no row is ever lost.
      if (existsSync(sealedPath)) {
        appendFileSync(sealedPath, readFileSync(this.file));
        rmSync(this.file);
      } else {
        renameSync(this.file, sealedPath);
      }
    }
    this.month = current;
    this.enforceRetention();
  }

  private sealedFiles(): { name: string; month: string; path: string }[] {
    const names = existsSync(this.dir) ? readdirSync(this.dir) : [];
    return names
      .filter((n) => SEALED_FILE_RE.test(n))
      .map((n) => ({ name: n, month: n.slice("journal.".length, -".jsonl".length), path: join(this.dir, n) }))
      .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
  }

  // Runs only from rotateIfNeeded — the active segment is never a deletion candidate at any
  // size, so "the month I am writing" can never vanish under an operator mid-investigation.
  private enforceRetention(): void {
    const cutoff = monthIndex(this.month) - this.retainMonths;
    let sealed = this.sealedFiles();
    for (const seg of sealed) {
      if (monthIndex(seg.month) < cutoff) {
        try { rmSync(seg.path); } catch { /* already gone / unlinkable — retention is best-effort */ }
      }
    }
    sealed = this.sealedFiles();
    const sizeOf = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
    let total = sealed.reduce((n, s) => n + sizeOf(s.path), 0) + sizeOf(this.file);
    for (const seg of sealed) {
      if (total <= this.maxTotalBytes) break;
      const size = sizeOf(seg.path);
      try { rmSync(seg.path); total -= size; } catch { /* best-effort */ }
    }
  }

  private snapshot(agentId: string | null): StepAgentSnapshot | null {
    if (!agentId) return null;
    try { return this.resolveAgent(agentId); } catch { return null; }
  }

  // The startedAt an entryId is built from MUST be the stepHistory entry's own stamp, not a
  // fresh now(): startStep() stamps with Date.now() and this is called separately, so a single
  // millisecond tick between them would orphan the open row from its close row forever.
  private danglingStartedAt(t: TaskRecord): number | null {
    const entry = t.stepHistory[t.stepHistory.length - 1];
    return entry && entry.endedAt === null ? entry.startedAt : null;
  }

  // Call AFTER QueueStore.startStep has pushed the stepHistory entry (that entry supplies the
  // shared startedAt). Falls back to now() only when there is no open entry to read.
  open(t: TaskRecord, stepIndex: number, stepId: string, agentId: string | null): void {
    const startedAt = this.danglingStartedAt(t) ?? this.now();
    const snap = this.snapshot(agentId);
    this.appendRow({
      entryId: this.entryIdFor(t.taskId, stepIndex, startedAt),
      ts: this.now(),
      phase: "open",
      source: "live",
      taskId: t.taskId,
      queue: t.queue,
      stepIndex,
      stepId,
      attempt: t.stepAttempts ?? 0,
      agentId,
      model: snap?.model ?? null,
      account: snap?.account ?? null,
      provider: snap?.provider ?? null,
      team: snap?.team ?? null,
      inputDigest: snap?.inputDigest ?? null,
      startedAt,
      endedAt: null,
      outcome: null,
      reason: null,
      costUsdCumulative: snap?.costUsd ?? null,
      usageCumulative: snap?.usage ?? null,
    });
  }

  // Call BEFORE QueueStore.closeStep stamps endedAt — the pairing key is the still-open
  // stepHistory entry, exactly the one closeDanglingStep is about to close. No open entry
  // means there is nothing to pair with, so nothing is written (a close row alone would be a
  // step attempt this store never saw start).
  close(t: TaskRecord, outcome: "passed" | "failed" | "retried", reason?: string): void {
    const entry = t.stepHistory[t.stepHistory.length - 1];
    if (!entry || entry.endedAt !== null) return;
    const snap = this.snapshot(entry.agentId);
    const ts = this.now();
    this.appendRow({
      entryId: this.entryIdFor(t.taskId, entry.stepIndex, entry.startedAt),
      ts,
      phase: "close",
      source: "live",
      taskId: t.taskId,
      queue: t.queue,
      stepIndex: entry.stepIndex,
      stepId: entry.stepId,
      attempt: t.stepAttempts ?? 0,
      agentId: entry.agentId,
      model: snap?.model ?? null,
      account: snap?.account ?? null,
      provider: snap?.provider ?? null,
      team: snap?.team ?? null,
      inputDigest: snap?.inputDigest ?? null,
      startedAt: entry.startedAt,
      endedAt: ts,
      outcome,
      reason: reason === undefined ? null : reason.slice(0, 500),
      costUsdCumulative: snap?.costUsd ?? null,
      usageCumulative: snap?.usage ?? null,
    });
  }

  private listFiles(): string[] {
    const names = existsSync(this.dir) ? readdirSync(this.dir) : [];
    return names.filter((n) => n === ACTIVE_FILE || SEALED_FILE_RE.test(n)).map((n) => join(this.dir, n));
  }

  // Segment-level filtering by month key, NOT by row ts: an open row and its close row can
  // straddle a month boundary, so a window applied within a kept segment would fold a
  // half-pair. `monthIndex(from) - 1` is the load-bearing lower bound — a pair can straddle at
  // most ONE boundary, so the immediately preceding month is always sufficient to reunite it.
  // Final row-level filtering is done on the FOLDED entry's startedAt in query().
  private segmentsInRange(from: number, to: number): string[] {
    const lo = monthIndex(monthKey(from)) - 1;
    const hi = monthIndex(monthKey(to));
    const names = existsSync(this.dir) ? readdirSync(this.dir) : [];
    const out: string[] = [];
    for (const n of names) {
      if (n === ACTIVE_FILE) {
        // The active file's month is tracked in `this.month` (derived at construction / kept in
        // sync by rotateIfNeeded), so no read is needed to bound it.
        if (monthIndex(this.month) >= lo && monthIndex(this.month) <= hi) out.push(join(this.dir, n));
        continue;
      }
      if (!SEALED_FILE_RE.test(n)) continue;
      const idx = monthIndex(n.slice("journal.".length, -".jsonl".length));
      if (idx >= lo && idx <= hi) out.push(join(this.dir, n));
    }
    return out;
  }

  private readRows(from: number, to: number): StepJournalRow[] {
    const out: StepJournalRow[] = [];
    for (const file of this.segmentsInRange(from, to)) {
      let content: string;
      try { content = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of content.split("\n")) {
        if (!line) continue;
        try { out.push(StepJournalRowSchema.parse(JSON.parse(line))); } catch { /* torn/corrupt line — skip */ }
      }
    }
    return out;
  }

  private foldRows(rows: readonly StepJournalRow[]): StepJournalEntry[] {
    const groups = new Map<string, { open?: StepJournalRow; close?: StepJournalRow }>();
    for (const row of rows) {
      const g = groups.get(row.entryId) ?? {};
      // Last row of a phase wins — a duplicate open (re-journal after a partial write) is
      // resolved to the most recent counters rather than dropped.
      if (row.phase === "open") g.open = row; else g.close = row;
      groups.set(row.entryId, g);
    }
    const out: StepJournalEntry[] = [];
    for (const [entryId, g] of groups) {
      const base = g.open ?? g.close;
      if (!base) continue;
      // CLOSE WINS, and only on a non-null value. The open row is snapshotted the instant the
      // agent is spawned (scheduler.ts startStep), before the backend has reported the model it
      // actually bound and before any rate-limit failover can move the step to another account —
      // so open holds the REQUEST, close holds what the step actually ran on (plan A2:
      // `actualModel ?? spec.model`). The `?? g.open` fallback is what keeps a close row whose
      // agent was already reaped (resolveAgent → null) from erasing the identity open recorded.
      // The trailing `?? null` is load-bearing too: two undefineds yield undefined, which
      // StepJournalEntrySchema rejects and JSON.stringify drops from the RPC payload entirely.
      const pick = <K extends keyof StepJournalRow>(k: K): StepJournalRow[K] =>
        ((g.close?.[k] ?? g.open?.[k]) ?? null) as StepJournalRow[K];
      const endedAt = g.close?.endedAt ?? null;
      out.push({
        entryId,
        source: base.source,
        taskId: base.taskId,
        queue: base.queue,
        stepIndex: base.stepIndex,
        stepId: base.stepId,
        attempt: base.attempt,
        agentId: pick("agentId"),
        model: pick("model"),
        account: pick("account"),
        provider: pick("provider"),
        team: pick("team"),
        inputDigest: pick("inputDigest"),
        startedAt: base.startedAt,
        endedAt,
        durationMs: endedAt === null ? null : endedAt - base.startedAt,
        outcome: g.close?.outcome ?? null,
        reason: g.close?.reason ?? null,
        costUsd: deltaCost(g.open, g.close),
        usage: deltaUsage(g.open, g.close),
        open: !g.close,
      });
    }
    return out;
  }

  query(params: StepJournalQuery = {}): StepJournalQueryResult {
    const to = params.to ?? this.now();
    const from = params.from ?? to - QUERY_DEFAULT_WINDOW_MS;
    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? QUERY_DEFAULT_LIMIT)), QUERY_MAX_LIMIT);
    const all = this.foldRows(this.readRows(from, to)).filter((e) => {
      if (e.startedAt < from || e.startedAt >= to) return false;
      if (params.taskId && e.taskId !== params.taskId) return false;
      if (params.queue && e.queue !== params.queue) return false;
      if (params.agentId && e.agentId !== params.agentId) return false;
      if (params.team && e.team !== params.team) return false;
      if (params.stepId && e.stepId !== params.stepId) return false;
      if (params.outcome === "open") return e.open;
      if (params.outcome && e.outcome !== params.outcome) return false;
      return true;
    });
    // Newest first, entryId as the tiebreak so the order is TOTAL — cursor paging over a
    // non-total order silently drops or repeats rows that share a startedAt.
    all.sort((a, b) => b.startedAt - a.startedAt || (a.entryId < b.entryId ? 1 : a.entryId > b.entryId ? -1 : 0));
    const matched = all.length;
    let start = 0;
    if (params.cursor) {
      const idx = all.findIndex((e) => e.entryId === params.cursor);
      // An unknown cursor (its entry aged out of retention) restarts at the top rather than
      // returning nothing — a stale cursor must not look like "no results".
      start = idx >= 0 ? idx + 1 : 0;
    }
    const entries = all.slice(start, start + limit);
    const nextCursor = entries.length === limit && start + limit < matched ? entries[entries.length - 1]!.entryId : null;
    return { entries, nextCursor, matched };
  }

  // One-time seed from the stepHistory the queues file still holds, so the journal does not
  // start empty on the boot that introduces it. Guarded on "does ANY segment exist" — checked
  // at call time, not cached — so a second boot can never double-journal.
  backfillOnce(tasks: readonly TaskRecord[]): number {
    if (this.listFiles().length > 0) return 0;
    let written = 0;
    for (const t of tasks) {
      for (const entry of t.stepHistory ?? []) {
        const entryId = this.entryIdFor(t.taskId, entry.stepIndex, entry.startedAt);
        const common = {
          entryId,
          taskId: t.taskId,
          queue: t.queue,
          stepIndex: entry.stepIndex,
          stepId: entry.stepId,
          // A historical attempt's ordinal is unrecoverable — stepAttempts is a live counter,
          // not per-entry. 0 is the honest "unknown", paired with source:"backfill".
          attempt: 0,
          agentId: entry.agentId,
          model: null, account: null, provider: null, team: null, inputDigest: null,
          startedAt: entry.startedAt,
          costUsdCumulative: null, usageCumulative: null,
          source: "backfill" as const,
        };
        // ts is "when this row was appended", NOT the step's own clock — deriveActiveMonth reads
        // the first row's ts to name the active month, so a historic ts here would make the next
        // boot seal (or, past the retention cutoff, DELETE) the whole live segment under an old
        // month. startedAt/endedAt keep the historic stamps and query filters on startedAt.
        this.appendRow({ ...common, ts: this.now(), phase: "open", endedAt: null, outcome: null, reason: null });
        written++;
        if (entry.endedAt !== null) {
          this.appendRow({
            ...common, ts: this.now(), phase: "close", endedAt: entry.endedAt,
            outcome: entry.outcome, reason: entry.reason === undefined ? null : entry.reason.slice(0, 500),
          });
          written++;
        }
      }
    }
    return written;
  }
}

// Both snapshots must exist for a delta to mean anything; the max(0, …) clamp guards the one
// case that would otherwise produce a negative "cost": the record was replaced between open
// and close and its cumulative counter restarted lower.
function deltaCost(open: StepJournalRow | undefined, close: StepJournalRow | undefined): number | null {
  if (!open || !close) return null;
  if (open.costUsdCumulative === null || close.costUsdCumulative === null) return null;
  return Math.max(0, close.costUsdCumulative - open.costUsdCumulative);
}

function deltaUsage(open: StepJournalRow | undefined, close: StepJournalRow | undefined): UsageScope | null {
  if (!open || !close) return null;
  const a = open.usageCumulative, b = close.usageCumulative;
  if (!a || !b) return null;
  return {
    input: Math.max(0, b.input - a.input),
    output: Math.max(0, b.output - a.output),
    cacheRead: Math.max(0, b.cacheRead - a.cacheRead),
    cacheCreation: Math.max(0, b.cacheCreation - a.cacheCreation),
  };
}

export { JOURNAL_RETAIN_MONTHS, JOURNAL_MAX_TOTAL_BYTES };
