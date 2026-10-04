// F23-1A: FAZ-1 driver batch (openai, xai, deepseek, groq). All four ride the shared
// GenericAgentBackend + OpenAICompatChatClient (F23-0B/0C/0D) — nothing provider-specific to
// implement beyond the catalog entry + quirks (deepseek/groq text-only). These tests pin down:
// (1) each catalog entry's wiring (baseUrl/envVar/chatPath actually reach the wire request),
// (2) the D5 spawn-time vision guard fires for the two text-only providers and does NOT fire
// for the two vision-capable ones.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { AgentSpecSchema } from "@chimera/protocol";
import { findProvider } from "@chimera/core/providers/catalog";
import { buildBackends } from "@chimera/core/providers/registry";
import type { BackendEvent, PermissionDecider, ResolvedAgentSpec } from "@chimera/core/backend";

const allow: PermissionDecider = async () => true;
const settle = () => new Promise((r) => setTimeout(r, 20));

function specWithImage(): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({
      prompt: "describe this image", cwd: tmpdir(), isolation: "none",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
      ],
    }),
    agentId: "faz1a-1", accountName: "test", resolvedProvider: "test", env: {}, depth: 0,
  } as ResolvedAgentSpec;
}

function textOnlySpec(): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "hi", cwd: tmpdir(), isolation: "none" }),
    agentId: "faz1a-2", accountName: "test", resolvedProvider: "test", env: {}, depth: 0,
  } as ResolvedAgentSpec;
}

describe.each(["openai", "xai", "deepseek", "groq"])("F23-1A: %s catalog entry", (id) => {
  it("parses and carries the fields FAZ-1 promised", () => {
    const p = findProvider(id)!;
    expect(p.kind).toBe("openai-compat");
    expect(p.envVar).toBeTruthy();
    expect(p.modelsEndpoint).toBeTruthy();
    expect(p.models.length).toBeGreaterThan(0);
  });

  it("buildBackends wires a real request at the profile's baseUrl+chatPath with the right auth header", async () => {
    const seen: { url?: string; auth?: string } = {};
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = new Headers(init!.headers).get("Authorization") ?? undefined;
      return new Response("data: [DONE]\n", { status: 200 });
    }) as unknown as typeof fetch;

    const profile = findProvider(id)!;
    const backends = await buildBackends([profile], {
      providers: [id], fetchFn, env: { [profile.envVar!]: "test-key-123" } as unknown as NodeJS.ProcessEnv,
    });
    const backend = backends.get(id)!;
    const evs: BackendEvent[] = [];
    backend.spawn(textOnlySpec(), (e) => evs.push(e), allow);
    await settle();

    expect(seen.url).toBe(`${profile.baseUrl}${id === "openai" ? "/responses" : profile.chatPath ?? "/chat/completions"}`);
    expect(seen.auth).toBe("Bearer test-key-123");
  });
});

describe("F23-1A: text-only provider vision guard (deepseek, groq)", () => {
  it.each(["deepseek", "groq"])("%s rejects image content with a clean error, without ever calling fetch", async (id) => {
    let fetchCalled = false;
    const fetchFn = (async () => { fetchCalled = true; return new Response("data: [DONE]\n"); }) as unknown as typeof fetch;
    const profile = findProvider(id)!;
    expect(profile.capabilities.vision).toBe(false);

    const backends = await buildBackends([profile], {
      providers: [id], fetchFn, env: { [profile.envVar!]: "k" } as unknown as NodeJS.ProcessEnv,
    });
    const evs: BackendEvent[] = [];
    backends.get(id)!.spawn(specWithImage(), (e) => evs.push(e), allow);
    await settle();

    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "error"]);
    expect(String((evs[1]!.data as { message: string }).message)).toContain("does not support image input");
    expect(fetchCalled).toBe(false);
  });
});

describe("F23-1A: vision-capable providers (openai, xai) are unaffected by the guard", () => {
  it.each(["openai", "xai"])("%s accepts image content normally", async (id) => {
    let fetchCalled = false;
    const fetchFn = (async () => { fetchCalled = true; return new Response(id === "openai" ? 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n' : "data: [DONE]\n"); }) as unknown as typeof fetch;
    const profile = findProvider(id)!;
    expect(profile.capabilities.vision).toBe(true);

    const backends = await buildBackends([profile], {
      providers: [id], fetchFn, env: { [profile.envVar!]: "k" } as unknown as NodeJS.ProcessEnv,
    });
    const evs: BackendEvent[] = [];
    backends.get(id)!.spawn(specWithImage(), (e) => evs.push(e), allow);
    await settle();

    expect(evs.some((e) => e.kind === "error")).toBe(false);
    expect(fetchCalled).toBe(true);
  });
});
