import { describe, it, expect, vi } from "vitest";
import {
  OpenAICompatChatClient,
  ChatAuthError,
  ChatRateLimitError,
  type ChatStreamDelta,
} from "@chimera/core/providers/openai-compat";

// F23-0B: unit tests for the OpenAI-compatible ChatClient transport.
// All network I/O is mocked via a fetchFn seam -- no real network calls.

function sseResponse(lines: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const body = lines.join("\n") + "\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // split into a few chunks to exercise the buffering path, including
      // a mid-line split to prove multi-byte-safe line reassembly
      const encoder = new TextEncoder();
      const bytes = encoder.encode(body);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: init.headers });
}

function client(fetchFn: typeof fetch, overrides: Partial<ConstructorParameters<typeof OpenAICompatChatClient>[0]> = {}) {
  return new OpenAICompatChatClient({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret-123",
    fetchFn,
    ...overrides,
  });
}

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    model: "test-model",
    messages: [{ role: "user" as const, content: "hi" }],
    ...overrides,
  };
}

describe("OpenAICompatChatClient", () => {
  it("streams a plain text response and reassembles it across chunk boundaries", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-123");
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return sseResponse([
        `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"content":"lo, world"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
        `data: [DONE]`,
      ]);
    });

    const deltas: ChatStreamDelta[] = [];
    const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq(), (d) => deltas.push(d));

    expect(result.message).toBe("Hello, world");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(deltas.filter((d) => d.type === "text").map((d) => (d as { text: string }).text)).toEqual(["Hel", "lo, world"]);
  });

  it("assembles two parallel fragmented tool calls by index across many deltas", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
        `data: [DONE]`,
      ])
    );

    const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {});

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "bash", arguments: '{"cmd":"ls"}' },
      { id: "call_b", name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
  });

  it("extracts a trailing usage chunk (stream_options.include_usage) and emits a usage delta", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`,
        `data: [DONE]`,
      ])
    );

    const deltas: ChatStreamDelta[] = [];
    const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq(), (d) => deltas.push(d));

    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(deltas.some((d) => d.type === "usage")).toBe(true);
  });

  it("falls back gracefully when a provider omits usage entirely", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
        `data: [DONE]`,
      ])
    );

    const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {});
    expect(result.usage).toBeUndefined();
    expect(result.message).toBe("hi");
  });

  it("uses the non-stream fallback path when configured, parsing the plain JSON body", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "non-stream reply",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        { status: 200 }
      );
    });

    const deltas: ChatStreamDelta[] = [];
    const result = await client(fetchFn as unknown as typeof fetch, { stream: false }).stream(baseReq(), (d) => deltas.push(d));

    expect(result.message).toBe("non-stream reply");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "grep", arguments: '{"q":"x"}' }]);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    expect(result.finishReason).toBe("tool_calls");
    expect(deltas.some((d) => d.type === "text")).toBe(true);
  });

  it("throws ChatAuthError on 401 and redacts the API key from the error message", async () => {
    const fetchFn = vi.fn(async () => new Response("bad key sk-secret-123 rejected", { status: 401 }));
    const c = client(fetchFn as unknown as typeof fetch);
    await expect(c.stream(baseReq(), () => {})).rejects.toThrow(ChatAuthError);
    try {
      await c.stream(baseReq(), () => {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ChatAuthError);
      expect((e as Error).message).not.toContain("sk-secret-123");
      expect((e as Error).message).toContain("[REDACTED]");
    }
  });

  it("throws ChatAuthError on 403", async () => {
    const fetchFn = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {})).rejects.toThrow(ChatAuthError);
  });

  describe("GENERIC-SPAWN-CREDENTIAL: per-spawn apiKey override", () => {
    it("prefers req.apiKey over the client's construction-time key", async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer per-spawn-key");
        return sseResponse([`data: [DONE]`]);
      });
      await client(fetchFn as unknown as typeof fetch).stream(baseReq({ apiKey: "per-spawn-key" }), () => {});
    });

    it("falls back to the construction-time key when the request carries no override", async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-123");
        return sseResponse([`data: [DONE]`]);
      });
      await client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {});
    });

    it("throws a clear ChatAuthError (not an empty bearer) when neither key is available", async () => {
      const fetchFn = vi.fn(async () => { throw new Error("should never fetch with no credential"); });
      const c = client(fetchFn as unknown as typeof fetch, { apiKey: "" });
      await expect(c.stream(baseReq({ credentialLabel: "zai-coding/glm" }), () => {})).rejects.toThrow(ChatAuthError);
      try {
        await c.stream(baseReq({ credentialLabel: "zai-coding/glm" }), () => {});
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain("zai-coding/glm");
        expect(fetchFn).not.toHaveBeenCalled();
      }
    });

    it("redacts the per-spawn override key from error messages, not just the construction-time key", async () => {
      const fetchFn = vi.fn(async () => new Response("bad key per-spawn-secret rejected", { status: 401 }));
      const c = client(fetchFn as unknown as typeof fetch);
      try {
        await c.stream(baseReq({ apiKey: "per-spawn-secret" }), () => {});
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain("per-spawn-secret");
        expect((e as Error).message).toContain("[REDACTED]");
      }
    });
  });

  it("throws ChatRateLimitError on 429 and surfaces retry-after in seconds", async () => {
    const fetchFn = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }));
    const c = client(fetchFn as unknown as typeof fetch);
    try {
      await c.stream(baseReq(), () => {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ChatRateLimitError);
      expect((e as ChatRateLimitError).retryAfterMs).toBe(30_000);
    }
  });

  it("supports a custom auth header/scheme (e.g. api-key with no Bearer prefix)", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers["api-key"]).toBe("sk-secret-123");
      expect(headers.authorization).toBeUndefined();
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `data: [DONE]`]);
    });
    const result = await client(fetchFn as unknown as typeof fetch, { authHeader: "api-key", authScheme: "" }).stream(
      baseReq(),
      () => {}
    );
    expect(result.message).toBe("ok");
  });

  it("merges extraHeaders into the request", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers["x-custom"]).toBe("v");
      return sseResponse([`data: [DONE]`]);
    });
    await client(fetchFn as unknown as typeof fetch, { extraHeaders: { "x-custom": "v" } }).stream(baseReq(), () => {});
  });

  // F23-1B: timeoutMs (moonshot's documented 2h request timeout, catalog.ts) -- the
  // transport has no implicit timeout of its own, so a configured timeoutMs must abort
  // a request that never resolves.
  describe("timeoutMs", () => {
    it("aborts a hung request once timeoutMs elapses", async () => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn((_url: string | URL, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        });
        const promise = client(fetchFn as unknown as typeof fetch, { timeoutMs: 1000 }).stream(baseReq(), () => {});
        const assertion = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not abort a request that resolves before timeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn(async () => sseResponse([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `data: [DONE]`]));
        const result = await client(fetchFn as unknown as typeof fetch, { timeoutMs: 60_000 }).stream(baseReq(), () => {});
        expect(result.message).toBe("ok");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still honors the caller's own signal when timeoutMs is also set", async () => {
      const controller = new AbortController();
      const fetchFn = vi.fn((_url: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init!.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const promise = client(fetchFn as unknown as typeof fetch, { timeoutMs: 60_000 }).stream(baseReq(), () => {}, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow();
    });

    it("leaves the request unaffected when timeoutMs is unset (no implicit timeout)", async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(init!.signal).toBeUndefined();
        return sseResponse([`data: [DONE]`]);
      });
      await client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {});
    });
  });

  // MODEL-ACTUAL-SURFACE: a served model can differ from the requested one (verified live: z.ai
  // served "glm-5.2" for a "glm-5" request) -- the wire's own `model` field is forwarded on
  // ChatResult so the generic backend can surface it, same as the claude backend already does.
  describe("served-model forwarding", () => {
    it("forwards a streamed chunk's top-level model field on the final ChatResult", async () => {
      const fetchFn = vi.fn(async () =>
        sseResponse([
          `data: {"model":"glm-5.2","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`,
          `data: {"model":"glm-5.2","choices":[{"delta":{},"finish_reason":"stop"}]}`,
          `data: [DONE]`,
        ]),
      );
      const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq({ model: "glm-5" }), () => {});
      expect(result.model).toBe("glm-5.2");
    });

    it("forwards a non-stream response's top-level model field", async () => {
      const fetchFn = vi.fn(async () =>
        new Response(JSON.stringify({ model: "glm-5.2", choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), { status: 200 }),
      );
      const result = await client(fetchFn as unknown as typeof fetch, { stream: false }).stream(baseReq({ model: "glm-5" }), () => {});
      expect(result.model).toBe("glm-5.2");
    });

    it("leaves model undefined when the wire response never echoes one", async () => {
      const fetchFn = vi.fn(async () => sseResponse([`data: [DONE]`]));
      const result = await client(fetchFn as unknown as typeof fetch).stream(baseReq(), () => {});
      expect(result.model).toBeUndefined();
    });
  });
});
