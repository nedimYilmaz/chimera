// F23-0B: fetch-based OpenAI-compatible chat client. Pure parameterized
// transport (no provider-specific behavior) -- GenericAgentBackend (F23-0C)
// drives the agent loop on top of this; provider quirks live in FAZ-1 catalog
// entries (ProviderProfile), not here.
import { redact } from "../credentials.js";
import type { ContentBlock } from "@chimera/protocol";

export type ChatRole = "system" | "user" | "assistant" | "tool";

// PROVIDER-META: opaque, provider-owned per-call metadata that must round-trip verbatim from a
// response back into the next request's replayed history without any provider-agnostic code
// parsing or reformatting it (see gemini-native.ts's `thoughtSignature` consumer).
export type ChatToolCall = { id: string; name: string; arguments: string; providerMeta?: Record<string, unknown> };

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  contentBlocks?: ContentBlock[];
  toolCalls?: ChatToolCall[];   // assistant message requesting tool calls
  toolCallId?: string;         // tool-result message: which call this answers
  name?: string;                // tool-result message: tool name (some providers require it)
};

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON schema
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  // GENERIC-SPAWN-CREDENTIAL: per-spawn resolved credential (from the agent's own
  // ResolvedAgentSpec.env), overriding the client's construction-time apiKey. Lets two
  // accounts of the same openai-compat/native provider each use their own key instead of
  // sharing whatever key was in process.env when this backend was constructed.
  apiKey?: string;
  credentialLabel?: string;   // "<provider>/<account>", used only in the no-credential error message
};

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type ChatStreamDelta =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; argsDelta: string }
  | { type: "usage"; usage: ChatUsage };

export type ChatResult = {
  message: string;
  toolCalls: ChatToolCall[];
  usage: ChatUsage | undefined;
  finishReason: FinishReason;
  // MODEL-ACTUAL-SURFACE: the wire response's own `model` field (present on both OpenAI's
  // chat.completion(.chunk) and z.ai's openai-compat responses) — often differs from the
  // requested model (e.g. request "glm-5", server serves "glm-5.2"). Absent when the
  // provider never echoes one back.
  model?: string;
};

export interface ChatClient {
  stream(req: ChatRequest, onDelta: (d: ChatStreamDelta) => void, signal?: AbortSignal): Promise<ChatResult>;
}

export class ChatAuthError extends Error {
  code = "chat-auth" as const;
  name = "ChatAuthError";
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class ChatRateLimitError extends Error {
  code = "chat-rate-limit" as const;
  name = "ChatRateLimitError";
  constructor(public retryAfterMs: number | undefined, message: string) {
    super(message);
  }
}

export class ChatServerError extends Error {
  code = "chat-server" as const;
  name = "ChatServerError";
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type OpenAICompatConfig = {
  baseUrl: string;
  apiKey: string;
  chatPath?: string;                 // default "/chat/completions"
  authHeader?: string;                // default "Authorization"
  authScheme?: string;                // default "Bearer "; pass "" for headers like api-key that carry the raw key
  extraHeaders?: Record<string, string>;
  stream?: boolean;                   // default true; false = non-stream fallback path
  includeUsage?: boolean;              // default true; adds stream_options.include_usage for providers that support it
  fetchFn?: typeof fetch;             // test seam
  timeoutMs?: number;                  // default: none (no implicit timeout); see ProviderProfile.timeoutMs
  maxTokensField?: "max_tokens" | "max_completion_tokens";
};

// Combines the caller's abort signal (if any) with a timeout-derived one: whichever fires
// first wins. Returns the un-aborted `signal` unchanged when no timeoutMs is configured, so
// the common case allocates nothing extra.
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!timeoutMs) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

type WireToolCallDelta = { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };

type WireChunk = {
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: WireToolCallDelta[] };
    message?: { role?: string; content?: string | null; tool_calls?: WireToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
};

function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const wire: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === "user" && m.contentBlocks?.length) {
      wire.content = m.contentBlocks.map((b) => b.type === "text" ? { type: "text", text: b.text } : {
        type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` },
      });
    }
    if (m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (m.toolCallId) wire.tool_call_id = m.toolCallId;
    if (m.name) wire.name = m.name;
    return wire;
  });
}

function toWireTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toWireUsage(u: WireChunk["usage"]): ChatUsage | undefined {
  if (!u) return undefined;
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
}

function toFinishReason(r: string | null | undefined): FinishReason | undefined {
  switch (r) {
    case "stop": return "stop";
    case "tool_calls": case "function_call": return "tool_calls";
    case "length": return "length";
    case "content_filter": return "content_filter";
    default: return undefined;
  }
}

// TRUNCATION-BACKSTOP: an openai-compat vendor is free to OMIT finish_reason entirely (observed
// on zai-coding/glm — the provider that produced the silent-truncation incident), and the
// default below would then report a response the provider cut off at max_tokens as a clean
// "stop", making backends/generic.ts's "length" check inert exactly where it was needed. When a
// response consumed its whole output allowance, read an ABSENT finish_reason as "length".
// A FLOOR, not an exact test: vendors disagree on whether reasoning tokens are counted in
// completion_tokens, so this can only ever be reached by a response that really did spend the
// ceiling. An EXPLICIT finish_reason always wins — this never overrides a provider that said
// "stop", it only replaces a GUESS with a better-founded one.
function inferFinishReason(
  explicit: FinishReason | undefined, usage: ChatUsage | undefined, maxTokens: number | undefined, hasToolCalls: boolean,
): FinishReason {
  if (explicit) return explicit;
  if (maxTokens !== undefined && usage?.completionTokens !== undefined && usage.completionTokens >= maxTokens) return "length";
  return hasToolCalls ? "tool_calls" : "stop";
}

// OUTPUT-CEILING-LEARNED: backends/generic.ts sends a blunt DEFAULT_MAX_OUTPUT_TOKENS (32k) for
// every model whose real ceiling the catalog does not know (GLM/Kimi/Fireworks — see
// model-catalog.ts's coverage gap). A provider whose real ceiling is lower answers HTTP 400
// ("max_tokens is too large"), which before this was a hard turn failure. Retry ONCE at this
// floor and remember the working value so the rest of the process pays that round-trip only
// once. PROCESS-LIFETIME ONLY (a Map, deliberately never persisted): a ceiling learned from one
// vendor error must not outlive a restart and silently cap a model whose limit was later raised.
// A model the catalog DOES know keeps its per-model/profile ceiling untouched — a correct
// ceiling never 400s, so it never enters this map at all.
const OUTPUT_CEILING_RETRY_TOKENS = 8192;
const OUTPUT_LIMIT_400_RE = /max_tokens|max_output_tokens|maxoutputtokens|max_completion_tokens|output (token|length|limit)/i;
const learnedOutputCeilings = new Map<string, number>();

// Test seam only — the map is process-global by design, so a test that provokes a 400 would
// otherwise leak its learned ceiling into every later case in the same file.
export function _resetLearnedOutputCeilings(): void { learnedOutputCeilings.clear(); }

export class OpenAICompatChatClient implements ChatClient {
  constructor(private config: OpenAICompatConfig) {}

  private headers(apiKey: string): Record<string, string> {
    const headerName = this.config.authHeader ?? "Authorization";
    const scheme = this.config.authScheme ?? "Bearer ";
    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      [headerName]: `${scheme}${apiKey}`,
      ...this.config.extraHeaders,
    };
  }

  private url(): string {
    const path = this.config.chatPath ?? "/chat/completions";
    return `${this.config.baseUrl}${path}`;
  }

  private async raiseHttpError(res: Response, apiKey: string): Promise<never> {
    return this.raiseHttpErrorFrom(res, await res.text().catch(() => ""), apiKey);
  }

  // Split out of raiseHttpError because a Response body can only be read ONCE: the
  // OUTPUT-CEILING-LEARNED path below has to inspect the body to decide whether to retry, so it
  // reads it first and hands the same text here when the answer is "no".
  private raiseHttpErrorFrom(res: Response, bodyText: string, apiKey: string): never {
    const message = redact(`${res.status} ${res.statusText}: ${bodyText}`.trim(), [this.config.apiKey, apiKey]);
    if (res.status === 401 || res.status === 403) throw new ChatAuthError(res.status, message);
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;
      throw new ChatRateLimitError(retryAfterMs, message);
    }
    throw new ChatServerError(res.status, message);
  }

  async stream(req: ChatRequest, onDelta: (d: ChatStreamDelta) => void, signal?: AbortSignal): Promise<ChatResult> {
    // GENERIC-SPAWN-CREDENTIAL fallback order: per-spawn override (req.apiKey, threaded from
    // the agent's ResolvedAgentSpec.env) -> construction-time key (still valid for
    // env-var-configured single-account setups) -> a clear error instead of an empty bearer
    // that the provider would otherwise reject with a confusing generic 401.
    const apiKey = req.apiKey ?? this.config.apiKey;
    if (!apiKey) {
      throw new ChatAuthError(401, `no credential resolved for ${req.credentialLabel ?? "this provider"} — check the account's credential configuration`);
    }

    const fetchFn = this.config.fetchFn ?? fetch;
    const useStream = this.config.stream ?? true;
    // OUTPUT-CEILING-LEARNED: keyed on baseUrl+model, since the SAME model id can carry a
    // different ceiling behind a different gateway.
    const ceilingKey = `${this.config.baseUrl}|${req.model}`;
    const learnedCeiling = learnedOutputCeilings.get(ceilingKey);
    const maxTokensField = this.config.maxTokensField ?? "max_tokens";
    let sentMaxTokens = req.maxTokens !== undefined && learnedCeiling !== undefined
      ? Math.min(req.maxTokens, learnedCeiling)
      : req.maxTokens;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      stream: useStream,
      ...(req.tools ? { tools: toWireTools(req.tools) } : {}),
      ...(sentMaxTokens !== undefined ? { [maxTokensField]: sentMaxTokens } : {}),
      ...(useStream && (this.config.includeUsage ?? true) ? { stream_options: { include_usage: true } } : {}),
      ...req.extraBody,
    };

    const { signal: effectiveSignal, cleanup } = withTimeout(signal, this.config.timeoutMs);
    try {
      const send = () => fetchFn(this.url(), {
        method: "POST",
        headers: this.headers(apiKey),
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
      let res = await send();

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        // OUTPUT-CEILING-LEARNED: exactly ONE retry, and only when lowering the cap could
        // plausibly help — a 400 that never mentioned an output limit, or one we were already
        // at/below the floor for, is the caller's error and is raised unchanged.
        const retryable = res.status === 400 && sentMaxTokens !== undefined
          && sentMaxTokens > OUTPUT_CEILING_RETRY_TOKENS && OUTPUT_LIMIT_400_RE.test(bodyText);
        if (!retryable) this.raiseHttpErrorFrom(res, bodyText, apiKey);
        sentMaxTokens = OUTPUT_CEILING_RETRY_TOKENS;
        body[maxTokensField] = sentMaxTokens;
        res = await send();
        // Learn only from a request that actually SUCCEEDED — a second failure proves nothing
        // about the ceiling, and caching a wrong one would cap every later turn for free.
        if (res.ok) learnedOutputCeilings.set(ceilingKey, sentMaxTokens);
        else await this.raiseHttpError(res, apiKey);
      }

      if (!useStream) return await this.consumeNonStream(res, onDelta, sentMaxTokens);
      return await this.consumeStream(res, onDelta, sentMaxTokens);
    } finally {
      cleanup();
    }
  }

  private async consumeNonStream(res: Response, onDelta: (d: ChatStreamDelta) => void, maxTokens: number | undefined): Promise<ChatResult> {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCallDelta[] }; finish_reason?: string | null }>;
      usage?: WireChunk["usage"];
      model?: string;
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (text) onDelta({ type: "text", text });

    const toolCalls: ChatToolCall[] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      const id = tc.id ?? `call_${toolCalls.length}`;
      const name = tc.function?.name ?? "";
      const args = tc.function?.arguments ?? "";
      onDelta({ type: "tool_call_start", index: tc.index ?? toolCalls.length, id, name });
      if (args) onDelta({ type: "tool_call_args", index: tc.index ?? toolCalls.length, argsDelta: args });
      toolCalls.push({ id, name, arguments: args });
    }

    const usage = toWireUsage(json.usage);
    if (usage) onDelta({ type: "usage", usage });

    return {
      message: text,
      toolCalls,
      usage,
      finishReason: inferFinishReason(toFinishReason(choice?.finish_reason), usage, maxTokens, toolCalls.length > 0),
      ...(json.model ? { model: json.model } : {}),
    };
  }

  private async consumeStream(res: Response, onDelta: (d: ChatStreamDelta) => void, maxTokens: number | undefined): Promise<ChatResult> {
    if (!res.body) throw new ChatServerError(res.status, "response has no body to stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let message = "";
    let usage: ChatUsage | undefined;
    let finishReason: FinishReason | undefined;
    let model: string | undefined;
    // index-keyed accumulation: OpenAI fragments tool_calls across many deltas
    // (id/name usually arrive once, arguments arrive as many string chunks)
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();

    const processChunk = (chunk: WireChunk) => {
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        message += delta.content;
        onDelta({ type: "text", text: delta.content });
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index;
        let entry = toolCallsByIndex.get(index);
        if (!entry) {
          entry = { id: tc.id ?? `call_${index}`, name: tc.function?.name ?? "", arguments: "" };
          toolCallsByIndex.set(index, entry);
          onDelta({ type: "tool_call_start", index, id: entry.id, name: entry.name });
        } else {
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          entry.arguments += tc.function.arguments;
          onDelta({ type: "tool_call_args", index, argsDelta: tc.function.arguments });
        }
      }
      const fr = toFinishReason(choice?.finish_reason);
      if (fr) finishReason = fr;
      const chunkUsage = toWireUsage(chunk.usage);
      if (chunkUsage) {
        usage = chunkUsage;
        onDelta({ type: "usage", usage: chunkUsage });
      }
    };

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return "continue" as const;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return "done" as const;
      if (!payload) return "continue" as const;
      processChunk(JSON.parse(payload) as WireChunk);
      return "continue" as const;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        let stop = false;
        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (processLine(line) === "done") {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      // flush a final partial line without a trailing newline, if the stream ended mid-line
      const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (tail) processLine(tail);
    } finally {
      await reader.cancel().catch(() => {});
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);

    return {
      message,
      toolCalls,
      usage,
      finishReason: inferFinishReason(finishReason, usage, maxTokens, toolCalls.length > 0),
      ...(model ? { model } : {}),
    };
  }
}

function parseRetryAfter(header: string): number | undefined {
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}
