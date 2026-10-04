// AGENT-GROUPS Phase 1: pure bucket+resolve math shared by both frontends (per this package's
// own doc comment convention, see jobGroups.ts — a UI-shape-specific pass, deciding row
// placement/box chrome/nesting, stays app-local; only "which agents are effectively in which
// group" belongs here).
import { hashTeam, TEAM_COLORS, type TeamColorId } from "./teamIcon.js";
import type { AgentView } from "./types.js";

/**
 * A row's effective group: its OWN `groups[0]` if set, else the nearest ANCESTOR's (walking
 * `parentId`), else undefined (ungrouped). An explicit [] stops inheritance after removal. This is what makes "a grouped agent moves with its
 * subtree" hold structurally — every descendant of a grouped node resolves to the SAME group
 * unless it (or something between it and the grouped ancestor) sets its own, so a single
 * contiguous-subtree box can be built downstream without re-deriving lineage per row.
 *
 * One group per agent for Phase 1's UI (`groups` is an array in the data for a deferred
 * Phase-2 multi-assign gesture — see protocol's AgentSpecSchema.groups comment — so only the
 * first entry is read here). Cycle-guarded like reducer.ts's treeOrder chain-walk: a malformed
 * parentId loop must degrade to "whatever was resolved before the cycle," never hang.
 */
export function effectiveGroupOf(agents: Record<string, AgentView>, agentId: string): string | undefined {
  const hops = new Set<string>();
  let cur: string | undefined = agentId;
  while (cur !== undefined && !hops.has(cur)) {
    hops.add(cur);
    const a: AgentView | undefined = agents[cur];
    if (!a) return undefined;
    if (a.groups !== undefined) return a.groups[0];
    cur = a.parentId ?? a.originConductorId ?? undefined;
  }
  return undefined;
}

/**
 * Buckets `agentIds` by their EFFECTIVE group (see effectiveGroupOf) — agents with no
 * resolvable group are simply absent from the result, mirroring bucketAgentsByJob's own
 * "callers keep those as ordinary ungrouped rows" contract. Insertion order within a bucket
 * follows `agentIds`' own order (callers pass an already tree/display-ordered list), NOT
 * re-sorted by recency — unlike a job bucket, a group's members are placed by an operator, not
 * spawn timing, so preserving the caller's order is what keeps a subtree contiguous.
 */
export function bucketAgentsByGroup(
  agents: Record<string, AgentView>,
  agentIds: ReadonlyArray<string>,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const id of agentIds) {
    const g = effectiveGroupOf(agents, id);
    if (!g) continue;
    const list = buckets.get(g);
    if (list) list.push(id);
    else buckets.set(g, [id]);
  }
  return buckets;
}

/** A group's rendered color: the operator's explicit pick if set, else deterministically
 * hashed from the group's own id (teamIcon.ts's hashTeam) — reusing the SAME hash/palette a
 * team badge uses, so a group is never colourless without persisting a redundant "was this
 * ever explicitly set" bit (mirrors AgentGroupSchema.color's own doc comment). */
export function groupColor(groupId: string, explicit: TeamColorId | undefined): TeamColorId {
  if (explicit) return explicit;
  return TEAM_COLORS[hashTeam(groupId) % TEAM_COLORS.length]!;
}
