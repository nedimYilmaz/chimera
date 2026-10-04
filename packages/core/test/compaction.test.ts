import { describe, it, expect } from "vitest";
import {
  charBudgetForTokenThreshold, compactMessages, resolveCompactionBudget,
  COMPACTION_WINDOW_SAFETY_FRACTION, DEFAULT_CHARS_PER_TOKEN, DEFAULT_COMPACTION_CHAR_BUDGET,
} from "@chimera/core/backends/compaction";
import type { ChatMessage } from "@chimera/core/backends/generic";

// Builds `n` synthetic "rounds": a user round, or an assistant(+tool) round when `withTool` is
// set -- mirrors exactly what generic.ts's run() loop pushes per round-trip (see
// compaction.ts's splitRounds comment).
function userRound(text: string): ChatMessage[] {
  return [{ role: "user", content: text }];
}
function toolRound(callId: string, resultText: string): ChatMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id: callId, name: "list_dir", arguments: "{}" }] },
    { role: "tool", toolCallId: callId, content: resultText },
  ];
}
function textRound(text: string): ChatMessage[] {
  return [{ role: "assistant", content: text }];
}

// Every assistant message's toolCalls[].id must be answered by a "tool" message somewhere
// later in the SAME array before the next user/assistant message -- catches orphaning from a
// compaction bug that splits a round in half.
function assertNoOrphanedToolCalls(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const answeredIds = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j]!.role === "tool"; j++) {
      answeredIds.add((messages[j] as { toolCallId: string }).toolCallId);
    }
    for (const tc of m.toolCalls) {
      expect(answeredIds.has(tc.id), `tool call ${tc.id} at index ${i} is orphaned`).toBe(true);
    }
  }
}

describe("compactMessages", () => {
  it("is a no-op (same reference) when under budget", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be helpful" },
      ...userRound("hello"),
      ...textRound("hi there"),
    ];
    expect(compactMessages(messages)).toBe(messages);
  });

  it("collapses the oldest rounds once over budget, preserving system + recent-K, no orphaned tool calls", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "be helpful" }];
    for (let i = 0; i < 40; i++) {
      messages.push(...toolRound(`call-${i}`, "x".repeat(3000)));
    }
    messages.push(...textRound("done"));

    const result = compactMessages(messages, { charBudget: 20_000, keepRecentRounds: 5 });
    expect(result).not.toBe(messages);

    // system preserved verbatim, first
    expect(result[0]).toEqual({ role: "system", content: "be helpful" });

    // a synthetic summary note was spliced in for the dropped rounds
    const summary = result[1] as { role: "user"; content: string };
    expect(summary.role).toBe("user");
    expect(summary.content).toContain("[compacted history]");

    // the most recent 5 tool rounds + the final text round survive untouched
    const lastToolRound = toolRound("call-39", "x".repeat(3000));
    expect(result.slice(-3, -1)).toEqual(lastToolRound);
    expect(result.at(-1)).toEqual({ role: "assistant", content: "done" });

    assertNoOrphanedToolCalls(result);

    // total size is now well under the raw (uncompacted) total
    const rawChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const compactedChars = result.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    expect(compactedChars).toBeLessThan(rawChars);
  });

  it("stays over budget rather than eating into the preserved recent-K window", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "s" }];
    for (let i = 0; i < 5; i++) messages.push(...toolRound(`call-${i}`, "x".repeat(1000)));
    // only 5 rounds exist, all inside the protected window -- nothing droppable
    const result = compactMessages(messages, { charBudget: 100, keepRecentRounds: 10 });
    expect(result).toBe(messages);
  });

  it("repeated compaction over a long-running single turn keeps carrying the summary forward without unbounded growth", () => {
    let messages: ChatMessage[] = [{ role: "system", content: "s" }];
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 15; i++) messages.push(...toolRound(`b${batch}-${i}`, "x".repeat(2000)));
      messages = compactMessages(messages, { charBudget: 30_000, keepRecentRounds: 8 });
      assertNoOrphanedToolCalls(messages);
    }
    const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    // bounded by the per-message truncation (tool-result.ts's 16k cap) applied to the summary
    // note, plus the preserved recent-K window -- nowhere near the ~120k chars of raw history.
    expect(totalChars).toBeLessThan(60_000);
  });

  // CODEX-COMPACTION-GAP acceptance check: confirms generic.ts's live default budget (the one
  // GenericAgentBackend.run() actually calls compactMessages() with, no options) still triggers
  // once history crosses 80k chars -- the openai-compat side of TOKEN-OPT-P3 stays live.
  it("triggers at the DEFAULT (no-options) 80k char budget", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "be helpful" }];
    for (let i = 0; i < 40; i++) messages.push(...toolRound(`call-${i}`, "x".repeat(3000)));
    expect(messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)).toBeGreaterThan(DEFAULT_COMPACTION_CHAR_BUDGET);

    const result = compactMessages(messages);
    expect(result).not.toBe(messages);
    expect((result[1] as { content: string }).content).toContain("[compacted history]");
    assertNoOrphanedToolCalls(result);
  });

  // COMPACTION-THRESHOLD-CONFIG: a configured token threshold converts to a SMALLER char
  // budget than the 80k default and triggers earlier -- proves generic.ts's wiring (charBudget:
  // charBudgetForTokenThreshold(spec.compactionThreshold)) actually changes the trigger point,
  // not just accepts the option silently.
  it("a configured token threshold triggers compaction earlier than the 80k default", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "be helpful" }];
    for (let i = 0; i < 10; i++) messages.push(...toolRound(`call-${i}`, "x".repeat(3000)));
    const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    expect(totalChars).toBeLessThan(DEFAULT_COMPACTION_CHAR_BUDGET); // default would NOT compact this

    expect(compactMessages(messages)).toBe(messages); // confirms the above under the real default

    const configuredBudget = charBudgetForTokenThreshold(5_000); // 5k tokens ≈ 20k chars
    expect(configuredBudget).toBe(5_000 * DEFAULT_CHARS_PER_TOKEN);
    const result = compactMessages(messages, { charBudget: configuredBudget, keepRecentRounds: 2 });
    expect(result).not.toBe(messages);
    assertNoOrphanedToolCalls(result);
  });
});

// GENERIC-COMPACTION-WINDOW: resolveCompactionBudget is the seam that replaces the flat
// DEFAULT_COMPACTION_CHAR_BUDGET with a model's real context window when one is reachable.
describe("resolveCompactionBudget", () => {
  it("a known small window (16K) compacts earlier than the old fixed 80K-char default would", () => {
    const catalog = { contextWindow: (m: string) => (m === "small-model" ? 16_000 : undefined), pricing: () => undefined };
    const budget = resolveCompactionBudget("small-model", catalog);
    expect(budget.source).toBe("catalog");
    expect(budget.charBudget).toBe(Math.floor(16_000 * COMPACTION_WINDOW_SAFETY_FRACTION) * DEFAULT_CHARS_PER_TOKEN);
    expect(budget.charBudget).toBeLessThan(DEFAULT_COMPACTION_CHAR_BUDGET);
  });

  it("a known large window (1M) compacts later than the old fixed 80K-char default would", () => {
    const catalog = { contextWindow: (m: string) => (m === "big-model" ? 1_000_000 : undefined), pricing: () => undefined };
    const budget = resolveCompactionBudget("big-model", catalog);
    expect(budget.source).toBe("catalog");
    expect(budget.charBudget).toBe(Math.floor(1_000_000 * COMPACTION_WINDOW_SAFETY_FRACTION) * DEFAULT_CHARS_PER_TOKEN);
    expect(budget.charBudget).toBeGreaterThan(DEFAULT_COMPACTION_CHAR_BUDGET);
  });

  it("falls back to protocol's hardcoded per-model window when the catalog has no dynamic entry", () => {
    const catalog = { contextWindow: () => undefined, pricing: () => undefined };
    const budget = resolveCompactionBudget("gpt-5.6-luna", catalog); // hardcoded 128_000 in protocol
    expect(budget.source).toBe("hardcoded");
    expect(budget.charBudget).toBe(Math.floor(128_000 * COMPACTION_WINDOW_SAFETY_FRACTION) * DEFAULT_CHARS_PER_TOKEN);
  });

  it("an unknown window falls back to the documented default, distinguishable via `source` from a real window", () => {
    const withNoCatalog = resolveCompactionBudget("totally-unknown-model");
    expect(withNoCatalog).toEqual({ charBudget: DEFAULT_COMPACTION_CHAR_BUDGET, source: "default" });

    const catalog = { contextWindow: () => undefined, pricing: () => undefined };
    const withMissCatalog = resolveCompactionBudget("totally-unknown-model", catalog);
    expect(withMissCatalog).toEqual({ charBudget: DEFAULT_COMPACTION_CHAR_BUDGET, source: "default" });

    // Same charBudget as a real 80K-ish window could coincidentally produce -- `source` is what
    // actually lets a caller tell "real window" from "guess" at runtime, not the number alone.
    expect(withMissCatalog.source).not.toBe("catalog");
    expect(withMissCatalog.source).not.toBe("hardcoded");
  });
});
