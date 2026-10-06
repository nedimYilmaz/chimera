import { z } from "zod";
import { ContentBlockSchema } from "./content-blocks.js";

// Stamped by the authenticated ingress, never accepted as an agent tool argument.
export const PrincipalSchema = z.object({
  from: z.string(),
  source: z.enum(["operator", "agent", "system", "external"]),
  engineId: z.string(),
  label: z.string().optional(),
  team: z.string().optional(),
  role: z.string().optional(),
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;
export const MessageKindSchema = z.enum(["user_message", "child_result", "child_failed", "signal"]);
export const AgentMessageMetadataSchema = PrincipalSchema.extend({ kind: MessageKindSchema });
export type AgentMessageMetadata = z.infer<typeof AgentMessageMetadataSchema>;

export const AgentMessageSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  author: PrincipalSchema,
  kind: MessageKindSchema,
  content: z.array(ContentBlockSchema),
  context: z.object({ taskId: z.string().optional(), replyTo: z.string().optional() }).strict().optional(),
}).strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentDelivery = { messages: AgentMessage[] };
export type AgentInput =
  | { type: "messages"; messages: AgentMessage[]; mode?: "enqueue" | "steer" }
  | { type: "command"; text: string };
