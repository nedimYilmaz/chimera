import { z } from "zod";

// Qualified remote IDs deliberately cannot resolve to an unrelated local source.
const localId = z.string().min(1).max(200).refine(s => !s.includes(":"), "local identifiers only");
export const ContextLinkSourceSchema = z.object({ kind: z.enum(["note-snapshot", "artifact", "agent-summary"]), ref: localId }).strict();
export const ContextLinkSnapshotSchema = z.object({
  title: z.string().min(1).max(200), bytes: z.number().int().min(0).max(32768),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(32768).optional(), artifactId: localId.optional(),
}).strict();
export const ContextLinkSchema = z.object({
  id: z.string().uuid(), from: ContextLinkSourceSchema, toAgentId: localId,
  createdBy: z.string().min(1), createdAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative().nullable(), revokedAt: z.number().finite().nonnegative().nullable(),
  snapshot: ContextLinkSnapshotSchema,
}).strict();
export const ContextLinkViewSchema = ContextLinkSchema.extend({
  status: z.enum(["active", "expired", "revoked", "source-removed"]), semantics: z.literal("snapshot"),
  untrusted: z.boolean(), notification: z.enum(["queued", "failed"]).optional(),
}).strict();
export const ContextLinkCreateSchema = z.object({
  from: ContextLinkSourceSchema, toAgentId: localId, title: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(32768).optional(), expiresAt: z.number().finite().nonnegative().nullable().optional(),
  confirmSecrets: z.boolean().optional(), notify: z.boolean().optional(), callerAgentId: localId.optional(),
}).strict();
export const ContextLinkListSchema = z.object({ toAgentId: localId.optional(), fromAgentId: localId.optional(), callerAgentId: localId.optional() }).strict();
export const ContextLinkTargetSchema = z.object({ id: z.string().uuid(), callerAgentId: localId.optional() }).strict();
export const ContextLinkListResponseSchema = z.object({ links: z.array(ContextLinkViewSchema).max(500) }).strict();
export type ContextLink = z.infer<typeof ContextLinkSchema>;
export type ContextLinkView = z.infer<typeof ContextLinkViewSchema>;
export type ContextLinkCreate = z.infer<typeof ContextLinkCreateSchema>;
export type ContextLinkList = z.infer<typeof ContextLinkListSchema>;
