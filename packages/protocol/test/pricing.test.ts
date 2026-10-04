import { describe, expect, it } from "vitest";
import {
  computeCostUsd, contextWindowFor, DEFAULT_CONTEXT_WINDOW, effectiveContextLimitFor, clampCompactionThresholdForProvider,
  MODEL_PRICING, pricingFor,
  type ModelMetadataLookup,
} from "../src/pricing.js";

describe("R2 pricing table", () => {
  it("contextWindowFor: known models return their real window, unknown/undefined falls back to the default", () => {
    expect(contextWindowFor("gpt-5.6-sol")).toBe(1_050_000);
    expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor("some-unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("pricingFor: null for an unpriced/unknown model", () => {
    expect(pricingFor("some-unknown-model")).toBeNull();
    expect(pricingFor(undefined)).toBeNull();
    expect(pricingFor("claude-sonnet-5")).not.toBeNull();
  });

  it("computeCostUsd: null for an unpriced model, never fabricates a number", () => {
    expect(computeCostUsd({ input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 }, "unknown-model")).toBeNull();
    expect(computeCostUsd({ input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 }, undefined)).toBeNull();
  });

  it("computeCostUsd: a positive number for a priced model, matching the raw $/MTok formula", () => {
    const cost = computeCostUsd({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }, "claude-sonnet-5");
    expect(cost).toBeCloseTo(3 + 15, 10);   // 1M fresh input + 1M output at the sonnet-5 rate
  });

  it("cache-read tokens are billed cheaper per-token than fresh input (never inverts the discount)", () => {
    const freshOnly = computeCostUsd({ input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }, "gpt-5.6-sol")!;
    const cachedOnly = computeCostUsd({ input: 0, output: 0, cacheRead: 1000, cacheCreation: 0 }, "gpt-5.6-sol")!;
    expect(cachedOnly).toBeLessThan(freshOnly);
    expect(cachedOnly).toBeCloseTo(freshOnly * 0.1, 10);   // gpt-5.6-sol's 90% cache discount
  });

  // W2-2 CACHE-WRITE-TTL: a flat cacheCreation figure (no TTL split known) on a claude model now
  // defaults to the 1-HOUR rate (2x), not the old flat 1.25x — see the "recomputes the RM-1
  // baseline" test below for why that default was chosen.
  it("cache-creation tokens are billed MORE than fresh input (write premium), for a claude model", () => {
    const freshOnly = computeCostUsd({ input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }, "claude-opus-4-8")!;
    const creationOnly = computeCostUsd({ input: 0, output: 0, cacheRead: 0, cacheCreation: 1000 }, "claude-opus-4-8")!;
    expect(creationOnly).toBeGreaterThan(freshOnly);
    expect(creationOnly).toBeCloseTo(freshOnly * 2, 10);
  });

  // P0-3 PRICING (2026-07-24): gpt-5.6-sol's prior figures ($1.25/$0.125/$10, 400K) falsely
  // claimed to mirror real GPT-5-Codex pricing "verbatim" — corrected here to the real published
  // figures ($5 input / $0.50 cached / $30 output per MTok, 1.05M context), which now DO match.
  it("gpt-5.6-sol matches the corrected, verified GPT-5-Codex figures", () => {
    expect(MODEL_PRICING["gpt-5.6-sol"]).toEqual({
      inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5, provenance: "authoritative",
      cacheWrite5mPerMTok: 6.25,
    });
    expect(contextWindowFor("gpt-5.6-sol")).toBe(1_050_000);
  });

  // KIMI-BACKEND S1: real published rate ($3 input / $15 output per MTok, checked live against
  // openrouter.ai/moonshotai/kimi-k3 2026-07-28), not an invented figure -- and a 1M-class context
  // window (matching the CLI's own reported window, spec §9), not the 200k DEFAULT_CONTEXT_WINDOW
  // an unentered model would silently fall back to.
  // PROVIDER-CATALOG-REFRESH-2026-08: context window corrected 1_000_000 -> the exact
  // 1_048_576 Moonshot's own pricing doc publishes (platform.kimi.ai/docs/pricing/chat-k3.md,
  // checked 2026-08-11).
  it("kimi-k3 carries a real (not invented) rate and its full 1,048,576-token context window", () => {
    expect(MODEL_PRICING["kimi-k3"]).toEqual({
      inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, provenance: "authoritative",
      cacheWrite5mPerMTok: 3.75,
    });
    expect(contextWindowFor("kimi-k3")).toBe(1_048_576);
  });

  // PROVIDER-CATALOG-REFRESH-2026-08: the 5 new authoritative rows added alongside catalog.ts's
  // stale-model-id fixes (zai/zai-coding -> glm-5.2, groq -> openai/gpt-oss-120b, fireworks's
  // corrected kimi-k2p6/glm-5p2 ids) actually resolve real numbers instead of silently falling
  // through to null pricing / DEFAULT_CONTEXT_WINDOW.
  it("PROVIDER-CATALOG-REFRESH-2026-08: new provider rows resolve real pricing and context", () => {
    expect(MODEL_PRICING["glm-5.2"]).toEqual({ inputPerMTok: 1.4, outputPerMTok: 4.4, cachedInputPerMTok: 0.26, provenance: "authoritative" });
    expect(contextWindowFor("glm-5.2")).toBe(1_048_576);

    expect(MODEL_PRICING["openai/gpt-oss-120b"]).toEqual({ inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.015, provenance: "authoritative" });
    expect(contextWindowFor("openai/gpt-oss-120b")).toBe(131_072);

    expect(MODEL_PRICING["accounts/fireworks/models/kimi-k2p6"]).toEqual({ inputPerMTok: 0.95, outputPerMTok: 4, cachedInputPerMTok: 0.095, provenance: "authoritative" });
    expect(contextWindowFor("accounts/fireworks/models/kimi-k2p6")).toBe(262_144);

    expect(MODEL_PRICING["accounts/fireworks/models/glm-5p2"]).toEqual({ inputPerMTok: 1.4, outputPerMTok: 4.4, cachedInputPerMTok: 0.14, provenance: "authoritative" });
    expect(contextWindowFor("accounts/fireworks/models/glm-5p2")).toBe(1_048_576);

    // the old, now-corrected fireworks ids must resolve to nothing (never a stale fabricated cost).
    expect(pricingFor("accounts/fireworks/models/kimi-k2.6")).toBeNull();
    expect(pricingFor("accounts/fireworks/models/glm-5.1")).toBeNull();
  });

  // W2-2 CACHE-WRITE-TTL golden fixtures: explicit 5m/1h split, unresolved-TTL default, and
  // GPT-5.6's single-tier behavior. Carried forward from P0-3's documented, deliberately-not-fixed
  // gap (pricing.ts's own prior comment: "the flat 1.25x here is Anthropic's 5-MINUTE cache-write
  // multiplier... observed Opus transcripts... used 1-hour caching exclusively").
  describe("cache-write TTL", () => {
    it("an explicit 5m/1h split is billed at each TTL's own distinct rate, not one flat multiplier", () => {
      const p = MODEL_PRICING["claude-opus-4-8"]!;
      const M = 1_000_000;
      const write5mOnly = computeCostUsd(
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, cacheCreation5m: 1000, cacheCreation1h: 0 }, "claude-opus-4-8",
      )!;
      const write1hOnly = computeCostUsd(
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, cacheCreation5m: 0, cacheCreation1h: 1000 }, "claude-opus-4-8",
      )!;
      expect(write5mOnly).toBeCloseTo((1000 / M) * p.inputPerMTok * 1.25, 10);
      expect(write1hOnly).toBeCloseTo((1000 / M) * p.inputPerMTok * 2, 10);
      expect(write1hOnly).toBeCloseTo(write5mOnly * 1.6, 10);   // 2x vs 1.25x

      const mixed = computeCostUsd(
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, cacheCreation5m: 400, cacheCreation1h: 600 }, "claude-opus-4-8",
      )!;
      expect(mixed).toBeCloseTo(write5mOnly * 0.4 + write1hOnly * 0.6, 10);
    });

    it("unresolved TTL (flat cacheCreation only) defaults to the 1-hour rate for a claude model — an ASSUMPTION, documented, not a detection", () => {
      const p = MODEL_PRICING["claude-sonnet-5"]!;
      const flatOnly = computeCostUsd({ input: 0, output: 0, cacheRead: 0, cacheCreation: 1000 }, "claude-sonnet-5")!;
      expect(flatOnly).toBeCloseTo((1000 / 1_000_000) * p.inputPerMTok * 2, 10);
    });

    it("GPT-5.6 cache writes stay at the single 1.25x rate regardless — no 1-hour tier exists to default to", () => {
      const p = MODEL_PRICING["gpt-5.6-sol"]!;
      expect(p.cacheWrite1hPerMTok).toBeUndefined();
      const flatOnly = computeCostUsd({ input: 0, output: 0, cacheRead: 0, cacheCreation: 1000 }, "gpt-5.6-sol")!;
      expect(flatOnly).toBeCloseTo((1000 / 1_000_000) * p.inputPerMTok * 1.25, 10);
      // Even a (nonsensical for this provider) explicit "1h" split falls back to the 5m rate,
      // since gpt-5.6-sol carries no cacheWrite1hPerMTok of its own.
      const splitAnyway = computeCostUsd(
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, cacheCreation5m: 0, cacheCreation1h: 1000 }, "gpt-5.6-sol",
      )!;
      expect(splitAnyway).toBeCloseTo(flatOnly, 10);
    });

    // Recomputes RM-1's live measured baseline (memory record b003ccd9, chimera/tokenopt,
    // 2026-07-25): a real claude-opus-5 spawn recorded costUsd=0.0956585 for
    // {input:2, output:4, cacheRead:16737, cacheCreation:8718} against the live dynamic catalog's
    // rates ($5 in / $25 out / $0.5 cached-read per MTok) — matched EXACTLY by a 2x/1-hour
    // cache-write multiplier, and undercounted by 34% (0.062966) under the old flat 1.25x. Uses
    // the ModelMetadataLookup injection seam to feed claude-opus-5's real rates (it has no
    // hardcoded MODEL_PRICING row — it's dynamic-catalog only) so this is a faithful replay, not a
    // re-derivation, of that measured run.
    it("recomputes the RM-1 baseline live run — corrected figure vs the old undercounted one", () => {
      const catalog: ModelMetadataLookup = {
        contextWindow: () => undefined,
        pricing: () => ({ inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5, cacheWrite1hPerMTok: 10 }),
      };
      const usage = { input: 2, output: 4, cacheRead: 16737, cacheCreation: 8718 };
      const corrected = computeCostUsd(usage, "claude-opus-5", catalog)!;
      expect(corrected).toBeCloseTo(0.0956585, 6);

      const M = 1_000_000;
      const oldFigure = (usage.input / M) * 5 + (usage.output / M) * 25 + (usage.cacheRead / M) * 0.5 + (usage.cacheCreation / M) * 5 * 1.25;
      expect(oldFigure).toBeCloseTo(0.062966, 6);
      expect(corrected).toBeGreaterThan(oldFigure * 1.3);   // ~34% undercount, matching RM-1's own finding
    });

    // PRICING-SHADOW (2026-07-25, memory d05679c6): reproduces the actual live bug, not the
    // idealized RM-1 replay above — INT-3 found the live dynamic catalog has base pricing for
    // claude-sonnet-5 (a MODEL_PRICING row that DOES carry cacheWrite1hPerMTok) but OMITS the
    // cache-write fields entirely, for every one of 2663 checked entries. Before this fix,
    // pricingFor's dynamic row shadowed MODEL_PRICING wholesale, so this fell to the legacy 1.25x
    // multiplier of the DYNAMIC input rate — silently wrong for every real Claude spawn that ever
    // hits this fallback.
    it("a dynamic catalog row missing cache-write fields falls back to the hardcoded Claude 1h rate, not the legacy 1.25x", () => {
      const catalog: ModelMetadataLookup = {
        contextWindow: () => undefined,
        // Base pricing only — mirrors the live model-catalog.json shape INT-3 found: no
        // cacheWrite5m/1hPerMTok on the dynamic row at all.
        pricing: () => ({ inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.4 }),
      };
      const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000 };
      const shadowed = computeCostUsd(usage, "claude-sonnet-5", catalog)!;
      const hardcoded = MODEL_PRICING["claude-sonnet-5"]!;
      expect(shadowed).toBeCloseTo((1000 / 1_000_000) * hardcoded.cacheWrite1hPerMTok!, 10);
      // The bug's signature: the legacy multiplier applied to the DYNAMIC (not hardcoded) input
      // rate would have given a different, wrong number — confirm we're not accidentally there.
      expect(shadowed).not.toBeCloseTo((1000 / 1_000_000) * 4 * 1.25, 10);

      // Non-Claude models are untouched: GPT-5.6's dynamic/hardcoded rates already agree, no
      // carve-out should engage even if the dynamic row similarly omits cache-write fields.
      const codexCatalog: ModelMetadataLookup = {
        contextWindow: () => undefined,
        pricing: () => ({ inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5 }),
      };
      const codexUnshadowed = computeCostUsd(usage, "gpt-5.6-sol", codexCatalog)!;
      expect(codexUnshadowed).toBeCloseTo((1000 / 1_000_000) * 5 * 1.25, 10);
    });
  });

  // P0-3 PRICING: every hardcoded row must be self-describing about how trustworthy its figures
  // are — "authoritative" (independently verified against a real, cited, published price) or
  // "modeled" (approximated/scaled, not independently re-verified). gpt-5.6-sol is the only row
  // re-verified in this pass; every other row is inherited and untouched, hence "modeled".
  // KIMI-BACKEND S1: kimi-k3 joins gpt-5.6-sol as a second independently re-verified row (real
  // published Moonshot rate, checked live 2026-07-28 -- see its own MODEL_PRICING comment), not
  // an invented figure -- so the "only gpt-5.6-sol" carve-out from this test's original pass
  // widens to both authoritative rows explicitly, rather than silently accepting any row.
  // PROVIDER-CATALOG-REFRESH-2026-08: 5 more rows join the authoritative set -- glm-5.2,
  // openai/gpt-oss-120b, and the two corrected fireworks ids -- each independently re-verified
  // against a live source in that pass (see their own MODEL_PRICING comments), not invented.
  it("every MODEL_PRICING row carries a provenance tag, and only the independently re-verified rows are authoritative", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.provenance, `${model} is missing a provenance tag`).toMatch(/^(authoritative|modeled)$/);
    }
    const authoritative = new Set([
      "gpt-5.6-sol", "kimi-k3", "glm-5.2", "openai/gpt-oss-120b",
      "accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/models/glm-5p2",
    ]);
    for (const model of authoritative) {
      expect(MODEL_PRICING[model]!.provenance, model).toBe("authoritative");
    }
    const others = Object.entries(MODEL_PRICING).filter(([model]) => !authoritative.has(model));
    expect(others.every(([, pricing]) => pricing.provenance === "modeled")).toBe(true);
  });
});

// R2 (ctx meter effective-limit): a configured compaction threshold — "the point at which WE
// compact" — must win over the model's native window whenever it's set; unset falls back to
// contextWindowFor's own model-window/DEFAULT_CONTEXT_WINDOW chain, byte-identical.
describe("effectiveContextLimitFor", () => {
  it("a configured limit wins over the model's native window, even when the model's window is larger", () => {
    expect(effectiveContextLimitFor("gpt-5.6-sol", 90_000)).toBe(90_000);   // 1.05M native, 90k configured
  });

  it("a configured limit wins even when it EXCEEDS the model's native window", () => {
    expect(effectiveContextLimitFor("claude-opus-4-8", 500_000)).toBe(500_000);   // 200k native, 500k configured
  });

  it("unset (undefined) falls back to contextWindowFor(model)", () => {
    expect(effectiveContextLimitFor("gpt-5.6-sol", undefined)).toBe(1_050_000);
    expect(effectiveContextLimitFor("claude-opus-4-8", undefined)).toBe(200_000);
  });

  it("unset + unknown/undefined model falls back to DEFAULT_CONTEXT_WINDOW", () => {
    expect(effectiveContextLimitFor("some-unknown-model", undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(effectiveContextLimitFor(undefined, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

// CTX-METER-TRIGGER-CLAMP: claude.ts clamps compactionThreshold into the SDK's own validated
// auto-compact range [100_000, 1_000_000] before using it as the real trigger — this must mirror
// that exactly so the ctx meter's denominator (fed through effectiveContextLimitFor above) never
// diverges from the point compaction actually fires at (CTX-COMPACTION-AUDIT finding B).
describe("clampCompactionThresholdForProvider", () => {
  it("claude: a value below the SDK floor clamps up to 100_000", () => {
    expect(clampCompactionThresholdForProvider("claude", 50_000)).toBe(100_000);
  });

  it("claude: a value above the SDK ceiling clamps down to 1_000_000", () => {
    expect(clampCompactionThresholdForProvider("claude", 5_000_000)).toBe(1_000_000);
  });

  it("claude: a value already inside the valid range is untouched", () => {
    expect(clampCompactionThresholdForProvider("claude", 300_000)).toBe(300_000);
  });

  it("non-claude providers pass the raw value through unclamped (their own trigger has no such SDK range)", () => {
    expect(clampCompactionThresholdForProvider("codex", 50_000)).toBe(50_000);
    expect(clampCompactionThresholdForProvider("codex", 5_000_000)).toBe(5_000_000);
    expect(clampCompactionThresholdForProvider(undefined, 50_000)).toBe(50_000);
  });

  it("undefined threshold stays undefined regardless of provider", () => {
    expect(clampCompactionThresholdForProvider("claude", undefined)).toBeUndefined();
    expect(clampCompactionThresholdForProvider("codex", undefined)).toBeUndefined();
  });
});

// LONG-CONTEXT-SUFFIX: observed live — claude-opus-5[1m] and claude-fable-5[1m] agents were
// stamped with a 200k window, so their ctx bars read five times too full and chimera's own
// compaction trigger would fire with most of the window still free.
describe("1M-context model variants", () => {
  it("reads the window from the [1m] suffix instead of falling to the 200k default", () => {
    expect(contextWindowFor("claude-opus-5[1m]", undefined)).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5[1m]", undefined)).toBe(1_000_000);
  });

  // CTX-WINDOW-5-SERIES: this originally asserted the base ids were 200k, which was simply the
  // wrong fact — the live model catalog reports contextWindow 1_000_000 for the whole Claude 5
  // family on the PLAIN id. The 200k table entries understated it five-fold, which is what
  // printed "100% · 210k/200k" for an agent with most of its window free.
  it("gives the Claude 5 family its real 1M window on the plain id too", () => {
    expect(contextWindowFor("claude-opus-5", undefined)).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5", undefined)).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5", undefined)).toBe(1_000_000);
  });

  it("still 200k for a model that really is 200k — the family rule is not a blanket one", () => {
    expect(contextWindowFor("claude-opus-4-8", undefined)).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5-20251001", undefined)).toBe(200_000);
  });

  it("an explicit catalog entry still wins — the suffix is the FALLBACK, not an override", () => {
    const catalog = { contextWindow: (m: string) => (m === "claude-opus-5[1m]" ? 900_000 : undefined), pricing: () => null } as never;
    expect(contextWindowFor("claude-opus-5[1m]", catalog)).toBe(900_000);
  });

  it("an operator's compaction threshold still wins over the model's window", () => {
    expect(effectiveContextLimitFor("claude-opus-5[1m]", 150_000)).toBe(150_000);
  });
});
