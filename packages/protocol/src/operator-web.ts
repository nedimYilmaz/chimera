import { z } from "zod";

export const OperatorWebScopeSchema = z.enum(["read", "control"]);
export const OperatorWebSettingsSchema = z.object({
  v: z.literal(1).default(1), port: z.number().int().min(0).max(65535).default(0),
  idleMin: z.number().int().min(1).max(30).default(30), absoluteH: z.number().min(0.01).max(24).default(8),
  // A tunnel must terminate TLS. Forwarded headers never establish trust.
  publicOrigin: z.string().url().refine(s => { const u = new URL(s); return u.protocol === "https:" && u.origin === s && !u.username && !u.password; }).nullable().default(null),
}).strict();
export const OperatorWebSessionSchema = z.object({
  id: z.string(), deviceLabel: z.string(), project: z.string(), scope: OperatorWebScopeSchema,
  createdAt: z.number(), lastUsedAt: z.number(), expiresAt: z.number(),
}).strict();
export const OperatorWebStatusSchema = z.object({
  enabled: z.boolean(), localUrl: z.string().nullable(), settings: OperatorWebSettingsSchema,
  sessions: z.array(OperatorWebSessionSchema), bundleAvailable: z.boolean(),
  limitation: z.string(),
}).strict();
export const OperatorWebPairStartSchema = z.object({ project: z.string().min(1).max(120), allowControl: z.boolean().default(false) }).strict();
export const OperatorWebPairCodeSchema = z.object({ code: z.string(), expiresAt: z.number(), project: z.string(), scope: OperatorWebScopeSchema }).strict();
export const OperatorWebPairSchema = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/), deviceLabel: z.string().min(1).max(80), scope: OperatorWebScopeSchema.default("read") }).strict();
export const OperatorWebSnapshotSchema = z.object({
  project: z.string(), scope: OperatorWebScopeSchema,
  agents: z.array(z.object({ agentId: z.string(), label: z.string(), state: z.string(), held: z.boolean() }).strict()),
  queues: z.array(z.object({ name: z.string(), paused: z.boolean(), tasks: z.array(z.object({ taskId: z.string(), state: z.string(), prompt: z.string() }).strict()) }).strict()),
  attention: z.array(z.object({ id: z.string(), agentId: z.string(), kind: z.enum(["permission", "question"]), prompt: z.string(), actionable: z.boolean(), freeform: z.boolean().optional(), options: z.array(z.object({ id: z.string(), label: z.string() }).strict()).optional() }).strict()),
  truncated: z.boolean(),
}).strict();
export type OperatorWebSettings = z.infer<typeof OperatorWebSettingsSchema>;
export type OperatorWebStatus = z.infer<typeof OperatorWebStatusSchema>;
export type OperatorWebSession = z.infer<typeof OperatorWebSessionSchema>;
export type OperatorWebSnapshot = z.infer<typeof OperatorWebSnapshotSchema>;
