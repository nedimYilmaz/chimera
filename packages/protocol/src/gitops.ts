import { z } from "zod";

export const GitTargetSchema = z.union([z.object({ agentId: z.string().min(1) }).strict(), z.object({ taskId: z.string().min(1) }).strict()]);
const path = z.string().min(1).max(4096).refine(p => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.split("/").every(s => !!s && s !== "." && s !== ".." && s.toLowerCase() !== ".git"), "confined relative path required");
export const GitStatusRequestSchema = z.object({ target: GitTargetSchema, callerAgentId: z.string().min(1).optional() }).strict();
export const GitStatusSchema = z.object({ branch: z.string().nullable(), head: z.string().nullable(), indexFingerprint: z.string(), files: z.array(z.object({ path, index: z.string(), worktree: z.string(), staged: z.boolean() }).strict()), truncated: z.boolean(), writable: z.boolean(), writeReason: z.string().nullable() }).strict();
export const GitDiffRequestSchema = GitStatusRequestSchema.extend({ path, staged: z.boolean().default(false), context: z.number().int().min(0).max(20).default(3), maxBytes: z.number().int().min(1).max(262144).default(131072) }).strict();
export const GitDiffSchema = z.object({ hunks: z.string(), binary: z.boolean(), truncated: z.boolean() }).strict();
export const FileReadRequestSchema = GitStatusRequestSchema.extend({ path }).strict();
export const FileReadSchema = z.object({ text: z.string(), contentVersion: z.string(), bytes: z.number().int().nonnegative() }).strict();
export const FileWriteRequestSchema = FileReadRequestSchema.extend({ text: z.string().max(262144), expectedContentVersion: z.string().min(1) }).strict();
export const FileWriteSchema = z.object({ contentVersion: z.string() }).strict();
export const GitStageRequestSchema = GitStatusRequestSchema.extend({ paths: z.array(path).min(1).max(100), unstage: z.boolean().default(false), expectedHead: z.string().nullable(), expectedIndexFingerprint: z.string().min(1) }).strict();
export const GitCommitRequestSchema = GitStatusRequestSchema.extend({ message: z.string().trim().min(1).max(16384).refine(s => !s.includes("\0")), expectedHead: z.string().nullable(), expectedIndexFingerprint: z.string().min(1) }).strict();
export const GitStageSchema = z.object({ indexFingerprint: z.string() }).strict();
export const GitCommitSchema = z.object({ sha: z.string() }).strict();
export type GitTarget = z.infer<typeof GitTargetSchema>;
export type GitStatus = z.infer<typeof GitStatusSchema>;
export type GitFile = z.infer<typeof FileReadSchema>;
