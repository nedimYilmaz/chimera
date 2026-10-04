// F23-1D: native Gemini ChatClient against generativelanguage.googleapis.com/v1beta directly
// (NOT the OpenAI-compat layer -- see openai-compat.ts / catalog.ts's "gemini" entry for the
// v1 default). Implements the exact same ChatClient interface as OpenAICompatChatClient
// (stream(req, onDelta, signal) -> Promise<ChatResult>) so it slots into the same
// chat-client-adapter.ts seam and GenericAgentBackend (F23-0C) consumes it unchanged.
//
// Gemini wire quirks (docs/superpowers/design-plans/F23-provider-research.md §D, cross-checked
// against F23-multi-provider-llm.md §D2):
//   - auth: `x-goog-api-key` header, not Authorization/Bearer.
//   - roles: contents[].role is "user" | "model" | "function" (not "assistant"/"tool"); a
//     system prompt is NOT a message -- it's a top-level `systemInstruction`.
//   - tools: `tools: [{ functionDeclarations: [...] }]` (one wrapper object, not one per tool).
//   - a model turn's tool call is `{ functionCall: { name, args } }` (args is a JSON OBJECT,
//     not a string -- stringified here to fit ChatToolCall.arguments); the matching tool
//     result is sent back as a role:"function" content with `{ functionResponse: { name,
//     response } }` -- response must be a JSON object, so a plain-string tool result gets
//     wrapped as `{ output: <string> }`.
//   - streaming is SSE ONLY via `?alt=sse` on :streamGenerateContent (no `?alt=sse` -> a
//     bare, non-SSE JSON array instead, which this client does not parse); there is no
//     `[DONE]` sentinel -- the stream just closes.
//   - unlike OpenAI, a functionCall part normally arrives whole in one chunk rather than
//     fragmented arguments -- still emitted as one tool_call_start + one tool_call_args delta
//     for symmetry with OpenAICompatChatClient's onDelta shape.
import { redact } from "../credentials.js";
import {
  ChatAuthError, ChatRateLimitError, ChatServerError,
  type ChatClient, type ChatRequest, type ChatResult,
  type ChatStreamDelta, type ChatToolCall, type ChatUsage, type FinishReason, type ToolDefinition,
} from "./openai-compat.js";
import type { ProviderProfile } from "@chimera/protocol";
import { adaptToGenericChatClient } from "./chat-client-adapter.js";
import type { ChatClient as GenericChatClient } from "../backends/generic.js";

export type GeminiNativeConfig = {
  baseUrl: string;           // e.g. https://generativelanguage.googleapis.com/v1beta
  apiKey: string;
  stream?: boolean;          // default true; false = non-stream :generateContent fallback
  fetchFn?: typeof fetch;    // test seam
};

// THOUGHT-SIGNATURE: a thinking Gemini model (2.5+/3.x) attaches an opaque `thoughtSignature`
// alongside a functionCall part -- proof the reasoning that produced the call was actually
// performed. Replaying that functionCall in a later request's history WITHOUT the matching
// signature gets HTTP 400 INVALID_ARGUMENT: the API can tell the call is unsigned. It must be
// carried opaquely (never parsed/reformatted) and replayed on the exact same part it came from.
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = { role: "user" | "model" | "function"; parts: GeminiPart[] };

type GeminiCandidate = {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
};

type GeminiResponseChunk = {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  // MODEL-ACTUAL-SURFACE: Gemini echoes the serving model back as `modelVersion` (not `model`,
  // unlike the OpenAI-compat wire shape) — forwarded when present.
  modelVersion?: string;
};

function parseFunctionArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw === "" ? "{}" : raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toGeminiRequestBody(req: ChatRequest): { systemInstruction?: { parts: [{ text: string }] }; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  const toolNameById = new Map<string, string>();

  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: m.contentBlocks?.length
        ? m.contentBlocks.map((b) => b.type === "text" ? { text: b.text } : { inlineData: { mimeType: b.mediaType, data: b.data } })
        : [{ text: m.content ?? "" }] });
      continue;
    }
    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        toolNameById.set(tc.id, tc.name);
        const thoughtSignature = tc.providerMeta?.thoughtSignature;
        parts.push({
          functionCall: { name: tc.name, args: parseFunctionArgs(tc.arguments) },
          ...(typeof thoughtSignature === "string" ? { thoughtSignature } : {}),
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    // m.role === "tool"
    const name = (m.toolCallId && toolNameById.get(m.toolCallId)) ?? m.name ?? "unknown";
    contents.push({ role: "function", parts: [{ functionResponse: { name, response: { output: m.content ?? "" } } }] });
  }

  return {
    ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } as const } : {}),
    contents,
  };
}

function toGeminiTools(tools: ToolDefinition[] | undefined): [{ functionDeclarations: Record<string, unknown>[] }] | undefined {
  if (!tools?.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

function mapFinishReason(raw: string | undefined, hasToolCalls: boolean): FinishReason {
  // TRUNCATION-SURFACE: MAX_TOKENS is checked BEFORE the hasToolCalls shortcut below, or a
  // candidate that Gemini cut off at the output cap *while emitting function calls* would be
  // normalized to "tool_calls" -- a clean stop as far as generic.ts's finish_reason check is
  // concerned, which is precisely the truncated turn that check exists to catch. Gemini hands
  // back already-parsed `functionCall.args`, so the damage here isn't half-written JSON: it's a
  // FURTHER function call (or the trailing text explaining the plan) that never arrived, with
  // the partial set executed as if it were the model's whole intent.
  if (raw === "MAX_TOKENS") return "length";
  if (hasToolCalls) return "tool_calls";
  switch (raw) {
    case "STOP": return "stop";
    case "SAFETY": case "RECITATION": case "BLOCKLIST": case "PROHIBITED_CONTENT": case "SPII": return "content_filter";
    default: return "stop";
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

type Accum = {
  message: string;
  toolCalls: ChatToolCall[];
  usage: ChatUsage | undefined;
  rawFinishReason: string | undefined;
  model: string | undefined;
};

export class GeminiNativeChatClient implements ChatClient {
  constructor(private config: GeminiNativeConfig) {}

  private headers(apiKey: string): Record<string, string> {
    return { "content-type": "application/json", "x-goog-api-key": apiKey };
  }

  private url(model: string, streaming: boolean): string {
    const method = streaming ? "streamGenerateContent" : "generateContent";
    const suffix = streaming ? "?alt=sse" : "";
    return `${this.config.baseUrl}/models/${model}:${method}${suffix}`;
  }

  private async raiseHttpError(res: Response, apiKey: string): Promise<never> {
    const bodyText = await res.text().catch(() => "");
    const message = redact(`${res.status} ${res.statusText}: ${bodyText}`.trim(), [this.config.apiKey, apiKey]);
    if (res.status === 401 || res.status === 403) throw new ChatAuthError(res.status, message);
    if (res.status === 429) throw new ChatRateLimitError(parseRetryAfter(res.headers.get("retry-after")), message);
    throw new ChatServerError(res.status, message);
  }

  async stream(req: ChatRequest, onDelta: (d: ChatStreamDelta) => void, signal?: AbortSignal): Promise<ChatResult> {
    // GENERIC-SPAWN-CREDENTIAL: same per-spawn-override / construction-fallback / clear-error
    // contract as OpenAICompatChatClient.stream — see that file's comment for the rationale.
    const apiKey = req.apiKey ?? this.config.apiKey;
    if (!apiKey) {
      throw new ChatAuthError(401, `no credential resolved for ${req.credentialLabel ?? "this provider"} — check the account's credential configuration`);
    }

    const fetchFn = this.config.fetchFn ?? fetch;
    const useStream = this.config.stream ?? true;
    const { systemInstruction, contents } = toGeminiRequestBody(req);
    const tools = toGeminiTools(req.tools);
    const body: Record<string, unknown> = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      ...(tools ? { tools } : {}),
      ...(req.maxTokens !== undefined ? { generationConfig: { maxOutputTokens: req.maxTokens } } : {}),
    };

    const res = await fetchFn(this.url(req.model, useStream), {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) await this.raiseHttpError(res, apiKey);
    return useStream ? this.consumeStream(res, onDelta) : this.consumeNonStream(res, onDelta);
  }

  private processChunk(chunk: GeminiResponseChunk, acc: Accum, onDelta: (d: ChatStreamDelta) => void): void {
    if (chunk.modelVersion) acc.model = chunk.modelVersion;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if ("text" in part && part.text) {
        acc.message += part.text;
        onDelta({ type: "text", text: part.text });
      } else if ("functionCall" in part) {
        const index = acc.toolCalls.length;
        const id = `call_${index}`;
        const argsStr = JSON.stringify(part.functionCall.args ?? {});
        onDelta({ type: "tool_call_start", index, id, name: part.functionCall.name });
        onDelta({ type: "tool_call_args", index, argsDelta: argsStr });
        acc.toolCalls.push({
          id, name: part.functionCall.name, arguments: argsStr,
          ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {}),
        });
      }
    }
    if (candidate?.finishReason) acc.rawFinishReason = candidate.finishReason;
    if (chunk.usageMetadata) {
      acc.usage = {
        promptTokens: chunk.usageMetadata.promptTokenCount,
        completionTokens: chunk.usageMetadata.candidatesTokenCount,
        totalTokens: chunk.usageMetadata.totalTokenCount,
      };
      onDelta({ type: "usage", usage: acc.usage });
    }
  }

  private finalize(acc: Accum): ChatResult {
    return {
      message: acc.message,
      toolCalls: acc.toolCalls,
      usage: acc.usage,
      finishReason: mapFinishReason(acc.rawFinishReason, acc.toolCalls.length > 0),
      ...(acc.model ? { model: acc.model } : {}),
    };
  }

  private async consumeNonStream(res: Response, onDelta: (d: ChatStreamDelta) => void): Promise<ChatResult> {
    const json = (await res.json()) as GeminiResponseChunk;
    const acc: Accum = { message: "", toolCalls: [], usage: undefined, rawFinishReason: undefined, model: undefined };
    this.processChunk(json, acc, onDelta);
    return this.finalize(acc);
  }

  private async consumeStream(res: Response, onDelta: (d: ChatStreamDelta) => void): Promise<ChatResult> {
    if (!res.body) throw new ChatServerError(res.status, "response has no body to stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const acc: Accum = { message: "", toolCalls: [], usage: undefined, rawFinishReason: undefined, model: undefined };

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice("data:".length).trim();
      if (!payload) return;
      this.processChunk(JSON.parse(payload) as GeminiResponseChunk, acc, onDelta);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        }
      }
      // flush a final partial line without a trailing newline, if the stream ended mid-line
      const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (tail) processLine(tail);
    } finally {
      await reader.cancel().catch(() => {});
    }

    return this.finalize(acc);
  }
}

export function geminiNativeClient(profile: ProviderProfile, deps: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): GenericChatClient {
  const env = deps.env ?? process.env;
  const apiKey = (profile.envVar ? env[profile.envVar] : undefined) ?? "";
  const client = new GeminiNativeChatClient({ baseUrl: profile.baseUrl, apiKey, fetchFn: deps.fetchFn });
  return adaptToGenericChatClient(profile, client);
}
