import { describe, it, expect } from "vitest";
import { fetchProviderModels } from "@chimera/core/providers/models";
import { findProvider } from "@chimera/core/providers/catalog";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("F23-1A: fetchProviderModels", () => {
  it("openai: hits modelsEndpoint with Bearer auth and returns live ids", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "gpt-5.1" }, { id: "gpt-5.1-mini" }] });
    const ids = await fetchProviderModels(findProvider("openai")!, "sk-test", fn);
    expect(ids).toEqual(["gpt-5.1", "gpt-5.1-mini"]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("xai: hits its own modelsEndpoint", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "grok-4.5" }] });
    const ids = await fetchProviderModels(findProvider("xai")!, "xai-key", fn);
    expect(ids).toEqual(["grok-4.5"]);
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/models");
  });

  it("deepseek: hits its own modelsEndpoint", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] });
    const ids = await fetchProviderModels(findProvider("deepseek")!, "ds-key", fn);
    expect(ids).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/models");
  });

  it("groq: hits the /openai/v1/models path (base URL includes /openai)", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "llama-3.3-70b-versatile" }] });
    const ids = await fetchProviderModels(findProvider("groq")!, "gsk-key", fn);
    expect(ids).toEqual(["llama-3.3-70b-versatile"]);
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/models");
  });

  // SPAWN-FORM-ACCOUNTS: claude's live probe reuses the same {data:[{id}]} shape as
  // every openai-compat provider above — only the auth header differs (x-api-key, raw
  // value, no "Bearer " scheme) plus the required anthropic-version header.
  it("claude: hits its modelsEndpoint with x-api-key + anthropic-version, no Bearer scheme", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-5" }] });
    const ids = await fetchProviderModels(findProvider("claude")!, "sk-ant-test", fn);
    expect(ids).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("falls back to the catalog's fallback list on a non-2xx response", async () => {
    const { fn } = fakeFetch(401, { error: "unauthorized" });
    const ids = await fetchProviderModels(findProvider("groq")!, "bad-key", fn);
    expect(ids).toEqual(findProvider("groq")!.models);
  });

  it("falls back to the catalog's fallback list when the response has no data", async () => {
    const { fn } = fakeFetch(200, {});
    const ids = await fetchProviderModels(findProvider("xai")!, "k", fn);
    expect(ids).toEqual(findProvider("xai")!.models);
  });

  it("falls back on a network error instead of throwing", async () => {
    const fn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const ids = await fetchProviderModels(findProvider("deepseek")!, "k", fn);
    expect(ids).toEqual(findProvider("deepseek")!.models);
  });

  it("returns the fallback list immediately when a profile has no modelsEndpoint", async () => {
    const noEndpoint = { ...findProvider("groq")!, modelsEndpoint: undefined };
    const { fn, calls } = fakeFetch(200, { data: [{ id: "should-not-be-called" }] });
    const ids = await fetchProviderModels(noEndpoint, "k", fn);
    expect(ids).toEqual(noEndpoint.models);
    expect(calls).toHaveLength(0);
  });

  // SDK-MODEL-LISTS: gemini-native's response shape differs from every openai-compat
  // provider above -- `{models:[{name:"models/<id>"}]}` instead of `{data:[{id}]}` -- and
  // its auth is x-goog-api-key (raw value, no Bearer scheme), same convention as claude's
  // x-api-key above.
  it("gemini-native: parses the {models:[{name}]} shape, stripping the \"models/\" prefix", async () => {
    const { fn, calls } = fakeFetch(200, { models: [{ name: "models/gemini-3.5-flash" }, { name: "models/gemini-2.5-pro" }] });
    const ids = await fetchProviderModels(findProvider("gemini-native")!, "fake-gemini-key", fn);
    expect(ids).toEqual(["gemini-3.5-flash", "gemini-2.5-pro"]);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("fake-gemini-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("gemini-native: falls back to the catalog list when the response has neither data nor models", async () => {
    const { fn } = fakeFetch(200, {});
    const ids = await fetchProviderModels(findProvider("gemini-native")!, "k", fn);
    expect(ids).toEqual(findProvider("gemini-native")!.models);
  });

  it("grok-build: hits its best-effort modelsEndpoint with standard Bearer auth", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ id: "grok-4.5" }] });
    const ids = await fetchProviderModels(findProvider("grok-build")!, "fake-grok-key", fn);
    expect(ids).toEqual(["grok-4.5"]);
    expect(calls[0]!.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer fake-grok-key");
  });
});
