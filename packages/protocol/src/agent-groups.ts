import { z } from "zod";

// ---------- agent groups (operator-defined wrapper boxes) ----------
// AGENT-GROUPS Phase 1: an ad-hoc, operator-named container ("sprint", "daily") an agent can
// be placed into — purely a UI/list-placement concept (core/src/groups.ts's GroupStore never
// touches spawn/scheduling). Reuses ui-state/teamIcon.ts's existing 8 semantic colour ids
// verbatim rather than inventing a second palette; protocol can't import ui-state, so the set
// is mirrored here as a literal tuple — ui-state carries a typetest asserting the two stay in
// lockstep (TeamColorId is the source of truth; this list must never drift from it).
export const AGENT_GROUP_COLORS = ["blue", "green", "amber", "purple", "cyan", "magenta", "red", "teal"] as const;
export const AgentGroupColorSchema = z.enum(AGENT_GROUP_COLORS);
export type AgentGroupColor = z.infer<typeof AgentGroupColorSchema>;

// Slug id (what AgentSpec.groups / AgentRecord actually carry) — distinct from the operator-
// facing `name`, which may carry spaces/case. Lowercase alnum/dash/underscore, 1-32 chars,
// must start alnum.
export const AgentGroupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export type AgentGroupId = z.infer<typeof AgentGroupIdSchema>;

export const AgentGroupSchema = z.object({
  id: AgentGroupIdSchema,
  name: z.string().trim().min(1).max(48),
  // Operator-pickable; absent ⇒ the client defaults to hashTeam(id)'s pick (ui-state/
  // teamIcon.ts) so a group is never colourless without persisting a redundant "was this
  // ever explicitly set" bit.
  color: AgentGroupColorSchema.optional(),
  createdAt: z.number(),
  order: z.number(),
}).strict();
export type AgentGroup = z.infer<typeof AgentGroupSchema>;

export const GroupCreateParamsSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: AgentGroupColorSchema.optional(),
}).strict();
export type GroupCreateParams = z.infer<typeof GroupCreateParamsSchema>;

export const GroupUpdateParamsSchema = z.object({
  id: AgentGroupIdSchema,
  name: z.string().trim().min(1).max(48).optional(),
  color: AgentGroupColorSchema.optional(),
}).strict();
export type GroupUpdateParams = z.infer<typeof GroupUpdateParamsSchema>;

export const GroupDeleteParamsSchema = z.object({
  id: AgentGroupIdSchema,
}).strict();
export type GroupDeleteParams = z.infer<typeof GroupDeleteParamsSchema>;

export const GroupListResultSchema = z.object({
  groups: z.array(AgentGroupSchema),
}).strict();
export type GroupListResult = z.infer<typeof GroupListResultSchema>;

// A missing registry entry retains membership and the app’s raw-ID box fallback until
// explicitly cleared/reassigned — the daemon accepts any well-formed id so a delete
// race (list fetched, then the group deleted, then this call lands) never fails a caller that
// did nothing wrong.
export const AgentSetGroupsParamsSchema = z.object({
  agentId: z.string().min(1),
  groups: z.array(AgentGroupIdSchema).max(8),
}).strict();
export type AgentSetGroupsParams = z.infer<typeof AgentSetGroupsParamsSchema>;

// Incremental membership requests use the same validated IDs and bound as replacement.
export const AgentChangeGroupsParamsSchema = AgentSetGroupsParamsSchema;
export type AgentChangeGroupsParams = z.infer<typeof AgentChangeGroupsParamsSchema>;
