import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { CodexAgentBackend, buildCodexOptions, type CodexFactory } from "@chimera/core/backends/codex";
import { prepareCodexInput, type CodexInput } from "@chimera/core/backends/codex-input";
import { openAiCompatClient, buildBackends } from "@chimera/core/providers/registry";
import { findProvider } from "@chimera/core/providers/catalog";
import { compactMessagesDetailed } from "@chimera/core/backends/compaction";
import type { ChatMessage } from "@chimera/core/backends/generic";
import type { BackendEvent, ContentBlock } from "@chimera/core/backend";
import { cxSpec, fakeCodex, settle } from "./codex-backend-helpers.js";

const blocks: ContentBlock[] = [
  { type: "text", text: "before" },
  { type: "image", mediaType: "image/png", data: Buffer.from("image bytes").toString("base64") },
  { type: "text", text: "after" },
];
const ok = () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

describe("Codex/OpenAI readiness", () => {
  it("forwards HTTP auth, timeouts and closed-world grants without widening them", () => {
    const options = buildCodexOptions(cxSpec({
      mcpServers: {
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Test": "yes" }, bearer_token_env_var: "MCP_TOKEN", env_http_headers: { "X-Account": "ACCOUNT" }, enabled_tools: ["read", "write"], disabled_tools: ["write"], startup_timeout_sec: 25, tool_timeout_sec: 150 },
        unlisted: { url: "https://example.com/other" },
      },
      mcpToolAllowlist: { remote: ["read", "delete"] },
    }));
    expect(options.config?.mcp_servers).toEqual({
      remote: { url: "https://example.com/mcp", http_headers: { "X-Test": "yes" }, bearer_token_env_var: "MCP_TOKEN", env_http_headers: { "X-Account": "ACCOUNT" }, enabled_tools: ["read"], disabled_tools: ["write"], startup_timeout_sec: 25, tool_timeout_sec: 150, required: true },
      unlisted: { url: "https://example.com/other", enabled_tools: [], required: false },
    });
  });

  it("rejects explicit legacy SSE instead of silently omitting the server", () => {
    expect(() => buildCodexOptions(cxSpec({ mcpServers: { old: { type: "sse", url: "https://example.com/sse" } } }))).toThrow(/legacy SSE/);
  });

  it("allows a human question to outlive the CLI's default 60-second timeout", () => {
    const config = buildCodexOptions(cxSpec({ orchestration: { allow: true, maxDepth: 2 } })).config;
    expect((config?.mcp_servers as Record<string, { tool_timeout_sec: number }>).chimera.tool_timeout_sec).toBeGreaterThan(300);
  });

  it("admits verified GPT-6 and reports providerOptions model and effort", async () => {
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }]]);
    const events: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ model: "gpt-5.5", effort: "low", providerOptions: { model: "gpt-6-astra", modelReasoningEffort: "high" } }), (e) => events.push(e), async () => true);
    await settle();
    expect(events[0]?.data).toMatchObject({ model: "gpt-6-astra", effort: "high" });
  });

  it("materializes private attachments and retains content precedence and instructions", () => {
    const prepared = prepareCodexInput({ text: "fallback", images: [{ mediaType: "image/png", data: "ignored" }], content: blocks, preamble: "instructions" });
    const input = prepared.input as Exclude<CodexInput, string>;
    const path = (input[2] as { path: string }).path;
    try {
      expect(input.map((b) => b.type)).toEqual(["text", "text", "local_image", "text"]);
      expect(input[0]).toEqual({ type: "text", text: "instructions" });
      expect(readFileSync(path, "utf8")).toBe("image bytes");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { prepared.cleanup(); }
    expect(existsSync(path)).toBe(false);
  });

  it.each(["success", "error", "abort"])("cleans Codex attachments after %s", async (outcome) => {
    let path = "";
    const factory: CodexFactory = () => ({
      startThread: () => ({ id: "th-img", runStreamed: async (input, options) => {
        path = (input as Array<{ path?: string }>).find((b) => b.path)!.path!;
        expect(existsSync(path)).toBe(true);
        if (outcome === "error") throw new Error("request failed");
        return { events: (async function* () {
          if (outcome === "abort") await new Promise<void>((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          yield { type: "turn.completed", usage: {} };
        })() };
      } }),
      resumeThread() { return this.startThread(); },
    });
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ content: blocks }), () => {}, async () => true);
    if (outcome === "abort") { await settle(); await handle.kill(); }
    await settle();
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });

  it("forwards follow-up Codex images in an idle resumed session", async () => {
    const { factory, threads } = fakeCodex([[{ type: "turn.completed", usage: {} }]]);
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ resume: "th-1", resumeOnly: true, persistent: true }), () => {}, async () => true);
    await handle.send("see attachment", [{ mediaType: "image/png", data: "aW1hZ2U=" }]);
    await settle();
    expect(threads[0]?.runs[0]?.input).toEqual([{ type: "text", text: "see attachment" }, { type: "local_image", path: expect.any(String) }]);
    await handle.kill();
  });

  it.each(["openai", "deepseek"])("uses provider-appropriate output and effort fields for %s", async (provider) => {
    const bodies: Record<string, unknown>[] = [];
    const client = openAiCompatClient(findProvider(provider)!, { env: { OPENAI_API_KEY: "test", DEEPSEEK_API_KEY: "test" }, fetchFn: vi.fn(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return ok(); }) });
    for await (const _ of client.stream({ model: "test-model", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 1024, effort: "high" })) { /* consume */ }
    expect(bodies[0]?.[provider === "openai" ? "max_completion_tokens" : "max_tokens"]).toBe(1024);
    expect(bodies[0]?.[provider === "openai" ? "max_tokens" : "max_completion_tokens"]).toBeUndefined();
    expect(bodies[0]?.reasoning_effort).toBe(provider === "openai" ? "high" : undefined);
  });

  it("retries an OpenAI output ceiling using the same modern field", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = openAiCompatClient(findProvider("openai")!, { env: { OPENAI_API_KEY: "test" }, fetchFn: vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return bodies.length === 1 ? new Response("max_completion_tokens exceeds output limit", { status: 400 }) : ok();
    }) });
    for await (const _ of client.stream({ model: "readiness-retry", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 32768 })) { /* consume */ }
    expect(bodies.map((b) => b.max_completion_tokens)).toEqual([32768, 8192]);
    expect(bodies.every((b) => !("max_tokens" in b))).toBe(true);
  });

  it("delivers initial and follow-up OpenAI image content all the way to HTTP", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string }> = [];
    const backends = await buildBackends([findProvider("openai")!], { env: { OPENAI_API_KEY: "test" }, fetchFn: vi.fn(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return ok(); }) });
    const handle = backends.get("openai")!.spawn({ ...cxSpec({ persistent: true, content: blocks, effort: "high", providerOptions: { openaiApi: "chat-completions" } }), resolvedProvider: "openai" }, () => {}, async () => true);
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      await handle.send("fallback", undefined, blocks);
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
      const wire = [{ type: "text", text: "before" }, { type: "image_url", image_url: { url: `data:image/png;base64,${(blocks[1] as { data: string }).data}` } }, { type: "text", text: "after" }];
      expect(bodies[0]?.messages.find((m) => m.role === "user")?.content).toEqual(wire);
      expect(bodies[1]?.messages.at(-1)?.content).toEqual(wire);
      expect(bodies[0]?.reasoning_effort).toBe("high");
    } finally { await handle.kill(); }
  });

  it("preserves recent image blocks through compaction and accounts for their memory", () => {
    const recent: ChatMessage = { role: "user", content: "before after", contentBlocks: blocks };
    const { messages, report } = compactMessagesDetailed([{ role: "user", content: "old" }, { role: "assistant", content: "old response" }, recent], { force: true, keepRecentRounds: 1 });
    expect(messages.at(-1)).toBe(recent);
    expect(report?.beforeChars).toBeGreaterThan("oldold responsebefore after".length);
  });

  it("rejects follow-up images for a text-only provider before any HTTP call", async () => {
    const fetchFn = vi.fn(async () => ok());
    const backends = await buildBackends([findProvider("deepseek")!], { env: { DEEPSEEK_API_KEY: "test" }, fetchFn });
    const handle = backends.get("deepseek")!.spawn({ ...cxSpec({ persistent: true, resumeOnly: true }), resolvedProvider: "deepseek" }, () => {}, async () => true);
    try {
      await expect(handle.send("image", undefined, blocks)).rejects.toThrow(/does not support image/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally { await handle.kill(); }
  });

  it("keeps native Gemini multimodal messages compatible with the shared adapter", async () => {
    const bodies: Array<{ contents: Array<{ parts: unknown[] }> }> = [];
    const backends = await buildBackends([findProvider("gemini-native")!], {
      fetchFn: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}\n\n');
      }),
    });
    const handle = backends.get("gemini-native")!.spawn({ ...cxSpec({ content: blocks }), resolvedProvider: "gemini-native", env: { GEMINI_API_KEY: "test" } }, () => {}, async () => true);
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]?.contents[0]?.parts).toEqual([{ text: "before" }, { inlineData: { mimeType: "image/png", data: (blocks[1] as { data: string }).data } }, { text: "after" }]);
    } finally { await handle.kill(); }
  });
});
