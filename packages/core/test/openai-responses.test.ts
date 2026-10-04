import { describe, it, expect, vi } from "vitest";
import { OpenAIResponsesClient, responsesInput } from "@chimera/core/providers/responses";
import { buildBackends } from "@chimera/core/providers/registry";
import { findProvider } from "@chimera/core/providers/catalog";
import type { ChatStreamRequest } from "@chimera/core/backends/generic";
import { cxSpec } from "./codex-backend-helpers.js";

const request: ChatStreamRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };
const completed = (output: unknown[] = [], extra = {}) => ({ type: "response.completed", response: { status: "completed", model: "served", output, ...extra } });
const message = { type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "done" }] };
function sse(events: unknown[], fragmented = false) {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    if (fragmented) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }));
}
async function collect(client: OpenAIResponsesClient, req = request) {
  const events = []; for await (const event of client.stream(req)) events.push(event); return events;
}

describe("native OpenAI Responses", () => {
  it("executes a real generic tool round trip and returns validated structured output", async () => {
    const reasoning = { type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [] };
    const call = { type: "function_call", id: "fc", call_id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "package.json" }) };
    const bodies: any[] = []; const events: any[] = [];
    const backends = await buildBackends([findProvider("openai")!], { env: { OPENAI_API_KEY: "key" }, fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return sse([completed(bodies.length === 1 ? [reasoning, call] : [{ ...message, content: [{ type: "output_text", text: '{"ok":true}' }] }])]);
    } });
    const handle = backends.get("openai")!.spawn({ ...cxSpec({ cwd: process.cwd(), resultSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }), resolvedProvider: "openai" }, (event) => events.push(event), async () => true);
    try {
      await vi.waitFor(() => expect(events.some((event) => event.kind === "result")).toBe(true));
      expect(bodies).toHaveLength(2);
      expect(bodies[1].input).toContainEqual(reasoning);
      expect(bodies[1].input).toContainEqual(call);
      expect(bodies[1].input.find((item: any) => item.type === "function_call_output")).toMatchObject({ call_id: "call_1", output: expect.stringContaining('"name"') });
      expect(events.find((event) => event.kind === "result").data.structuredOutput).toEqual({ ok: true });
    } finally { await handle.kill(); }
  });

  it("aborts a pending fetch using the caller's signal", async () => {
    const controller = new AbortController();
    const client = new OpenAIResponsesClient({ baseUrl: "https://test", model: "m", apiKey: "key", fetchFn: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })) });
    const pending = collect(client, { ...request, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("streams fragmented frames and sends images, effort, schema and account credentials", async () => {
    const fetchFn = vi.fn(async () => sse([{ type: "response.output_text.delta", delta: "done" }, completed([message], { usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } })], true));
    const client = new OpenAIResponsesClient({ baseUrl: "https://test/v1/", model: "default", apiKey: "fallback", fetchFn });
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const events = await collect(client, { ...request, apiKey: "account-key", effort: "high", maxTokens: 2048, resultSchema: schema, messages: [{ role: "user", content: "hi", contentBlocks: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "aQ==" }] }] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test/v1/responses");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer account-key");
    expect(JSON.parse(init.body as string)).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 2048, reasoning: { effort: "high" }, text: { format: { schema } }, input: [{ content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,aQ==" }] }] });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 } });
    expect(events.at(-1)).toMatchObject({ type: "message_complete", content: "done", model: "served", finishReason: "stop" });
  });

  it("replays native reasoning and call IDs with function results without duplicating messages", () => {
    const items = [{ type: "reasoning", id: "r", encrypted_content: "opaque" }, { type: "function_call", id: "fc", call_id: "call", name: "read", arguments: "{}" }];
    expect(responsesInput([{ role: "assistant", content: null, providerItems: items, toolCalls: [{ id: "call", name: "read", arguments: "{}" }] }, { role: "tool", toolCallId: "call", content: "result" }])).toEqual([...items, { type: "function_call_output", call_id: "call", output: "result" }]);
  });

  it.each(["max_output_tokens", "content_filter"])("does not execute partial tools on incomplete %s", async (reason) => {
    const client = new OpenAIResponsesClient({ baseUrl: "https://test", model: "test", apiKey: "key", fetchFn: async () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, output: [{ type: "function_call", call_id: "partial", name: "Bash", arguments: "{" }] } }]) });
    expect((await collect(client)).at(-1)).toMatchObject({ toolCalls: [], finishReason: reason === "max_output_tokens" ? "length" : "error" });
  });

  it("surfaces refusals and truncated streams", async () => {
    const client = new OpenAIResponsesClient({ baseUrl: "https://test", model: "test", apiKey: "key", fetchFn: async () => sse([completed([{ type: "message", content: [{ type: "refusal", refusal: "no" }] }])]) });
    expect((await collect(client)).at(-1)).toMatchObject({ finishReason: "content_filter" });
    const broken = new OpenAIResponsesClient({ baseUrl: "https://test", model: "test", apiKey: "key", fetchFn: async () => sse([{ type: "response.output_text.delta", delta: "partial" }]) });
    await expect(collect(broken)).rejects.toThrow(/terminal event/);
  });

  it("redacts the active key from HTTP and server failures", async () => {
    for (const response of [new Response("secret-key", { status: 401 }), sse([{ type: "response.failed", response: { error: { message: "bad secret-key" } } }])]) {
      const client = new OpenAIResponsesClient({ baseUrl: "https://test", model: "test", apiKey: "secret-key", fetchFn: async () => response });
      await expect(collect(client)).rejects.not.toThrow(/secret-key/);
    }
  });

  it("defaults registry OpenAI to Responses and keeps conversation state per agent", async () => {
    const bodies: any[] = [];
    const backends = await buildBackends([findProvider("openai")!], { env: { OPENAI_API_KEY: "key" }, fetchFn: async (url, init) => {
      expect(String(url)).toMatch(/\/responses$/); bodies.push(JSON.parse(init!.body as string)); return sse([completed([message])]);
    } });
    const handles = ["first-private", "second-private"].map((prompt) => backends.get("openai")!.spawn({ ...cxSpec({ prompt, persistent: true }), resolvedProvider: "openai" }, () => {}, async () => true));
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
      expect(JSON.stringify(bodies[0])).not.toContain("second-private");
      expect(JSON.stringify(bodies[1])).not.toContain("first-private");
      await handles[0]!.send("followup");
      await vi.waitFor(() => expect(bodies).toHaveLength(3));
      expect(bodies[2].input).toContainEqual(message);
      expect(JSON.stringify(bodies[2])).not.toContain("second-private");
    } finally { await Promise.all(handles.map((handle) => handle.kill())); }
  });
});
