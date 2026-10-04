import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OpenAICompatChatClient,
  ChatServerError,
  _resetLearnedOutputCeilings,
} from "@chimera/core/providers/openai-compat";

// Two follow-ups to the silent-truncation incident, both about the OUTPUT ceiling:
//   TRUNCATION-BACKSTOP  — a vendor that OMITS finish_reason must not read as a clean "stop"
//                          when the response spent its whole output allowance.
//   OUTPUT-CEILING-LEARNED — a provider whose real ceiling is below the 32k default answers 400;
//                          retry once at 8192 and remember it for the process.

function sseResponse(lines: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
      controller.close();
    },
  }), { status: 200 });
}

function client(fetchFn: typeof fetch, overrides: Partial<ConstructorParameters<typeof OpenAICompatChatClient>[0]> = {}) {
  return new OpenAICompatChatClient({ baseUrl: "https://api.example.com/v1", apiKey: "sk-secret-123", fetchFn, ...overrides });
}

const req = (overrides: Record<string, unknown> = {}) => ({
  model: "glm-5.2",
  messages: [{ role: "user" as const, content: "hi" }],
  ...overrides,
});

beforeEach(() => { _resetLearnedOutputCeilings(); });

describe("TRUNCATION-BACKSTOP: an absent finish_reason at the output cap reads as \"length\"", () => {
  it("streaming: no finish_reason anywhere + completion_tokens === max_tokens ⇒ length", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"cut off mid-"}}]}`,
      `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":8192,"total_tokens":8202}}`,
      `data: [DONE]`,
    ]));
    const result = await client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 8192 }), () => {});
    expect(result.finishReason).toBe("length");
  });

  it("streaming: an EXPLICIT \"stop\" at the cap still wins — the backstop only replaces a guess", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}],"usage":{"completion_tokens":8192}}`,
      `data: [DONE]`,
    ]));
    const result = await client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 8192 }), () => {});
    expect(result.finishReason).toBe("stop");
  });

  it("streaming: comfortably under the cap with no finish_reason is still \"stop\"", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"short"}}],"usage":{"completion_tokens":12}}`,
      `data: [DONE]`,
    ]));
    const result = await client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 8192 }), () => {});
    expect(result.finishReason).toBe("stop");
  });

  it("non-stream fallback: same backstop (this path never had a finish_reason for some vendors either)", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "cut off" } }],
      usage: { prompt_tokens: 5, completion_tokens: 4096, total_tokens: 4101 },
    }), { status: 200 }));
    const result = await client(fetchFn as unknown as typeof fetch, { stream: false })
      .stream(req({ maxTokens: 4096 }), () => {});
    expect(result.finishReason).toBe("length");
  });

  it("no maxTokens requested ⇒ no cap to compare against, behaviour unchanged", async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      `data: {"choices":[{"delta":{"content":"x"}}],"usage":{"completion_tokens":999999}}`,
      `data: [DONE]`,
    ]));
    const result = await client(fetchFn as unknown as typeof fetch).stream(req(), () => {});
    expect(result.finishReason).toBe("stop");
  });
});

describe("OUTPUT-CEILING-LEARNED: a 400 on max_tokens retries once at 8192 and is remembered", () => {
  function ceilingFetch(bodies: number[]) {
    return vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string).max_tokens as number;
      bodies.push(sent);
      if (sent > 8192) {
        return new Response(JSON.stringify({ error: { message: "max_tokens is too large: model supports at most 8192" } }), { status: 400 });
      }
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `data: [DONE]`]);
    });
  }

  it("retries ONCE at 8192 and returns the retry's result instead of throwing", async () => {
    const sent: number[] = [];
    const fetchFn = ceilingFetch(sent);
    const result = await client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 32_768 }), () => {});
    expect(sent).toEqual([32_768, 8192]);
    expect(result.message).toBe("ok");
  });

  it("remembers the ceiling for that provider+model, so the NEXT request goes out at 8192 first", async () => {
    const sent: number[] = [];
    const fetchFn = ceilingFetch(sent);
    const c = client(fetchFn as unknown as typeof fetch);
    await c.stream(req({ maxTokens: 32_768 }), () => {});
    await c.stream(req({ maxTokens: 32_768 }), () => {});
    expect(sent).toEqual([32_768, 8192, 8192]);              // second request pays no 400 round-trip
  });

  it("the learned ceiling is per provider+model — another model on the same host is unaffected", async () => {
    const sent: Array<{ model: string; max: number }> = [];
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { model: string; max_tokens: number };
      sent.push({ model: body.model, max: body.max_tokens });
      if (body.model === "glm-5.2" && body.max_tokens > 8192) {
        return new Response("max_tokens too large", { status: 400 });
      }
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `data: [DONE]`]);
    });
    const c = client(fetchFn as unknown as typeof fetch);
    await c.stream(req({ maxTokens: 32_768 }), () => {});
    await c.stream(req({ model: "kimi-k2", maxTokens: 32_768 }), () => {});
    expect(sent).toEqual([
      { model: "glm-5.2", max: 32_768 },
      { model: "glm-5.2", max: 8192 },
      { model: "kimi-k2", max: 32_768 },
    ]);
  });

  it("a 400 that has nothing to do with the output limit is raised unchanged — no retry", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid tool schema" } }), { status: 400 }));
    await expect(client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 32_768 }), () => {}))
      .rejects.toThrow(ChatServerError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // the pre-read body must still reach the error message (a Response body reads only once)
    await expect(client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 32_768 }), () => {}))
      .rejects.toThrow(/invalid tool schema/);
  });

  it("a request already at or below the floor is not retried (lowering the cap cannot help)", async () => {
    const fetchFn = vi.fn(async () => new Response("max_tokens exceeds the model's output limit", { status: 400 }));
    await expect(client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 8192 }), () => {}))
      .rejects.toThrow(ChatServerError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a retry that ALSO fails throws and learns nothing", async () => {
    const fetchFn = vi.fn(async () => new Response("max_tokens is too large", { status: 400 }));
    const c = client(fetchFn as unknown as typeof fetch);
    await expect(c.stream(req({ maxTokens: 32_768 }), () => {})).rejects.toThrow(ChatServerError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await expect(c.stream(req({ maxTokens: 32_768 }), () => {})).rejects.toThrow(ChatServerError);
    expect(fetchFn).toHaveBeenCalledTimes(4);                // still tries the full cap first
  });

  it("the retry's own cap is what the truncation backstop compares against", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string).max_tokens as number;
      if (sent > 8192) return new Response("max_tokens is too large", { status: 400 });
      return sseResponse([
        `data: {"choices":[{"delta":{"content":"cut"}}],"usage":{"completion_tokens":8192}}`,
        `data: [DONE]`,
      ]);
    });
    const result = await client(fetchFn as unknown as typeof fetch).stream(req({ maxTokens: 32_768 }), () => {});
    expect(result.finishReason).toBe("length");
  });
});
