import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { extractUsage } from "@chimera/ui-state";

let seq = 0;
const turnComplete = (data: Record<string, unknown>): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId: "a1", kind: "turn_complete", data });

// R2 (unified cache-aware token/ctx/cost metrics): the core claim of the normalization —
// a codex-shaped usage object (input_tokens INCLUDES cached, verified against OpenAI docs) and
// a claude-shaped one (input_tokens EXCLUDES cache, verified against the Anthropic SDK's Usage
// type) representing the SAME conceptual turn (60 fresh input tokens, 40 cache-read tokens, 20
// output tokens) must normalize to the SAME canonical TokenUsage and the SAME full-context total.
describe("R2: extractUsage normalizes codex and claude to the same full-context total", () => {
  const codexUsage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 0 };
  const claudeUsage = { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 20 };

  it("codex: cached_input_tokens is subtracted out of input (a subset), not added", () => {
    expect(extractUsage(turnComplete({ usage: codexUsage }))).toEqual({ input: 60, output: 20, cacheRead: 40, cacheCreation: 0 });
  });

  it("claude: input_tokens already excludes cache — passes through unchanged", () => {
    expect(extractUsage(turnComplete({ usage: claudeUsage }))).toEqual({ input: 60, output: 20, cacheRead: 40, cacheCreation: 0 });
  });

  it("both providers land on the IDENTICAL normalized TokenUsage for the same conceptual turn", () => {
    const codexNormalized = extractUsage(turnComplete({ usage: codexUsage }));
    const claudeNormalized = extractUsage(turnComplete({ usage: claudeUsage }));
    expect(codexNormalized).toEqual(claudeNormalized);
  });

  it("full-context (input+cacheRead+cacheCreation) matches across providers, unlike the raw input_tokens fields", () => {
    const codexNormalized = extractUsage(turnComplete({ usage: codexUsage }))!;
    const claudeNormalized = extractUsage(turnComplete({ usage: claudeUsage }))!;
    const fullContext = (u: typeof codexNormalized) => u.input + u.cacheRead + u.cacheCreation;
    expect(fullContext(codexNormalized)).toBe(100);
    expect(fullContext(claudeNormalized)).toBe(100);
    // the RAW input_tokens fields differ (100 vs 60) precisely because of the provider-specific
    // subset/additive semantics — normalization is what makes them reconcile.
    expect(codexUsage.input_tokens).not.toBe(claudeUsage.input_tokens);
  });

  it("a codex event with no cache hit at all (cached_input_tokens:0) leaves input untouched", () => {
    expect(extractUsage(turnComplete({ usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } })))
      .toEqual({ input: 50, output: 5, cacheRead: 0, cacheCreation: 0 });
  });

  // R2 (generic/openai-compat backend fix): generic.ts sinks {input_tokens, output_tokens} with
  // NO cached_input_tokens/cache_read_input_tokens key at all (ChatUsage has no cache concept
  // today) — proves the fix actually round-trips through the SHARED normalization code (not just
  // generic-backend.test.ts's own backend-local assertions). Falls into the claude-shaped branch
  // (no "cached_input_tokens" in u), so input passes through unchanged — correct, since there's
  // nothing to subtract.
  it("generic/openai-compat: a usage object with no cache key at all normalizes with cacheRead/cacheCreation at 0", () => {
    expect(extractUsage(turnComplete({ usage: { input_tokens: 100, output_tokens: 20 } })))
      .toEqual({ input: 100, output: 20, cacheRead: 0, cacheCreation: 0 });
  });
});
