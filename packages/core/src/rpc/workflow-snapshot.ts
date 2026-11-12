import type { ShadowWorkflowInspectResponse, WorkflowInnerAgent } from "@chimera/protocol/contract";
import { readBoundedTail } from "./shadow-transcript.js";

const str = (v: unknown): string | null => typeof v === "string" ? v.slice(0, 4000) : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

// Claude persists the CLI's Phases panel beside (not inside) the transcript directory.
// Read data only: this file also contains the workflow script, which must never execute.
export async function readWorkflowSnapshot(path: string) {
  const file = await readBoundedTail(path, 4 * 1024 * 1024);
  if (file.truncated) return null;
  return parseWorkflowSnapshot(JSON.parse(file.text));
}

export function parseWorkflowSnapshot(o: any) {
  if (!o || typeof o !== "object" || typeof o.runId !== "string" || typeof o.taskId !== "string") return null;
  const phases = new Map<number, { index: number; title: string; detail: string | null }>();
  if (Array.isArray(o.phases)) o.phases.slice(0, 200).forEach((p: any, i: number) => {
    if (str(p?.title)) phases.set(i + 1, { index: i + 1, title: str(p.title)!, detail: str(p.detail) });
  });
  const agents: WorkflowInnerAgent[] = [];
  if (Array.isArray(o.workflowProgress)) for (const p of o.workflowProgress.slice(0, 2000)) {
    if (p?.type === "workflow_phase" && num(p.index) !== null && str(p.title)) {
      phases.set(p.index, { index: p.index, title: str(p.title)!, detail: phases.get(p.index)?.detail ?? null });
    }
    if (p?.type !== "workflow_agent") continue;
    // Queued entries can precede the agent id. Keep their index stable and disable
    // transcript access until the real file appears in the roster.
    const id = str(p.agentId) ?? (num(p.index) !== null ? `pending-${p.index}` : null);
    if (!id || !/^[\w-]+$/.test(id)) continue;
    let state = p.state === "queued" || p.state === "start" && p.queuedAt !== undefined && p.startedAt === undefined ? "pending"
      : p.state === "progress" || p.state === "start" ? "running" : p.state === "error" ? "failed"
      : ["pending", "running", "done", "failed", "killed", "paused"].includes(p.state) ? p.state : "unknown";
    if (state === "running" || state === "pending") {
      if (["failed", "killed", "paused"].includes(o.status)) state = o.status;
      else if (o.status === "completed" || o.status === "done") state = "unknown";
    }
    const a: WorkflowInnerAgent = {
      agentId: id, agentType: null, label: str(p.label) ?? str(p.promptPreview), phase: str(p.phaseTitle),
      state, resultPreview: str(p.resultPreview), lastActivityTs: num(p.lastProgressAt) ?? num(p.startedAt) ?? num(p.queuedAt),
      spawnDepth: null, model: str(p.model),
    };
    for (const key of ["phaseIndex", "tokens", "toolCalls", "durationMs"] as const) {
      const value = num(p[key]); if (value !== null) a[key] = value;
    }
    for (const key of ["lastToolName", "lastToolSummary"] as const) {
      const value = str(p[key]); if (value !== null) a[key] = value;
    }
    agents.push(a);
  }
  const workflow: NonNullable<ShadowWorkflowInspectResponse["workflow"]> = {
    name: str(o.workflowName), status: str(o.status), durationMs: num(o.durationMs),
    totalTokens: num(o.totalTokens), totalToolCalls: num(o.totalToolCalls),
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
  };
  return { taskId: o.taskId as string, runId: o.runId as string, agents, workflow,
    narratorLines: Array.isArray(o.logs) ? o.logs.slice(-100).flatMap((l: unknown) => str(l) ? [str(l)!] : []) : [] };
}
