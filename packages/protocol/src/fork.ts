import { z } from "zod";

const localId = z.string().min(1).max(200).refine(s => !s.includes(":"), "Select a local agent");
export const ForkLineageSchema = z.object({ forkedFrom: localId, mode: z.enum(["native", "snapshot"]), atSeq: z.number().int().positive() }).strict();
export const ForkCapabilitiesRequestSchema = z.object({ agentId: localId, upToSeq: z.number().int().positive().optional(), callerAgentId: localId.optional() }).strict();
const availability = z.object({ available: z.boolean(), reason: z.string().nullable() }).strict();
export const ForkCapabilitiesSchema = z.object({
  native: availability, snapshot: availability, atSeq: z.number().int().positive().nullable(),
  provider: z.string(), account: z.string(), model: z.string().nullable(),
}).strict();
export const ForkRequestSchema = ForkCapabilitiesRequestSchema.extend({
  mode: z.enum(["auto", "native", "snapshot"]), task: z.string().trim().min(1).max(8000),
  title: z.string().trim().min(1).max(120).optional(), includeUncommitted: z.boolean().default(false),
}).strict();
export const ForkResponseSchema = z.object({
  agentId: localId, mode: z.enum(["native", "snapshot"]), label: z.string(), lineage: ForkLineageSchema,
  worktree: z.object({ path: z.string(), branch: z.string(), baseSha: z.string() }).strict(), warnings: z.array(z.string()),
}).strict();
export type ForkRequest = z.infer<typeof ForkRequestSchema>;
export type ForkCapabilities = z.infer<typeof ForkCapabilitiesSchema>;
export type ForkResponse = z.infer<typeof ForkResponseSchema>;
export type ForkLineage = z.infer<typeof ForkLineageSchema>;
