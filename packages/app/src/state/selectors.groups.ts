import type { AgentGroup } from "@chimera/protocol";
import { effectiveGroupOf, groupColor, type AgentView } from "@chimera/ui-state";
import { ancestorIdsOf, derivedState, isTerminalState } from "./selectors";
import type { AgentListRow } from "./selectors.workflows";

/** Is `candidateId` legitimately part of the group-box run rooted at `rootId`? Lineage first
 * (same tree, or the root reachable through candidate's parentId/originConductorId chain), then
 * membership (it resolves to the same group anyway). Anything else is a stranger row. */
function isRunMember(agents: Record<string, AgentView>, rootId: string, candidateId: string, groupId: string): boolean {
  if (candidateId === rootId) return true;
  const cand = agents[candidateId];
  const root = agents[rootId];
  // An explicit move/removal wins over lineage: otherwise the contiguous subtree
  // sweep would immediately swallow a dragged-out child back into its old box.
  if (cand?.groups !== undefined) return effectiveGroupOf(agents, candidateId) === groupId;
  if (cand?.parentId && ancestorIdsOf(agents, candidateId).has(rootId)) {
    return effectiveGroupOf(agents, candidateId) === groupId;
  }
  if (cand && root && (cand.treeId ?? candidateId) === (root.treeId ?? rootId)) return true;
  if (ancestorIdsOf(agents, candidateId).has(rootId)) return true;
  return effectiveGroupOf(agents, candidateId) === groupId;
}

// Run after task/job grouping. Task rows retain their replaced agent as an anchor so
// a conductor's queue workers travel with its entire subtree into an operator group.
// Explicit group moves override inherited ownership, including a dragged-out child.
export function groupAgentListRowsByGroup(
  rows: ReadonlyArray<AgentListRow>,
  agents: Record<string, AgentView>,
  groupRegistry: ReadonlyArray<AgentGroup>,
): AgentListRow[] {
  // Defensive: never trust a caller-supplied registry is actually an array (a stub/mock
  // bridge or an older/malformed group.list response can hand back something else) — same
  // discipline as commands.groups.ts's own loadGroups guard.
  const registry = Array.isArray(groupRegistry) ? groupRegistry : [];
  const anchor = (row: AgentListRow): string | undefined => row.kind === "agent" ? row.agentId : row.kind === "task" ? row.anchorAgentId : undefined;
  type Run = { groupId: string; start: number; end: number };
  const runs: Run[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    const rootId = anchor(row);
    if (!rootId || !("depth" in row)) { i++; continue; }
    const groupId = effectiveGroupOf(agents, rootId);
    if (!groupId) { i++; continue; }
    const rootDepth = row.depth;
    let j = i + 1;
    // A non-"agent" row (task/jobGroup) breaks contiguity conservatively — those passes
    // haven't run yet at this point in the pipeline, so this never actually fires today, but
    // future pipeline reordering must not silently swallow an unrelated row into a box.
    //
    // AGENT-TREE: depth alone is NOT enough. A deeper following row is only this run's
    // descendant if it is actually related to the run root (same tree, lineage chain, or the
    // same effective group) — an indented row belonging to somebody else ENDS the run instead
    // of being counted into the box (the operator-reported "I-170 · 9/9" that swallowed another
    // conductor's queue workers). A grouped conductor's OWN owned workers still qualify, via
    // their originConductorId link.
    while (j < rows.length) {
      const next = rows[j]!;
      const nextId = anchor(next);
      if (!nextId || !("depth" in next) || next.depth <= rootDepth) break;
      if (!isRunMember(agents, rootId, nextId, groupId)) break;
      j++;
    }
    runs.push({ groupId, start: i, end: j });
    i = j;
  }
  if (runs.length === 0 && registry.length === 0) return rows.map((r) => ({ ...r }));

  const firstRunIndexOfGroup = new Map<string, number>();
  for (const r of runs) if (!firstRunIndexOfGroup.has(r.groupId)) firstRunIndexOfGroup.set(r.groupId, r.start);
  const indexStartsGroup = new Map<number, string>();
  for (const [groupId, idx] of firstRunIndexOfGroup) indexStartsGroup.set(idx, groupId);

  const consumed = new Set<number>();
  for (const r of runs) for (let k = r.start; k < r.end; k++) consumed.add(k);

  const memberRowsByGroup = new Map<string, AgentListRow[]>();
  for (const r of runs) {
    const rootDepth = (rows[r.start] as { depth: number }).depth;
    const rebased = rows.slice(r.start, r.end).map((row) =>
      "depth" in row ? { ...row, depth: row.depth - rootDepth } : { ...row },
    );
    const existing = memberRowsByGroup.get(r.groupId);
    if (existing) existing.push(...rebased);
    else memberRowsByGroup.set(r.groupId, rebased);
  }

  const registryById = new Map(registry.map((g) => [g.id, g]));
  const buildBoxRow = (groupId: string, memberRows: AgentListRow[]): AgentListRow => {
    const reg = registryById.get(groupId);
    const memberIds = memberRows.flatMap(r => { const id = anchor(r); return id ? [id] : []; });
    const liveCount = memberIds.filter((id) => { const a = agents[id]; return a && !isTerminalState(derivedState(a)); }).length;
    return {
      kind: "group",
      groupId,
      name: reg?.name ?? groupId,
      color: groupColor(groupId, reg?.color),
      liveCount,
      totalCount: memberIds.length,
      memberRows,
    };
  };

  const out: AgentListRow[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const startsGroup = indexStartsGroup.get(idx);
    if (startsGroup !== undefined) {
      out.push(buildBoxRow(startsGroup, memberRowsByGroup.get(startsGroup)!));
      continue;
    }
    if (consumed.has(idx)) continue; // a later run of an already-boxed group — absorbed above
    out.push({ ...rows[idx]! });
  }
  // EMPTY-GROUPS-PERSIST: a registry group with zero currently-produced rows (every member
  // done+hidden by showDone, or genuinely no members yet) still renders — "sprint"/"daily" are
  // recurring containers an operator expects to still exist next week. Appended in registry
  // order, after every non-empty box.
  for (const g of registry) {
    if (memberRowsByGroup.has(g.id)) continue;
    out.push(buildBoxRow(g.id, []));
  }
  let detachedDepth: number | null = null;
  return out.map(row => {
    if (row.kind !== "agent") { detachedDepth = null; return row; }
    if (detachedDepth !== null && row.depth <= detachedDepth) detachedDepth = null;
    if (agents[row.agentId]?.groups?.length === 0) detachedDepth = row.depth;
    return detachedDepth === null ? row : { ...row, depth: row.depth - detachedDepth };
  });
}
