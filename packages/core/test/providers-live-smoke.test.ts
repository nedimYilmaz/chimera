import { describe, it, expect } from "vitest";
import { findProvider } from "@chimera/core/providers/catalog";
import { openAiCompatClient } from "@chimera/core/providers/registry";
import type { ChatStreamEvent, ChatToolDef } from "@chimera/core/backends/generic";

// F23-1B live-smoke: real network calls against real provider APIs (docs/superpowers/
// design-plans/F23-multi-provider-llm.md D7). Each suite is SKIPPED entirely unless its
// provider's env var is present -- CI has no provider secrets, this is an opt-in local/
// verification run. "Working" = unit-green (openai-compat.ts, providers-catalog.test.ts,
// providers-registry.test.ts) + live-smoke green where creds exist.
//
//   MOONSHOT_API_KEY=... pnpm vitest run packages/core -t "live-smoke: moonshot"
//   KIMI_CODE_API_KEY=... pnpm vitest run packages/core -t "live-smoke: kimi-code"
//   MISTRAL_API_KEY=...  pnpm vitest run packages/core -t "live-smoke: mistral"
//   CEREBRAS_API_KEY=... pnpm vitest run packages/core -t "live-smoke: cerebras"
//   FIREWORKS_API_KEY=... pnpm vitest run packages/core -t "live-smoke: fireworks"
//
// Costs real tokens (a handful per suite) against the operator's own account.

const WEATHER_TOOL: ChatToolDef = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

async function drain(id: string): Promise<{ chat(prompt: string): Promise<ChatStreamEvent[]>; tool(prompt: string): Promise<ChatStreamEvent[]> }> {
  const profile = findProvider(id);
  if (!profile) throw new Error(`no catalog entry for "${id}"`);
  const client = openAiCompatClient(profile, {});
  const run = async (prompt: string, tools: ChatToolDef[]) => {
    const events: ChatStreamEvent[] = [];
    for await (const ev of client.stream({ messages: [{ role: "user", content: prompt }], tools })) events.push(ev);
    return events;
  };
  return {
    chat: (prompt) => run(prompt, []),
    tool: (prompt) => run(prompt, [WEATHER_TOOL]),
  };
}

function messageComplete(events: ChatStreamEvent[]) {
  const complete = events.find((e) => e.type === "message_complete");
  expect(complete, `expected a message_complete event, got: ${JSON.stringify(events)}`).toBeDefined();
  return complete as { type: "message_complete"; content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };
}

describe.skipIf(!process.env.MOONSHOT_API_KEY)("live-smoke: moonshot", () => {
  it("completes a real chat turn", async () => {
    const events = await (await drain("moonshot")).chat("Reply with exactly the word: pong");
    expect(messageComplete(events).content?.toLowerCase()).toContain("pong");
  }, 60_000);

  it("makes a real tool call", async () => {
    const events = await (await drain("moonshot")).tool("What's the weather in Paris? Use the get_weather tool.");
    expect(messageComplete(events).toolCalls?.[0]?.name).toBe("get_weather");
  }, 60_000);
});

describe.skipIf(!process.env.KIMI_CODE_API_KEY)("live-smoke: kimi-code", () => {
  it("completes a real chat turn against the Kimi Code subscription endpoint", async () => {
    const events = await (await drain("kimi-code")).chat("Reply with exactly the word: pong");
    expect(messageComplete(events).content?.toLowerCase()).toContain("pong");
  }, 60_000);

  it("makes a real tool call", async () => {
    const events = await (await drain("kimi-code")).tool("What's the weather in Paris? Use the get_weather tool.");
    expect(messageComplete(events).toolCalls?.[0]?.name).toBe("get_weather");
  }, 60_000);
});

describe.skipIf(!process.env.MISTRAL_API_KEY)("live-smoke: mistral", () => {
  it("completes a real chat turn", async () => {
    const events = await (await drain("mistral")).chat("Reply with exactly the word: pong");
    expect(messageComplete(events).content?.toLowerCase()).toContain("pong");
  }, 60_000);

  it("makes a real tool call", async () => {
    const events = await (await drain("mistral")).tool("What's the weather in Paris? Use the get_weather tool.");
    expect(messageComplete(events).toolCalls?.[0]?.name).toBe("get_weather");
  }, 60_000);
});

describe.skipIf(!process.env.CEREBRAS_API_KEY)("live-smoke: cerebras", () => {
  it("completes a real chat turn", async () => {
    const events = await (await drain("cerebras")).chat("Reply with exactly the word: pong");
    expect(messageComplete(events).content?.toLowerCase()).toContain("pong");
  }, 60_000);

  it("makes a real tool call", async () => {
    const events = await (await drain("cerebras")).tool("What's the weather in Paris? Use the get_weather tool.");
    expect(messageComplete(events).toolCalls?.[0]?.name).toBe("get_weather");
  }, 60_000);
});

describe.skipIf(!process.env.FIREWORKS_API_KEY)("live-smoke: fireworks", () => {
  it("completes a real chat turn", async () => {
    const events = await (await drain("fireworks")).chat("Reply with exactly the word: pong");
    expect(messageComplete(events).content?.toLowerCase()).toContain("pong");
  }, 60_000);

  it("makes a real tool call", async () => {
    const events = await (await drain("fireworks")).tool("What's the weather in Paris? Use the get_weather tool.");
    expect(messageComplete(events).toolCalls?.[0]?.name).toBe("get_weather");
  }, 60_000);
});
