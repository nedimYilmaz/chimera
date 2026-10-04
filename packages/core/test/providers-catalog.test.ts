import { describe, it, expect } from "vitest";
import { ProviderProfileSchema } from "@chimera/protocol";
import { PROVIDERS, findProvider, providerIds } from "@chimera/core/providers/catalog";

describe("F23-0D: provider catalog", () => {
  it("every entry parses against ProviderProfileSchema", () => {
    for (const p of PROVIDERS) {
      expect(() => ProviderProfileSchema.parse(p), `entry "${p.id}" failed to parse`).not.toThrow();
    }
  });

  it("every id is unique", () => {
    const ids = providerIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the two existing agentic-sdk drivers, untouched", () => {
    expect(findProvider("claude")?.kind).toBe("agentic-sdk");
    expect(findProvider("codex")?.kind).toBe("agentic-sdk");
  });

  // KIMI-BACKEND S1 (spec §5): a NEW agentic-sdk entry, id "kimi", distinct from the existing
  // "kimi-code" openai-compat entry -- both coexist.
  it("ships a new `kimi` agentic-sdk entry (subscription/oauth, not apiKey)", () => {
    const kimi = findProvider("kimi");
    expect(kimi?.kind).toBe("agentic-sdk");
    expect(kimi?.authModes).toEqual(["oauth"]);
    expect(kimi?.defaultModel).toBe("kimi-k3");
    expect(kimi?.models).toContain("kimi-k3");
    expect(kimi?.tosNote).toBeTruthy();
  });

  // KIMI-BACKEND S1 FALLBACK REQUIREMENT (spec §5): the new `kimi` entry must not alter or
  // replace the pre-existing `kimi-code` openai-compat/apiKey entry in any way.
  it("regression: kimi-code stays an unmodified openai-compat/apiKey entry alongside the new kimi entry", () => {
    const kimiCode = findProvider("kimi-code");
    expect(kimiCode?.kind).toBe("openai-compat");
    expect(kimiCode?.authModes).toEqual(["apiKey"]);
    expect(kimiCode?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(kimiCode?.envVar).toBe("KIMI_CODE_API_KEY");
    expect(kimiCode?.id).not.toBe(findProvider("kimi")?.id);
  });

  it("drops meta-llama (service sunset 2026-07-06 per the research addendum)", () => {
    expect(findProvider("meta-llama")).toBeUndefined();
  });

  it("ships the zero-OAuth subscription wins (kimi-code, zai-coding) as plain apiKey providers", () => {
    expect(findProvider("kimi-code")?.authModes).toEqual(["apiKey"]);
    expect(findProvider("zai-coding")?.authModes).toEqual(["apiKey"]);
  });

  it("marks copilot experimental (device-code OAuth, F23-2A) — gated behind config providers.experimental", () => {
    const copilot = findProvider("copilot");
    expect(copilot?.experimental).toBe(true);
    expect(copilot?.authModes).toEqual(["oauth"]);
  });

  it("marks grok-build experimental (external-CLI credential flow, F23-2A) — gated the same way", () => {
    const grokBuild = findProvider("grok-build");
    expect(grokBuild?.experimental).toBe(true);
    expect(grokBuild?.authModes).toEqual(["oauth"]);
    expect(grokBuild?.tosNote).toBeTruthy();
  });

  it("every openai-compat/native entry carries a non-empty envVar", () => {
    for (const p of PROVIDERS) {
      if (p.kind === "agentic-sdk") continue;
      expect(p.envVar, `entry "${p.id}" has no envVar`).toBeTruthy();
    }
  });

  it("findProvider returns undefined for an unknown id", () => {
    expect(findProvider("totally-unknown-provider")).toBeUndefined();
  });

  it("F23-1D: gemini defaults to the openai-compat layer, gemini-native is a separate opt-in kind:native entry", () => {
    const gemini = findProvider("gemini");
    expect(gemini?.kind).toBe("openai-compat");
    expect(gemini?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");

    const native = findProvider("gemini-native");
    expect(native?.kind).toBe("native");
    expect(native?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(native?.envVar).toBe("GEMINI_API_KEY");
    expect(native?.authModes).toEqual(["apiKey"]);
  });
});

describe("F23-1B: FAZ-1 driver batch quirks (moonshot/kimi-code/mistral/cerebras/fireworks)", () => {
  it("moonshot and kimi-code carry a generous (>= 1h) request timeout for long agentic turns", () => {
    for (const id of ["moonshot", "kimi-code"]) {
      const p = findProvider(id);
      expect(p?.timeoutMs, `entry "${id}" has no timeoutMs`).toBeGreaterThanOrEqual(3_600_000);
    }
  });

  it("every one of the 5 FAZ-1 entries declares a modelsEndpoint (model IDs are fallback-only)", () => {
    for (const id of ["moonshot", "kimi-code", "mistral", "cerebras", "fireworks"]) {
      const p = findProvider(id);
      expect(p?.modelsEndpoint, `entry "${id}" has no modelsEndpoint`).toMatch(/^https:\/\//);
    }
  });

  it("cerebras and moonshot capabilities match the research doc (no vision on cerebras; vision on moonshot's k3)", () => {
    expect(findProvider("cerebras")?.capabilities.vision).toBe(false);
    expect(findProvider("moonshot")?.capabilities.vision).toBe(true);
  });

  it("kimi-code is a plan-scoped subscription entry: apiKey-only, distinct envVar, tosNote present", () => {
    const p = findProvider("kimi-code");
    expect(p?.authModes).toEqual(["apiKey"]);
    expect(p?.envVar).toBe("KIMI_CODE_API_KEY");
    expect(p?.envVar).not.toBe(findProvider("moonshot")?.envVar);
    expect(p?.tosNote).toBeTruthy();
  });

  it("fireworks model ids use the accounts/fireworks/models/<name> shape", () => {
    for (const m of findProvider("fireworks")?.models ?? []) {
      expect(m).toMatch(/^accounts\/fireworks\/models\//);
    }
  });
});

describe("PROVIDER-CATALOG-REFRESH-2026-08: dead/stale model ids replaced", () => {
  it("openai no longer defaults to the retired gpt-5.1 family (shut down 2026-07-23)", () => {
    const openai = findProvider("openai");
    expect(openai?.defaultModel).toBe("gpt-5.6-sol");
    expect(openai?.models).not.toContain("gpt-5.1");
    expect(openai?.models).not.toContain("gpt-5.1-mini");
    expect(openai?.models).not.toContain("o4-mini");
  });

  it("groq no longer defaults to a model deprecating 2026-08-16 for free/dev-tier keys", () => {
    const groq = findProvider("groq");
    expect(groq?.defaultModel).toBe("openai/gpt-oss-120b");
    expect(groq?.models).toContain("openai/gpt-oss-120b");
  });

  it("fireworks uses the real dot-to-p-encoded ids, not the dead kimi-k2.6/glm-5.1 strings", () => {
    const fireworks = findProvider("fireworks");
    expect(fireworks?.defaultModel).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(fireworks?.models).not.toContain("accounts/fireworks/models/kimi-k2.6");
    expect(fireworks?.models).not.toContain("accounts/fireworks/models/glm-5.1");
    expect(fireworks?.models).toContain("accounts/fireworks/models/glm-5p2");
  });

  it("zai/zai-coding default to the current glm-5.2 flagship and are marked text-only (no vision)", () => {
    for (const id of ["zai", "zai-coding"]) {
      const p = findProvider(id);
      expect(p?.defaultModel, id).toBe("glm-5.2");
      expect(p?.models, id).toContain("glm-5.2");
      expect(p?.capabilities.vision, id).toBe(false);
    }
  });

  it("kimi-code uses the coding-plan endpoint's own model ids, not the pay-per-token kimi-k3 id", () => {
    const kimiCode = findProvider("kimi-code");
    expect(kimiCode?.defaultModel).toBe("k3");
    expect(kimiCode?.models).not.toContain("kimi-k3");
    // the pay-per-token `moonshot` entry correctly keeps kimi-k3 -- different host, different ids.
    expect(findProvider("moonshot")?.models).toContain("kimi-k3");
  });
});
