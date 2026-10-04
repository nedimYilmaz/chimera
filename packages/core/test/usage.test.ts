import { describe, it, expect } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@chimera/protocol";
import type { EventLog } from "@chimera/core/events";
import { UsageLedger, type UsageAgentContext } from "@chimera/core/usage";

// D15 (usage ledger, coverage §C17, F19): UsageLedger doesn't need a REAL EventLog (which
// always stamps `ts: Date.now()` — no injectable clock) — a minimal fake with the same
// `subscribe` shape lets tests drive fully deterministic event timestamps, mirroring
// notify.test.ts's fakeTimer seam.
function fakeEventLog() {
  const listeners: Array<(e: NormalizedEvent) => void> = [];
  return {
    subscribe: (fn: (e: NormalizedEvent) => void) => { listeners.push(fn); return () => {}; },
    emit: (e: NormalizedEvent) => { for (const fn of listeners) fn(e); },
  };
}

let seq = 0;
function resultEvent(agentId: string, ts: number, data: Record<string, unknown>): NormalizedEvent {
  return { ts, seq: ++seq, engineId: "local", agentId, kind: "result", data };
}

const dir = () => mkdtempSync(join(tmpdir(), "chimera-usage-"));

// A local-noon instant: +1s never crosses local midnight, +24h always does — so the
// bucket/rollover assertions below hold in EVERY timezone the suite might run in.
const NOON = new Date(2026, 6, 16, 12, 0, 0).getTime();

describe("UsageLedger (D15/F19)", () => {
  it("records a result event as a usage row and usage.query totals match it", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: "teamX", job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    fake.emit(resultEvent("a1", NOON, {
      costUsd: 1.5,
      billableUsage: { input_tokens: 100, output_tokens: 50 },
      contextUsage: { input_tokens: 100, output_tokens: 50 },
    }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(1.5, 10);
    expect(q.totalTokensIn).toBe(100);
    expect(q.totalTokensOut).toBe(50);
    expect(q.totalCacheReadTokens).toBe(0);
    expect(q.totalCacheCreationTokens).toBe(0);
    expect(q.count).toBe(1);
    expect(q.groups).toEqual([
      { key: "a1", costUsd: 1.5, tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, count: 1 },
    ]);
  });

  // TOKEN-OPT-P4: the SDK forwards cache_read/cache_creation_input_tokens verbatim on
  // claude.ts's "result" event usage object — this is the ledger-side half of surfacing
  // the ~90%-off cached-prefix reuse (vs a cache miss/bust) per agent.
  it("extracts cache_read_input_tokens / cache_creation_input_tokens into the row and query totals", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: "teamX", job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    const usage = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 200 };
    fake.emit(resultEvent("a1", NOON, { costUsd: 0.05, billableUsage: usage, contextUsage: usage }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    expect(q.totalCacheReadTokens).toBe(9000);
    expect(q.totalCacheCreationTokens).toBe(200);
    expect(q.groups).toEqual([
      { key: "a1", costUsd: 0.05, tokensIn: 40, tokensOut: 10, cacheReadTokens: 9000, cacheCreationTokens: 200, count: 1 },
    ]);
  });

  // R2 (unified cache-aware token/ctx/cost metrics): codex's raw usage carries
  // cached_input_tokens, a SUBSET of input_tokens (verified against OpenAI docs) — the
  // ledger's own extraction previously left it un-subtracted (a THIRD copy of the same bug
  // fixed in ui-state's extractUsage and budget.ts's usageFromRaw), which would silently
  // reintroduce the exact provider inconsistency this feature removes. tokensIn must be the
  // fresh-only figure (60), not the raw input_tokens (100).
  it("subtracts codex's cached_input_tokens out of tokensIn (a subset, not additive)", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", provider: "codex", model: "gpt-5.6-sol", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 0 };
    fake.emit(resultEvent("a1", NOON, { costUsd: 0.02, billableUsage: usage, contextUsage: usage }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    expect(q.groups).toEqual([
      { key: "a1", costUsd: 0.02, tokensIn: 60, tokensOut: 20, cacheReadTokens: 40, cacheCreationTokens: 0, count: 1 },
    ]);
  });

  // TOKEN-OPT-P0-1: codex's cache_write_input_tokens (pinned SDK 0.145.0) must land as
  // cacheCreation, not be discarded — the old toCostUsage hardcoded cacheCreation:0.
  it("surfaces codex's cache_write_input_tokens as cacheCreation, not 0", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", provider: "codex", model: "gpt-5.6-sol", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    const usage = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 500, output_tokens: 20, reasoning_output_tokens: 0 };
    fake.emit(resultEvent("a1", NOON, { costUsd: 0.03, billableUsage: usage, contextUsage: usage }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    expect(q.totalCacheCreationTokens).toBe(500);
  });

  // TOKEN-OPT-P0-1: the whole point of the split — a multi-turn run's costUsd is CUMULATIVE
  // (paid for every turn's cache reads) but the OLD ledger paired it with only the LAST
  // turn's usage, silently undercounting cache-read by however many turns ran. billableUsage
  // (cumulative) must be what query() sums; contextUsage (last-turn-only, tiny by comparison)
  // must NOT leak into the aggregate.
  it("sums billableUsage (cumulative), never contextUsage (last-turn-only), into query totals", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    // A 71-turn run: cumulative cache_read is 71x any single turn's — exactly the measured bug.
    fake.emit(resultEvent("a1", NOON, {
      costUsd: 7.1,
      billableUsage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 71000, cache_creation_input_tokens: 200 },
      contextUsage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    expect(q.totalCacheReadTokens).toBe(71000);
    expect(q.totalTokensIn).toBe(100);
    expect(q.totalTokensOut).toBe(50);
    expect(q.totalCacheCreationTokens).toBe(200);
  });

  // TOKEN-OPT-P0-1: a legacy pre-split row (single `usage` field, no billableUsage/
  // contextUsage) must not silently misparse as one scope or the other — UsageRowSchema
  // requires both, so readRows' per-line parse skips it like any other corrupt line.
  it("skips a legacy single-`usage`-field row (pre-split ledger segment) rather than misparsing it", () => {
    const home = dir();
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unused = new UsageLedger(home, { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    const usageDir = join(home, "usage");
    const legacyRow = { ts: NOON, agent: "legacy", team: null, job: null, account: "main", provider: "unknown", model: "sonnet", usage: { in: 10, out: 5, cacheRead: 0, cacheCreation: 0 }, costUsd: 1 };
    appendFileSync(join(usageDir, "usage.jsonl"), `${JSON.stringify(legacyRow)}\n`);
    fake.emit(resultEvent("a1", NOON + 1, {
      costUsd: 2, billableUsage: { input_tokens: 20, output_tokens: 10 }, contextUsage: { input_tokens: 20, output_tokens: 10 },
    }));

    const ledger2 = new UsageLedger(home, { events: fakeEventLog() as unknown as EventLog, resolveContext: () => ctx, now: () => NOON + 1 });
    const q = ledger2.query({ from: NOON - 1, to: NOON + 2, groupBy: "agent" });
    expect(q.count).toBe(1);
    expect(q.totalCostUsd).toBeCloseTo(2, 10);
  });

  it("a cache miss (all tokens re-written to cache, none read) is distinguishable per agent via groupBy:agent", () => {
    const fake = fakeEventLog();
    const contexts = new Map<string, UsageAgentContext>([
      ["cached", { account: "main", model: "sonnet", team: null, job: null }],
      ["busted", { account: "main", model: "sonnet", team: null, job: null }],
    ]);
    const ledger = new UsageLedger(dir(), {
      events: fake as unknown as EventLog, now: () => NOON,
      resolveContext: (agentId) => contexts.get(agentId) ?? null,
    });
    // "cached": mostly cache_read (turn 2+ of a stable-prefix agent)
    const cachedUsage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 };
    fake.emit(resultEvent("cached", NOON, { costUsd: 0.01, billableUsage: cachedUsage, contextUsage: cachedUsage }));
    // "busted": all cache_creation, zero cache_read — the regression this guards against
    const bustedUsage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 8000 };
    fake.emit(resultEvent("busted", NOON, { costUsd: 0.05, billableUsage: bustedUsage, contextUsage: bustedUsage }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "agent" });
    const cached = q.groups.find((g) => g.key === "cached")!;
    const busted = q.groups.find((g) => g.key === "busted")!;
    expect(cached.cacheReadTokens).toBe(8000);
    expect(cached.cacheCreationTokens).toBe(0);
    expect(busted.cacheReadTokens).toBe(0);
    expect(busted.cacheCreationTokens).toBe(8000);
  });

  it("switching groupBy keeps the same total (no-drift rule)", () => {
    const fake = fakeEventLog();
    const contexts = new Map<string, UsageAgentContext>([
      ["a1", { account: "main", model: "sonnet", team: "teamX", job: null }],
      ["a2", { account: "main", model: "haiku", team: "teamX", job: "nightly" }],
      ["a3", { account: "alt", model: "sonnet", team: null, job: null }],
    ]);
    const ledger = new UsageLedger(dir(), {
      events: fake as unknown as EventLog, now: () => NOON,
      resolveContext: (agentId) => contexts.get(agentId) ?? null,
    });
    fake.emit(resultEvent("a1", NOON, { costUsd: 1, billableUsage: { input_tokens: 10, output_tokens: 5 }, contextUsage: { input_tokens: 10, output_tokens: 5 } }));
    fake.emit(resultEvent("a2", NOON, { costUsd: 2, billableUsage: { input_tokens: 20, output_tokens: 8 }, contextUsage: { input_tokens: 20, output_tokens: 8 } }));
    fake.emit(resultEvent("a3", NOON, { costUsd: 3, billableUsage: { input_tokens: 30, output_tokens: 12 }, contextUsage: { input_tokens: 30, output_tokens: 12 } }));

    const range = { from: NOON - 1, to: NOON + 1 };
    for (const groupBy of ["team", "agent", "account", "provider", "model", "job"] as const) {
      const q = ledger.query({ ...range, groupBy });
      expect(q.totalCostUsd).toBeCloseTo(6, 10);
      expect(q.totalTokensIn).toBe(60);
      expect(q.totalTokensOut).toBe(25);
      expect(q.count).toBe(3);
    }

    const byTeam = ledger.query({ ...range, groupBy: "team" });
    expect(byTeam.groups.find((g) => g.key === "teamX")?.costUsd).toBeCloseTo(3, 10);
    expect(byTeam.groups.find((g) => g.key === "none")?.costUsd).toBeCloseTo(3, 10);

    const byJob = ledger.query({ ...range, groupBy: "job" });
    expect(byJob.groups.find((g) => g.key === "nightly")?.costUsd).toBeCloseTo(2, 10);
    expect(byJob.groups.find((g) => g.key === "none")?.costUsd).toBeCloseTo(4, 10);
  });

  it("buckets rows into LOCAL calendar days, not UTC", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    fake.emit(resultEvent("a1", NOON, { costUsd: 1 }));
    fake.emit(resultEvent("a1", NOON + 1000, { costUsd: 2 }));               // same local day
    fake.emit(resultEvent("a1", NOON + 24 * 3600 * 1000, { costUsd: 4 }));   // exactly one day later → new local day

    const q = ledger.query({ from: NOON - 1, to: NOON + 25 * 3600 * 1000, groupBy: "agent", bucket: "day" });
    expect(q.buckets).toHaveLength(2);
    expect(q.buckets![0]!.costUsd).toBeCloseTo(3, 10);
    expect(q.buckets![1]!.costUsd).toBeCloseTo(4, 10);
    expect(q.buckets![0]!.day < q.buckets![1]!.day).toBe(true);
  });

  it("spendTodayUsd (todayUsd) equals the ledger's own today sum", () => {
    let now = NOON;
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => now });
    fake.emit(resultEvent("a1", NOON - 24 * 3600 * 1000, { costUsd: 9 }));   // yesterday — excluded
    fake.emit(resultEvent("a1", NOON, { costUsd: 1 }));
    fake.emit(resultEvent("a1", NOON + 1000, { costUsd: 2 }));
    now = NOON + 1000;

    expect(ledger.todayUsd()).toBeCloseTo(3, 10);
    const startOfDay = new Date(2026, 6, 16, 0, 0, 0, 0).getTime();
    const q = ledger.query({ from: startOfDay, to: now + 1, groupBy: "agent" });   // +1: query's `to` is exclusive
    expect(q.totalCostUsd).toBeCloseTo(ledger.todayUsd(), 10);
  });

  it("codex rows record tokens with costUsd 0", () => {
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "codex", team: null, job: null };
    const ledger = new UsageLedger(dir(), { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    fake.emit(resultEvent("a1", NOON, { costUsd: 0, billableUsage: { input_tokens: 500, output_tokens: 200 }, contextUsage: { input_tokens: 500, output_tokens: 200 } }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 1, groupBy: "model" });
    expect(q.totalCostUsd).toBe(0);
    expect(q.totalTokensIn).toBe(500);
    expect(q.totalTokensOut).toBe(200);
  });

  it("seals the previous month's file on rollover and usage.query reads across the boundary", () => {
    let now = NOON;
    const home = dir();
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    new UsageLedger(home, { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => now });
    fake.emit(resultEvent("a1", now, { costUsd: 1 }));

    const nextMonth = new Date(2026, 7, 16, 12, 0, 0).getTime();   // one calendar month later
    now = nextMonth;
    fake.emit(resultEvent("a1", now, { costUsd: 2 }));

    const usageDir = join(home, "usage");
    expect(existsSync(join(usageDir, "usage.2026-07.jsonl"))).toBe(true);
    expect(existsSync(join(usageDir, "usage.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(usageDir, "usage.jsonl"), "utf8").trim()).costUsd).toBe(2);

    const ledger2 = new UsageLedger(home, { events: fakeEventLog() as unknown as EventLog, resolveContext: () => ctx, now: () => now });
    const q = ledger2.query({ from: NOON - 1, to: nextMonth + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(3, 10);
    expect(q.count).toBe(2);
  });

  it("tolerates a corrupt/torn line in usage.jsonl (observability data, never crash-loop)", () => {
    const home = dir();
    const fake = fakeEventLog();
    const ctx: UsageAgentContext = { account: "main", model: "sonnet", team: null, job: null };
    const ledger = new UsageLedger(home, { events: fake as unknown as EventLog, resolveContext: () => ctx, now: () => NOON });
    fake.emit(resultEvent("a1", NOON, { costUsd: 1 }));
    appendFileSync(join(home, "usage", "usage.jsonl"), "{not json\n");
    fake.emit(resultEvent("a1", NOON + 1000, { costUsd: 2 }));

    const q = ledger.query({ from: NOON - 1, to: NOON + 2000, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(3, 10);
    expect(q.count).toBe(2);
    expect(readdirSync(join(home, "usage"))).toContain("usage.jsonl");
  });
});
