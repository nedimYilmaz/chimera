import { z } from "zod";

const metric = z.number().finite().nonnegative().nullable();
export const AgentResourceSampleSchema = z.object({
  agentId: z.string().min(1), sampledAt: z.number().finite().nonnegative(),
  state: z.enum(["ok", "unavailable", "stale"]),
  reason: z.enum(["platform", "no_process", "permission", "sampling", "identity"]).optional(),
  rootPid: z.number().int().positive().nullable(),
  procs: z.array(z.object({
    pid: z.number().int().positive(), ppid: z.number().int().nonnegative(),
    name: z.string().max(128), role: z.enum(["agent", "tool", "terminal", "other"]),
    cpuPct: metric, rssBytes: metric, elapsedSec: metric,
  }).strict()).max(2000),
  totals: z.object({ cpuPct: metric, rssBytes: metric, procCount: z.number().int().min(0).max(2000) }).strict(),
  truncated: z.boolean(),
}).strict();
export const HostAdmissionSchema = z.object({
  cap: z.number().int().nonnegative(), ceiling: z.number().int().nonnegative(), healthy: z.boolean(),
  cpuPressure: z.boolean(), memPressure: z.boolean(), load1: metric, cores: metric, freeMemGb: metric,
  explain: z.string(), running: z.number().int().nonnegative(),
}).strict();
export const AgentResourcesRequestSchema = z.object({ agentId: z.string().min(1), callerAgentId: z.string().min(1).optional() }).strict();
export const AgentResourcesResponseSchema = z.object({ sample: AgentResourceSampleSchema, admission: HostAdmissionSchema }).strict();
export type AgentResourceSample = z.infer<typeof AgentResourceSampleSchema>;
export type HostAdmission = z.infer<typeof HostAdmissionSchema>;
export type AgentResourcesResponse = z.infer<typeof AgentResourcesResponseSchema>;
