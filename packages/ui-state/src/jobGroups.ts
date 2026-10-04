// JOB-FLEET-GROUPING: pure bucket+sort shared by both frontends (a UI-shape-specific
// grouping pass — deciding row placement, group-box chrome, lazy-load window — stays
// app/tui-local; only the "which agents belong to which job, newest spawn first" math
// belongs here, per this package's own doc comment: state logic BOTH UIs share).
import type { AgentView } from "./types.js";

/**
 * Buckets `agentIds` by their AgentView.jobName (agents with no jobName are simply
 * absent from the result — callers keep those as ordinary ungrouped rows), each bucket
 * sorted newest-spawn-first. Falls back to lastEventTs when createdAt hasn't landed yet
 * (an older daemon, or an app client mid-connect before the first event for that agent) —
 * an imprecise but reasonable proxy, since lastEventTs is seeded from the agent's own
 * first event in that case too.
 */
export function bucketAgentsByJob(
  agents: Record<string, AgentView>,
  agentIds: ReadonlyArray<string>,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const id of agentIds) {
    const job = agents[id]?.jobName;
    if (!job) continue;
    const list = buckets.get(job);
    if (list) list.push(id);
    else buckets.set(job, [id]);
  }
  const recency = (id: string): number => agents[id]?.createdAt ?? agents[id]?.lastEventTs ?? 0;
  for (const list of buckets.values()) list.sort((a, b) => recency(b) - recency(a));
  return buckets;
}
