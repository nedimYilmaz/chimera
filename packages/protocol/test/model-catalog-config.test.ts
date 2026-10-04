import { describe, it, expect } from "vitest";
import {
  ChimeraConfigSchema,
  ModelCatalogConfigSchema,
  ModelCatalogEntrySchema,
  ModelCatalogPricingSchema,
  LITELLM_CATALOG_URL,
} from "@chimera/protocol";

// DYNAMIC-MODEL-METADATA (layer 1, config): schema unit coverage for the new ModelCatalog
// config field. Proves an old config (no `modelCatalog` key) parses to the shipped default,
// and that the overrides/remote sub-shapes carry the intended defaults and .strict() rejections.
// The layered RESOLVER + service behavior live in core/test/model-catalog.test.ts; this file
// pins only the protocol contract those consumers read.

describe("ModelCatalogConfigSchema", () => {
  it("applies field defaults to an empty config", () => {
    const cat = ModelCatalogConfigSchema.parse({});
    expect(cat.overrides).toEqual({});
    expect(cat.remote).toEqual({ enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 });
  });

  it("defaults the remote block when only overrides are supplied", () => {
    const cat = ModelCatalogConfigSchema.parse({
      overrides: { "vendor-omega-2": { contextWindow: 500_000 } },
    });
    expect(cat.remote).toEqual({ enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 });
    expect(cat.overrides["vendor-omega-2"]).toEqual({ contextWindow: 500_000 });
  });

  it("fills per-field remote defaults when the remote block is partial", () => {
    const cat = ModelCatalogConfigSchema.parse({ remote: { enabled: false } });
    expect(cat.remote).toEqual({ enabled: false, url: LITELLM_CATALOG_URL, ttlHours: 24 });
  });

  it("preserves an explicit remote url and ttlHours", () => {
    const cat = ModelCatalogConfigSchema.parse({
      remote: { enabled: true, url: "https://mirror.test/catalog.json", ttlHours: 6 },
    });
    expect(cat.remote.url).toBe("https://mirror.test/catalog.json");
    expect(cat.remote.ttlHours).toBe(6);
  });

  it("rejects a non-URL remote.url", () => {
    expect(() => ModelCatalogConfigSchema.parse({ remote: { url: "not-a-url" } })).toThrow();
  });

  it("rejects a non-positive remote.ttlHours", () => {
    expect(() => ModelCatalogConfigSchema.parse({ remote: { ttlHours: 0 } })).toThrow();
  });

  it("rejects an unknown key on the remote block (.strict)", () => {
    expect(() => ModelCatalogConfigSchema.parse({ remote: { enabled: true, poll: true } })).toThrow();
  });

  it("rejects an unknown key on the top-level config (.strict)", () => {
    expect(() => ModelCatalogConfigSchema.parse({ mirror: "x" })).toThrow();
  });
});

describe("ModelCatalogEntrySchema", () => {
  it("accepts a context-only override (pricing omitted)", () => {
    const entry = ModelCatalogEntrySchema.parse({ contextWindow: 128_000 });
    expect(entry.contextWindow).toBe(128_000);
    expect(entry.pricing).toBeUndefined();
  });

  it("accepts a pricing-only override (contextWindow omitted)", () => {
    const entry = ModelCatalogEntrySchema.parse({
      pricing: { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 0.5 },
    });
    expect(entry.contextWindow).toBeUndefined();
    expect(entry.pricing).toEqual({ inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 0.5 });
  });

  it("accepts an empty override (both fields omitted)", () => {
    expect(ModelCatalogEntrySchema.parse({})).toEqual({});
  });

  it("rejects a non-integer contextWindow", () => {
    expect(() => ModelCatalogEntrySchema.parse({ contextWindow: 128_000.5 })).toThrow();
  });

  it("rejects a non-positive contextWindow", () => {
    expect(() => ModelCatalogEntrySchema.parse({ contextWindow: 0 })).toThrow();
  });

  it("rejects an unknown key (.strict)", () => {
    expect(() => ModelCatalogEntrySchema.parse({ contextWindow: 1000, foo: "bar" })).toThrow();
  });
});

describe("ModelCatalogPricingSchema", () => {
  it("accepts nonnegative per-MTok figures, including zero", () => {
    const p = ModelCatalogPricingSchema.parse({ inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0 });
    expect(p).toEqual({ inputPerMTok: 0, outputPerMTok: 0, cachedInputPerMTok: 0 });
  });

  it("rejects a negative per-MTok figure", () => {
    expect(() => ModelCatalogPricingSchema.parse({ inputPerMTok: -1, outputPerMTok: 2, cachedInputPerMTok: 0.1 })).toThrow();
  });

  it("requires all three fields", () => {
    expect(() => ModelCatalogPricingSchema.parse({ inputPerMTok: 1, outputPerMTok: 2 })).toThrow();
  });

  it("rejects an unknown key (.strict)", () => {
    expect(() =>
      ModelCatalogPricingSchema.parse({ inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1, batchPerMTok: 0.5 }),
    ).toThrow();
  });
});

describe("ChimeraConfigSchema modelCatalog field", () => {
  const base = {
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
  };

  it("an old config with no modelCatalog key parses to the shipped default", () => {
    const cfg = ChimeraConfigSchema.parse(base);
    expect(cfg.modelCatalog).toEqual({
      overrides: {},
      remote: { enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 },
    });
  });

  it("preserves an operator-supplied modelCatalog block", () => {
    const cfg = ChimeraConfigSchema.parse({
      ...base,
      modelCatalog: {
        overrides: { "vendor-omega-2": { contextWindow: 999_999 } },
        remote: { enabled: false, url: "https://mirror.test/c.json", ttlHours: 12 },
      },
    });
    expect(cfg.modelCatalog.overrides["vendor-omega-2"]).toEqual({ contextWindow: 999_999 });
    expect(cfg.modelCatalog.remote).toEqual({ enabled: false, url: "https://mirror.test/c.json", ttlHours: 12 });
  });

  it("fills modelCatalog sub-defaults when only overrides are supplied", () => {
    const cfg = ChimeraConfigSchema.parse({ ...base, modelCatalog: { overrides: {} } });
    expect(cfg.modelCatalog.remote).toEqual({ enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 });
  });
});
