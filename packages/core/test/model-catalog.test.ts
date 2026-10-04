import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelCatalogService,
  parseLiteLlmCatalog,
} from "@chimera/core/providers/model-catalog";
import { estimateEffectiveSpendUsd } from "@chimera/core/budget";
import { makeMultiProviderSupervisor } from "./helpers.js";
import {
  contextWindowFor,
  pricingFor,
  computeCostUsd,
  effectiveContextLimitFor,
  DEFAULT_CONTEXT_WINDOW,
  type ModelCatalogConfig,
} from "@chimera/protocol";

// DYNAMIC-MODEL-METADATA: exercises the layered resolver end-to-end — resolution order, TTL
// staleness, the offline/failed-fetch path, LiteLLM parsing, and the protocol-function injection
// that all cost/context consumers funnel through.

const LITELLM_SAMPLE = {
  // doc key with no numeric fields — must be skipped, never surface as a model.
  sample_spec: { max_input_tokens: "abc", litellm_provider: "example" },
  // a REAL model absent from protocol's hardcoded map — proves catalog-sourced resolution.
  "vendor-omega-2": {
    max_input_tokens: 500_000,
    max_output_tokens: 64_000,
    input_cost_per_token: 0.000_002, // -> 2 / MTok
    output_cost_per_token: 0.000_010, // -> 10 / MTok
    cache_read_input_token_cost: 0.000_000_2, // -> 0.2 / MTok
    litellm_provider: "vendor",
  },
  // context-only entry (no costs) — contributes a window but no pricing.
  "vendor-ctxonly": { max_tokens: 32_000, litellm_provider: "vendor" },
  // pricing without an explicit cache-read cost — cachedInputPerMTok defaults to 10% of input.
  "vendor-nocache": {
    max_input_tokens: 128_000,
    input_cost_per_token: 0.000_001, // -> 1 / MTok
    output_cost_per_token: 0.000_004, // -> 4 / MTok
    litellm_provider: "vendor",
  },
};

function cfg(overrides: Partial<ModelCatalogConfig> = {}): ModelCatalogConfig {
  return {
    overrides: {},
    remote: { enabled: true, url: "https://example.test/catalog.json", ttlHours: 24 },
    ...overrides,
  };
}

// per-MTok figures come from float × 1e6, so compare field-wise with tolerance, not deep-equal.
function expectPricingClose(
  actual: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok: number } | null | undefined,
  expected: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok: number },
): void {
  expect(actual).toBeTruthy();
  expect(actual!.inputPerMTok).toBeCloseTo(expected.inputPerMTok, 9);
  expect(actual!.outputPerMTok).toBeCloseTo(expected.outputPerMTok, 9);
  expect(actual!.cachedInputPerMTok).toBeCloseTo(expected.cachedInputPerMTok, 9);
}

const okFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
const failFetch = (): typeof fetch =>
  (async () => { throw new Error("ENETDOWN"); }) as unknown as typeof fetch;

describe("parseLiteLlmCatalog", () => {
  it("converts per-token costs to per-MTok, reads context, skips junk", () => {
    const parsed = parseLiteLlmCatalog(LITELLM_SAMPLE);
    expect(parsed["sample_spec"]).toBeUndefined();
    expect(parsed["vendor-omega-2"].contextWindow).toBe(500_000);
    expectPricingClose(parsed["vendor-omega-2"].pricing, { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 });
    // context-only entry has a window and no pricing.
    expect(parsed["vendor-ctxonly"]).toEqual({ contextWindow: 32_000 });
    expect(parsed["vendor-ctxonly"].pricing).toBeUndefined();
    // missing cache-read cost defaults to 10% of input.
    expectPricingClose(parsed["vendor-nocache"].pricing, { inputPerMTok: 1, outputPerMTok: 4, cachedInputPerMTok: 0.1 });
  });
});

describe("ModelCatalogService", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "chimera-catalog-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("resolution order: config override > remote cache > (provider api) > hardcoded fallback", async () => {
    const logs: string[] = [];
    const svc = new ModelCatalogService(
      () => cfg({ overrides: { "vendor-omega-2": { contextWindow: 999_999 } } }),
      { home, fetchImpl: okFetch(LITELLM_SAMPLE), log: (l) => logs.push(l) },
    );
    await svc.refresh();

    // Layer 1 (config override) beats the remote value for the same model.
    expect(svc.contextWindow("vendor-omega-2")).toBe(999_999);
    // …but the override pinned only contextWindow, so pricing falls through to the remote layer.
    expectPricingClose(svc.pricing("vendor-omega-2"), { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 });
    // Layer 2 (remote) for a model with no override.
    expect(svc.contextWindow("vendor-nocache")).toBe(128_000);
    // Miss on every layer 1-3 ⇒ undefined (protocol then applies layers 4/default).
    expect(svc.contextWindow("totally-unknown-model")).toBeUndefined();
    expect(svc.pricing("totally-unknown-model")).toBeUndefined();

    expect(logs.some((l) => l.includes("refreshed") && l.includes("models"))).toBe(true);
  });

  it("protocol consumers fall through service → hardcoded map → default", async () => {
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: okFetch(LITELLM_SAMPLE) });
    await svc.refresh();

    // ACCEPTANCE: gpt-5.6-sol is not in the remote sample, resolves 1.05M from the hardcoded map.
    expect(contextWindowFor("gpt-5.6-sol", svc)).toBe(1_050_000);
    // ACCEPTANCE: a model missing from the hardcoded map resolves context + pricing from the catalog.
    expect(contextWindowFor("vendor-omega-2", svc)).toBe(500_000);
    expectPricingClose(pricingFor("vendor-omega-2", svc), { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 });
    // Unknown model preserves DEFAULT behavior.
    expect(contextWindowFor("no-such-model", svc)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(pricingFor("no-such-model", svc)).toBeNull();
    // effectiveContextLimit honors a configured compaction threshold over the resolved window.
    expect(effectiveContextLimitFor("vendor-omega-2", 120_000, svc)).toBe(120_000);
    expect(effectiveContextLimitFor("vendor-omega-2", undefined, svc)).toBe(500_000);
  });

  it("cost estimates use catalog pricing for a model outside the hardcoded map", async () => {
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: okFetch(LITELLM_SAMPLE) });
    await svc.refresh();
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };
    // 1M input @ $2/MTok + 1M output @ $10/MTok = $12 exactly.
    expect(computeCostUsd(usage, "vendor-omega-2", svc)).toBeCloseTo(12, 9);
    expect(estimateEffectiveSpendUsd(usage, "vendor-omega-2", svc)).toBeCloseTo(12, 9);
    // Without the catalog, an unknown model is unpriced (null) and the estimate uses the flat rate.
    expect(computeCostUsd(usage, "vendor-omega-2")).toBeNull();
  });

  it("TTL staleness: fresh cache is not refetched; a stale one is", async () => {
    let t = 1_000_000;
    let fetches = 0;
    const countingFetch: typeof fetch = (async () => {
      fetches++;
      return { ok: true, status: 200, json: async () => LITELLM_SAMPLE };
    }) as unknown as typeof fetch;

    // First populate: await refresh() explicitly so the persist to disk completes deterministically
    // (init()'s refresh is fire-and-forget — fine in production, racy for a "then read the file" test).
    const svc1 = new ModelCatalogService(() => cfg({ remote: { enabled: true, url: "x", ttlHours: 24 } }), {
      home, now: () => t, fetchImpl: countingFetch,
    });
    await svc1.refresh();
    expect(fetches).toBe(1);

    // A brand-new service within the TTL loads the persisted cache and does NOT refetch.
    t += 60 * 60 * 1000; // +1h, still < 24h
    const svc2 = new ModelCatalogService(() => cfg({ remote: { enabled: true, url: "x", ttlHours: 24 } }), {
      home, now: () => t, fetchImpl: countingFetch,
    });
    await svc2.init();
    await new Promise((r) => setImmediate(r));
    expect(fetches).toBe(1);
    expect(svc2.contextWindow("vendor-omega-2")).toBe(500_000); // served from persisted cache

    // Past the TTL, a fresh service DOES refetch (fetch is invoked synchronously inside init()'s
    // refresh, so the counter is already bumped by the time init() resolves).
    t += 24 * 60 * 60 * 1000;
    const svc3 = new ModelCatalogService(() => cfg({ remote: { enabled: true, url: "x", ttlHours: 24 } }), {
      home, now: () => t, fetchImpl: countingFetch,
    });
    await svc3.init();
    await svc3.refresh(); // join background persistence before removing the fixture
    expect(fetches).toBe(2);
  });

  it("offline: a failed fetch serves the stale cache and never throws", async () => {
    // Seed a good cache.
    const good = new ModelCatalogService(() => cfg(), { home, fetchImpl: okFetch(LITELLM_SAMPLE) });
    await good.refresh();
    expect(good.contextWindow("vendor-omega-2")).toBe(500_000);

    // A new service loads that cache, then a failing refresh keeps serving it.
    const logs: string[] = [];
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: failFetch(), log: (l) => logs.push(l) });
    await svc.init();
    await expect(svc.refresh()).resolves.toBeUndefined(); // does not throw
    expect(svc.contextWindow("vendor-omega-2")).toBe(500_000); // stale cache preserved
    expect(logs.some((l) => l.includes("fetch failed") && l.includes("stale cache"))).toBe(true);
  });

  it("offline with no cache: falls all the way to the hardcoded map / default via protocol", async () => {
    const logs: string[] = [];
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: failFetch(), log: (l) => logs.push(l) });
    await svc.init(); // no persisted file, fetch fails
    await svc.refresh();
    // Layers 1-3 all empty ⇒ undefined; protocol then supplies hardcoded/default.
    expect(svc.contextWindow("vendor-omega-2")).toBeUndefined();
    expect(contextWindowFor("gpt-5.6-sol", svc)).toBe(1_050_000); // hardcoded fallback intact
    expect(contextWindowFor("anything", svc)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(logs.some((l) => l.includes("hardcoded model map"))).toBe(true);
  });

  it("remote.enabled=false: init never fetches, only override + cache + fallback apply", async () => {
    let fetches = 0;
    const countingFetch: typeof fetch = (async () => { fetches++; return { ok: true, status: 200, json: async () => LITELLM_SAMPLE }; }) as unknown as typeof fetch;
    const svc = new ModelCatalogService(
      () => cfg({ overrides: { "pinned-x": { contextWindow: 111_000, pricing: { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 0.5 } } }, remote: { enabled: false, url: "x", ttlHours: 24 } }),
      { home, fetchImpl: countingFetch },
    );
    await svc.init();
    await new Promise((r) => setImmediate(r));
    expect(fetches).toBe(0);
    // The override still resolves with no network.
    expect(svc.contextWindow("pinned-x")).toBe(111_000);
    expect(svc.pricing("pinned-x")).toEqual({ inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 0.5 });
  });

  it("persists atomically to CHIMERA_HOME/model-catalog.json", async () => {
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: okFetch(LITELLM_SAMPLE) });
    await svc.refresh();
    const raw = await readFile(join(home, "model-catalog.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed.fetchedAt).toBe("number");
    expect(parsed.entries["vendor-omega-2"].contextWindow).toBe(500_000);
    // no leftover tmp file
    await expect(readFile(join(home, `model-catalog.json.tmp.${process.pid}`), "utf8")).rejects.toThrow();
  });

  it("tolerates a corrupt persisted cache (starts empty, refetches)", async () => {
    await writeFile(join(home, "model-catalog.json"), "{ not json", "utf8");
    const svc = new ModelCatalogService(() => cfg(), { home, fetchImpl: okFetch(LITELLM_SAMPLE) });
    await svc.init();
    await svc.refresh(); // init returns before its background atomic write finishes
    expect(svc.contextWindow("vendor-omega-2")).toBe(500_000);
  });
});

// Codex session capacities must not inherit the shared API catalog, even when
// that catalog recognizes a model absent from Chimera's built-in table.
describe("AgentSupervisor: Codex capacity is independent of the API catalog", () => {
  const catalog = {
    contextWindow: (m: string) => (m === "vendor-omega-2" ? 500_000 : undefined),
    pricing: () => undefined,
  };

  it("keeps a Codex window unknown despite a third-party catalog entry", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[{ awaitSend: true }]], undefined, { modelCatalog: catalog });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", model: "vendor-omega-2" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  it("keeps a Codex window unknown when the provider has not reported it", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", model: "vendor-omega-2" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });
});
