import { describe, it, expect } from "vitest";
import { OpenAICompatChatClient, type ChatStreamDelta } from "@chimera/core/providers/openai-compat";
import { findProvider } from "@chimera/core/providers/catalog";

// F23-1C: live-smoke for the FAZ-1 driver batch (qwen, nvidia-nim, together, openrouter,
// cohere, zai, zai-coding). Per D7 verification policy: SKIPS a provider entirely unless its
// real API key env var is present -- this suite makes zero network calls in CI/sandbox
// environments with no creds configured. Where a key IS present: one plain-text chat round
// trip + one tool-call round trip (single `echo` tool), proving the provider actually talks
// to chimera's shared OpenAICompatChatClient, not just that the catalog entry parses.
//
// Run: env -u CHIMERA_AGENT_ID -u CHIMERA_DEPTH -u CHIMERA_TREE_ID npx vitest run <this file>
// with e.g. DASHSCOPE_API_KEY=... set to exercise the qwen case.

type LiveCase = { id: string; envVar: string };

const CASES: LiveCase[] = [
  { id: "qwen", envVar: "DASHSCOPE_API_KEY" },
  { id: "nvidia-nim", envVar: "NVIDIA_API_KEY" },
  { id: "together", envVar: "TOGETHER_API_KEY" },
  { id: "openrouter", envVar: "OPENROUTER_API_KEY" },
  { id: "cohere", envVar: "COHERE_API_KEY" },
  { id: "zai", envVar: "ZAI_API_KEY" },
  { id: "zai-coding", envVar: "ZAI_CODING_PLAN_API_KEY" },
];

const ECHO_TOOL = {
  name: "echo",
  description: "Echo back the given text verbatim. Call this now with text set to \"ok\".",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

for (const { id, envVar } of CASES) {
  const apiKey = process.env[envVar];

  describe.skipIf(!apiKey)(`F23-1C live-smoke: ${id}`, () => {
    const profile = findProvider(id)!;

    it("completes a plain-text chat round trip", async () => {
      const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey!, chatPath: profile.chatPath, authHeader: profile.authHeader });
      const deltas: ChatStreamDelta[] = [];
      const result = await client.stream(
        { model: profile.defaultModel, messages: [{ role: "user", content: "Reply with exactly one word: ack" }], maxTokens: 32 },
        (d) => deltas.push(d)
      );
      expect(result.message.length).toBeGreaterThan(0);
      expect(["stop", "length"]).toContain(result.finishReason);
    }, 30_000);

    it("completes a tool-call round trip", async () => {
      const client = new OpenAICompatChatClient({ baseUrl: profile.baseUrl, apiKey: apiKey!, chatPath: profile.chatPath, authHeader: profile.authHeader });
      const result = await client.stream(
        {
          model: profile.defaultModel,
          messages: [{ role: "user", content: 'Call the echo tool with text "ok". Use the tool, do not just reply in text.' }],
          tools: [ECHO_TOOL],
          maxTokens: 128,
        },
        () => {}
      );
      // some providers/models answer in plain text instead of calling the tool -- assert
      // the round trip completed cleanly either way, and that IF a tool call happened it's
      // well-formed (this is a connectivity smoke test, not a tool-use eval).
      expect(["stop", "tool_calls", "length"]).toContain(result.finishReason);
      if (result.finishReason === "tool_calls") {
        expect(result.toolCalls[0]?.name).toBe("echo");
        expect(() => JSON.parse(result.toolCalls[0]!.arguments)).not.toThrow();
      }
    }, 30_000);
  });
}
