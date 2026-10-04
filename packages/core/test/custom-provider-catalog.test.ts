import { describe, it, expect } from "vitest";
import { PROVIDERS, customProviderProfile, effectiveCatalog, findEffectiveProvider } from "@chimera/core/providers/catalog";

const OLLAMA = { label: "Ollama (local)", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx", requiresKey: false };

describe("CUSTOM-OPENAI-COMPAT: customProviderProfile", () => {
  it("synthesizes an openai-compat profile keyed by the operator's own id", () => {
    const p = customProviderProfile("ollama-local", OLLAMA);
    expect(p.id).toBe("ollama-local");
    expect(p.kind).toBe("openai-compat");
    expect(p.baseUrl).toBe(OLLAMA.baseUrl);
    expect(p.defaultModel).toBe(OLLAMA.defaultModel);
    expect(p.requiresKey).toBe(false);
    expect(p.custom).toBe(true);
  });

  it("synthesizes a stable, collision-free envVar from the id (no invented key value)", () => {
    const p = customProviderProfile("ollama-local", OLLAMA);
    expect(p.envVar).toBe("CUSTOM_OLLAMA_LOCAL_API_KEY");
  });

  it("derives modelsEndpoint from baseUrl for model discovery", () => {
    const p = customProviderProfile("ollama-local", OLLAMA);
    expect(p.modelsEndpoint).toBe("http://127.0.0.1:3333/v1/models");
  });
});

describe("CUSTOM-OPENAI-COMPAT: effectiveCatalog / findEffectiveProvider", () => {
  it("with no customProviders/providerOverrides, returns the built-in catalog unchanged", () => {
    const cat = effectiveCatalog({});
    expect(cat.length).toBe(PROVIDERS.length);
    expect(cat).toEqual(PROVIDERS);
  });

  it("appends synthesized profiles for each customProviders entry", () => {
    const cat = effectiveCatalog({ customProviders: { "ollama-local": OLLAMA } });
    expect(cat.length).toBe(PROVIDERS.length + 1);
    expect(findEffectiveProvider("ollama-local", { customProviders: { "ollama-local": OLLAMA } })?.baseUrl).toBe(OLLAMA.baseUrl);
  });

  it("a built-in id always wins over any same-id custom entry (no hijacking)", () => {
    const cfg = { customProviders: { openai: { ...OLLAMA, label: "fake openai" } } };
    const resolved = findEffectiveProvider("openai", cfg);
    expect(resolved?.custom).toBeUndefined();
    expect(resolved?.baseUrl).not.toBe(OLLAMA.baseUrl);
  });

  it("providerOverrides still applies to built-ins alongside custom providers", () => {
    const cfg = {
      providerOverrides: { openai: { baseUrl: "https://proxy.internal/v1" } },
      customProviders: { "ollama-local": OLLAMA },
    };
    expect(findEffectiveProvider("openai", cfg)?.baseUrl).toBe("https://proxy.internal/v1");
    expect(findEffectiveProvider("ollama-local", cfg)?.baseUrl).toBe(OLLAMA.baseUrl);
  });

  it("findEffectiveProvider returns undefined for an unknown id", () => {
    expect(findEffectiveProvider("nope", {})).toBeUndefined();
  });
});
