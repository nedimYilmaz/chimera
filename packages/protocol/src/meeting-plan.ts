import { z } from "zod";

export const MeetingPlanInputSchema = z.object({
  topic: z.string().min(1).max(8192),
  stage: z.enum(["initial", "followup"]),
  candidates: z.array(z.string().min(1).max(200)).min(1).max(12),
  spoken: z.array(z.string().min(1).max(200)).max(8),
  history: z.array(z.object({ speaker: z.string().max(200), text: z.string().max(2000) }).strict()).max(24),
}).strict();
export const MeetingPlanSchema = z.object({
  action: z.enum(["speak", "wait"]), agentId: z.string().max(200).nullable(),
  discussion: z.boolean(), topic: z.string().min(1).max(8192),
  contribution: z.string().max(500), reason: z.string().max(300),
}).strict().refine(p => p.action === "wait" ? p.agentId === null : !!p.agentId, "Speaker required only for speak action");
export type MeetingPlanInput = z.infer<typeof MeetingPlanInputSchema>;
export type MeetingPlan = z.infer<typeof MeetingPlanSchema>;
