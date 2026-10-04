import type { ChatClient, ChatMessage, ChatStreamEvent, ChatStreamRequest } from "../backends/generic.js";
import { redact } from "../credentials.js";

type Item = Record<string, unknown>;
type ResponsePayload = {
  status?: string; model?: string; output?: Item[];
  error?: { message?: string }; incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
};

export function responsesInput(messages: ChatMessage[]): Item[] {
  return messages.flatMap((message): Item[] => {
    if (message.role === "assistant" && message.providerItems) return message.providerItems;
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    if (message.role === "assistant") return [
      ...(message.content ? [{ role: "assistant", content: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments })),
    ];
    return [{ role: message.role === "system" ? "developer" : "user", content: message.role === "user" && message.contentBlocks?.length
      ? message.contentBlocks.map((b) => b.type === "text" ? { type: "input_text", text: b.text } : { type: "input_image", image_url: `data:${b.mediaType};base64,${b.data}` })
      : message.content }];
  });
}

// No shared conversation state: response output stays on each agent's own history.
// store:false + encrypted reasoning supports replay without server-side persistence.
export class OpenAIResponsesClient implements ChatClient {
  constructor(private options: { baseUrl: string; apiKey?: string; model: string; fetchFn?: typeof fetch; timeoutMs?: number; extraHeaders?: Record<string, string>; authHeader?: string }) {}

  async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    const key = req.apiKey ?? this.options.apiKey;
    if (!key) throw new Error(`no credential resolved for openai/${req.accountName ?? "account"}`);
    const signal = this.options.timeoutMs
      ? AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(this.options.timeoutMs)]) : req.signal;
    const headers = new Headers(this.options.extraHeaders);
    const authHeader = this.options.authHeader ?? "Authorization";
    headers.set(authHeader, authHeader.toLowerCase() === "authorization" ? `Bearer ${key}` : key);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");
    const response = await (this.options.fetchFn ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST", signal,
      headers,
      body: JSON.stringify({
        model: req.model ?? this.options.model, input: responsesInput(req.messages), store: false, stream: true,
        include: ["reasoning.encrypted_content"],
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
        ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
        ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
        ...(req.resultSchema ? { text: { format: { type: "json_schema", name: "agent_result", schema: req.resultSchema, strict: true } } } : {}),
      }),
    });
    if (!response.ok) throw new Error(redact(`OpenAI Responses ${response.status}: ${(await response.text()).slice(0, 4000)}`, [key]));
    if (!response.body) throw new Error("OpenAI Responses returned an empty stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = false;
    let text = "";
    const items = new Map<number, Item>();
    try {
      while (!terminal) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (chunk.done && buffer.trim()) buffer += "\n\n";
        let boundary: number;
        buffer = buffer.replace(/\r\n/g, "\n");
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data) as Item;
          if (event.type === "response.output_text.delta") {
            text += String(event.delta ?? "");
            yield { type: "text_delta", text: String(event.delta ?? "") };
          } else if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
            items.set(Number(event.output_index), event.item as Item);
          } else if (event.type === "response.function_call_arguments.delta") {
            const item = items.get(Number(event.output_index));
            if (item) item.arguments = String(item.arguments ?? "") + String(event.delta ?? "");
          } else if (event.type === "error" || event.type === "response.failed") {
            const failed = event.response as ResponsePayload | undefined;
            throw new Error(redact(String(failed?.error?.message ?? event.message ?? "OpenAI response failed"), [key]));
          } else if (event.type === "response.completed" || event.type === "response.incomplete") {
            terminal = true;
            const result = event.response as ResponsePayload;
            const output = result.output ?? [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
            const refusal = output.some((item) => item.type === "message" && (item.content as Item[] | undefined)?.some((part) => part.type === "refusal"));
            const incomplete = event.type === "response.incomplete" || result.status === "incomplete";
            if (result.usage) yield { type: "usage", usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, cachedInputTokens: result.usage.input_tokens_details?.cached_tokens ?? 0 } };
            const completeText = output.filter((item) => item.type === "message").flatMap((item) => (item.content as Item[] | undefined) ?? []).filter((part) => part.type === "output_text").map((part) => String(part.text ?? "")).join("");
            yield {
              type: "message_complete", content: completeText || text, model: result.model ?? req.model ?? this.options.model,
              providerItems: output,
              toolCalls: incomplete || refusal ? [] : output.filter((item) => item.type === "function_call").map((item) => ({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? "") })),
              finishReason: refusal ? "content_filter" : incomplete ? result.incomplete_details?.reason === "max_output_tokens" ? "length" : "error" : "stop",
            };
            break;
          }
        }
        if (chunk.done) break;
      }
      if (!terminal) throw new Error("OpenAI Responses stream ended before a terminal event");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
