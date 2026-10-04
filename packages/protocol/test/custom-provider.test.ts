import { describe, it, expect } from "vitest";
import { CustomProviderSchema, ChimeraConfigSchema } from "@chimera/protocol";

describe("CUSTOM-OPENAI-COMPAT: CustomProviderSchema", () => {
  it("parses a minimal entry and defaults requiresKey to false", () => {
    const p = CustomProviderSchema.parse({
      label: "Ollama (local)", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    expect(p.requiresKey).toBe(false);
  });

  it("accepts an explicit requiresKey: true", () => {
    const p = CustomProviderSchema.parse({
      label: "vLLM", baseUrl: "https://vllm.internal/v1", defaultModel: "llama-4", requiresKey: true,
    });
    expect(p.requiresKey).toBe(true);
  });

  it("rejects an empty label/baseUrl/defaultModel", () => {
    expect(() => CustomProviderSchema.parse({ label: "", baseUrl: "x", defaultModel: "x" })).toThrow();
    expect(() => CustomProviderSchema.parse({ label: "x", baseUrl: "", defaultModel: "x" })).toThrow();
    expect(() => CustomProviderSchema.parse({ label: "x", baseUrl: "x", defaultModel: "" })).toThrow();
  });

  it("rejects unknown fields (strict) — no invented key field can sneak into config", () => {
    expect(() =>
      CustomProviderSchema.parse({ label: "x", baseUrl: "x", defaultModel: "x", apiKey: "sk-fake" }),
    ).toThrow();
  });
});

describe("CUSTOM-OPENAI-COMPAT: ChimeraConfigSchema.customProviders", () => {
  it("is optional — old configs with no customProviders field still parse byte-identically", () => {
    const cfg = ChimeraConfigSchema.parse({});
    expect(cfg.customProviders).toBeUndefined();
  });

  it("parses a map of custom providers keyed by operator-chosen id", () => {
    const cfg = ChimeraConfigSchema.parse({
      customProviders: {
        "ollama-local": { label: "Ollama", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx" },
      },
    });
    expect(cfg.customProviders?.["ollama-local"]?.defaultModel).toBe("qwen3.5:9b-mlx");
    expect(cfg.customProviders?.["ollama-local"]?.requiresKey).toBe(false);
  });
});
