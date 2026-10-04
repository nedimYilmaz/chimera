import { computeCostUsd, type ModelMetadataLookup } from "@chimera/protocol";

// FEATURE-5 (hierarchical budget governor + cache signals): pure helpers used by
// AgentSupervisor's pre-flight admission and live-backpressure checks. Kept separate from
// supervisor.ts so the $-estimation formula is independently unit-testable without spinning
// up a full supervisor/backend rig.

// Distinct `code` from GuardrailError ("guardrail") so scheduler.ts's existing
// `err.code === "guardrail"` catch branches (transient starvation → retry) do NOT match
// this — a budget denial falls through to their `else` branch (queues.markFailed), i.e. a
// TERMINAL failure, not an infinite retry against a structurally-exhausted subtree.
export class BudgetDeniedError extends Error {
  code = "budget_denied" as const;
  name = "BudgetDeniedError";
}

export type EffectiveUsage = { input: number; output: number; cacheRead: number; cacheCreation: number };

// Approximate, provider-agnostic $/token rates used ONLY for the LIVE, pre-"result"
// backpressure estimate (see AgentSupervisor's handling of "usage" events) — never
// overrides the authoritative costUsd a backend reports on its terminal "result" event
// (trackCost still books that verbatim). Cache-read is billed at ~10% of fresh input,
// cache-creation at ~125% — Anthropic's documented cache pricing multipliers
// (packages/core/src/usage.ts:96-97 already notes the ~90% discount figure without
// applying it anywhere; this is where it's finally used). Deliberately a single fixed
// approximation rather than a per-model rate table — see PLAN.md Follow-ups.
const RATE_IN_PER_TOKEN = 3 / 1_000_000;
const RATE_OUT_PER_TOKEN = 15 / 1_000_000;
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_CREATION_MULTIPLIER = 1.25;

// R2 (unified cache-aware token/ctx/cost metrics): when `model` resolves in the new protocol
// pricing table, use it — computeCostUsd expects the CANONICAL fresh-only `u.input` meaning
// (matching usageFromRaw's normalized output below), no ambiguity. When it doesn't (model
// unset, or one of the 15+ openai-compat providers with no table entry), fall back to the
// EXISTING flat-rate formula UNCHANGED (byte-identical, including its own "`input` may already
// include cache tokens as a subset (provider-dependent)" approximation) — this is a LIVE,
// pre-"result" backpressure estimate, never the authoritative costUsd, so preserving its
// existing (deliberately approximate) behavior for the no-table case is correct, not a cut
// corner: budget-governor.test.ts's existing direct calls (no model arg) pin this exactly.
// DYNAMIC-MODEL-METADATA: `catalog` threads the layered model-metadata service through so a model
// resolved from the remote/override catalog (but absent from protocol's hardcoded map) still gets
// real per-model pricing here instead of falling to the flat-rate approximation. Omitted ⇒
// hardcoded-map-then-flat-rate, byte-identical to before (budget-governor.test.ts pins this).
export function estimateEffectiveSpendUsd(u: EffectiveUsage, model?: string, catalog?: ModelMetadataLookup): number {
  const priced = computeCostUsd(u, model, catalog);
  if (priced !== null) return priced;
  // `input` may already include cache tokens as a subset (provider-dependent) — clamping
  // freshInput at 0 keeps the estimate sane either way instead of going negative.
  const freshInput = Math.max(0, u.input - u.cacheRead - u.cacheCreation);
  return freshInput * RATE_IN_PER_TOKEN
    + u.cacheRead * RATE_IN_PER_TOKEN * CACHE_READ_MULTIPLIER
    + u.cacheCreation * RATE_IN_PER_TOKEN * CACHE_CREATION_MULTIPLIER
    + u.output * RATE_OUT_PER_TOKEN;
}

// F50 BUDGET-COVERAGE: the ONE place that decides whether a turn's dollars were MEASURED or
// DERIVED. `reported` is whatever the backend put on the wire; `reportedIsDerived` is that
// backend telling us it computed the number from the price table itself (codex.ts, generic.ts,
// claude.ts's no-SDK-cost fallback) rather than receiving it from the provider.
//
// Why the supervisor and not each backend: nine backends, one budget governor. Backends keep
// their existing "never fabricate a number" contract on the wire (kimi.ts:45 states it as a
// design invariant); turning a token count into a budget fact is the GOVERNOR's job, and doing it
// here means a tenth backend is covered the day it lands.
//
// A reported figure ALWAYS wins over a derived one — even a tiny non-zero one. Overriding a
// provider's own number with our table would be a regression in accuracy, not an improvement.
export type MeteredCost = {
  costUsd: number;
  /** true ⇒ costUsd came from token counts, not from a provider's own billing figure. */
  estimated: boolean;
  /** "reported" | "table" (a MODEL_PRICING/catalog row) | "flat-rate" (budget.ts's own
   *  provider-agnostic approximation) | "none" (nothing to meter). Carried so a future
   *  surface can distinguish a priced estimate from a flat-rate guess without re-deriving it. */
  basis: "reported" | "table" | "flat-rate" | "none";
};

export function meterTurnCost(
  reported: number | undefined,
  rawUsage: Record<string, unknown> | undefined,
  model?: string,
  catalog?: ModelMetadataLookup,
  reportedIsDerived = false,
): MeteredCost {
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0)
    return { costUsd: reported, estimated: reportedIsDerived, basis: reportedIsDerived ? "table" : "reported" };
  const u = usageFromRaw(rawUsage);
  // Kimi emits NO usage at all (kimi.ts:45) — there is nothing to price, and inventing a figure
  // would be exactly the "confidently wrong spend number" this card exists to avoid.
  if (u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheCreation === 0)
    return { costUsd: 0, estimated: false, basis: "none" };
  return {
    costUsd: estimateEffectiveSpendUsd(u, model, catalog),
    estimated: true,
    basis: computeCostUsd(u, model, catalog) !== null ? "table" : "flat-rate",
  };
}

// R2: same codex-cached-subset normalization as ui-state's extractUsage (independent
// implementation — core cannot depend on ui-state, only the reverse) — cached_input_tokens is
// a SUBSET of codex's input_tokens (verified against OpenAI docs), so it's subtracted out
// rather than left double-counted inside both `input` and `cacheRead`.
// TOKEN-OPT-P0-1: cacheCreation reads BOTH providers' write-counter keys — Anthropic's
// cache_creation_input_tokens and codex's cache_write_input_tokens (pinned SDK 0.145.0's
// Usage type; previously discarded by codex.ts's toCostUsage as a hardcoded 0). Only one key
// is ever present on a given provider's raw object, so summing both is safe (the other is 0).
export function usageFromRaw(u: Record<string, unknown> | undefined): EffectiveUsage {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const isCodexShaped = "cached_input_tokens" in u;
  const rawInput = num(u["input_tokens"]);
  const cachedInput = num(u["cached_input_tokens"]);
  return {
    input: isCodexShaped ? Math.max(0, rawInput - cachedInput - num(u["cache_write_input_tokens"])) : rawInput,
    output: num(u["output_tokens"]) + (isCodexShaped ? 0 : num(u["reasoning_output_tokens"])),
    cacheRead: isCodexShaped ? cachedInput : num(u["cache_read_input_tokens"]),
    cacheCreation: num(u["cache_creation_input_tokens"]) + num(u["cache_write_input_tokens"]),
  };
}
