import { describe, it, expect, vi } from "vitest";
import {
  GeminiNativeChatClient,
} from "@chimera/core/providers/gemini-native";
import { ChatAuthError, ChatRateLimitError } from "@chimera/core/providers/openai-compat";

// F23-1D: unit tests for the native Gemini v1beta ChatClient. All network I/O is mocked via
// a fetchFn seam -- no real network calls (see gemini-live-smoke.test.ts for the real thing,
// gated on GEMINI_API_KEY).

function sseResponse(chunks: unknown[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(body);
      // split mid-stream to exercise multi-byte-safe line reassembly, like openai-compat.test.ts
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: init.headers });
}

function client(fetchFn: typeof fetch, overrides: Partial<ConstructorParameters<typeof GeminiNativeChatClient>[0]> = {}) {
  return new GeminiNativeChatClient({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "goog-secret-123",
    fetchFn,
    ...overrides,
  });
}

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    model: "gemini-3.5-flash",
    messages: [{ role: "user" as const, content: "hi" }],
    ...overrides,
  };
}

describe("GeminiNativeChatClient", () => {
  it("streams via ?alt=sse, using x-goog-api-key auth, and reassembles text across chunks", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
      expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("goog-secret-123");
      expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
      return sseResponse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "lo, world" }] }, finishReason: "STOP" }] },
      ]);
    });
    const events: unknown[] = [];
    const result = await client(fetchFn).stream(baseReq(), (d) => events.push(d));
    expect(result.message).toBe("Hello, world");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(events.filter((e: any) => e.type === "text").map((e: any) => e.text)).toEqual(["Hel", "lo, world"]);
  });

  // MODEL-ACTUAL-SURFACE: Gemini echoes the serving model back as `modelVersion` on each chunk
  // -- forwarded on ChatResult when present, same seam openai-compat.ts uses for its `model` field.
  it("forwards a chunk's modelVersion on the final ChatResult", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        { modelVersion: "gemini-3.5-flash-002", candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
      ]),
    );
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.model).toBe("gemini-3.5-flash-002");
  });

  it("leaves model undefined when the response never carries a modelVersion", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] }]),
    );
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.model).toBeUndefined();
  });

  it("puts the system message in systemInstruction, not in contents", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
      expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
      return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    await client(fetchFn).stream(baseReq({
      messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }],
    }), () => {});
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps assistant -> model and tool -> function, threading functionCall/functionResponse by name", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "list files" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
        { role: "function", parts: [{ functionResponse: { name: "bash", response: { output: "a.txt\nb.txt" } } }] },
      ]);
      return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
    });
    await client(fetchFn).stream(baseReq({
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: null, toolCalls: [{ id: "call_0", name: "bash", arguments: '{"command":"ls"}' }] },
        { role: "tool", toolCallId: "call_0", content: "a.txt\nb.txt" },
      ],
    }), () => {});
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sends tools as one functionDeclarations wrapper", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.tools).toEqual([{ functionDeclarations: [{ name: "bash", description: "run a shell command", parameters: { type: "object" } }] }]);
      return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    await client(fetchFn).stream(baseReq({
      tools: [{ name: "bash", description: "run a shell command", parameters: { type: "object" } }],
    }), () => {});
  });

  it("assembles a functionCall part into a fully-formed tool call with JSON-string arguments and finishReason tool_calls", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] }, finishReason: "STOP" }] },
    ]));
    const events: unknown[] = [];
    const result = await client(fetchFn).stream(baseReq(), (d) => events.push(d));
    expect(result.toolCalls).toEqual([{ id: "call_0", name: "bash", arguments: '{"command":"ls"}' }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(events.some((e: any) => e.type === "tool_call_start" && e.name === "bash")).toBe(true);
  });

  // THOUGHT-SIGNATURE: a thinking Gemini model attaches an opaque thoughtSignature next to a
  // functionCall part; replaying that call in a later turn's history without it gets HTTP 400
  // INVALID_ARGUMENT. Must round-trip byte-for-byte, per call, without being parsed/reformatted.
  it("THOUGHT-SIGNATURE: captures a functionCall's thoughtSignature into providerMeta", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      { candidates: [{ content: { role: "model", parts: [
        { functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "sig-abc123" },
      ] }, finishReason: "STOP" }] },
    ]));
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "bash", arguments: '{"command":"ls"}', providerMeta: { thoughtSignature: "sig-abc123" } },
    ]);
  });

  it("THOUGHT-SIGNATURE: omits providerMeta when the response carries no signature", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] }, finishReason: "STOP" }] },
    ]));
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.toolCalls).toEqual([{ id: "call_0", name: "bash", arguments: '{"command":"ls"}' }]);
    expect(result.toolCalls[0]).not.toHaveProperty("providerMeta");
  });

  it("THOUGHT-SIGNATURE: preserves distinct signatures per call, in position, across multiple tool calls in one turn", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      { candidates: [{ content: { role: "model", parts: [
        { functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "sig-1" },
        { functionCall: { name: "read", args: { path: "a.txt" } } },
        { functionCall: { name: "write", args: { path: "b.txt" } }, thoughtSignature: "sig-3" },
      ] }, finishReason: "STOP" }] },
    ]));
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "bash", arguments: '{"command":"ls"}', providerMeta: { thoughtSignature: "sig-1" } },
      { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      { id: "call_2", name: "write", arguments: '{"path":"b.txt"}', providerMeta: { thoughtSignature: "sig-3" } },
    ]);
  });

  it("THOUGHT-SIGNATURE: replays a signed tool call's signature on the exact matching functionCall part in the next request", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "list files" }] },
        { role: "model", parts: [
          { functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "sig-1" },
          { functionCall: { name: "read", args: { path: "a.txt" } } },
        ] },
        { role: "function", parts: [{ functionResponse: { name: "bash", response: { output: "a.txt" } } }] },
        { role: "function", parts: [{ functionResponse: { name: "read", response: { output: "contents" } } }] },
      ]);
      return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
    });
    await client(fetchFn).stream(baseReq({
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: null, toolCalls: [
          { id: "call_0", name: "bash", arguments: '{"command":"ls"}', providerMeta: { thoughtSignature: "sig-1" } },
          { id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
        ] },
        { role: "tool", toolCallId: "call_0", content: "a.txt" },
        { role: "tool", toolCallId: "call_1", content: "contents" },
      ],
    }), () => {});
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("TRUNCATION-SURFACE: MAX_TOKENS wins over the tool-call shortcut so a cut-off candidate reports \"length\"", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] }, finishReason: "MAX_TOKENS" }] },
    ]));
    const result = await client(fetchFn).stream(baseReq(), () => {});
    // Regression: this used to normalize to "tool_calls" (hasToolCalls short-circuited the
    // switch), so backends/generic.ts's finish_reason==="length" check never fired and a turn
    // Gemini cut off mid-plan ran its partial tool set and landed as a clean finish.
    expect(result.finishReason).toBe("length");
  });

  it("extracts usage from usageMetadata", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ]));
    const result = await client(fetchFn).stream(baseReq(), () => {});
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("falls back to non-streaming :generateContent (no ?alt=sse) when stream:false", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "hi there" }] }, finishReason: "STOP" }],
      }), { status: 200 });
    });
    const result = await client(fetchFn, { stream: false }).stream(baseReq(), () => {});
    expect(result.message).toBe("hi there");
  });

  it("maps 401/403 to ChatAuthError with the api key redacted", async () => {
    const fetchFn = vi.fn(async () => new Response("permission denied goog-secret-123", { status: 401, statusText: "Unauthorized" }));
    await expect(client(fetchFn).stream(baseReq(), () => {})).rejects.toThrow(ChatAuthError);
    try {
      await client(fetchFn).stream(baseReq(), () => {});
    } catch (e) {
      expect((e as Error).message).not.toContain("goog-secret-123");
    }
  });

  it("maps 429 to ChatRateLimitError, parsing retry-after", async () => {
    const fetchFn = vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }));
    const err = await client(fetchFn).stream(baseReq(), () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ChatRateLimitError);
    expect((err as ChatRateLimitError).retryAfterMs).toBe(2000);
  });

  it("does not send an Authorization/Bearer header at all (x-goog-api-key only)", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    await client(fetchFn).stream(baseReq(), () => {});
  });

  describe("GENERIC-SPAWN-CREDENTIAL: per-spawn apiKey override", () => {
    it("prefers req.apiKey over the client's construction-time key, still via x-goog-api-key", async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("per-spawn-key");
        return sseResponse([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
      });
      await client(fetchFn).stream(baseReq({ apiKey: "per-spawn-key" }), () => {});
    });

    it("throws a clear ChatAuthError when neither a per-spawn nor a construction-time key is available", async () => {
      const fetchFn = vi.fn(async () => { throw new Error("should never fetch with no credential"); });
      const c = client(fetchFn, { apiKey: "" });
      try {
        await c.stream(baseReq({ credentialLabel: "gemini-native/glm" }), () => {});
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ChatAuthError);
        expect((e as Error).message).toContain("gemini-native/glm");
        expect(fetchFn).not.toHaveBeenCalled();
      }
    });
  });
});
