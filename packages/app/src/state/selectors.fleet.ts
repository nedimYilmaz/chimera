import type { AgentView, UiState } from "@chimera/ui-state";
import { derivedState, isTerminalState, remoteEngine } from "./selectors";

export type FleetGroupBy = "project" | "team" | "workflow" | "tree" | "engine";

export type FleetRow = {
  agentId: string;
  agent: AgentView;
  state: string;
  group: Record<FleetGroupBy, string>;
  tokens: number;
  costUsd: number;
  stalled: boolean;
  attention: boolean;
  queue: string | null;
};

export type FleetGroup = {
  key: string;
  rows: FleetRow[];
  running: number;
  busy: number;
  stalled: number;
  costUsd: number;
  tokens: number;
  utilization: number;
};

const TERMINAL = new Set(["done", "failed", "killed", "interrupted"]);

function taskFor(state: UiState, id: string): Record<string, unknown> | undefined {
  return Object.values(state.tasks).find((t) => t.agentId === id) as unknown as Record<string, unknown> | undefined;
}

export function fleetRows(state: UiState, now: number, stallMs = 60_000): FleetRow[] {
  return state.agentOrder.flatMap((agentId) => {
    const agent = state.agents[agentId];
    if (!agent || agent.shadow) return [];
    const task = taskFor(state, agentId);
    const workflow = typeof task?.["workflow"] === "string" ? task["workflow"] as string : "unbound";
    const queue = typeof task?.["queue"] === "string" ? task["queue"] as string : null;
    const stateWord = derivedState(agent);
    const stalled = !TERMINAL.has(agent.state) && agent.state === "running" && agent.busy && agent.lastEventTs > 0 && now - agent.lastEventTs >= stallMs;
    return [{
      agentId,
      agent,
      state: stateWord,
      group: {
        project: agent.projectId ?? "unassigned",
        team: agent.membership?.team ?? "unassigned",
        workflow,
        tree: agent.treeId ?? agent.agentId,
        engine: remoteEngine(agent.agentId) ?? agent.provider ?? "local",
      },
      tokens: agent.usage ? agent.usage.input + agent.usage.output : 0,
      costUsd: agent.costUsd,
      stalled,
      attention: stalled || !!agent.pendingQuestion || !!agent.pendingDialog || agent.state === "paused" || agent.state === "failed" || !!agent.promptStall,
      queue,
    }];
  });
}

export function groupFleetRows(rows: readonly FleetRow[], by: FleetGroupBy): FleetGroup[] {
  const map = new Map<string, FleetRow[]>();
  for (const row of rows) {
    const key = row.group[by];
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, grouped]) => {
    const running = grouped.filter((r) => r.agent.state === "running").length;
    const busy = grouped.filter((r) => r.agent.state === "running" && r.agent.busy).length;
    return {
      key,
      rows: grouped,
      running,
      busy,
      stalled: grouped.filter((r) => r.stalled).length,
      costUsd: grouped.reduce((n, r) => n + r.costUsd, 0),
      tokens: grouped.reduce((n, r) => n + r.tokens, 0),
      utilization: running === 0 ? 0 : busy / running,
    };
  });
}

export function queuePressure(state: UiState): Array<{ queue: string; pending: number; blocked: number; inProgress: number }> {
  const counts = new Map<string, { queue: string; pending: number; blocked: number; inProgress: number }>();
  for (const task of Object.values(state.tasks)) {
    const row = counts.get(task.queue) ?? { queue: task.queue, pending: 0, blocked: 0, inProgress: 0 };
    if (task.state === "pending") row.pending++;
    else if (task.state === "blocked") row.blocked++;
    else if (task.state === "in_progress") row.inProgress++;
    counts.set(task.queue, row);
  }
  return [...counts.values()].sort((a, b) => (b.pending + b.blocked) - (a.pending + a.blocked));
}

export type FleetSummary = {
  total: number;
  byState: Record<string, number>;
  activeCount: number;
  doneCount: number;
  running: number;
  busy: number;
  utilization: number;
  stalled: number;
  costUsd: number;
  costByProvider: Array<{ key: string; costUsd: number }>;
  topQueues: Array<{ queue: string; pending: number; blocked: number; inProgress: number }>;
  byTeam: Array<{ key: string; count: number; costUsd: number }>;
  byProject: Array<{ key: string; count: number; costUsd: number }>;
};

function accumulateByKey(rows: readonly FleetRow[], keyOf: (r: FleetRow) => string): Array<{ key: string; count: number; costUsd: number }> {
  const map = new Map<string, { key: string; count: number; costUsd: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? { key, count: 0, costUsd: 0 };
    entry.count++;
    entry.costUsd += row.costUsd;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);
}

/** Fleet-wide health, independent of the toolbar's active `groupBy` — feeds
 * the dashboard's right-side summary pane (fills the space a flat single-
 * column list leaves empty, and answers "what am I looking at" at a glance). */
export function fleetSummary(rows: readonly FleetRow[], state: UiState, topQueueLimit = 5): FleetSummary {
  const byState: Record<string, number> = {};
  let activeCount = 0;
  let doneCount = 0;
  let running = 0;
  let busy = 0;
  let stalled = 0;
  let costUsd = 0;
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (isTerminalState(row.state)) doneCount++;
    else activeCount++;
    if (row.agent.state === "running") running++;
    if (row.agent.state === "running" && row.agent.busy) busy++;
    if (row.stalled) stalled++;
    costUsd += row.costUsd;
  }
  const costByProvider = accumulateByKey(rows, (r) => r.group.engine).sort((a, b) => b.costUsd - a.costUsd);
  const byTeam = accumulateByKey(rows, (r) => r.group.team);
  const byProject = accumulateByKey(rows, (r) => r.group.project);
  return {
    total: rows.length,
    byState,
    activeCount,
    doneCount,
    running,
    busy,
    utilization: running === 0 ? 0 : busy / running,
    stalled,
    costUsd,
    costByProvider,
    topQueues: queuePressure(state).slice(0, topQueueLimit),
    byTeam,
    byProject,
  };
}

export function defaultLiveboardIds(rows: readonly FleetRow[], selectedId: string | null, max = 4): string[] {
  const ranked = [...rows].sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.agent.busy) - Number(a.agent.busy) || b.agent.lastEventTs - a.agent.lastEventTs);
  return [...new Set([...(selectedId ? [selectedId] : []), ...ranked.map((r) => r.agentId)])].slice(0, max);
}
