// SHADOW-WORKFLOW-VISIBILITY: PURE fold helpers for the cockpit's workflow shadow inspector.
//
// A WORKFLOW shadow has no transcript of its own — its inner agents run as separate harness-side
// processes whose activity lives only on disk. `shadow.workflowInspect` parses that on demand; the
// polling hook lives in ./useWorkflowInspect (it imports the Tauri bridge). This module is kept
// bridge-free and React-free so the fold stays unit-testable in a plain node environment.

import type { WorkflowInnerAgent } from "@chimera/protocol/contract";

export type InnerRow = WorkflowInnerAgent & { relTime: string | null };

// Running agents float to the top (they're what's live), done agents follow — each subgroup keeps
// the daemon's newest-activity-first order (stable partition). Adds a coarse relative time.
export function foldInnerAgents(agents: readonly WorkflowInnerAgent[], nowMs: number): InnerRow[] {
  const withRel = (a: WorkflowInnerAgent): InnerRow => ({ ...a, relTime: relTimeOf(a.lastActivityTs, nowMs) });
  const running = agents.filter((a) => a.state === "running").map(withRel);
  const done = agents.filter((a) => a.state !== "running").map(withRel);
  return [...running, ...done];
}

export function relTimeOf(ts: number | null, nowMs: number): string | null {
  if (ts === null) return null;
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
