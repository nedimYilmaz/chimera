import { z } from "zod";

export const IssueRepoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
const Scope = { callerAgentId: z.string().min(1).optional() };
const Labels = z.array(z.string().min(1).max(100).refine(s => !/[\x00-\x1f]/.test(s))).max(8);
export const IssueSourceSchema = z.object({
  id: z.string().uuid(), projectId: z.string().min(1), repo: IssueRepoSchema,
  labels: Labels, state: z.enum(["open", "all"]), queue: z.string().min(1), enabled: z.boolean(),
  lastSyncAt: z.number().nullable(), lastError: z.string().nullable(),
}).strict();
export const IssueLinkSchema = z.object({
  taskId: z.string(), sourceId: z.string().uuid(), repo: IssueRepoSchema, number: z.number().int().positive(),
  url: z.string().url(), title: z.string().max(1000), state: z.enum(["open", "closed"]),
  bodyDigest: z.string(), changed: z.boolean(), upstreamUpdatedAt: z.string(),
  importedAt: z.number(), syncedAt: z.number(), commentedAt: z.number().nullable(),
}).strict();
export const IssueBoardLinkSchema = IssueLinkSchema.extend({
  boardStatus: z.enum(["queued", "blocked", "working", "awaiting_review", "accepted", "failed", "unavailable"]),
  agentId: z.string().nullable(), resultText: z.string().nullable(),
});
export const IssueSourceListRequestSchema = z.object({ projectId: z.string().optional(), queue: z.string().optional(), ...Scope }).strict();
export const IssueSourceUpsertRequestSchema = z.object({
  id: z.string().uuid().optional(), projectId: z.string().min(1), repo: IssueRepoSchema,
  labels: Labels.default([]), state: z.enum(["open", "all"]).default("open"),
  queue: z.string().min(1).optional(), enabled: z.boolean().default(true),
  allowRunningQueue: z.boolean().default(false), ...Scope,
}).strict();
export const IssueSourceRemoveRequestSchema = z.object({ sourceId: z.string().uuid(), ...Scope }).strict();
export const IssueSyncRequestSchema = IssueSourceRemoveRequestSchema;
export const IssueSyncResultSchema = z.object({ imported: z.number(), updated: z.number(), skipped: z.number(), truncated: z.boolean(), ghState: z.enum(["ok", "missing", "unauthenticated"]), retryAfterMs: z.number().default(0) }).strict();
export const IssueLinkListRequestSchema = z.object({ taskId: z.string().optional(), sourceId: z.string().uuid().optional(), queue: z.string().optional(), ...Scope }).strict();
export const IssuePostCommentRequestSchema = z.object({
  taskId: z.string().min(1), body: z.string().min(1).max(16000), closeIssue: z.boolean().default(false),
  phase: z.enum(["preview", "confirm"]).default("preview"), previewId: z.string().uuid().optional(), ...Scope,
}).strict();
export const IssuePostCommentResultSchema = z.object({
  status: z.enum(["approval_required", "posted", "conflict", "partial", "uncertain"]), previewId: z.string().uuid().nullable(),
  repo: IssueRepoSchema, number: z.number().int().positive(), body: z.string(), closeIssue: z.boolean(), message: z.string(),
  commentStatus: z.enum(["not_attempted", "posted", "uncertain"]).optional(),
  closeStatus: z.enum(["not_requested", "not_attempted", "closed", "uncertain"]).optional(),
}).strict();
export type IssueSource = z.infer<typeof IssueSourceSchema>;
export type IssueLink = z.infer<typeof IssueLinkSchema>;
export type IssueBoardLink = z.infer<typeof IssueBoardLinkSchema>;
export type IssueSourceUpsert = z.infer<typeof IssueSourceUpsertRequestSchema>;
export type IssuePostComment = z.infer<typeof IssuePostCommentRequestSchema>;
