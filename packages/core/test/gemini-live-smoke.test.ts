import { describe, it, expect } from "vitest";
import { OpenAICompatChatClient } from "@chimera/core/providers/openai-compat";
import { GeminiNativeChatClient } from "@chimera/core/providers/gemini-native";
import { findProvider } from "@chimera/core/providers/catalog";

// F23-1D: live verification against the real Gemini API, for both the openai-compat layer
// (v1 default) and the native v1beta driver. SKIPS entirely unless GEMINI_API_KEY is set --
// per F23 design doc §D7, "working" = unit-green always + live-smoke green where creds exist.
const apiKey = process.env.GEMINI_API_KEY;
const describeLive = apiKey ? describe : describe.skip;

describeLive("Gemini live smoke (GEMINI_API_KEY set)", () => {
  it("compat layer: answers a trivial chat prompt", async () => {
    const profile = findProvider("gemini")!;
    const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey! });
    const result = await client.stream(
      { model: profile.defaultModel, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] },
      () => {},
    );
    expect(result.message.toLowerCase()).toContain("pong");
  }, 30_000);

  it("compat layer: makes a tool call when a tool is offered", async () => {
    const profile = findProvider("gemini")!;
    const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey! });
    const result = await client.stream(
      {
        model: profile.defaultModel,
        messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
        tools: [{ name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      },
      () => {},
    );
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
  }, 30_000);

  it("native driver: answers a trivial chat prompt", async () => {
    const profile = findProvider("gemini-native")!;
    const client = new GeminiNativeChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey! });
    const result = await client.stream(
      { model: profile.defaultModel, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] },
      () => {},
    );
    expect(result.message.toLowerCase()).toContain("pong");
  }, 30_000);

  it("native driver: makes a tool call when a tool is offered", async () => {
    const profile = findProvider("gemini-native")!;
    const client = new GeminiNativeChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey! });
    const result = await client.stream(
      {
        model: profile.defaultModel,
        messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
        tools: [{ name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      },
      () => {},
    );
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
  }, 30_000);
});
