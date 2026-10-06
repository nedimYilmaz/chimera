import { randomUUID } from "node:crypto";
import { PrincipalSchema, type AgentDelivery, type AgentInput, type AgentMessage, type ContentBlock, type Principal } from "@chimera/protocol";
import type { AgentHandle, Image } from "./backend.js";

export function authoredContent(text: string, images?: Image[], content?: ContentBlock[]): ContentBlock[] {
  return structuredClone(content?.length ? content : [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...(images ?? []).map(image => ({ type: "image" as const, ...image })),
  ]);
}
export function contentText(content: ContentBlock[]): string {
  return content.filter(block => block.type === "text").map(block => block.text).join("\n\n");
}
export function createMessage(text: string, author: Principal, opts: { id?: string; createdAt?: number; kind?: AgentMessage["kind"]; images?: Image[]; content?: ContentBlock[]; context?: AgentMessage["context"] } = {}): AgentMessage {
  return {
    id: opts.id ?? randomUUID(), createdAt: opts.createdAt ?? Date.now(),
    author: PrincipalSchema.strip().parse(author), kind: opts.kind ?? "user_message",
    content: authoredContent(text, opts.images, opts.content),
    ...(opts.context ? { context: structuredClone(opts.context) } : {}),
  };
}

// Full provenance stays in storage. Only facts needed to interpret this input
// enter the model context. These user-priority data blocks never confer authority.
export function projectMessages(messages: AgentMessage[]): ContentBlock[] {
  return messages.flatMap(message => {
    if (message.author.source === "operator" && messages.length === 1 && message.kind === "user_message") return message.content;
    const { from, source, engineId } = message.author;
    return [{ type: "text" as const, text: JSON.stringify({ message: {
      from, source, ...(engineId !== "local" ? { engineId } : {}),
      ...(message.kind !== "user_message" ? { kind: message.kind } : {}),
    } }) }, ...message.content];
  });
}

// Compatibility for callers still using text/images/content. An envelope, when
// supplied, is authoritative; a conflicting legacy body cannot override it.
export function deliveryContent(text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery): ContentBlock[] {
  return delivery ? projectMessages(delivery.messages) : authoredContent(text, images, content);
}
export function deliveryText(text: string, delivery?: AgentDelivery): string {
  return requireTextContent(deliveryContent(text, undefined, undefined, delivery));
}
export class UnsupportedContentError extends Error { readonly code = "guardrail"; }
export function requireTextContent(content: ContentBlock[]): string {
  if (content.some(block => block.type !== "text")) throw new UnsupportedContentError("This backend does not support image content");
  return contentText(content);
}

// Existing embedders can keep send(). The daemon uses deliver() exclusively;
// adaptation happens once, immediately before a provider's input API.
export function withMessageInput<T extends AgentHandle>(handle: T): T {
  handle.deliver = async (input: AgentInput) => {
    if (input.type === "command") return handle.send(input.text);
    const content = projectMessages(input.messages);
    const send = input.mode === "steer" && handle.steer ? handle.steer.bind(handle) : handle.send.bind(handle);
    await send(contentText(content), undefined, content);
  };
  return handle;
}
export async function deliverAgentInput(handle: AgentHandle, input: AgentInput): Promise<void> {
  if (handle.deliver) return handle.deliver(input);
  // Compatibility for external/test backends that predate the envelope API.
  await withMessageInput(handle).deliver!(input);
}
