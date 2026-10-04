// F39 commit 2 — the counterfactual threshold replay in scripts/audit-lib.mjs. Same import shape
// as measurement-audit.test.ts: a pure .mjs outside packages/*/src, imported by relative path and
// never typechecked (packages/core/tsconfig.json sets include:["src"]).
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_COMPACTION_THRESHOLD } from "@chimera/protocol";
// @ts-expect-error - plain JS module, not part of this package's typecheck surface (tsconfig include:["src"])
import {
  buildCompactionReport,
  replayThreshold,
  buildCallSeries,
  indexCompactions,
  classifyPostCompactionCalls,
  priceUsage,
  indexAgents,
  claudeTurns,
  buildSpendLedger,
  THRESHOLD_SWEEP,
  MIN_NET_MULTIPLIER,
  READ_RATE,
  WRITE_RATE,
  PRICES,
  LEDGER_CROSS_CHECK_TOLERANCE_USD,
  SENSITIVITY_READ_RATES,
  SENSITIVITY_WRITE_RATES,
  FLEET_DEFAULT_THRESHOLD,
} from "../../../scripts/audit-lib.mjs";

let seq = 0;
beforeEach(() => {
  seq = 0;
});

type Ev = Record<string, unknown>;

function ev(kind: string, agentId: string, data: Record<string, unknown> = {}, opts: { ts?: number; raw?: unknown } = {}): Ev {
  seq += 1;
  const e: Record<string, unknown> = { ts: opts.ts ?? seq, seq, engineId: "local", agentId, kind, data };
  if (opts.raw !== undefined) e.raw = opts.raw;
  return e;
}

function agentStarted(agentId: string, over: Record<string, unknown> = {}, ts = 0): Ev {
  return ev("agent_started", agentId, { provider: "claude", conductor: false, depth: 0, model: "claude-opus-5", ...over }, { ts });
}

const MODEL = "claude-opus-5";

// A real model call: message_start opens the turn and carries the read/write/fresh baseline.
function start(agentId: string, u: { read?: number; write?: number; fresh?: number; output?: number }, model = MODEL, ts?: number): Ev {
  return ev(
    "usage",
    agentId,
    {
      usage: {
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
        input_tokens: u.fresh ?? 0,
        output_tokens: u.output ?? 0,
      },
    },
    { ts, raw: { event: { type: "message_start", message: { model } } } },
  );
}

// A re-emission: the SAME turn, input/cache pinned to the message_start baseline, output ticking up.
function delta(agentId: string, u: { read?: number; write?: number; fresh?: number; output?: number }, ts?: number): Ev {
  return ev(
    "usage",
    agentId,
    {
      usage: {
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
        input_tokens: u.fresh ?? 0,
        output_tokens: u.output ?? 0,
      },
    },
    { ts, raw: { event: { type: "message_delta" } } },
  );
}

// A ramp of `ctx` sizes as pure cache reads, one real call each.
function ramp(agentId: string, ctxs: number[], output = 500): Ev[] {
  return ctxs.map((c) => start(agentId, { read: c, output }));
}

function seriesOf(events: Ev[], agentId: string) {
  const agents = indexAgents(events);
  return buildCallSeries(events, agents).series.get(agentId);
}

function compactionEvent(agentId: string, before: number, after: number, ts?: number): Ev {
  return ev("compaction", agentId, { trigger: "budget", owner: "sdk", before: { tokens: before }, after: { tokens: after } }, { ts });
}

describe("compaction-audit (F39 replay)", () => {
  it("case 1: replayThreshold at T=Infinity reproduces the actual bill exactly (netMultiplier === 1.0)", () => {
    const events = [
      agentStarted("a1"),
      ...ramp("a1", [20_000, 90_000, 240_000, 620_000]),
      // a real compaction: ctx COLLAPSES, which is the case the plan's `sim += max(0, delta)`
      // pseudocode gets wrong — sim stays pinned high and scale blows up.
      compactionEvent("a1", 620_000, 12_000),
      ...ramp("a1", [12_000, 40_000, 130_000]),
    ];
    const report = buildCompactionReport(events);
    expect(report.selfCheck.exact).toBe(true);
    expect(report.selfCheck.netMultiplierAtInfinity).toBe(1);
    const inf = report.sweep.find((r: { threshold: number | null }) => r.threshold === null);
    expect(inf.simulatedUsd).toBe(report.actual.usd);
    expect(report.actual.usd).toBeGreaterThan(0);
  });

  it("case 2: a ramping fixture under T=120k fires the expected number of compactions and no more", () => {
    const events = [agentStarted("a1"), ...ramp("a1", [20_000, 60_000, 100_000, 140_000, 180_000, 220_000, 260_000, 300_000, 340_000, 400_000])];
    const series = seriesOf(events, "a1");
    expect(series).toHaveLength(10);
    const r = replayThreshold(series, 120_000, 10_000);
    expect(r.compactions).toBe(4);
    // and the cap really binds: the same series under a threshold above its peak never compacts
    expect(replayThreshold(series, 500_000, 10_000).compactions).toBe(0);
  });

  it("case 3: the report returns one sweep row per (threshold, floor) pair, plus the self-check row", () => {
    const events = [agentStarted("a1"), ...ramp("a1", [50_000, 150_000, 300_000]), compactionEvent("a1", 300_000, 9_000)];
    const report = buildCompactionReport(events);
    expect(report.sweep).toHaveLength(THRESHOLD_SWEEP.length * 3 + 1);
    for (const T of THRESHOLD_SWEEP) {
      const rows = report.sweep.filter((r: { threshold: number | null }) => r.threshold === T);
      expect(rows.map((r: { floorLabel: string }) => r.floorLabel).sort()).toEqual(["max", "median", "min"]);
    }
    // the self-check row is floor-independent — no compaction ever fires at threshold=none
    expect(report.sweep.filter((r: { threshold: number | null }) => r.threshold === null)).toHaveLength(1);
  });

  it("case 4: netMultiplier is monotone non-increasing in T over a monotone-growing fixture", () => {
    const events = [
      agentStarted("a1"),
      ...ramp("a1", Array.from({ length: 40 }, (_, i) => 20_000 + i * 15_000)),
      compactionEvent("a1", 600_000, 12_000),
    ];
    const report = buildCompactionReport(events);
    const atMedian = report.sweep
      .filter((r: { floorLabel: string; threshold: number | null }) => r.floorLabel === "median" && r.threshold !== null)
      .sort((a: { threshold: number }, b: { threshold: number }) => a.threshold - b.threshold);
    for (let i = 1; i < atMedian.length; i++) {
      expect(atMedian[i].netMultiplier).toBeLessThanOrEqual(atMedian[i - 1].netMultiplier + 1e-12);
    }
  });

  it("case 5: the same threshold yields a WORSE multiplier at the max floor than at the min floor", () => {
    const events = [
      agentStarted("a1"),
      ...ramp("a1", Array.from({ length: 30 }, (_, i) => 20_000 + i * 20_000)),
      compactionEvent("a1", 600_000, 6_000),
      compactionEvent("a1", 600_000, 90_000),
    ];
    const report = buildCompactionReport(events);
    const row = (label: string, T: number) =>
      report.sweep.find((r: { floorLabel: string; threshold: number | null }) => r.floorLabel === label && r.threshold === T);
    expect(row("max", 200_000).netMultiplier).toBeLessThan(row("min", 200_000).netMultiplier);
  });

  it("case 6: a threshold that clears the bar at the median floor but not at the max floor is NOT recommended", () => {
    // floors are derived from the OBSERVED after.tokens, so a fleet whose compactions land at
    // 6k..150k has a pessimistic floor that eats most of the saving.
    const events = [
      agentStarted("a1"),
      ...ramp("a1", Array.from({ length: 40 }, (_, i) => 20_000 + i * 12_000)),
      compactionEvent("a1", 500_000, 6_000),
      compactionEvent("a1", 500_000, 40_000),
      compactionEvent("a1", 500_000, 150_000),
    ];
    const report = buildCompactionReport(events);
    const row = (label: string, T: number) =>
      report.sweep.find((r: { floorLabel: string; threshold: number | null }) => r.floorLabel === label && r.threshold === T);
    const split = THRESHOLD_SWEEP.filter(
      (T: number) => row("median", T).netMultiplier >= MIN_NET_MULTIPLIER && row("max", T).netMultiplier < MIN_NET_MULTIPLIER,
    );
    expect(split.length).toBeGreaterThan(0);
    for (const T of split) {
      expect(report.recommendation.threshold).not.toBe(T);
      expect(report.recommendation.rejected.map((r: { threshold: number }) => r.threshold)).toContain(T);
    }
  });

  it("case 7: each simulated compaction charges a full cache REWRITE of the floor at WRITE_RATE, not at READ_RATE", () => {
    const events = [agentStarted("a1"), ...ramp("a1", [50_000, 300_000])];
    const series = seriesOf(events, "a1");
    const floor = 10_000;
    const r = replayThreshold(series, 120_000, floor);
    expect(r.compactions).toBe(1);
    const asWrite = priceUsage({ read: 0, write: floor, fresh: 0, output: 0 }, MODEL);
    const asRead = priceUsage({ read: floor, write: 0, fresh: 0, output: 0 }, MODEL);
    expect(r.compactionCostUsd).toBe(asWrite);
    expect(asWrite).toBeCloseTo((floor / 1e6) * PRICES[MODEL].input * WRITE_RATE, 12);
    expect(asWrite / asRead).toBeCloseTo(WRITE_RATE / READ_RATE, 9);
  });

  it("case 8: caveats[] carries the SDK-summarization-invisible note in upper-bound wording", () => {
    const report = buildCompactionReport([agentStarted("a1"), ...ramp("a1", [50_000, 150_000])]);
    const joined = report.caveats.join("\n");
    expect(joined).toContain("summarization output tokens are invisible to chimera");
    expect(joined).toContain("UPPER BOUND");
  });

  it("case 9: coverage names codex and kimi with their code reasons and marks canPriceCompaction false", () => {
    const events = [
      agentStarted("a1"),
      agentStarted("cx", { provider: "codex" }),
      agentStarted("km", { provider: "kimi" }),
      agentStarted("gn", { provider: "zai-coding" }),
      ...ramp("a1", [50_000, 150_000]),
    ];
    const report = buildCompactionReport(events);
    expect(report.coverage.claude).toMatchObject({ agents: 1, canPriceCompaction: true });
    expect(report.coverage.codex.canPriceCompaction).toBe(false);
    expect(report.coverage.codex.reason).toContain("codex.ts");
    expect(report.coverage.kimi.canPriceCompaction).toBe(false);
    expect(report.coverage.kimi.reason).toContain("kimi.ts");
    // a non-dedicated provider id is the "generic" class by construction
    expect(report.coverage.generic.agents).toBe(1);
  });

  it("case 10: a Read re-read and a Bash `cat` re-read of the same pre-boundary path both count", () => {
    const events = [
      agentStarted("a1"),
      ev("tool_call", "a1", { toolName: "Read", toolUseId: "u1", input: { file_path: "/x/a.ts" } }, { ts: 10 }),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u2", input: { command: "cat /x/b.ts | head -20" } }, { ts: 11 }),
      compactionEvent("a1", 400_000, 9_000, 20),
      ev("tool_call", "a1", { toolName: "Read", toolUseId: "u3", input: { file_path: "/x/a.ts" } }, { ts: 30 }),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u4", input: { command: "cat /x/b.ts" } }, { ts: 31 }),
      ev("tool_call", "a1", { toolName: "Read", toolUseId: "u5", input: { file_path: "/x/never-seen.ts" } }, { ts: 32 }),
    ];
    const d07 = classifyPostCompactionCalls(events, indexCompactions(events).completions);
    expect(d07.reReads).toBe(2);
    expect(d07.reReadsByTool).toMatchObject({ Read: 1, Bash: 1 });
    expect(d07.chronicleDenominator).toBe(3);
  });

  it("case 11: zero chronicle calls report as 0/N with N printed, and a wrapped chronicle_* call counts", () => {
    const base = [
      agentStarted("a1"),
      compactionEvent("a1", 400_000, 9_000, 20),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1", input: { command: "ls" } }, { ts: 30 }),
      ev("tool_call", "a1", { toolName: "Read", toolUseId: "u2", input: { file_path: "/x/a.ts" } }, { ts: 31 }),
    ];
    const zero = classifyPostCompactionCalls(base, indexCompactions(base).completions);
    expect(zero.chronicleCalls).toBe(0);
    expect(zero.chronicleDenominator).toBe(2);
    expect(zero.n).toBe(1);

    const wrapped = [
      ...base,
      ev("tool_call", "a1", { toolName: "mcp__chimera__chimera_call", toolUseId: "u3", input: { tool: "chronicle_search", args: {} } }, { ts: 32 }),
      ev("tool_call", "a1", { toolName: "mcp__chimera__chronicle_get", toolUseId: "u4", input: {} }, { ts: 33 }),
    ];
    const found = classifyPostCompactionCalls(wrapped, indexCompactions(wrapped).completions);
    expect(found.chronicleCalls).toBe(2);
    expect(found.chronicleDenominator).toBe(4);
  });

  it("case 12: the synthetic post-compaction usage event is excluded from actual.usd, exactly as the M9 zero-signature exclusion is", () => {
    const syntheticEvent = ev("usage", "a1", {
      usage: { input_tokens: 13_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      synthetic: "compaction-baseline",
    });
    const withSynthetic = [agentStarted("a1"), ...ramp("a1", [50_000, 200_000]), syntheticEvent, ...ramp("a1", [13_000, 60_000])];
    // the M9 zero-signature: read==0 && write==0 && output==0 && input>0, matched WITHOUT the marker
    const zeroSignature = (e: Ev) => {
      const u = (e.data as { usage?: Record<string, number> } | undefined)?.usage;
      return (
        e.kind === "usage" &&
        !!u &&
        (u.cache_read_input_tokens ?? 0) === 0 &&
        (u.cache_creation_input_tokens ?? 0) === 0 &&
        (u.output_tokens ?? 0) === 0 &&
        (u.input_tokens ?? 0) > 0
      );
    };
    const withoutSynthetic = withSynthetic.filter((e) => !zeroSignature(e));
    expect(withoutSynthetic).toHaveLength(withSynthetic.length - 1);

    const a = buildCompactionReport(withSynthetic);
    const b = buildCompactionReport(withoutSynthetic);
    expect(a.actual.usd).toBe(b.actual.usd);
    expect(a.observed.syntheticUsageEvents).toBe(1);
    expect(a.observed.syntheticInputTokens).toBe(13_000);
    expect(a.observed.markedSynthetic).toBe(1);
    expect(a.window.modelCalls).toBe(4);
  });

  it("case 13: one message_start plus three message_delta re-emissions contribute ONE model call and ONE context reading", () => {
    const events = [
      agentStarted("a1"),
      start("a1", { read: 100_000, write: 2_000, fresh: 5, output: 3 }),
      delta("a1", { read: 100_000, write: 2_000, fresh: 5, output: 120 }),
      delta("a1", { read: 100_000, write: 2_000, fresh: 5, output: 340 }),
      delta("a1", { read: 100_000, write: 2_000, fresh: 5, output: 902 }),
    ];
    const report = buildCompactionReport(events);
    expect(report.window.modelCalls).toBe(1);
    expect(report.actual.meanCtx).toBe(102_005);
    // and the merged row keeps the DELTA's output, not message_start's placeholder 3
    const series = seriesOf(events, "a1");
    expect(series).toHaveLength(1);
    expect(series[0].output).toBe(902);
  });

  it("case 15: claudeTurns and the streaming spend ledger agree — the twin merge rules cannot drift apart", () => {
    // F45.QA-A made buildSpendLedger streaming, so it applies the same message_start/message_delta
    // merge one event at a time while claudeTurns returns the rows. This pins their agreement.
    const events: Ev[] = [agentStarted("a1")];
    for (let i = 0; i < 6; i++) {
      events.push(start("a1", { read: 40_000 + i * 3_000, write: 900, fresh: 4, output: 3 }));
      events.push(delta("a1", { read: 40_000 + i * 3_000, write: 900, fresh: 4, output: 500 + i }));
    }
    const agents = indexAgents(events);
    const viaTurns = claudeTurns(
      events.filter((e) => e.kind === "usage"),
      "claude-opus-5",
    ).reduce((sum: number, r: { model: string }) => sum + priceUsage(r, r.model), 0);
    const ledger = buildSpendLedger(events, agents);
    // no result event in this fixture, so the claude figure falls back to the list-price model
    expect(ledger.claudeSpend.modelledFallbackUsd).toBeCloseTo(viaTurns, 12);
    expect(ledger.modelledListUsd).toBeCloseTo(viaTurns, 12);
  });

  // F39.QA — the plan's headline risk R1 says the ratio SURVIVES a uniform double-count almost
  // unharmed, so cases 13/14 (which pin counts) cannot detect a dedupe regression reaching the
  // decision. This is the missing half: inject re-emissions and assert the DERIVED number — every
  // sweep row and the recommendation itself — is bit-identical. The deltas repeat their opener's
  // figures INCLUDING output on purpose: claudeTurns merges the delta's output into the row, so a
  // delta with a different output would legitimately move both bills and make this test flaky by
  // construction rather than by regression.
  it("case 16: injecting message_delta re-emissions leaves every sweep multiplier and the recommendation EXACTLY unchanged", () => {
    const ctxs = [40_000, 90_000, 160_000, 240_000, 380_000, 520_000];
    const clean: Ev[] = [agentStarted("a1"), ...ramp("a1", ctxs)];
    const dup: Ev[] = [agentStarted("a1")];
    for (const c of ctxs) {
      dup.push(start("a1", { read: c, output: 500 }));
      dup.push(delta("a1", { read: c, output: 500 }));
      dup.push(delta("a1", { read: c, output: 500 }));
    }

    const a = buildCompactionReport(clean);
    const b = buildCompactionReport(dup);

    expect(b.window.modelCalls).toBe(a.window.modelCalls);
    expect(b.window.usageEvents).toBe(3 * a.window.usageEvents);      // the duplicates really are there
    expect(b.window.deltaReemissions).toBe(12);
    expect(b.actual.usd).toBe(a.actual.usd);
    expect(b.recommendation.threshold).toBe(a.recommendation.threshold);
    expect(b.recommendation.netAtPessimisticFloor).toBe(a.recommendation.netAtPessimisticFloor);
    for (let i = 0; i < a.sweep.length; i++) {
      expect(b.sweep[i].netMultiplier).toBe(a.sweep[i].netMultiplier);
      expect(b.sweep[i].compactions).toBe(a.sweep[i].compactions);
    }
  });

  // F39.QA — A3's marker was written into the row and read by nothing: the latch claude.ts pays a
  // per-spawn `let` to maintain produced no number anywhere in the artifact, so the replay's
  // MODELLED compaction charge had no measured counterpart to be compared against.
  it("case 17: calls marked afterCompaction:true are counted and their cache_creation summed, so the modelled compaction charge has a measured counterpart", () => {
    const marked = ev(
      "usage",
      "a1",
      { usage: { cache_read_input_tokens: 4_000, cache_creation_input_tokens: 33_412, input_tokens: 0, output_tokens: 400 }, afterCompaction: true },
      { raw: { event: { type: "message_start", message: { model: MODEL } } } },
    );
    const report = buildCompactionReport([agentStarted("a1"), ...ramp("a1", [50_000]), marked, ...ramp("a1", [60_000])]);
    expect(report.observed.afterCompactionCalls).toBe(1);
    expect(report.observed.afterCompactionWriteTokens).toBe(33_412);
    expect(report.observed.afterCompactionMeanWriteTokens).toBe(33_412);
    // and an unmarked log reports 0 rather than omitting the field — a missing key reads as
    // "not applicable" when it means "this log predates the latch".
    const bare = buildCompactionReport([agentStarted("a2"), ...ramp("a2", [50_000])]);
    expect(bare.observed.afterCompactionCalls).toBe(0);
    expect(bare.observed.afterCompactionWriteTokens).toBe(0);
  });

  // F39.QA — the phantom-spend bug of plan M9/R2 was fixed in buildCompactionReport but NOT in the
  // shared ledger F45/F41 read, whose own caveat admitted "F45's buildSpendLedger still charges
  // them". It grows linearly with compaction count, i.e. with what the 120k default just bought.
  it("case 18: buildSpendLedger does not bill the synthetic post-compaction reset, and a real turn with no stream type still counts", () => {
    const real = [agentStarted("a1"), ...ramp("a1", [80_000])];
    const agents = indexAgents(real);
    const baseline = buildSpendLedger(real, agents).modelledListUsd;

    const withSynthetic = [
      ...real,
      ev("usage", "a1", { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 13_545, output_tokens: 0 }, synthetic: "compaction-baseline" }),
    ];
    expect(buildSpendLedger(withSynthetic, indexAgents(withSynthetic)).modelledListUsd).toBe(baseline);

    // NOT keyed on "no raw.event": an unmarked usage row is a real turn to this ledger and must
    // keep billing, or every fixture and every non-claude-stream emitter silently goes free.
    const withPlain = [
      ...real,
      ev("usage", "a1", { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 13_545, output_tokens: 0 } }),
    ];
    expect(buildSpendLedger(withPlain, indexAgents(withPlain)).modelledListUsd).toBeGreaterThan(baseline);
  });

  it("case 14: window.modelCalls equals the message_start count, never the usage-event count", () => {
    const events: Ev[] = [agentStarted("a1")];
    for (let i = 0; i < 5; i++) {
      events.push(start("a1", { read: 50_000 + i * 1_000, output: 3 }));
      events.push(delta("a1", { read: 50_000 + i * 1_000, output: 400 }));
      events.push(delta("a1", { read: 50_000 + i * 1_000, output: 800 }));
    }
    const report = buildCompactionReport(events);
    expect(report.window.modelCalls).toBe(5);
    expect(report.window.usageEvents).toBe(15);
    expect(report.window.deltaReemissions).toBe(10);
    // the regression alarm the markdown prints: these two being equal means the dedupe is gone
    expect(report.window.modelCalls).not.toBe(report.window.usageEvents);
  });

  // F39.QA M-2 — the A6 self-check only ever compared the sweep's own T=Infinity row against
  // itself (a tautology: it can never fail). These two cases give it real discriminating power.
  it("case 19: selfCheck.ledgerCrossCheck agrees with buildSpendLedger on a clean fixture, and a wrong ledger trips it", () => {
    const clean = [agentStarted("a1"), ...ramp("a1", [50_000, 90_000, 130_000])];
    const report = buildCompactionReport(clean);
    expect(report.selfCheck.ledgerCrossCheck.withinTolerance).toBe(true);
    expect(Math.abs(report.selfCheck.ledgerCrossCheck.deltaUsd)).toBeLessThanOrEqual(LEDGER_CROSS_CHECK_TOLERANCE_USD);
    expect(report.selfCheck.ledgerCrossCheck.modelledListUsd).toBeCloseTo(report.selfCheck.ledgerCrossCheck.expectedUsd, 9);

    // case 18 showed a bare usage row (no raw.event, so buildCallSeries drops it from `series`)
    // still gets billed by buildSpendLedger. Manually replicate the ledgerCrossCheck formula
    // across the SAME evs buildCompactionReport would see, to prove the check actually catches
    // a real ledger/series mismatch rather than always trivially passing.
    const bareRow = ev("usage", "a1", { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 13_545, output_tokens: 0 } });
    const poisoned = [...clean, bareRow];
    const poisonedReport = buildCompactionReport(poisoned);
    expect(poisonedReport.selfCheck.ledgerCrossCheck.withinTolerance).toBe(true);

    const agents = indexAgents(poisoned);
    const ledgerUsd = buildSpendLedger(poisoned, agents).modelledListUsd;
    // the wrong hypothesis a regression would introduce: forgetting excludedLedgerBillableUsd
    // in the comparison, i.e. checking the ledger only against actual.usd.
    const wrongExpectedUsd = poisonedReport.actual.usd;
    expect(Math.abs(ledgerUsd - wrongExpectedUsd)).toBeGreaterThan(LEDGER_CROSS_CHECK_TOLERANCE_USD);
    // the real formula (exposed as ledgerCrossCheck.expectedUsd, i.e. actual.usd +
    // excludedLedgerBillableUsd) is exactly what closes that gap — proving the check isn't a
    // tautology: a naive comparison against actual.usd alone would have flagged this fixture.
    expect(ledgerUsd).toBeCloseTo(poisonedReport.selfCheck.ledgerCrossCheck.expectedUsd, 9);
    expect(poisonedReport.selfCheck.ledgerCrossCheck.expectedUsd).not.toBeCloseTo(wrongExpectedUsd, 6);
  });

  it("case 20 (M-2 fixture): an oversized replay floor produces a losing uncapped counterfactual (netMultiplierUncapped < 1)", () => {
    // ctx grows 20k -> 90k under T=50k: one simulated compaction fires. floor=590k is a wildly
    // pessimistic floor (e.g. fitted from a fleet whose OTHER agents compact much higher) — the
    // capped path clamps the rewritten size back down to the real ctx (90k), but the uncapped
    // counterfactual carries the full floor+delta (660k) into the next call's write price.
    const events = [agentStarted("a1"), ...ramp("a1", [20_000, 90_000])];
    const series = seriesOf(events, "a1");
    const T = 50_000;
    const floor = 590_000;
    const r = replayThreshold(series, T, floor);
    expect(r.compactions).toBe(1);
    expect(r.usdUncapped).toBeGreaterThan(r.usd);

    const actualUsd = series.reduce((sum: number, row: unknown) => sum + priceUsage(row, MODEL), 0);
    const netMultiplier = actualUsd / r.usd;
    const netMultiplierUncapped = actualUsd / r.usdUncapped;
    expect(netMultiplierUncapped).toBeLessThan(1);
    expect(netMultiplierUncapped).toBeLessThan(netMultiplier);
  });

  // F39.QA M-3 — the recommendation rested on a single READ_RATE/WRITE_RATE pair with no evidence
  // it survives realistic billed-vs-list pricing variation. report.sensitivity grids that out.
  it("case 21 (M-3 fixture): report.sensitivity is a full READ_RATE x WRITE_RATE grid at the recommended threshold/floor", () => {
    // No compaction completions here (unlike case 6, which deliberately observes a 150k max
    // floor to prove rejection) — floors fall back to POST_COMPACTION_FLOORS (max=23,526), so a
    // long high ctx ramp clears MIN_NET_MULTIPLIER even at the pessimistic floor, and `ramp` only
    // ever sets cache reads (no cache_creation), so firstCacheWrites is 0 and prefixBar is 0 —
    // every THRESHOLD_SWEEP value trivially clears the T >= prefixBar gate too.
    const events = [agentStarted("a1"), ...ramp("a1", Array.from({ length: 40 }, (_, i) => 20_000 + i * 12_000))];
    const report = buildCompactionReport(events);
    expect(report.recommendation.threshold).not.toBeNull();
    expect(report.sensitivity).not.toBeNull();
    expect(report.sensitivity.thresholdEvaluated).toBe(report.recommendation.threshold);

    const expectedPairs = new Set(SENSITIVITY_READ_RATES.flatMap((r: number) => SENSITIVITY_WRITE_RATES.map((w: number) => `${r}:${w}`)));
    expect(report.sensitivity.grid).toHaveLength(SENSITIVITY_READ_RATES.length * SENSITIVITY_WRITE_RATES.length);
    const actualPairs = new Set(report.sensitivity.grid.map((c: { readRate: number; writeRate: number }) => `${c.readRate}:${c.writeRate}`));
    expect(actualPairs).toEqual(expectedPairs);

    // the baseline cell (the sweep's own rates) must agree with the sweep row it's grading against
    const baselineCell = report.sensitivity.grid.find((c: { readRate: number; writeRate: number }) => c.readRate === READ_RATE && c.writeRate === WRITE_RATE);
    const sweepRow = report.sweep.find(
      (r: { floorLabel: string; threshold: number | null }) => r.floorLabel === "max" && r.threshold === report.recommendation.threshold,
    );
    expect(baselineCell.netMultiplier).toBeCloseTo(sweepRow.netMultiplier, 6);

    expect(report.sensitivity.allClearBar).toBe(
      report.sensitivity.grid.every((c: { netMultiplier: number }) => c.netMultiplier >= MIN_NET_MULTIPLIER),
    );
  });

  // F39.FIX M-2 — the cross-check as first landed reported a mismatch on EVERY real log (measured
  // -$18.87), because a third asymmetry was missing from expectedLedgerUsd. Cases 22/23 pin both
  // halves: the known asymmetry must not fire, and a genuinely divergent series must.
  it("case 22: an agent whose agent_started was pruned out of the window does NOT trip the ledger cross-check", () => {
    // "a2" has usage but no agent_started: buildCallSeries admits it (its guard is
    // `if (agent && agent.provider !== "claude")`), buildSpendLedger books it to the
    // `unattributed` bucket and out of modelledListUsd. A retained window that has rolled even one
    // segment always contains such an agent, so this is the real-log case.
    const events = [agentStarted("a1"), ...ramp("a1", [50_000, 90_000]), ...ramp("a2", [40_000, 70_000])];
    const report = buildCompactionReport(events);
    expect(report.selfCheck.ledgerCrossCheck.unattributedSeriesUsd).toBeGreaterThan(0);
    expect(report.selfCheck.ledgerCrossCheck.withinTolerance).toBe(true);

    // and the term is load-bearing: without it the check would have reported a mismatch here
    const naiveExpectedUsd = report.actual.usd + report.selfCheck.ledgerCrossCheck.excludedLedgerBillableUsd;
    expect(Math.abs(report.selfCheck.ledgerCrossCheck.modelledListUsd - naiveExpectedUsd)).toBeGreaterThan(LEDGER_CROSS_CHECK_TOLERANCE_USD);
  });

  it("case 23: a series that disagrees with the ledger about which turn a message_delta belongs to DOES trip the cross-check", () => {
    // The seam: spendAcc.add returns early on a `synthetic` row WITHOUT flushing its open turn, so
    // the following message_delta re-emission lands on the preceding REAL turn. claudeTurns
    // flushes instead, so the same delta lands on the SYNTHETIC row — which is then dropped from
    // `series` and (being explicitly marked) never counted into excludedLedgerBillableUsd either.
    // Same events, two different bills: exactly the "series built from the wrong rows" failure the
    // cross-check exists to catch. This test is coupled to that early return on purpose — a future
    // fix to either side should break it and be re-judged, not silently absorbed.
    const events = [
      agentStarted("a1"),
      ...ramp("a1", [50_000]),
      start("a1", { read: 60_000, output: 10 }),
      ev("usage", "a1", {
        usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 13_000, output_tokens: 0 },
        synthetic: "compaction-baseline",
      }),
      delta("a1", { read: 60_000, output: 1_000_000 }),
    ];
    const report = buildCompactionReport(events);
    expect(report.selfCheck.ledgerCrossCheck.withinTolerance).toBe(false);
    // orders of magnitude past the tolerance, not a rounding artefact
    expect(Math.abs(report.selfCheck.ledgerCrossCheck.deltaUsd)).toBeGreaterThan(1);
    // A6a still says "exact" on the very same report — which is the whole point of M-2: the
    // tautological self-check cannot see this, and the cross-check can.
    expect(report.selfCheck.exact).toBe(true);
  });

  // F39.FIX M-3 — the grid is keyed to recommendation.threshold, which moves with the retained
  // window; the number shipped to every agent does not. The artifact must answer for BOTH.
  it("case 24: FLEET_DEFAULT_THRESHOLD tracks DEFAULT_COMPACTION_THRESHOLD.claude and gets its own grid", () => {
    // audit-lib is plain .mjs run by `node` and cannot import the TS const, so this is the pin
    // that stops the two drifting apart.
    expect(FLEET_DEFAULT_THRESHOLD).toBe(DEFAULT_COMPACTION_THRESHOLD.claude);

    const events = [agentStarted("a1"), ...ramp("a1", Array.from({ length: 40 }, (_, i) => 20_000 + i * 12_000))];
    const report = buildCompactionReport(events);
    const fd = report.sensitivity.fleetDefault;
    expect(fd.thresholdEvaluated).toBe(FLEET_DEFAULT_THRESHOLD);
    expect(fd.floorEvaluated).toBe(report.sensitivity.floorEvaluated);
    expect(fd.grid).toHaveLength(SENSITIVITY_READ_RATES.length * SENSITIVITY_WRITE_RATES.length);
    expect(fd.allClearBar).toBe(fd.grid.every((c: { netMultiplier: number }) => c.netMultiplier >= MIN_NET_MULTIPLIER));
  });

  // F45.QA-B leftover #3 — buildCompactionReport takes 7 internal passes over `events`; it must
  // accept a re-iterable factory (compaction-audit.mjs's new `() => readEvents(HOME)`, re-reading
  // the log per pass instead of holding it materialized) and still produce the identical report a
  // plain array produces, since every existing fixture in this file passes an array.
  it("case 25: buildCompactionReport accepts a re-iterable factory and a materialized array interchangeably", () => {
    const events = [agentStarted("a1"), ...ramp("a1", [20_000, 90_000, 240_000, 620_000])];
    let calls = 0;
    const factory = () => {
      calls++;
      return events;
    };
    const viaFactory = buildCompactionReport(factory);
    const viaArray = buildCompactionReport(events);
    expect(viaFactory).toEqual(viaArray);
    // 7 internal passes: indexAgents, the firstTs/lastTs scan, buildCallSeries, indexCompactions,
    // buildSpendLedger, firstCacheWrites, classifyPostCompactionCalls
    expect(calls).toBeGreaterThanOrEqual(7);
  });

  // F39.THRESHOLD-DECISION — the fleet-default caveat used to fire "needs revisiting" on ANY
  // sub-bar cell, so every run re-opened the keep-120k ruling. The grid's lowest cells assume
  // readRate 0.05, half the multiplier Anthropic actually charges (READ_RATE); cases 26/27 pin
  // that the alarm is now reserved for grids that fail where it counts.
  it("case 26: a grid that clears at BASELINE and stays above break-even reports a settled decision, not 'needs revisiting'", () => {
    // 24 calls, gentle ctx ramp with a real cache write on every one — the write leg damps the
    // read-rate spread, so the 0.05 cells land in (1.0, 1.10): sub-bar but never loss-making.
    const events = [
      agentStarted("a1"),
      ...Array.from({ length: 24 }, (_, i) => start("a1", { read: 20_000 + i * 6_000, write: 10_000, output: 500 })),
    ];
    const report = buildCompactionReport(events);
    const fd = report.sensitivity.fleetDefault;
    expect(fd.allClearBar).toBe(false);
    expect(fd.clearsAtBaseline).toBe(true);
    expect(fd.minAboveBreakeven).toBe(true);
    // the two new fields mean what they say
    const baselineCell = fd.grid.find((c: { readRate: number; writeRate: number }) => c.readRate === READ_RATE && c.writeRate === WRITE_RATE);
    expect(baselineCell.netMultiplier).toBeGreaterThanOrEqual(MIN_NET_MULTIPLIER);
    expect(fd.minNetMultiplier).toBeGreaterThanOrEqual(1.0);
    expect(fd.minNetMultiplier).toBeLessThan(MIN_NET_MULTIPLIER);

    const sensitivityCaveats = report.caveats.filter((c: string) => c.startsWith("SENSITIVITY"));
    expect(sensitivityCaveats.some((c: string) => c.includes("needs revisiting"))).toBe(false);
    const informational = sensitivityCaveats.find((c: string) => c.includes(`the SHIPPED fleet default (${FLEET_DEFAULT_THRESHOLD})`));
    expect(informational).toBeDefined();
    expect(informational).toContain("informational, decision settled");
    // it must name the baseline value, the grid min, and why the sub-bar cells don't count
    expect(informational).toContain(baselineCell.netMultiplier.toFixed(4));
    expect(informational).toContain(fd.minNetMultiplier.toFixed(4));
    expect(informational).toContain("readRate 0.05");
  });

  it("case 27: a grid that misses the bar AT BASELINE still demands DEFAULT_COMPACTION_THRESHOLD be revisited", () => {
    // Same shape, but a steep read-only ramp: no cache writes to damp the spread, so 120k loses
    // money at the rates actually billed.
    const events = [agentStarted("a1"), ...ramp("a1", Array.from({ length: 16 }, (_, i) => 20_000 + i * 25_000))];
    const report = buildCompactionReport(events);
    const fd = report.sensitivity.fleetDefault;
    expect(fd.clearsAtBaseline).toBe(false);
    expect(fd.minAboveBreakeven).toBe(false);

    const fdCaveat = report.caveats.find((c: string) => c.startsWith("SENSITIVITY") && c.includes(`the SHIPPED fleet default (${FLEET_DEFAULT_THRESHOLD})`));
    expect(fdCaveat).toContain("needs revisiting");
    expect(fdCaveat).not.toContain("decision settled");
    expect(fdCaveat).toContain("BASELINE rates");
  });
});
