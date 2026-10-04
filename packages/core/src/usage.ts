import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  UsageRowSchema, type UsageRow, type UsageGroupBy, type UsageQueryParams, type UsageQueryResult,
} from "@chimera/protocol";
import type { EventLog } from "./events.js";
import type { NormalizedEvent } from "@chimera/protocol";
import { usageFromRaw } from "./budget.js";

// D15 (usage ledger, coverage §C17, F19): append-only usage.jsonl, one row per `result`
// event, with monthly rotation. This is the SINGLE source of truth for cost/token
// accounting — daemon.status's spendTodayUsd re-reads from it (see Engine wiring) so the
// SpendChip and the usage.query response can never drift apart.
//
// Persistence: `${home}/usage/usage.jsonl` (active file) + sealed prior months renamed
// to `usage.<YYYY-MM>.jsonl` on the first append after a month rollover (mirrors
// EventLog's rename-to-seal discipline). Corrupt/torn lines are skipped on read, never
// thrown — usage is observability data, not coordination state (same tolerance as
// SpendLedger/ArtifactStore).
//
// Context (team/job/account/model) isn't on the `result` event itself, so a row is
// assembled by correlating the event's agentId against the live AgentSupervisor record
// (account/model/team) and JobScheduler's in-flight map (job) — the same "look up the
// live record" trick NotifyEvaluator's resolveTreeAgent uses for tree resolution.
export type UsageAgentContext = { account: string; provider?: string; model: string; team: string | null; job: string | null };
export type ResolveUsageContext = (agentId: string) => UsageAgentContext | null;

function pad2(n: number): string { return String(n).padStart(2, "0"); }

// LOCAL calendar date/month keys — never toISOString (UTC), so rotation and day buckets
// roll over at local midnight, matching SpendLedger's rollover contract.
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function groupKeyFor(row: UsageRow, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case "team": return row.team ?? "none";
    case "job": return row.job ?? "none";
    case "agent": return row.agent;
    case "account": return row.account;
    case "provider": return row.provider;
    case "model": return row.model;
  }
}

const SEALED_FILE_RE = /^usage\.\d{4}-\d{2}\.jsonl$/;

// P0-2 MODEL-ATTR: hard fail-loud backstop, not a convention — "default" is not a model id.
// The historical bug (engine.ts's resolveContext doing `spec.model ?? "default"`) silently
// mislabeled 59% of ledger rows ($785.75) as unattributed cost; enforcement lives HERE, at the
// one place every usage row is born, so any future regression that reintroduces a "default"
// fallback anywhere upstream is caught immediately instead of corrupting the ledger again.
export function resolveModel(candidate: string, agentId: string): string {
  if (candidate === "default") {
    throw new Error(`usage ledger: refusing to record model "default" for agent ${agentId} — resolveContext must never fall back to the literal string "default"`);
  }
  return candidate;
}

export class UsageLedger {
  private dir: string;
  private file: string;
  private month: string;
  private now: () => number;
  private resolveContext: ResolveUsageContext;

  constructor(home: string, opts: { events: EventLog; resolveContext: ResolveUsageContext; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    this.resolveContext = opts.resolveContext;
    this.dir = join(home, "usage");
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, "usage.jsonl");
    this.month = this.deriveActiveMonth();
    opts.events.subscribe((e) => this.onEvent(e));
  }

  // The active file may already hold rows from a month that ended while the daemon was
  // down (rotation only runs on the next append) — derive the tracked month from the
  // file's own first row rather than assuming "now", so a late append rotates correctly.
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

  private onEvent(e: NormalizedEvent): void {
    // LEDGER-UNCLEAN-EXIT: "usage_settle" is supervisor.ts's ledger-only flush for a record that
    // settled (killed/failed) WITHOUT ever producing a "result" — same row shape, sourced from
    // the last "turn_complete" instead of the terminal message. See settleUnrecordedUsage's doc
    // comment; this ledger has no other way to learn about that spend.
    if (e.kind !== "result" && e.kind !== "usage_settle") return;
    const ctx = this.resolveContext(e.agentId);
    // TOKEN-OPT-P0-1: backends now sink TWO raw usage objects on the terminal result —
    // billableUsage (cumulative, the SAME totals costUsd was computed over) and contextUsage
    // (last-turn-only, the ctx-meter's scope). usageFromRaw is budget.ts's own cache-aware
    // normalization (Anthropic's cache_read/cache_creation_input_tokens are additive;
    // codex's cached_input_tokens is a SUBSET of input_tokens and gets subtracted out,
    // output folds in reasoning_output_tokens) — imported rather than duplicated a third
    // time (ui-state's extractUsage is the one genuine duplicate left, since ui-state
    // cannot depend on core).
    const billableUsage = usageFromRaw(e.data["billableUsage"] as Record<string, unknown> | undefined);
    const contextUsage = usageFromRaw(e.data["contextUsage"] as Record<string, unknown> | undefined);
    const costUsd = Number(e.data["costUsd"] ?? 0);
    // P0-2 MODEL-ATTR: prefer the `result` event's OWN model (set by claude.ts/codex.ts from
    // the backend's actually-resolved model at the moment this specific result was produced)
    // over ctx.model (resolveContext's snapshot of the live AgentRecord, which can lag a
    // fast-following respawn/model-change). Falls through to ctx.model, then "unknown" — never
    // "default"; resolveModel below is the hard backstop against that literal ever landing.
    const resultModel = typeof e.data["model"] === "string" ? e.data["model"] : undefined;
    const row: UsageRow = {
      ts: e.ts,
      agent: e.agentId,
      team: ctx?.team ?? null,
      job: ctx?.job ?? null,
      account: ctx?.account ?? "unknown",
      provider: ctx?.provider ?? "unknown",
      model: resolveModel(resultModel ?? ctx?.model ?? "unknown", e.agentId),
      billableUsage, contextUsage,
      costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    };
    this.append(row);
  }

  private append(row: UsageRow): void {
    // TOKEN-OPT-P0-1: the ledger REJECTS an unscoped/malformed row rather than silently
    // writing it — usage is observability data (never crash-loop the daemon over it), so a
    // failed parse just drops this one row instead of throwing. usageFromRaw above always
    // produces a fully-numeric UsageScope, so this only guards a future edit that forgets a
    // field, not a real per-event failure mode today.
    const parsed = UsageRowSchema.safeParse(row);
    if (!parsed.success) return;
    const current = monthKey(this.now());
    if (current !== this.month) {
      if (existsSync(this.file)) renameSync(this.file, join(this.dir, `usage.${this.month}.jsonl`));
      this.month = current;
    }
    appendFileSync(this.file, `${JSON.stringify(parsed.data)}\n`);
  }

  private listFiles(): string[] {
    const names = existsSync(this.dir) ? readdirSync(this.dir) : [];
    return names.filter((n) => n === "usage.jsonl" || SEALED_FILE_RE.test(n)).map((n) => join(this.dir, n));
  }

  // [from, to) over every row across all segments — a query spanning a month boundary
  // (or the whole ledger's history) transparently reads sealed files too. Torn/malformed
  // lines (a crash mid-append) are skipped, never thrown.
  private readRows(from: number, to: number): UsageRow[] {
    const out: UsageRow[] = [];
    for (const file of this.listFiles()) {
      let content: string;
      try { content = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const row = UsageRowSchema.parse(JSON.parse(line));
          if (row.ts >= from && row.ts < to) out.push(row);
        } catch { /* torn/corrupt line — skip */ }
      }
    }
    return out;
  }

  query(params: UsageQueryParams): UsageQueryResult {
    const rows = this.readRows(params.from, params.to);
    let totalCostUsd = 0, totalTokensIn = 0, totalTokensOut = 0, totalCacheReadTokens = 0, totalCacheCreationTokens = 0;
    type Acc = { costUsd: number; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheCreationTokens: number; count: number };
    const groups = new Map<string, Acc>();
    const buckets = params.bucket === "day" ? new Map<string, Acc>() : null;
    for (const row of rows) {
      // TOKEN-OPT-P0-1: aggregate billableUsage (cumulative, cost-scope) — the SAME scope
      // costUsd was computed over — never contextUsage (last-turn-only; see the type's doc
      // comment in protocol/src/index.ts).
      totalCostUsd += row.costUsd;
      totalTokensIn += row.billableUsage.input;
      totalTokensOut += row.billableUsage.output;
      totalCacheReadTokens += row.billableUsage.cacheRead;
      totalCacheCreationTokens += row.billableUsage.cacheCreation;

      const gk = groupKeyFor(row, params.groupBy);
      const g = groups.get(gk) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
      g.costUsd += row.costUsd; g.tokensIn += row.billableUsage.input; g.tokensOut += row.billableUsage.output;
      g.cacheReadTokens += row.billableUsage.cacheRead; g.cacheCreationTokens += row.billableUsage.cacheCreation; g.count += 1;
      groups.set(gk, g);

      if (buckets) {
        const bk = dayKey(row.ts);
        const b = buckets.get(bk) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
        b.costUsd += row.costUsd; b.tokensIn += row.billableUsage.input; b.tokensOut += row.billableUsage.output;
        b.cacheReadTokens += row.billableUsage.cacheRead; b.cacheCreationTokens += row.billableUsage.cacheCreation; b.count += 1;
        buckets.set(bk, b);
      }
    }
    return {
      totalCostUsd, totalTokensIn, totalTokensOut, totalCacheReadTokens, totalCacheCreationTokens, count: rows.length,
      groups: [...groups.entries()]
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      ...(buckets ? {
        buckets: [...buckets.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
      } : {}),
    };
  }

  // spendTodayUsd (D1 unification): the local-calendar-day sum, re-derived from the
  // ledger on every read (same "first read after midnight self-resets" behavior
  // SpendLedger.todayUsd() had) — no separate running total to keep in sync.
  todayUsd(): number {
    const now = this.now();
    // +1: readRows' range is [from, to) — a row appended in the SAME millisecond as this
    // call (e.g. a result folded into the ledger just before daemon.status reads it) must
    // still count as "today", not fall just outside an exclusive upper bound.
    return this.readRows(startOfLocalDay(now), now + 1).reduce((sum, r) => sum + r.costUsd, 0);
  }
}
