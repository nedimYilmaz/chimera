// F23-1A: shared live-API smoke helpers (D7 verification policy). Each per-provider
// live-smoke-*.test.ts file drives these against the REAL provider endpoint — no mocked
// transport, no GenericAgentBackend loop, just the raw OpenAICompatChatClient (F23-0B) so a
// failure points straight at "the provider rejected this request" rather than through the
// agent-loop/permission-gate machinery. Costs real tokens; only runs when the caller's
// describe.skipIf(!process.env.<X>_API_KEY) lets it through.
import type { ProviderProfile } from "@chimera/protocol";
import { OpenAICompatChatClient, type ChatResult } from "@chimera/core/providers/openai-compat";

export async function runLiveChatSmoke(profile: ProviderProfile, apiKey: string): Promise<ChatResult> {
  const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey, chatPath: profile.chatPath, authHeader: profile.authHeader, extraHeaders: profile.extraHeaders });
  return client.stream(
    { model: profile.defaultModel, messages: [{ role: "user", content: "Reply with exactly one word: pong" }] },
    () => {},
  );
}

const ECHO_TOOL = {
  name: "echo",
  description: "Echoes the given text back to the caller.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "the text to echo back" } },
    required: ["text"],
  },
};

export async function runLiveToolCallSmoke(profile: ProviderProfile, apiKey: string): Promise<ChatResult> {
  const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey, chatPath: profile.chatPath, authHeader: profile.authHeader, extraHeaders: profile.extraHeaders });
  return client.stream(
    {
      model: profile.defaultModel,
      messages: [{ role: "user", content: "Call the echo tool with text set to exactly \"chimera-f23-1a\". Only call the tool -- do not reply with any other text." }],
      tools: [ECHO_TOOL],
    },
    () => {},
  );
}
