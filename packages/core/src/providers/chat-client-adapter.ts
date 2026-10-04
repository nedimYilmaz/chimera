// F23-1D: shared seam that wraps any "compat-shaped" ChatClient (the Promise/onDelta
// interface defined in openai-compat.ts -- implemented by both OpenAICompatChatClient and
// gemini-native.ts's GeminiNativeChatClient) into the AsyncIterable ChatClient interface
// GenericAgentBackend (F23-0C) actually drives. Extracted out of registry.ts's original
// openAiCompatClient() so a native driver module can reuse the exact same adapter without
// registry.ts and the driver module importing each other.
import type { ProviderProfile } from "@chimera/protocol";
import type {
  ChatClient as GenericChatClient, ChatStreamEvent, ChatMessage as GenericChatMessage,
} from "../backends/generic.js";
import type { ChatClient, ChatMessage as CompatChatMessage, ChatStreamDelta } from "./openai-compat.js";

export function adaptToGenericChatClient(profile: ProviderProfile, client: ChatClient): GenericChatClient {
  return {
    async *stream(req): AsyncIterable<ChatStreamEvent> {
      const events: ChatStreamEvent[] = [];
      let wake: (() => void) | null = null;
      const push = (e: ChatStreamEvent) => { events.push(e); wake?.(); wake = null; };

      const settle = client
        .stream(
          {
            model: req.model ?? profile.defaultModel,
            messages: req.messages.map(toCompatMessage),
            tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            // GENERIC-SPAWN-CREDENTIAL: forward this spawn's resolved credential (if any) and
            // an account label for the ChatClient's "no credential resolved" error.
            apiKey: req.apiKey,
            credentialLabel: req.accountName ? `${profile.id}/${req.accountName}` : profile.id,
            // TOKEN-OPT-P3: this was the missing link -- generic.ts populates req.maxTokens,
            // but nothing forwarded it into the compat ChatRequest, so openai-compat.ts:226's
            // `max_tokens` field (and gemini-native.ts's matching field) stayed inactive.
            maxTokens: req.maxTokens,
            ...(profile.id === "openai" && req.effort ? { extraBody: { reasoning_effort: req.effort } } : {}),
          },
          (delta: ChatStreamDelta) => {
            if (delta.type === "text") push({ type: "text_delta", text: delta.text });
            else if (delta.type === "usage") push({ type: "usage", usage: { inputTokens: delta.usage.promptTokens, outputTokens: delta.usage.completionTokens } });
            // tool_call_start/tool_call_args deltas are intentionally NOT forwarded -- 0C's
            // ChatStreamEvent has no partial-tool-call-delta member; it only consumes the
            // fully-assembled toolCalls[] on the terminal message_complete below.
          },
          req.signal,
        )
        .then((result) => {
          push({
            type: "message_complete",
            content: result.message === "" ? null : result.message,
            toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
            ...(result.model ? { model: result.model } : {}),
            // TRUNCATION-SURFACE: forwards openai-compat.ts's/gemini-native.ts's real
            // finish_reason so generic.ts can tell a "length" cutoff from a clean stop --
            // previously discarded here, the missing link matching TOKEN-OPT-P3's maxTokens one.
            finishReason: result.finishReason,
          });
        })
        .catch((err: unknown) => {
          push({ type: "error", message: err instanceof Error ? err.message : String(err) });
        });

      let done = false;
      while (!done) {
        while (events.length > 0) {
          const e = events.shift()!;
          yield e;
          if (e.type === "message_complete" || e.type === "error") done = true;
        }
        if (!done) await new Promise<void>((resolve) => { wake = resolve; });
      }
      await settle;   // already resolved by the time `done` flips; awaited so no dangling rejection
    },
  };
}

function toCompatMessage(m: GenericChatMessage): CompatChatMessage {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.content, ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}) };
    case "tool":
      return { role: "tool", content: m.content, toolCallId: m.toolCallId };
    case "assistant":
      return { role: "assistant", content: m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}) };
    default:
      return { role: m.role, content: m.content };
  }
}
