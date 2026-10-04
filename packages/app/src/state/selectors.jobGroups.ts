import type { AgentView } from "@chimera/ui-state";
import { bucketAgentsByJob } from "@chimera/ui-state";
import type { AgentListRow } from "./selectors.workflows";

// JOB-FLEET-GROUPING: a scheduled job (`slack-watch` etc.) firing every few minutes used to
// leave every one of its spawns as its own flat top-level row — 14+ consecutive rows from one
// job crowding out every other agent/conductor in the list, with nothing beyond a visual clamp
// once it hit hundreds/day. Reshapes groupAgentListRowsByTask's own output the SAME way that
// pass reshapes buildAgentRows': every job with >=2 currently-visible runs collapses into ONE
// "jobGroup" row, moved to the END of the list. A job with exactly one currently-visible run
// passes through UNCHANGED as an ordinary agent row (explicit acceptance criterion — a 1-member
// group is pointless chrome, not a fix). The two grouping passes never fight over the same row:
// jobs.ts's agent-target spawn path (the only one that stamps AgentRecord.jobName) never touches
// the queue/task system, so a job-spawned agent never carries a workflow task binding.
export function groupAgentListRowsByJob(
  rows: ReadonlyArray<AgentListRow>,
  agents: Record<string, AgentView>,
): AgentListRow[] {
  const candidateIds: string[] = [];
  for (const r of rows) if (r.kind === "agent") candidateIds.push(r.agentId);
  const buckets = bucketAgentsByJob(agents, candidateIds);

  const memberOf = new Map<string, string>();
  for (const [jobName, ids] of buckets) {
    if (ids.length < 2) continue; // 0/1-member "group" stays an ordinary row — no pointless chrome
    for (const id of ids) memberOf.set(id, jobName);
  }
  if (memberOf.size === 0) return rows.map((r) => ({ ...r }));

  const emitted = new Set<string>();
  const out: AgentListRow[] = [];
  const groupRows: AgentListRow[] = [];
  for (const r of rows) {
    const jobName = r.kind === "agent" ? memberOf.get(r.agentId) : undefined;
    if (!jobName) {
      out.push({ ...r });
      continue;
    }
    if (emitted.has(jobName)) continue; // member rows are dropped outright; the group row carries them all
    emitted.add(jobName);
    groupRows.push({ kind: "jobGroup", jobName, memberIds: buckets.get(jobName)! });
  }
  return [...out, ...groupRows];
}
