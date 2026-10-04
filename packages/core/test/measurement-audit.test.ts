// F45 — scripts/audit-lib.mjs is a pure module outside packages/*/src (plan §2.0), imported by
// relative path since packages/core/tsconfig.json's include:["src"] means this file (and the
// .mjs it imports) is never typechecked. Written failing-first against the frozen §2.6 shape.
import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - plain JS module, not part of this package's typecheck surface (tsconfig include:["src"])
import { buildReport, turnKey, classifyTool, buildSpendLedger, indexAgents, perAgentCallTimes, normalizeModel, TOOL_RESULT_MAX_CHARS } from "../../../scripts/audit-lib.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function ev(kind: string, agentId: string, data: Record<string, unknown> = {}, opts: { ts?: number; raw?: unknown } = {}) {
  seq += 1;
  const e: Record<string, unknown> = {
    ts: opts.ts ?? seq,
    seq,
    engineId: "local",
    agentId,
    kind,
    data,
  };
  if (opts.raw !== undefined) e.raw = opts.raw;
  return e;
}

function agentStarted(agentId: string, over: Record<string, unknown> = {}, raw: Record<string, unknown> | undefined = undefined, ts = 0) {
  return ev(
    "agent_started",
    agentId,
    { provider: "claude", conductor: false, depth: 0, model: "claude-sonnet-5", mcpServers: [], ...over },
    { ts, ...(raw !== undefined ? { raw } : {}) },
  );
}

describe("audit-lib", () => {
  it("case 1: groups tool_calls into turns by data.turnId", () => {
    const events = [
      agentStarted("a1"),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1", turnId: "t1" }, { ts: 10 }),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u2", turnId: "t1" }, { ts: 11 }),
    ];
    const report = buildReport(events);
    expect(report.l3.byRole["worker-d0"].turns).toBe(1);
    expect(report.l3.byRole["worker-d0"].toolCalls).toBe(2);
    expect(report.l3.byRole["worker-d0"].histogram["2"]).toBe(1);
    expect(report.l3.ungrouped).toBe(0);
  });

  it("case 2: falls back to raw.message.id when data.turnId is absent, with an identical histogram", () => {
    const events = [
      agentStarted("a1"),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1" }, { ts: 10, raw: { message: { id: "m1" } } }),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u2" }, { ts: 11, raw: { message: { id: "m1" } } }),
    ];
    const report = buildReport(events);
    expect(report.l3.byRole["worker-d0"].turns).toBe(1);
    expect(report.l3.byRole["worker-d0"].toolCalls).toBe(2);
    expect(report.l3.byRole["worker-d0"].histogram["2"]).toBe(1);
  });

  it("case 3: bySpawnCohort keeps a pre-cutoff agent in the before window even when its calls land after", () => {
    const cutoffTs = 1000;
    const events = [
      agentStarted("a1", {}, undefined, 500), // spawned before cutoff
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1", turnId: "t1" }, { ts: 2000 }), // call lands after
    ];
    const report = buildReport(events, { since: cutoffTs });
    const zero = report.l3.cutoffs.find((c: { label: string }) => c.label === "+0h");
    expect(zero.bySpawnCohort.before.turns).toBe(1);
    expect(zero.bySpawnCohort.after.turns).toBe(0);
    expect(zero.byEventTs.before.turns).toBe(0);
    expect(zero.byEventTs.after.turns).toBe(1);
  });

  it("case 4: a tool_call with neither turnId nor raw.message.id increments ungrouped and is not a 1-call turn", () => {
    const events = [agentStarted("a1"), ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1" }, { ts: 10 })];
    const report = buildReport(events);
    expect(report.l3.ungrouped).toBe(1);
    expect(report.l3.byRole["worker-d0"].turns).toBe(0);
    expect(report.l3.byRole["worker-d0"].histogram["1"]).toBe(0);
  });

  it("case 5: emits one after-window row per cutoff (+0h, +6h, +24h)", () => {
    const events = [agentStarted("a1"), ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1", turnId: "t1" }, { ts: 10 })];
    const report = buildReport(events, { since: 0 });
    expect(report.l3.cutoffs.map((c: { label: string }) => c.label)).toEqual(["+0h", "+6h", "+24h"]);
    expect(report.l3.cutoffs).toHaveLength(3);
  });

  it("case 6: joins tool_result.toolId to tool_call.toolUseId to recover toolName", () => {
    const events = [
      agentStarted("a1"),
      ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "hello" }, { ts: 11 }),
    ];
    const report = buildReport(events);
    expect(report.q3.byClass["sdk-native"].results).toBe(1);
    expect(report.q3.byClass["sdk-native"].chars).toBe(5);
    expect(report.q3.unjoined.results).toBe(0);
  });

  it("case 7: a tool_result with no retained tool_call lands in q3.unjoined", () => {
    const events = [agentStarted("a1"), ev("tool_result", "a1", { toolId: "ghost", result: "orphan" }, { ts: 11 })];
    const report = buildReport(events);
    expect(report.q3.unjoined.results).toBe(1);
    expect(report.q3.unjoined.chars).toBe(6);
  });

  it("case 8: a result at exactly TOOL_RESULT_MAX_CHARS is counted truncated and adds a caveat", () => {
    const bigResult = "x".repeat(TOOL_RESULT_MAX_CHARS);
    const events = [
      agentStarted("a1"),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: bigResult }, { ts: 11 }),
    ];
    const report = buildReport(events);
    expect(report.q3.byClass["chimera-served"].truncatedCount).toBe(1);
    expect(report.caveats.some((c: string) => c.includes("floor"))).toBe(true);
  });

  it("case 9: spend sums claude usage events and generic result.costUsd into one denominator", () => {
    const events = [
      agentStarted("claude-a", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev(
        "usage",
        "claude-a",
        { usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
        { ts: 10 },
      ),
      agentStarted("generic-a", { provider: "zai-coding", model: null }, undefined, 0),
      ev("result", "generic-a", { costUsd: 0.5 }, { ts: 20 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    expect(ledger.byProviderClass.claude).toBeCloseTo(3, 5); // 1M fresh tokens @ $3/Mtok
    expect(ledger.byProviderClass.generic).toBeCloseTo(0.5, 5);
    expect(ledger.observedProviders["zai-coding"]).toBe(1);
  });

  it("case 22: observedProviders counts agent_started rows, including agents that never spent", () => {
    const events = [
      agentStarted("spender", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("usage", "spender", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }, { ts: 10 }),
      agentStarted("died-before-first-turn", { provider: "zai-coding" }, undefined, 1),
      // spend with no retained agent_started — its own bucket, not folded into a provider count
      ev("result", "ghost", { costUsd: 1 }, { ts: 20 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    expect(ledger.observedProviders).toEqual({ claude: 1, "zai-coding": 1 });
    expect(ledger.unattributedSpendAgents).toBe(1);
  });

  // QA finding 7: claude was priced from a 3-row list table while codex/generic came straight from
  // the SDK's own result.costUsd, so genericSharePct divided an SDK numerator by a modelled
  // denominator ~3x too large. Measured on the whole retained log: modelled $5848.04 vs SDK
  // $1389.42 across the 292 of 344 claude agents that report a cost.
  it("case 25: a claude agent that reports result.costUsd is priced from the SDK, not the list table", () => {
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    const events = [
      agentStarted("claude-a", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("usage", "claude-a", { usage }, { ts: 10, raw: { event: { type: "message_start", message: { model: "claude-sonnet-5" } } } }),
      // total_cost_usd is CUMULATIVE per run, so the max wins — the same rule codex already used.
      ev("result", "claude-a", { costUsd: 0.4 }, { ts: 11 }),
      ev("result", "claude-a", { costUsd: 1.1 }, { ts: 12 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    expect(ledger.byProviderClass.claude).toBeCloseTo(1.1, 6);
    expect(ledger.claudeSpend).toMatchObject({ sdkUsd: 1.1, sdkAgents: 1, modelledFallbackAgents: 0, modelledFallbackUsd: 0 });
    // ...and the list-price model is still reported beside it, as a second unit.
    expect(ledger.modelledListUsd).toBeCloseTo(3, 6); // 1M fresh tokens @ $3/Mtok
  });

  it("case 26: a claude agent with usage but no result.costUsd falls back to the modelled price, flagged", () => {
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    const events = [
      agentStarted("has-result", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("usage", "has-result", { usage }, { ts: 10 }),
      ev("result", "has-result", { costUsd: 0.5 }, { ts: 11 }),
      agentStarted("no-result", { provider: "claude", model: "claude-opus-5[1m]" }, undefined, 1),
      ev("usage", "no-result", { usage }, { ts: 12 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    // 0.5 SDK + 1M fresh @ $15/Mtok modelled for the agent that never reported a cost.
    expect(ledger.byProviderClass.claude).toBeCloseTo(0.5 + 15, 6);
    expect(ledger.claudeSpend).toMatchObject({ sdkAgents: 1, modelledFallbackAgents: 1 });
    expect(ledger.claudeSpend.modelledFallbackUsd).toBeCloseTo(15, 6);
    expect(ledger.modelledListUsd).toBeCloseTo(3 + 15, 6);
  });

  it("case 27: gates.q4.floor tracks the FALLBACK misses, not misses that only touch modelledListUsd", () => {
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    // An unpriced model on an SDK-priced agent cannot make the gate a floor: its spend came from
    // the SDK, and the price table never touched the number the gate divides by.
    const sdkPriced = buildReport([
      agentStarted("a1", { provider: "claude", model: "claude-fable-5-1" }, undefined, 0),
      ev("usage", "a1", { usage }, { ts: 10 }),
      ev("result", "a1", { costUsd: 2 }, { ts: 11 }),
    ]);
    expect(sdkPriced.spend.priceTableMisses).toEqual(["claude-fable-5-1"]);
    expect(sdkPriced.spend.claudeSpend.fallbackPriceTableMisses).toEqual([]);
    expect(sdkPriced.gates.q4.floor).toBe(false);
    expect(sdkPriced.spend.byProviderClass.claude).toBeCloseTo(2, 6);

    // The same unpriced model on a fallback agent DOES: its $0 shrinks the gate's denominator.
    const fallback = buildReport([
      agentStarted("a1", { provider: "claude", model: "claude-fable-5-1" }, undefined, 0),
      ev("usage", "a1", { usage }, { ts: 10 }),
    ]);
    expect(fallback.spend.claudeSpend.fallbackPriceTableMisses).toEqual(["claude-fable-5-1"]);
    expect(fallback.gates.q4.floor).toBe(true);

    // The unit mismatch itself is always named in caveats[] (§2.6: every honesty note is machine-readable).
    expect(sdkPriced.caveats.some((c: string) => c.includes("MIXES UNITS"))).toBe(true);
  });

  // F45.QA-B leftover #1: the synthetic post-compaction usage exclusion (F39.QA) dropped phantom
  // spend silently — buildSpendLedger's finish() must surface how much it dropped.
  it("case 28: buildSpendLedger reports syntheticUsageEvents/syntheticInputTokens and excludes them from spend", () => {
    const events = [
      agentStarted("a1", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("usage", "a1", { usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }, { ts: 10, raw: { event: { type: "message_start", message: { model: "claude-sonnet-5" } } } }),
      // the post-compaction reset: explicit marker, no raw.event — must be excluded from spend but counted
      ev("usage", "a1", { usage: { input_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, synthetic: "compaction-baseline" }, { ts: 11 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    expect(ledger.syntheticUsageEvents).toBe(1);
    expect(ledger.syntheticInputTokens).toBe(500_000);
    // only the real 1M-token turn is billed; the synthetic 500k reset is not
    expect(ledger.byProviderClass.claude).toBeCloseTo(3, 5); // 1M fresh tokens @ $3/Mtok
  });

  it("case 10: kimi turns are reported unmeasurable and excluded from the denominator, not counted as $0", () => {
    const events = [
      agentStarted("kimi-a", { provider: "kimi", model: null }, undefined, 0),
      ev("result", "kimi-a", { costUsd: 0 }, { ts: 10 }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    expect(ledger.unmeasurable).toEqual([{ provider: "kimi", agents: 1, turns: 1 }]);
    expect(ledger.byProviderClass.generic).toBe(0);
    expect(ledger.byProviderClass.codex).toBe(0);
    expect(ledger.genericSharePct).toBe(0);
  });

  it("case 11: classifies from agent_started.raw.tools when present, by mcp__ prefix when absent", () => {
    const events = [
      agentStarted("with-tools", {}, { tools: ["mcp__chimera__agent_spawn"] }, 0),
      ev("tool_call", "with-tools", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "with-tools", { toolId: "u1", result: "ok" }, { ts: 11 }),

      agentStarted("no-tools", {}, undefined, 0),
      ev("tool_call", "no-tools", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u2" }, { ts: 12 }),
      ev("tool_result", "no-tools", { toolId: "u2", result: "ok" }, { ts: 13 }),
    ];
    const report = buildReport(events);
    expect(report.q3.byClass["chimera-served"].results).toBe(2);
    expect(classifyTool("mcp__chimera__agent_spawn", new Set(["mcp__chimera__agent_spawn"]))).toBe("chimera-served");
    expect(classifyTool("mcp__chimera__agent_spawn", undefined)).toBe("chimera-served");
  });

  it("case 12: dollar weighting multiplies result tokens by the agent's subsequent usage-event count", () => {
    const events = [
      agentStarted("a1", { model: "claude-sonnet-5" }, undefined, 0),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(4000) }, { ts: 11 }),
      ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: 20 }),
      ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: 30 }),
    ];
    const report = buildReport(events);
    // tokens = 4000/4 = 1000; subsequentCalls = 2; price.input = 3; READ_RATE = 0.1
    const expected = ((1000 * 2) / 1e6) * 3 * 0.1;
    expect(report.q3.byClass["chimera-served"].dollarUsd).toBeCloseTo(expected, 8);
  });

  it("case 13: gate boundaries: 15.0%/20.0% reopen, 14.9%/19.9% close", () => {
    const q4Report = (generic: number, codex: number) =>
      buildReport([
        agentStarted("codex-a", { provider: "codex", model: null }, undefined, 0),
        ev("result", "codex-a", { costUsd: codex }, { ts: 10 }),
        agentStarted("generic-a", { provider: "zai-coding", model: null }, undefined, 0),
        ev("result", "generic-a", { costUsd: generic }, { ts: 10 }),
      ]);
    expect(q4Report(150, 850).gates.q4.verdict).toBe("reopen"); // 150/1000 = 15.0%
    expect(q4Report(149, 851).gates.q4.verdict).toBe("close"); // 149/1000 = 14.9%

    const q3Report = (reachableChars: number, reachableSub: number, unreachableChars: number, unreachableSub: number) => {
      const events: unknown[] = [agentStarted("a1", { model: "claude-sonnet-5" }, undefined, 0)];
      events.push(ev("tool_call", "a1", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u1" }, { ts: 10 }));
      events.push(ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(reachableChars) }, { ts: 11 }));
      events.push(ev("tool_call", "a1", { toolName: "Bash", toolUseId: "u2" }, { ts: 12 }));
      events.push(ev("tool_result", "a1", { toolId: "u2", result: "x".repeat(unreachableChars) }, { ts: 13 }));
      let ts = 100;
      for (let i = 0; i < Math.max(reachableSub, unreachableSub); i++) {
        events.push(ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: ts++ }));
      }
      return buildReport(events);
    };
    // reachable product 1000 (chars 4000, sub 1), unreachable product 4000 (chars 8000, sub 2) -> 1000/5000 = 20.0%
    expect(q3Report(4000, 1, 8000, 2).gates.q3.verdict).toBe("reopen");
    // reachable product 199 (chars 796, sub 1), unreachable product 801 (chars 3204, sub 1) -> 199/1000 = 19.9%
    expect(q3Report(796, 1, 3204, 1).gates.q3.verdict).toBe("close");
  });

  it("case 14: surface buckets with n<5 carry lowN:true", () => {
    const events: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `a${i}`;
      events.push(agentStarted(id, { mcpServers: [] }, undefined, 0));
      events.push(ev("usage", id, { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0 } }, { ts: 10 + i }));
    }
    const report = buildReport(events);
    const bucketZero = report.surface.byServerCount.find((b: { bucket: string }) => b.bucket === "0");
    expect(bucketZero.n).toBe(3);
    expect(bucketZero.lowN).toBe(true);
  });

  it("case 15: buildReport returns exactly the frozen top-level keys", () => {
    const report = buildReport([agentStarted("a1")]);
    expect(Object.keys(report).sort()).toEqual(
      ["baseline", "caveats", "eventsHome", "gates", "l3", "l4", "q3", "schemaVersion", "spend", "surface", "window"].sort(),
    );
  });

  it("turnKey: prefers data.turnId, falls back to raw.message.id, else null", () => {
    expect(turnKey({ data: { turnId: "t1" } })).toBe("t1");
    expect(turnKey({ data: {}, raw: { message: { id: "m1" } } })).toBe("m1");
    expect(turnKey({ data: {} })).toBeNull();
  });

  // ---- QA of 8f105070: regressions the landed feature claimed but never pinned ----

  // The F45.0 commit message claims "dedupes claude's double-emitted usage ... so spend figures
  // aren't ~2x", and nothing tested it. Verified on the real log: message_start and message_delta
  // arrive 1:1 (199/200 in the newest segment), so a naive sum is 1.96x the truth.
  it("case 17: a message_start + message_delta usage pair is ONE priced turn, not two", () => {
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 };
    const events = [
      agentStarted("a1", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("usage", "a1", { usage }, { ts: 10, raw: { event: { type: "message_start", message: { model: "claude-sonnet-5" } } } }),
      // claude.ts:1012-1021 re-emits the SAME read/write/fresh with only output ticking up.
      ev("usage", "a1", { usage: { ...usage, output_tokens: 500 } }, { ts: 11, raw: { event: { type: "message_delta" } } }),
    ];
    const ledger = buildSpendLedger(events, indexAgents(events));
    // ONE turn: 1M fresh @ $3/Mtok + 500 output @ $15/Mtok. A naive sum would be ~$6.01.
    expect(ledger.byProviderClass.claude).toBeCloseTo(3 + (500 / 1e6) * 15, 6);
    // ...and the same pair is ONE context read for Q3's dollar-weighting lookback.
    expect(perAgentCallTimes(events).get("a1")).toHaveLength(1);
  });

  // Root cause of the flipped F40 gate: agent_started.data.model keeps the `[1m]` context-beta
  // suffix, PRICES does not have that row, and computeQ3 silently weighted those agents at $0 —
  // 41% of all chimera-served bytes on the real log, biasing gates.q3 downward from 22% to 5%.
  it("case 18: a [1m] context-beta model id prices at the base rate, not $0", () => {
    expect(normalizeModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    const events = [
      agentStarted("a1", { model: "claude-opus-5[1m]" }, undefined, 0),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_result", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(4000) }, { ts: 11 }),
      ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: 20 }),
    ];
    const report = buildReport(events);
    // tokens 1000 x 1 subsequent read / 1e6 x $15 x READ_RATE 0.1
    expect(report.q3.byClass["chimera-served"].dollarUsd).toBeCloseTo((1000 / 1e6) * 15 * 0.1, 10);
    expect(report.q3.unpriced.results).toBe(0);
    expect(report.gates.q3.floor).toBe(false);
  });

  it("case 19: a result from a genuinely unpriced model is reported, not silently $0-weighted", () => {
    const events = [
      agentStarted("a1", { model: "claude-fable-5-1" }, undefined, 0),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_result", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(4000) }, { ts: 11 }),
      ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: 20 }),
    ];
    const report = buildReport(events);
    expect(report.q3.unpriced).toMatchObject({ results: 1, chars: 4000, models: ["claude-fable-5-1"] });
    expect(report.q3.unpriced.byClass["chimera-served"]).toBe(4000);
    expect(report.gates.q3.floor).toBe(true); // plan §6: an unpriced model makes the gate a floor
    expect(report.caveats.some((c: string) => c.includes("unpriced models"))).toBe(true);
  });

  it("case 20: byServerCount buckets are ordered by server count, not by string", () => {
    const events: unknown[] = [];
    const push = (id: string, n: number) => {
      events.push(agentStarted(id, { mcpServers: Array.from({ length: n }, (_, i) => ({ name: `s${i}` })) }, undefined, 0));
      events.push(ev("usage", id, { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 0 } }, { ts: 1 }));
    };
    push("z", 0);
    push("a", 3); // "2-5"
    push("b", 20); // "16+"
    const report = buildReport(events);
    expect(report.surface.byServerCount.map((b: { bucket: string }) => b.bucket)).toEqual(["0", "2-5", "16+"]);
  });

  it("case 21: a non-numeric --l4-bound falls back to the default instead of disabling overBound", () => {
    const events = [
      agentStarted("a1", { conductor: true }, undefined, 0),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_result", toolUseId: "u1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(9000) }, { ts: 11 }),
    ];
    const report = buildReport(events, { l4BoundChars: Number("abc") });
    expect(report.l4.boundChars).toBe(8000);
    expect(report.l4.conductors.overBound).toHaveLength(1);
  });

  it("case 16: CLI writes both artifacts and is idempotent for a given --date", () => {
    const home = mkdtempSync(join(tmpdir(), "measurement-audit-home-"));
    const eventsDir = join(home, "events");
    mkdirSync(eventsDir, { recursive: true });
    const lines = [
      JSON.stringify({ ts: 0, seq: 1, engineId: "local", agentId: "a1", kind: "agent_started", data: { provider: "claude", conductor: false, depth: 0, model: "claude-sonnet-5", mcpServers: [] } }),
      JSON.stringify({ ts: 10, seq: 2, engineId: "local", agentId: "a1", kind: "tool_call", data: { toolName: "Bash", toolUseId: "u1", turnId: "t1" } }),
      JSON.stringify({ ts: 11, seq: 3, engineId: "local", agentId: "a1", kind: "tool_result", data: { toolId: "u1", result: "ok" } }),
    ];
    writeFileSync(join(eventsDir, "events.0-2.jsonl"), lines.join("\n") + "\n");

    const outDir = mkdtempSync(join(tmpdir(), "measurement-audit-out-"));
    const script = fileURLToPath(new URL("../../../scripts/measurement-audit.mjs", import.meta.url));
    const date = "2026-01-01";
    const runCli = () => execFileSync("node", [script, "--home", home, "--date", date, "--out", outDir], { encoding: "utf8" });

    runCli();
    const mdPath = join(outDir, `${date}-measurement-audit.md`);
    const jsonPath = join(outDir, `${date}-measurement-audit.json`);
    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    const firstJson = readFileSync(jsonPath, "utf8");
    JSON.parse(firstJson);

    runCli();
    const secondJson = readFileSync(jsonPath, "utf8");
    const first = JSON.parse(firstJson);
    const second = JSON.parse(secondJson);
    delete first.generatedAt;
    delete second.generatedAt;
    expect(second).toEqual(first);
  });

  // Plan §6's memory mitigation: buildReport streams two passes over a re-iterable source instead
  // of materializing the log. The CLI now hands it `() => readEvents(home)`, so the factory path is
  // the one that produces the shipped artifact — it must be numerically identical to the array path
  // the other 23 cases exercise, or the two would silently drift apart.
  it("case 23: the () => Iterable factory path and the array path produce an identical report", () => {
    const events: unknown[] = [
      agentStarted("conductor-a", { provider: "claude", conductor: true, model: "claude-opus-5[1m]" }, { tools: ["mcp__chimera__agent_result"] }, 0),
      agentStarted("worker-a", { provider: "claude", model: "claude-sonnet-5", mcpServers: [{ name: "chimera" }] }, undefined, 1),
      agentStarted("generic-a", { provider: "zai-coding", model: null }, undefined, 2),
      ev("tool_call", "conductor-a", { toolName: "mcp__chimera__agent_result", toolUseId: "u1", turnId: "t1" }, { ts: 10 }),
      ev("tool_result", "conductor-a", { toolId: "u1", result: "x".repeat(TOOL_RESULT_MAX_CHARS) }, { ts: 11 }),
      ev("tool_call", "conductor-a", { toolName: "mcp__chimera__chimera_call", toolUseId: "u2", turnId: "t1" }, { ts: 12 }),
      ev("tool_result", "conductor-a", { toolId: "u2", result: "y".repeat(9000) }, { ts: 13 }),
      ev("tool_call", "worker-a", { toolName: "Bash", toolUseId: "u3" }, { ts: 14, raw: { message: { id: "m1" } } }),
      ev("tool_result", "worker-a", { toolId: "u3", result: "ok" }, { ts: 15 }),
      ev("tool_result", "worker-a", { toolId: "no-such-call", result: "orphan" }, { ts: 16 }),
      ev("usage", "conductor-a", { usage: { input_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 800, output_tokens: 40 } }, { ts: 20, raw: { event: { type: "message_start", message: { model: "claude-opus-5" } } } }),
      ev("usage", "conductor-a", { usage: { input_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 800, output_tokens: 700 } }, { ts: 21, raw: { event: { type: "message_delta" } } }),
      ev("usage", "worker-a", { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 } }, { ts: 22 }),
      ev("result", "generic-a", { costUsd: 0.25 }, { ts: 23 }),
      ev("result", "generic-a", { costUsd: 0.75 }, { ts: 24 }),
      ev("status", "worker-a", { toolSurface: { approxTokens: 3831 } }, { ts: 25 }),
      // spend from an agent whose agent_started fell out of the retained window
      ev("result", "ghost", { costUsd: 2 }, { ts: 26 }),
    ];
    // The `--l4-bound` is set below the 9000-char return so overBound is non-empty in both paths.
    const opts = { since: 0, l4BoundChars: 8000, eventsHome: "/synthetic", segments: 1 };
    const fromArray = buildReport(events, opts);
    const fromFactory = buildReport(() => events[Symbol.iterator](), opts);
    expect(fromFactory).toEqual(fromArray);
    // Guard against the trivial pass: the fixture must actually exercise the metrics.
    expect(fromArray.window.events).toBe(events.length);
    expect(fromArray.q3.byClass["chimera-served"].results).toBe(2);
    expect(fromArray.q3.unjoined.results).toBe(1);
    expect(fromArray.l4.conductors.overBound.length).toBeGreaterThan(0);
    // 0.75 (generic-a, max of its two cumulative costUsd rows) + 2 (the ghost: an agent with no
    // retained agent_started has provider "?" and lands in the generic bucket — which is exactly
    // why unattributedSpendAgents is reported beside the share).
    expect(fromArray.spend.byProviderClass.generic).toBeCloseTo(2.75, 6);
    expect(fromArray.spend.unattributedSpendAgents).toBe(1);
  });

  // A one-shot generator is NOT re-iterable: buildReport must materialize it once rather than let
  // pass 2 see an exhausted iterator and silently report an empty L3/Q3/L4/spend.
  it("case 24: a bare one-shot iterator is materialized, not consumed empty by the second pass", () => {
    const events = [
      agentStarted("a1", { provider: "claude", model: "claude-sonnet-5" }, undefined, 0),
      ev("tool_call", "a1", { toolName: "mcp__chimera__agent_spawn", toolUseId: "u1", turnId: "t1" }, { ts: 10 }),
      ev("tool_result", "a1", { toolId: "u1", result: "x".repeat(4000) }, { ts: 11 }),
      ev("usage", "a1", { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, { ts: 20 }),
    ];
    function* gen() {
      yield* events;
    }
    const fromGenerator = buildReport(gen(), { since: 0 });
    expect(fromGenerator).toEqual(buildReport(events, { since: 0 }));
    expect(fromGenerator.q3.byClass["chimera-served"].results).toBe(1);
  });
});
