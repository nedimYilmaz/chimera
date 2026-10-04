// R2 (unified cache-aware token/ctx/cost metrics): per-model context-window + $/token tables.
// Pure data, no zod schema — lives here (not packages/core/src/providers/catalog.ts) because
// packages/app cannot depend on @chimera/core (Node-only, see cronPreview.ts) but its ctxPct
// selector needs the SAME per-model context window claude.ts/codex.ts use to compute cost.
// ProviderProfile (catalog.ts) is per-PROVIDER; this is per-MODEL — a different shape, so it
// doesn't belong on ProviderProfile either.
//
// This repo's model catalog (claude-opus-4-8, gpt-5.6-sol, ...) is a fictional near-future
// lineup (see catalog.ts's own "re-verify against research doc" caveat) — there is no real
// published pricing for these exact ids, so every row below is necessarily an approximation.
// Each row's `provenance` says how close: "authoritative" means the figures were independently
// verified to mirror a real, current, published price VERBATIM (cited in that row's comment);
// "modeled" means scaled/estimated from a related real tier, not independently verified against
// a live source in this pass. P0-3 (2026-07-24) audited gpt-5.6-sol and found its prior
// "mirrors verbatim" claim FALSE (see that row) — every other row's claim is inherited from the
// original R2 pass (Context7 docs, 2026-07-20) and has NOT been re-verified since, hence
// "modeled" rather than "authoritative" until someone does.
// Cache-read discount: verified via docs that BOTH providers give newer models a ~90% cache-read
// discount (Anthropic prompt caching; OpenAI's gpt-5-nano/GPT-5-Codex-class figure, vs. gpt-4o's
// older 50%) — every entry below uses the 90% figure (cachedInputPerMTok = 10% of inputPerMTok).
// Cache-WRITE premium (W2-2, 2026-07-25): verified via platform.claude.com/docs/en/build-with-claude/
// prompt-caching (memory record 225185f9, chimera/tokenopt) that Anthropic bills a cache WRITE at
// 1.25x input for a 5-minute TTL entry and 2x input for a 1-hour TTL entry — two distinct tiers,
// not one flat rate. OpenAI's GPT-5.6 docs (record 69b25e3a) confirm a single 1.25x write rate
// with a 30-minute minimum TTL and no 1-hour tier at all. Every row below sets
// cacheWrite5mPerMTok = inputPerMTok * 1.25 for every model, and additionally
// cacheWrite1hPerMTok = inputPerMTok * 2 for the claude-* rows only (gpt-5.6-*/gpt-5.5 omit it —
// no such tier exists to price). See computeCostUsd for how these are applied.
export type ModelPricing = {
  inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok: number;
  // P0-3 PRICING: per-row provenance for this HARDCODED fallback table only — see the file
  // header. Optional: a dynamically-sourced ModelPricing (e.g. core's LiteLLM-backed
  // ModelCatalogService, packages/core/src/providers/model-catalog.ts) has no notion of this
  // repo's own fictional-catalog provenance taxonomy and simply omits it.
  provenance?: "authoritative" | "modeled";
  // W2-2 CACHE-WRITE-TTL: per-TTL cache-WRITE rates, in $/MTok — same unit and convention as
  // cachedInputPerMTok (an absolute rate, not a multiplier), and the same shape as LiteLLM's real
  // `cache_creation_input_token_cost` (5m/base tier) and `cache_creation_input_token_cost_above_1hr`
  // (1h tier) fields, so core's parseLiteLlmCatalog (packages/core/src/providers/model-catalog.ts)
  // and a hand-edited ~/.chimera/model-catalog.json override can both populate these 1:1.
  // cacheWrite5mPerMTok also serves as the ONLY cache-write rate for a provider with just one TTL
  // tier (e.g. GPT-5.6: min TTL 30m, single 1.25x-input rate, no distinct 1h option — see
  // MODEL_PRICING below). cacheWrite1hPerMTok is Anthropic-specific; omit it for any
  // model/provider that doesn't offer a 1-hour cache tier.
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
};

// DYNAMIC-MODEL-METADATA: the injectable resolution seam. A caller (core's ModelCatalogService)
// implements this to feed the layered catalog (config override > cached remote > provider API)
// into these otherwise-pure functions WITHOUT protocol depending on Node/fs/network. Returning
// `undefined` for a model means "no dynamic entry" — the function then falls through to the
// hardcoded map below (layer 4) and finally the DEFAULT. Kept in protocol (not core) because
// packages/app calls contextWindowFor client-side and can't depend on @chimera/core.
export interface ModelMetadataLookup {
  contextWindow(model: string): number | undefined;
  pricing(model: string): ModelPricing | undefined;
  // TRUNCATION-SURFACE: the model's real output-token ceiling, when a source actually reports
  // one (LiteLLM's `max_output_tokens`, distinct from the `max_input_tokens`/`max_tokens` pair
  // contextWindow reads) — optional so an existing implementer (fakes in tests, any lookup
  // built before this field existed) doesn't need updating; callers read it via `?.()`.
  // undefined ⇒ the caller's own hardcoded fallback applies, same layering as contextWindow.
  maxOutputTokens?(model: string): number | undefined;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

// P0-3 PRICING: gpt-5.6-sol's window corrected to 1.05M (was 400K) — see MODEL_PRICING's
// gpt-5.6-sol comment for the source. core's own tests were updated alongside this (P0-2/P0-3
// share the core package). NOTE for the integrator: this still ripples into OTHER packages'
// tests that hardcode the old 400_000 figure for gpt-5.6-sol — at least
// app/test/{selectors,AgentDetailPanel}.test.tsx and
// daemon/test/effective-context-limit-blackbox.test.ts — out of this slice's file scope
// (protocol + core only), left for whoever lands this alongside those packages.
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  // CTX-WINDOW-5-SERIES: the Claude 5 family ships a 1M window on the PLAIN id — verified
  // against the live model catalog (contextWindow: 1_000_000 for claude-opus-5,
  // claude-sonnet-5 and claude-fable-5 alike, while claude-opus-4-5 beside them is 200k).
  // These were 200_000 here, which understated the real window five-fold: an agent legitimately
  // holding 210k read as "100% · 210k/200k" — a denominator its own numerator had already
  // disproven — and it pushed chimera's compaction trigger far earlier than the model needs.
  // The [1m] SUFFIX rule in contextWindowFor stays: it covers ids that spell the variant out,
  // which is a different thing from the family's own default.
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 128_000,
  "gpt-5.5": 272_000,
  // KIMI-BACKEND S1: confirmed live (openrouter.ai/moonshotai/kimi-k3, checked 2026-07-28) --
  // matches this repo's own `kimi` CLI-reported window (spec §9). Without this entry,
  // effectiveContextLimitFor falls through to DEFAULT_CONTEXT_WINDOW (200k), understating the
  // real window 5x and firing chimera's own compaction trigger prematurely.
  // PROVIDER-CATALOG-REFRESH-2026-08: corrected 1_000_000 -> the exact figure Moonshot's own
  // pricing doc publishes (platform.kimi.ai/docs/pricing/chat-k3.md, checked 2026-08-11) --
  // 1,048,576 (2^20), not a round 1M. Same LiteLLM entries (moonshot/kimi-k2.6 etc) use 262144,
  // confirming k3 specifically is the 1M-class tier.
  "kimi-k3": 1_048_576,
  // PROVIDER-CATALOG-REFRESH-2026-08: catalog.ts's `zai`/`zai-coding` defaultModel moved
  // glm-5 -> glm-5.2 (docs.z.ai/release-notes/new-released, checked 2026-08-11: glm-5.2 is the
  // current flagship, released 2026-06-16, "1M lossless context"). Confirmed 1,048,576 exactly
  // via docs.z.ai/guides/llm/glm-5.2. NOTE: LiteLLM's remote catalog (BerriAI/litellm main,
  // fetched 2026-08-11) has NO row for the bare id "glm-5.2" chimera actually sends -- only
  // provider-prefixed variants like "zai/glm-5.1" and "cloudflare/@cf/zai-org/glm-5.2" -- so this
  // hardcoded row is the ONLY source of truth for chimera's own zai/zai-coding spawns; without
  // it they'd silently report costUsd:0 and a 200k (5x-too-small) context window.
  "glm-5.2": 1_048_576,
  // PROVIDER-CATALOG-REFRESH-2026-08: catalog.ts's `groq` defaultModel moved to this id ahead of
  // Groq's 2026-08-16 deprecation of llama-3.3-70b-versatile/llama-3.1-8b-instant for
  // free/developer-tier keys (console.groq.com/docs/deprecations, checked 2026-08-11). Confirmed
  // via LiteLLM's remote catalog (BerriAI/litellm main, key "groq/openai/gpt-oss-120b", fetched
  // 2026-08-11) — matches Groq's own docs figure independently reported in this pass.
  "openai/gpt-oss-120b": 131_072,
  // PROVIDER-CATALOG-REFRESH-2026-08: catalog.ts's `fireworks` defaultModel/models corrected
  // from the invalid "kimi-k2.6"/"glm-5.1" ids (Fireworks encodes version dots as `p`, not `.`;
  // those exact strings 404 against fireworks.ai/models/fireworks/<id>) to the real ids below.
  // Figures verified via LiteLLM's remote catalog (BerriAI/litellm main, keys
  // "fireworks_ai/accounts/fireworks/models/kimi-k2p6" and ".../glm-5p2", fetched 2026-08-11) --
  // the bare (unprefixed) id chimera actually sends has no row of its own in LiteLLM, same
  // fall-through gap as glm-5.2 above.
  "accounts/fireworks/models/kimi-k2p6": 262_144,
  "accounts/fireworks/models/glm-5p2": 1_048_576,
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // "mirrors real Opus/Haiku/Sonnet tiers" (R2, 2026-07-20) — inherited claim, not
  // independently re-verified in this pass. claude-sonnet-5 additionally matches budget.ts's
  // pre-existing flat-rate constants exactly, so that one tier is at least internally consistent.
  "claude-opus-4-8": {
    inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5, provenance: "modeled",
    cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30,
  },
  "claude-sonnet-5": {
    inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, provenance: "modeled",
    cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08, provenance: "modeled",
    cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1.6,
  },
  // No real analog; priced near the haiku/small tier (R2, 2026-07-20) — a pure estimate.
  "claude-fable-5": {
    inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1, provenance: "modeled",
    cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2,
  },
  // P0-3 PRICING (2026-07-24): the prior entry here ($1.25/$0.125/$10, 400K) claimed to mirror
  // real GPT-5-Codex pricing "verbatim" — that claim was FALSE (checked against
  // developers.openai.com/api/docs/models/gpt-5-codex). Corrected figures below DO mirror the
  // real published GPT-5-Codex price verbatim ($5 input / $0.50 cached / $30 output per MTok,
  // 1.05M context) — hence "authoritative", the only row in this table currently re-verified
  // against a live source. W2-2: cacheWrite5mPerMTok=6.25 (5*1.25) is GPT-5.6's real, verified
  // write rate too (OpenAI prompt-caching docs, record 69b25e3a) — no cacheWrite1hPerMTok, GPT-5.6
  // has no 1-hour cache tier.
  "gpt-5.6-sol": {
    inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, provenance: "authoritative",
    cacheWrite5mPerMTok: 6.25,
  },
  // terra/luna are scaled-down smaller/faster tiers; gpt-5.5 mirrors sol as a same-generation
  // baseline (R2, 2026-07-20) — all three are extrapolated from gpt-5.6-sol's PRE-correction
  // figures, not independently re-verified against a real source in this pass.
  "gpt-5.6-terra": {
    inputPerMTok: 0.5, outputPerMTok: 4, cachedInputPerMTok: 0.05, provenance: "modeled",
    cacheWrite5mPerMTok: 0.625,
  },
  "gpt-5.6-luna": {
    inputPerMTok: 0.15, outputPerMTok: 1.2, cachedInputPerMTok: 0.015, provenance: "modeled",
    cacheWrite5mPerMTok: 0.1875,
  },
  "gpt-5.5": {
    inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125, provenance: "modeled",
    cacheWrite5mPerMTok: 1.5625,
  },
  // KIMI-BACKEND S1: real published rate, independently confirmed live against two sources
  // (openrouter.ai/moonshotai/kimi-k3: "$3 per 1M input / $15 per 1M output"; corroborated by
  // requesty.ai/models/moonshot/kimi-k3 and others, checked 2026-07-28) -- "authoritative", not
  // guessed, per the task's explicit "do not invent a rate" requirement. cachedInputPerMTok
  // applies this file's own established 90%-discount convention (see file header) since no
  // source broke out a distinct cache-read figure; no cacheWrite1hPerMTok -- no 1-hour cache
  // tier is documented for Kimi (same as the non-Claude gpt-5.6-*/gpt-5.5 rows above).
  "kimi-k3": {
    inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, provenance: "authoritative",
    cacheWrite5mPerMTok: 3.75,
  },
  // PROVIDER-CATALOG-REFRESH-2026-08: real published rate for the new zai/zai-coding default
  // (docs.z.ai/guides/overview/pricing, checked 2026-08-11: $1.40 input / $4.40 output / $0.26
  // cached per MTok) -- cross-checked against openrouter.ai/z-ai/glm-5.2 and
  // models.dev/models/zhipuai/glm-5.2, both agreeing on $1.40/$4.40. No cache-write-TTL figure
  // published (no cacheWrite5m/1hPerMTok) -- falls through to the legacy 1.25x-input multiplier
  // like every other non-Claude/non-GPT-5.6 row.
  "glm-5.2": { inputPerMTok: 1.4, outputPerMTok: 4.4, cachedInputPerMTok: 0.26, provenance: "authoritative" },
  // PROVIDER-CATALOG-REFRESH-2026-08: real published rate for the new groq defaultModel, sourced
  // from LiteLLM's remote catalog (BerriAI/litellm main, key "groq/openai/gpt-oss-120b", fetched
  // 2026-08-11: $0.15 input / $0.60 output per MTok), independently corroborated against
  // console.groq.com's own pricing docs in the same research pass. No cache-read/write figures
  // published for this id -- cachedInputPerMTok falls back to this file's 90%-discount
  // convention (10% of input) since no source broke out a distinct rate.
  "openai/gpt-oss-120b": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.015, provenance: "authoritative" },
  // PROVIDER-CATALOG-REFRESH-2026-08: real published rates for the corrected fireworks ids,
  // sourced from LiteLLM's remote catalog (BerriAI/litellm main, keys
  // "fireworks_ai/accounts/fireworks/models/kimi-k2p6" and ".../glm-5p2", fetched 2026-08-11).
  // Same 90%-cache-read-discount convention applied (no distinct cache-read figure published).
  "accounts/fireworks/models/kimi-k2p6": { inputPerMTok: 0.95, outputPerMTok: 4, cachedInputPerMTok: 0.095, provenance: "authoritative" },
  "accounts/fireworks/models/glm-5p2": { inputPerMTok: 1.4, outputPerMTok: 4.4, cachedInputPerMTok: 0.14, provenance: "authoritative" },
};

// DYNAMIC-MODEL-METADATA resolution order (first hit wins): the injected `catalog` holds
// layers 1-3 (config override > cached remote > provider API); this function adds the
// hardcoded MODEL_CONTEXT_WINDOWS as layer 4 (fallback) and DEFAULT_CONTEXT_WINDOW as the
// last resort. `catalog` omitted (old call site / app client-side) ⇒ byte-identical to the
// pre-service behavior (hardcoded map, then default).
export function contextWindowFor(model: string | undefined, catalog?: ModelMetadataLookup): number {
  if (model) {
    const dynamic = catalog?.contextWindow(model);
    if (dynamic !== undefined) return dynamic;
    const hard = MODEL_CONTEXT_WINDOWS[model];
    if (hard !== undefined) return hard;
    // LONG-CONTEXT-SUFFIX: Anthropic's 1M-context variants carry it in the id itself
    // ("claude-opus-5[1m]"). Without this they miss every lookup above and fall to the 200k
    // default — understating a 1,000,000-token window FIVE-fold, which both pins the ctx meter
    // near 100% for an agent with most of its window still free and fires chimera's own
    // compaction trigger prematurely. (Exactly the failure MODEL_CONTEXT_WINDOWS' kimi-k3 entry
    // documents, arriving again through a different door.) Read from the SUFFIX rather than
    // enumerated per model, so a new <model>[1m] needs no table edit — the id already states it.
    // Checked last: an explicit catalog or table entry still wins, since either is more specific.
    if (/\[1m\]$/i.test(model)) return 1_000_000;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// R2 (ctx meter effective-limit): the ctx meter's denominator — an operator-configured
// compaction threshold (the point at which WE compact) wins when set, else the model's native
// window. One formula, two callers that must never drift: core/supervisor.ts's launch() (fed the
// resolved AccountRegistry.compactionThresholdFor) stamps this onto AgentRecord.effectiveContextLimit
// server-side; app/state/selectors.ts calls it client-side (fed the agent's already-resolved
// effectiveContextLimit, or undefined for an older daemon / not-yet-arrived snapshot).
export function effectiveContextLimitFor(model: string | undefined, configuredLimit: number | undefined, catalog?: ModelMetadataLookup): number {
  return configuredLimit ?? contextWindowFor(model, catalog);
}

// CTX-METER-TRIGGER-CLAMP: claude.ts clamps an operator-configured compactionThreshold into the
// Claude Agent SDK's own validated auto-compact range before using it as the REAL trigger
// (COMPACTION-THRESHOLD-CONFIG) — an unclamped value outside this range made the ctx meter's
// denominator (effectiveContextLimitFor, above) diverge from the point compaction actually fires
// at. Shared here as the single source of truth so supervisor.ts's meter-stamping call sites and
// claude.ts's own SDK-options clamp can never drift apart again. No-op for every other provider:
// codex/generic pass the raw threshold straight through as their own trigger, so their meter
// already matches with no clamp needed.
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;
export function clampCompactionThresholdForProvider(provider: string | undefined, threshold: number | undefined): number | undefined {
  if (threshold === undefined || provider !== "claude") return threshold;
  return Math.min(CLAUDE_AUTO_COMPACT_WINDOW_MAX, Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, threshold));
}

// L1-DEFAULT-THRESHOLD (F39): the fleet default compaction trigger, in tokens, per provider.
// Consumed as the LAST rung of core's AccountRegistry.compactionThresholdWithSource — a spawn's
// own value, then the account's, then providerOverrides all still win, and an operator rolls the
// whole thing back to claude's NATIVE behavior with one line: { "providerOverrides": { "claude":
// { "compactionThreshold": null } } } in ~/.chimera/config.json.
// A config.patch (the app's Settings → Providers card, and any agent calling the RPC) expresses
// that same null with the CONFIG_PATCH_NULL escape — overlays are applied as RFC 7396 JSON Merge
// Patch, where a literal null DELETES the key and so lands back on this default (QA finding M-1);
// see config-patch.ts.
//
// 120_000 comes from the counterfactual replay in
// docs/superpowers/measurements/2026-09-02-compaction-audit.md (JSON sidecar beside it),
// reproducible with `node scripts/compaction-audit.mjs --date 2026-09-02`. Measured over
// 2026-08-26 -> 2026-09-02 (61 event segments, 19,761 deduped model calls out of 39,496 raw
// `usage` rows, 340 claude agents, $5,724.70 modelled actual spend): replaying the same real
// per-call context growth against a 120k trigger nets 1.882x at the median post-compaction floor
// and 1.746x at the pessimistic (max) floor, versus 1.000x uncapped. Selection rule (plan
// F39 2.4.4): drop any candidate under 1.10x at the pessimistic floor, drop any under 2x the p95
// first-turn cache write (101,566), then take the LARGEST survivor within 5% of the best — every
// candidate cleared the bars, and only 120k fell inside 5% of the best 1.746x, so largest and
// best coincide here.
//
// MUST stay >= CLAUDE_AUTO_COMPACT_WINDOW_MIN: below it, claude.ts clamps the REAL trigger up
// while the value written here would still be reported, and the ctx meter would diverge from the
// point compaction actually fires at.
//
// claude ONLY. codex takes the same knob (backends/codex.ts -> model_auto_compact_token_limit)
// but emits neither `usage` nor a `compaction` event, and kimi hardcodes costUsd 0 — a default
// for either would be a number nobody can audit, which is the failure mode this feature exists
// to stop.
export const DEFAULT_COMPACTION_THRESHOLD: Record<string, number> = { claude: 120_000 };

// Same layered resolution as contextWindowFor: catalog (layers 1-3) > hardcoded MODEL_PRICING
// (layer 4) > null. `catalog` omitted ⇒ byte-identical to the pre-service behavior.
export function pricingFor(model: string | undefined, catalog?: ModelMetadataLookup): ModelPricing | null {
  if (model) {
    const dynamic = catalog?.pricing(model);
    if (dynamic) return dynamic;
    const hard = MODEL_PRICING[model];
    if (hard) return hard;
  }
  return null;
}

export type UsageForCost = {
  input: number; output: number; cacheRead: number;
  // Cumulative/total cache-write tokens — always required, used as-is whenever the caller can't
  // (or the provider doesn't) distinguish TTL buckets.
  cacheCreation: number;
  // W2-2 CACHE-WRITE-TTL: optional TTL-bucketed cache-write tokens. Anthropic's raw Usage type
  // DOES distinguish these (`cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`
  // — verified present on the pinned @anthropic-ai/sdk 0.110.0 Messages Usage type and threaded
  // through unchanged by the Claude Agent SDK's NonNullableUsage), so a caller sitting on that raw
  // payload (e.g. core/backends/claude.ts) CAN supply an exact split instead of leaving
  // computeCostUsd to assume one. Codex/GPT-5.6 usage has no such split (OpenAI reports one flat
  // cache_write_input_tokens figure) — those callers only ever set `cacheCreation`. When supplied,
  // these two should sum to `cacheCreation` (caller's responsibility); computeCostUsd trusts the
  // split over the flat total whenever either is present, to avoid double-billing.
  cacheCreation5m?: number;
  cacheCreation1h?: number;
};

// Legacy flat cache-write multiplier (Anthropic's 5-minute rate) — used ONLY as the very last
// resort, for a model/row whose ModelPricing predates this fix and carries neither
// cacheWrite5mPerMTok nor cacheWrite1hPerMTok (e.g. an old cached ~/.chimera/model-catalog.json
// entry, or a LiteLLM remote entry parseLiteLlmCatalog hasn't populated cache-write fields for).
// Byte-identical to every row's pre-W2-2 behavior in that fallback case.
const LEGACY_CACHE_WRITE_MULTIPLIER = 1.25;

// PRICING-SHADOW (2026-07-25, see chimera/tokenopt memory d05679c6): INT-3 checked all 2663
// entries of the live ~/.chimera/model-catalog.json — ZERO carry cacheWrite5m/1hPerMTok for ANY
// model, including claude-sonnet-5/claude-opus-4-8 (151 of 170 real ledger rows). pricingFor
// prefers a dynamic catalog row WHOLESALE over MODEL_PRICING, so an incomplete dynamic row
// silently shadows the hardcoded table's correct cache-write rates, reverting a Claude spawn to
// the wrong 5m-tier multiplier. Same root cause and same carve-out shape as model-catalog.ts's
// CTX-METER-DENOM (which distrusts remote for context window); this one distrusts remote ONLY for
// the two cache-write-TTL fields, on Claude ids only, never for base input/output/cachedInput
// pricing (which the dynamic catalog gets right) — GPT-5.6 is untouched, its dynamic and
// hardcoded rows already agree on the single flat 1.25x tier, nothing to shadow.
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("anthropic.") || model.startsWith("anthropic/");
}

// Only the two cache-write-TTL fields, from the hardcoded row — undefined when the model isn't
// Claude, or has no hardcoded row at all (e.g. a newer claude-* id MODEL_PRICING hasn't caught up
// with yet; falls through to the legacy multiplier below, no worse than before this fix).
function claudeHardcodedCacheWrite(model: string): Pick<ModelPricing, "cacheWrite5mPerMTok" | "cacheWrite1hPerMTok"> | undefined {
  if (!isClaudeModel(model)) return undefined;
  return MODEL_PRICING[model];
}

// W2-2 CACHE-WRITE-TTL: the rate for cache-write tokens whose TTL is UNKNOWN (both
// u.cacheCreation5m/1h are undefined — the caller's raw usage payload didn't distinguish them, or
// wasn't threaded through). Anthropic's platform docs say a cache_control write "Defaults to 5m"
// when a caller specifies no TTL — but RM-1's measured LIVE Chimera transcripts (memory record
// b003ccd9, chimera/tokenopt: a real spawn's recorded costUsd exactly matches a 2x/1-hour
// computation and is 34% higher than a 1.25x/5-minute one) show every observed Claude cache write
// in THIS repo is actually billed at the 1-HOUR rate — so for a row that has one, default to it;
// ASSUMED, not detected, and stated here explicitly per this slice's brief. A row with only a
// single tier (GPT-5.6: one 1.25x rate, no 1h option) has nothing else to default to regardless.
function unresolvedTtlCacheWriteRate(p: ModelPricing, model?: string): number {
  const carve = model ? claudeHardcodedCacheWrite(model) : undefined;
  return p.cacheWrite1hPerMTok ?? carve?.cacheWrite1hPerMTok
    ?? p.cacheWrite5mPerMTok ?? carve?.cacheWrite5mPerMTok
    ?? p.inputPerMTok * LEGACY_CACHE_WRITE_MULTIPLIER;
}

function cacheCreationCostUsd(u: UsageForCost, p: ModelPricing, model?: string): number {
  const M = 1_000_000;
  if (u.cacheCreation5m !== undefined || u.cacheCreation1h !== undefined) {
    const carve = model ? claudeHardcodedCacheWrite(model) : undefined;
    const rate5m = p.cacheWrite5mPerMTok ?? carve?.cacheWrite5mPerMTok ?? p.inputPerMTok * LEGACY_CACHE_WRITE_MULTIPLIER;
    const rate1h = p.cacheWrite1hPerMTok ?? carve?.cacheWrite1hPerMTok ?? rate5m;
    return ((u.cacheCreation5m ?? 0) / M) * rate5m + ((u.cacheCreation1h ?? 0) / M) * rate1h;
  }
  return (u.cacheCreation / M) * unresolvedTtlCacheWriteRate(p, model);
}

// `u.input` must already be the FRESH/uncached figure (extractUsage's canonical meaning — see
// ui-state/reducer.ts). cacheRead is billed at the discounted cachedInputPerMTok; cacheCreation is
// billed via cacheCreationCostUsd above — TTL-split rates when the caller supplies them, else the
// per-model unresolved-TTL default (see unresolvedTtlCacheWriteRate). Applies uniformly to every
// model's cacheCreation figure, including gpt-5.6-sol/terra/luna (P0-1 wired codex's real
// cache_write_input_tokens through; that provider just never has a TTL split to supply).
// Returns null when the model has no table entry — the caller decides the fallback (a flat rate,
// or simply 0), never fabricates a number for a provider this table doesn't know about.
export function computeCostUsd(u: UsageForCost, model: string | undefined, catalog?: ModelMetadataLookup): number | null {
  const p = pricingFor(model, catalog);
  if (!p) return null;
  const M = 1_000_000;
  return (u.input / M) * p.inputPerMTok
    + (u.output / M) * p.outputPerMTok
    + (u.cacheRead / M) * p.cachedInputPerMTok
    + cacheCreationCostUsd(u, p, model);
}


/** Provider-reported context capacities; absence means unknown, never a guessed model limit. */
export type CodexContextLimits = {
  source: "codex";
  defaultWindow?: number;
  maxWindow?: number;
  sessionWindow?: number;
  compactAt?: number;
};
