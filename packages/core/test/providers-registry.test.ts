import { describe, it, expect } from "vitest";
import { AgentSpecSchema, computeCostUsd, type ModelMetadataLookup, type ProviderProfile } from "@chimera/protocol";
import { buildBackends, openAiCompatClient } from "@chimera/core/providers/registry";
import { PROVIDERS } from "@chimera/core/providers/catalog";
import { GenericAgentBackend } from "@chimera/core/backends/generic";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import type { CodexAgentBackend } from "@chimera/core/backends/codex";
import { KimiAgentBackend } from "@chimera/core/backends/kimi";
import { fakeCodex, cxSpec, settle } from "./codex-backend-helpers.js";

const XAI: ProviderProfile = {
  id: "xai", label: "xAI", kind: "openai-compat", baseUrl: "https://api.x.ai/v1",
  defaultModel: "grok-4.5", models: [], authModes: ["apiKey"],
  capabilities: { tools: true, vision: true, streaming: true }, envVar: "XAI_API_KEY",
};

describe("F23-0D: buildBackends", () => {
  it("constructs the two agentic-sdk backends for claude/codex", async () => {
    const backends = await buildBackends(PROVIDERS, { providers: ["claude", "codex"] });
    expect(backends.get("claude")?.provider).toBe("claude");
    expect(backends.get("codex")?.provider).toBe("codex");
    expect(backends.size).toBe(2);
  });

  it("constructs a GenericAgentBackend for every openai-compat/native catalog entry", async () => {
    const backends = await buildBackends([XAI], { providers: ["xai"] });
    const backend = backends.get("xai");
    expect(backend).toBeInstanceOf(GenericAgentBackend);
    expect(backend?.provider).toBe("xai");
    expect(backend?.capabilities).toEqual({ supportsResume: false, supportsMcpServers: true, supportsSettingSources: false, supportsVoiceRealtime: false });
  });

  it("filters to just the requested providers (unconfigured providers get no backend)", async () => {
    const backends = await buildBackends(PROVIDERS, { providers: ["claude"] });
    expect(backends.size).toBe(1);
    expect(backends.has("codex")).toBe(false);
    expect(backends.has("xai")).toBe(false);
  });

  it("builds every catalog provider when no filter is given", async () => {
    const backends = await buildBackends(PROVIDERS);
    expect(backends.size).toBe(PROVIDERS.length);
  });

  // KIMI-BACKEND S2: "kimi" is id-registered to the real KimiAgentBackend, not left
  // unregistered -- an unregistered id would silently drop it from buildBackends()'s output
  // above, breaking the "every catalog provider gets a backend" invariant just asserted.
  it("constructs a KimiAgentBackend for the new kimi catalog entry", async () => {
    const backends = await buildBackends(PROVIDERS, { providers: ["kimi"] });
    const backend = backends.get("kimi");
    expect(backend).toBeInstanceOf(KimiAgentBackend);
    expect(backend?.provider).toBe("kimi");
  });

  // KIMI-CLI-PROTOCOL (was KIMI-BACKEND S2): a kimiFactory test seam (mirrors codexFactory) lets
  // this stay hermetic -- full event-mapping/cost/kill/interrupt coverage lives in
  // kimi-backend.test.ts; this just proves buildBackends() wires deps.kimiFactory through to the
  // constructed backend. Factory shape changed with the ACP transport swap: it now returns
  // `{ready, killNow}` (ready resolves once the real handshake would complete) instead of a
  // synchronous SDK-shaped session -- and agent_started fires AFTER `ready` settles (carrying the
  // real ACP sessionId), not synchronously before any round trip like the old SDK path, so this
  // needs a settle tick before checking evs[0].
  it("forwards deps.kimiFactory to the constructed KimiAgentBackend", async () => {
    const evs: BackendEvent[] = [];
    const kimiFactory = () => ({
      ready: Promise.resolve({ sessionId: "sess-1", prompt: async () => ({ stopReason: "end_turn" }), cancel: async () => {}, close: async () => {} }),
      killNow: () => {},
    });
    const backends = await buildBackends(PROVIDERS, { providers: ["kimi"], kimiFactory: kimiFactory as never });
    const backend = backends.get("kimi") as KimiAgentBackend;
    const spec: ResolvedAgentSpec = {
      ...AgentSpecSchema.parse({ prompt: "hi", cwd: "/tmp", isolation: "none" }),
      agentId: "kimi-1", accountName: "kimi-acct", resolvedProvider: "kimi", env: {}, depth: 0,
    } as ResolvedAgentSpec;
    expect(() => backend.spawn(spec, (e) => evs.push(e), async () => true)).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(evs[0]).toMatchObject({ kind: "agent_started" });
  });

  it("a requested provider id absent from the catalog silently yields no backend (not a throw)", async () => {
    const backends = await buildBackends(PROVIDERS, { providers: ["totally-unknown-provider"] });
    expect(backends.size).toBe(0);
  });

  it("F23-1D: constructs a GenericAgentBackend for the gemini-native (kind:native) catalog entry", async () => {
    const backends = await buildBackends(PROVIDERS, { providers: ["gemini-native"] });
    const backend = backends.get("gemini-native");
    expect(backend).toBeInstanceOf(GenericAgentBackend);
    expect(backend?.provider).toBe("gemini-native");
  });

  it("reads the openai-compat API key from the injected env, keyed by the profile's envVar", async () => {
    let seenAuth: string | undefined;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      seenAuth = (init!.headers as Record<string, string>).Authorization;
      return new Response("data: [DONE]\n", { status: 200 });
    }) as unknown as typeof fetch;
    const client = openAiCompatClient(XAI, { fetchFn, env: { XAI_API_KEY: "sk-xai-test" } as unknown as NodeJS.ProcessEnv });
    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);
    expect(seenAuth).toBe("Bearer sk-xai-test");
  });

  it("GENERIC-SPAWN-CREDENTIAL: buildBackends threads profile.envVar into the backend so a per-spawn spec.env credential overrides the boot-time env key", async () => {
    const seenAuth: string[] = [];
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      seenAuth.push((init!.headers as Record<string, string>).Authorization);
      return new Response("data: [DONE]\n", { status: 200 });
    }) as unknown as typeof fetch;
    // boot-time env only has account A's key (as if the daemon started with one account
    // configured) -- account B's key arrives later, purely via a per-spawn resolved credential.
    const backends = await buildBackends([XAI], { providers: ["xai"], fetchFn, env: { XAI_API_KEY: "boot-time-key-A" } as unknown as NodeJS.ProcessEnv });
    const backend = backends.get("xai") as GenericAgentBackend;

    const specFor = (accountName: string, env: Record<string, string>): ResolvedAgentSpec => ({
      ...AgentSpecSchema.parse({ prompt: "hi", cwd: "/tmp", isolation: "none" }),
      agentId: `${accountName}-1`, accountName, resolvedProvider: "xai", env, depth: 0,
    } as ResolvedAgentSpec);

    backend.spawn(specFor("acct-a", {}), () => {}, async () => true);
    await new Promise((r) => setTimeout(r, 20));

    backend.spawn(specFor("acct-b", { XAI_API_KEY: "per-spawn-key-B" }), () => {}, async () => true);
    await new Promise((r) => setTimeout(r, 20));

    expect(seenAuth).toEqual(["Bearer boot-time-key-A", "Bearer per-spawn-key-B"]);
  });

  // DYNAMIC-MODEL-METADATA: a provided `modelCatalog` must reach the constructed claude/codex
  // backends (registry.ts forwards deps.modelCatalog into `new CodexAgentBackend`). Proven through
  // observable behavior: a codex spawn on a model absent from the hardcoded map produces a
  // catalog-priced run cost — only possible if the catalog was forwarded into the backend.
  it("forwards a provided modelCatalog into the constructed codex backend (result cost uses catalog pricing)", async () => {
    const model = "gpt-5.2-codex-dynamic-pricing"; // unpriced locally, search-capable via SDK prefix metadata
    const catalog: ModelMetadataLookup = {
      contextWindow: () => undefined,
      pricing: (m) => (m === model ? { inputPerMTok: 7, outputPerMTok: 21, cachedInputPerMTok: 0.7 } : undefined),
    };
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
    ]]);
    const backends = await buildBackends(PROVIDERS, { providers: ["codex"], codexFactory: factory, modelCatalog: () => catalog });
    const backend = backends.get("codex") as unknown as CodexAgentBackend;

    const evs: BackendEvent[] = [];
    backend.spawn(cxSpec({ model }), (e) => evs.push(e), async () => true);
    await settle();

    const expected = computeCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, model, catalog)!;
    expect(expected).toBeCloseTo(7, 10);
    expect(evs.find((e) => e.kind === "result")!.data["costUsd"]).toBeCloseTo(7, 10);
  });

  it("without a modelCatalog, the same codex spawn on the unknown model reports costUsd 0 (nothing forwarded)", async () => {
    const model = "gpt-5.2-codex-dynamic-pricing";
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
    ]]);
    const backends = await buildBackends(PROVIDERS, { providers: ["codex"], codexFactory: factory });
    const backend = backends.get("codex") as unknown as CodexAgentBackend;

    const evs: BackendEvent[] = [];
    backend.spawn(cxSpec({ model }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.find((e) => e.kind === "result")!.data["costUsd"]).toBe(0);
  });

  it("F23-1B: threads profile.timeoutMs through to the underlying OpenAICompatChatClient", async () => {
    const MOONSHOT: ProviderProfile = {
      ...XAI, id: "moonshot", envVar: "MOONSHOT_API_KEY", timeoutMs: 1000,
    };
    const fetchFn = ((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal?.addEventListener("abort", () => reject(init!.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const client = openAiCompatClient(MOONSHOT, { fetchFn, env: { MOONSHOT_API_KEY: "k" } as unknown as NodeJS.ProcessEnv });
    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("timed out") }]);
  });
});

describe("F23-0D: openAiCompatClient adapter (0B ChatClient -> 0C ChatClient bridge)", () => {
  function fakeFetch(chunks: string[]) {
    return (async () => {
      const body = chunks.join("") ;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("yields text_delta events then a terminal message_complete", async () => {
    const fetchFn = fakeFetch([
      `data: {"choices":[{"delta":{"content":"hel"}}]}\n`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n`,
      `data: [DONE]\n`,
    ]);
    const client = openAiCompatClient(XAI, { fetchFn, env: { XAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv });
    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["hel", "lo"]);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("message_complete");
    expect((last as { content: string | null }).content).toBe("hello");
  });

  it("surfaces a transport failure as an error event, not a thrown exception mid-stream", async () => {
    const fetchFn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const client = openAiCompatClient(XAI, { fetchFn, env: { XAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv });
    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);
    expect(events).toEqual([{ type: "error", message: "network down" }]);
  });

  it("carries fully-assembled tool calls onto message_complete", async () => {
    const fetchFn = fakeFetch([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":""}}]}}]}\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n`,
      `data: [DONE]\n`,
    ]);
    const client = openAiCompatClient(XAI, { fetchFn, env: { XAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv });
    const events = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(ev);
    const complete = events.find((e) => e.type === "message_complete") as { toolCalls?: { id: string; name: string; arguments: string }[] };
    expect(complete.toolCalls).toEqual([{ id: "call_1", name: "bash", arguments: '{"command":"ls"}' }]);
  });
});
