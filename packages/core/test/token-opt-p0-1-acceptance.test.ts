// TOKEN-OPT-P0-1 acceptance: a scripted 3-turn agent per backend, verifying billableUsage ×
// pricing reproduces the recorded cost (cost-scope, cumulative) while contextUsage stays a
// bounded, current-context figure (ctx-scope, last-turn-only) — the two scopes the ledger used
// to conflate into one field, undercounting cache-read by however many turns a run made.
import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema, computeCostUsd, MODEL_CONTEXT_WINDOWS } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import { CodexAgentBackend } from "@chimera/core/backends/codex";
import { usageFromRaw } from "@chimera/core/budget";
import type { AgentHandle, BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { fakeCodex, cxSpec, settle } from "./codex-backend-helpers.js";

type Msg = Record<string, unknown>;
function fakeClaudeQuery(messages: Msg[]) {
  const fn = (() => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: vi.fn(async () => {}),
  })) as never;
  return fn;
}
function claudeSpec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "acc-claude", accountName: "main", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "acc-claude", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}

describe("TOKEN-OPT-P0-1 acceptance", () => {
  it("claude: a 3-turn run's billableUsage × pricing reproduces costUsd; contextUsage stays within the context window", async () => {
    const MODEL = "claude-sonnet-5";
    const WINDOW = MODEL_CONTEXT_WINDOWS[MODEL]!;
    // Cumulative SDK usage grows every turn (the SDK's own "result" message usage is
    // session-cumulative, per claude.ts's TOKEN-OPT-P4 doc comment). Turn 3's cumulative input
    // alone already exceeds the context window — a stand-in for a long conductor session — while
    // each turn's OWN live prompt (contextUsage) stays comfortably inside it.
    // CTX-WINDOW-5-SERIES: scaled up when claude-sonnet-5's real window was corrected 200k -> 1M.
    // The fixture's whole job is that the CUMULATIVE tally overruns the window while each turn's
    // own prompt does not, so the numbers have to sit either side of whatever the window is.
    const cumulativeAfterTurn = [
      { input_tokens: 500_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000 },
      { input_tokens: 1_010_000, output_tokens: 500, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 10_000 },
      { input_tokens: 1_520_000, output_tokens: 900, cache_read_input_tokens: 1_010_000, cache_creation_input_tokens: 15_000 },
    ];
    const liveTurnUsage = [
      { input_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000 },
      { input_tokens: 5_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000 },
      { input_tokens: 5_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000 },
    ];
    const finalUsage = cumulativeAfterTurn[2]!;
    const finalCostUsd = computeCostUsd(
      { input: finalUsage.input_tokens, output: finalUsage.output_tokens, cacheRead: finalUsage.cache_read_input_tokens, cacheCreation: finalUsage.cache_creation_input_tokens },
      MODEL,
    )!;
    expect(finalCostUsd).toBeGreaterThan(0);

    const script: Msg[] = [{ type: "system", subtype: "init", session_id: "s1", model: MODEL }];
    for (let i = 0; i < 3; i++) {
      script.push(
        { type: "stream_event", event: { type: "message_start", message: { usage: liveTurnUsage[i] } } },
        { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 100 } } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `turn ${i + 1}` }] } },
        {
          type: "result", subtype: "success", result: `turn ${i + 1} done`,
          total_cost_usd: i === 2 ? finalCostUsd : (i + 1) * 0.01,
          usage: cumulativeAfterTurn[i],
        },
      );
    }
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fakeClaudeQuery(script) }).spawn(claudeSpec({ model: MODEL }), (e) => evs.push(e), async () => true);
    await settle();

    const result = evs.filter((e) => e.kind === "result").at(-1)!;
    expect(result.data["costUsd"]).toBeCloseTo(finalCostUsd, 10);
    const billable = result.data["billableUsage"] as typeof finalUsage;
    expect(billable).toEqual(finalUsage);
    const recomputed = computeCostUsd(
      { input: billable.input_tokens, output: billable.output_tokens, cacheRead: billable.cache_read_input_tokens, cacheCreation: billable.cache_creation_input_tokens },
      MODEL,
    )!;
    expect(recomputed).toBeCloseTo(result.data["costUsd"] as number, 10);

    // contextUsage (last turn only) stays within the window; billableUsage (cumulative) does not
    // — exactly the scope distinction the split exists to preserve.
    const context = result.data["contextUsage"] as { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
    const contextTotal = context.input_tokens + context.cache_read_input_tokens + context.cache_creation_input_tokens;
    expect(contextTotal).toBeLessThanOrEqual(WINDOW);
    const billableTotal = billable.input_tokens + billable.cache_read_input_tokens + billable.cache_creation_input_tokens;
    expect(billableTotal).toBeGreaterThan(WINDOW);
  });

  it("codex: a 3-turn run's billableUsage × pricing reproduces costUsd, and shows nonzero cacheCreation from cache_write_input_tokens", async () => {
    const MODEL = "gpt-5.6-sol";
    const WINDOW = MODEL_CONTEXT_WINDOWS[MODEL]!;
    const turnUsage = [
      { input_tokens: 90_000, cached_input_tokens: 0, cache_write_input_tokens: 8_000, output_tokens: 200, reasoning_output_tokens: 50 },
      { input_tokens: 95_000, cached_input_tokens: 90_000, cache_write_input_tokens: 3_000, output_tokens: 250, reasoning_output_tokens: 60 },
      { input_tokens: 98_000, cached_input_tokens: 95_000, cache_write_input_tokens: 2_000, output_tokens: 300, reasoning_output_tokens: 70 },
    ];
    // Exec reports session totals on every completion, including all prior turns.
    const cumulativeUsage = turnUsage.map((_, index) => Object.fromEntries(
      Object.keys(turnUsage[0]!).map(key => [key, turnUsage.slice(0, index + 1).reduce((sum, usage) => sum + usage[key as keyof typeof usage], 0)]),
    ) as (typeof turnUsage)[number]);
    const turnWithUsage = (text: string, usage: (typeof turnUsage)[number]) => [
      { type: "item.completed" as const, item: { id: "a", type: "agent_message" as const, text } },
      { type: "turn.completed" as const, usage },
    ];
    const { factory } = fakeCodex([
      turnWithUsage("t1", cumulativeUsage[0]!),
      turnWithUsage("t2", cumulativeUsage[1]!),
      turnWithUsage("t3", cumulativeUsage[2]!),
    ]);
    const evs: BackendEvent[] = [];
    let turnsSent = 0;
    let h: AgentHandle;
    const sink = (e: BackendEvent) => {
      evs.push(e);
      if (e.kind === "turn_complete" && turnsSent < 2) { turnsSent++; void h.send(`go ${turnsSent}`); }
    };
    h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ model: MODEL }), sink, async () => true);
    await settle();

    const result = evs.find((e) => e.kind === "result")!;
    const billableRaw = result.data["billableUsage"] as Record<string, unknown>;
    const billable = usageFromRaw(billableRaw);

    // Nonzero cacheCreation from codex's cache_write_input_tokens (pinned SDK 0.145.0) — the old
    // toCostUsage hardcoded this to 0.
    expect(billable.cacheCreation).toBe(8_000 + 3_000 + 2_000);
    expect(billable.cacheCreation).toBeGreaterThan(0);

    // billableUsage is the SUM of all three turns (cumulativeUsage) — reproduces costUsd via the
    // SAME pricing table codex.ts itself used.
    const recomputed = computeCostUsd(billable, MODEL)!;
    expect(recomputed).toBeCloseTo(result.data["costUsd"] as number, 10);

    expect(billable.input + billable.cacheRead + billable.cacheCreation).toBe(283000);
    expect(billable.output).toBe(750); // reasoning is already included in output_tokens
    // This synthetic SDK stream has no rollout: cumulative totals cannot supply context.
    // codex-session-usage.test.ts verifies the actual rollout's last-request snapshot.
    expect(result.data["contextUsage"]).toBeNull();
  });
});
