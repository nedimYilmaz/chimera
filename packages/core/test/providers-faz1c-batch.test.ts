import { describe, it, expect } from "vitest";
import { ProviderProfileSchema } from "@chimera/protocol";
import { findProvider } from "@chimera/core/providers/catalog";
import { openAiCompatClient } from "@chimera/core/providers/registry";

// F23-1C: FAZ-1 driver batch -- qwen, nvidia-nim, together, openrouter, cohere, zai,
// zai-coding. All of these already had a catalog entry from F23-0D; this batch adds
// modelsEndpoint + documents quirks (see catalog.ts comments + docs/providers/<id>.md) and
// proves each entry actually drives a real request through the shared F23-0B/0D transport
// (correct URL, auth header keyed off its own envVar, default model when none requested).
// No network I/O -- fetchFn is a test seam, same pattern as providers-registry.test.ts.

const BATCH_IDS = ["qwen", "nvidia-nim", "together", "openrouter", "cohere", "zai", "zai-coding"] as const;

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> }) {
  return (async (url: string | URL, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init!.headers as Record<string, string>;
    capture.body = JSON.parse(init!.body as string);
    return new Response("data: [DONE]\n", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("F23-1C: FAZ-1 driver batch catalog entries", () => {
  it("every batch id is present in the catalog and parses against ProviderProfileSchema", () => {
    for (const id of BATCH_IDS) {
      const p = findProvider(id);
      expect(p, `missing catalog entry for "${id}"`).toBeDefined();
      expect(() => ProviderProfileSchema.parse(p)).not.toThrow();
    }
  });

  it("every batch id ships a modelsEndpoint (live model list, not just the fallback array)", () => {
    for (const id of BATCH_IDS) {
      expect(findProvider(id)?.modelsEndpoint, `"${id}" has no modelsEndpoint`).toBeTruthy();
    }
  });

  it("qwen: intl base URL + region-scoped-key envVar", () => {
    const p = findProvider("qwen")!;
    expect(p.baseUrl).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(p.envVar).toBe("DASHSCOPE_API_KEY");
    expect(p.authModes).toEqual(["apiKey"]);
  });

  it("nvidia-nim: nvapi base + org/model default id", () => {
    const p = findProvider("nvidia-nim")!;
    expect(p.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(p.defaultModel).toContain("/");
    expect(p.envVar).toBe("NVIDIA_API_KEY");
  });

  it("together: org/Model default id", () => {
    const p = findProvider("together")!;
    expect(p.baseUrl).toBe("https://api.together.ai/v1");
    expect(p.defaultModel).toContain("/");
    expect(p.envVar).toBe("TOGETHER_API_KEY");
  });

  it("openrouter: aggregator default + envVar", () => {
    const p = findProvider("openrouter")!;
    expect(p.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(p.defaultModel).toBe("openrouter/auto");
    expect(p.envVar).toBe("OPENROUTER_API_KEY");
  });

  it("cohere: compat base + no vision (undocumented on compat layer)", () => {
    const p = findProvider("cohere")!;
    expect(p.baseUrl).toBe("https://api.cohere.ai/compatibility/v1");
    expect(p.capabilities.vision).toBe(false);
    expect(p.envVar).toBe("COHERE_API_KEY");
  });

  it("zai: pay-per-token base distinct from zai-coding's plan base", () => {
    const p = findProvider("zai")!;
    expect(p.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(p.envVar).toBe("ZAI_API_KEY");
  });

  it("zai-coding: GLM Coding Plan base + subscription envVar + tosNote present", () => {
    const p = findProvider("zai-coding")!;
    expect(p.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(p.envVar).toBe("ZAI_CODING_PLAN_API_KEY");
    expect(p.tosNote).toBeTruthy();
    expect(p.authModes).toEqual(["apiKey"]);
  });

  it.each(BATCH_IDS)("%s: drives a real request through openAiCompatClient with the correct URL, Bearer key, and default model", async (id) => {
    const profile = findProvider(id)!;
    const envValue = `test-key-${id}`;
    const capture: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    const client = openAiCompatClient(profile, {
      fetchFn: fakeFetch(capture),
      env: { [profile.envVar!]: envValue } as unknown as NodeJS.ProcessEnv,
    });

    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);

    expect(capture.url).toBe(`${profile.baseUrl}${profile.chatPath ?? "/chat/completions"}`);
    expect(capture.headers?.Authorization).toBe(`Bearer ${envValue}`);
    expect(capture.body?.model).toBe(profile.defaultModel);
  });
});
