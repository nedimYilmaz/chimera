// F20 (W22 · coverage §B24/§C18) — PURE selectors/formatters for D16's
// checkpoint.* surfaces (the strip + the checkpoints card), same discipline as
// selectors.artifacts/usage: plain functions over already-typed protocol
// records, no React/DOM, fully unit-testable.
import type { CheckpointRecord, CheckpointTrigger, NormalizedEvent } from "@chimera/protocol";

export type CheckpointRow = { id: string; ref: string; trigger: CheckpointTrigger; ts: number; message: string };

export function checkpointRow(rec: CheckpointRecord): CheckpointRow {
  return { id: rec.id, ref: rec.ref, trigger: rec.trigger, ts: rec.ts, message: rec.message };
}

/** Display id, mock style ("cp-3") — CheckpointRecord.id itself is the bare
 * ref sequence number ("3"), never prefixed on the wire. */
export function checkpointLabel(id: string): string {
  return `cp-${id}`;
}

/** The trigger label the strip/card rows show (mock lines 443-445): manual
 * carries its own chord hint, destructive_bash surfaces the guarded command
 * from the commit message (engine.ts's checkpointCreate closure stamps it
 * verbatim into `message`), task_start is a bare label. Falls back gracefully
 * if the message doesn't carry a quoted command (a custom `message` was
 * passed some other way). */
export function triggerLabel(row: Pick<CheckpointRow, "trigger" | "message">): string {
  if (row.trigger === "manual") return "manual (mod+k)";
  if (row.trigger === "task_start") return "task start";
  const m = /"([^"]*)"/.exec(row.message);
  return m ? `before Bash: ${m[1]}` : "before a destructive command";
}

/** The newest seq among checkpoint_created/_reverted — the strip/card's
 * re-fetch trigger (F20: "driven by checkpoint_created/reverted events"),
 * mirroring latestArtifactSeq/latestSessionSeq's "no polling timers" rule. */
export function latestCheckpointSeq(events: ReadonlyArray<Pick<NormalizedEvent, "seq" | "kind">>): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === "checkpoint_created" || k === "checkpoint_reverted") return events[i]!.seq;
  }
  return 0;
}

/** P3-T4 (PLAN-PROJECT-CONDUCTOR-ROUTING.md): the effective cwd the checkpoint
 * view should read for a selected agent. Checkpoints are ALREADY per-repo
 * (git-plumbing refs), so a project's checkpoint history is keyed off the
 * PROJECT ROOT, not the agent's raw spec.cwd — the two diverge for a worktree
 * agent (`spec.cwd` sits under `.chimera/worktrees/...`, not the repo root the
 * checkpoint refs and their files-since diff are meaningful against) and for
 * the home-dir main session (non-git, would otherwise force `supported:false`
 * even when the agent's project IS a real repo). `projectId` (P3-T2, an
 * AgentRecord.projectId — the ProjectSpec's `name`) wins when it resolves
 * against the given project list; any other case (no projectId, or an unknown
 * one — a stale/renamed project) falls back to the raw `cwd`, preserving
 * today's pre-P3-T4 behavior for non-project agents and older daemons. */
export function resolveCheckpointCwd(
  rec: { projectId?: string | null; cwd: string | null },
  projects: ReadonlyArray<{ name: string; path: string }>,
): string | null {
  if (rec.projectId) {
    const project = projects.find((p) => p.name === rec.projectId);
    if (project) return project.path;
  }
  return rec.cwd;
}
