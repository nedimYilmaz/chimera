import { z } from "zod";

// This is local, explicit cleanup. Never accept an engine-qualified ID or a path.
const LocalAgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
export const AgentForgetParamsSchema = z.object({
  agentIds: z.array(LocalAgentIdSchema).min(1).max(100),
  // The MCP resolver supplies identity; the desktop operator omits it.
  callerAgentId: LocalAgentIdSchema.optional(),
}).strict();
export type AgentForgetParams = z.infer<typeof AgentForgetParamsSchema>;
export const AgentForgetResultSchema = z.object({
  requested: z.number().int().nonnegative(),
  purged: z.number().int().nonnegative(),
  agentIds: z.array(z.string()),
  skipped: z.array(z.object({
    agentId: z.string(),
    reason: z.enum(["unknown", "live", "self", "outside_scope"]),
    state: z.string().optional(),
  }).strict()),
  eventsRemoved: z.number().int().nonnegative(),
  chronicleDocsRemoved: z.number().int().nonnegative(),
}).strict();
export type AgentForgetResult = z.infer<typeof AgentForgetResultSchema>;
