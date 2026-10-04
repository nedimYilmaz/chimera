// F22.UI — the ONE place the single-writer worktree lease is turned into operator wording.
// Both surfaces (app TranscriptHeader/AgentDetailPanel, TUI AgentDetail) render from these
// helpers so a lease can never be described differently on the two screens — same rule as
// pause.ts / failure.ts / promptStall.ts.
import type { AgentView } from "./types.js";

/** The lease's key is the worktree directory name — core's worktreePath() builds
 * `<cwd>/.chimera/worktrees/<workdirKey ?? agentId>`, so the basename IS the key the
 * worktree_lease_handoff / _release RPCs take. Null for a non-worktree agent (cwd isolation),
 * which is exactly when there is no lease to talk about. */
export function worktreeKeyFromWorkdir(workdir: string | null | undefined): string | null {
  if (!workdir) return null;
  const marker = "/.chimera/worktrees/";
  const i = workdir.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = workdir.slice(i + marker.length).replace(/\/+$/, "");
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** Observed enforcement mode, never a configured one: `cfg.worktreeLease` is not projected to
 * either UI, and mode "off" emits no events at all, so it is unobservable. Absent ⇒ "no lease
 * decision seen yet", which the chip renders as a plain held chip with no mode suffix. */
export function worktreeLeaseModeLabel(agent: Pick<AgentView, "worktreeLeaseMode">): string | null {
  if (agent.worktreeLeaseMode === "enforce") return "enforce";
  if (agent.worktreeLeaseMode === "warn") return "warn";
  return null;
}

export type WorktreeLeaseChip = {
  /** held = this agent owns the lease; denied/contended = a refusal/contention already happened. */
  kind: "held" | "denied" | "contended";
  label: string;
  /** Long-form hover/detail text — the same sentence on both surfaces. */
  title: string;
};

export function worktreeLeaseChips(
  agent: Pick<AgentView, "worktreeLeaseHeld" | "worktreeLeaseDenied" | "lastWorktreeLeaseDenial" | "worktreeLeaseContended" | "worktreeLeaseMode" | "workdir">,
): WorktreeLeaseChip[] {
  const chips: WorktreeLeaseChip[] = [];
  const key = worktreeKeyFromWorkdir(agent.workdir);
  const mode = worktreeLeaseModeLabel(agent);
  if (agent.worktreeLeaseHeld === true) {
    chips.push({
      kind: "held",
      label: `⌂ sole writer${key ? ` ${key}` : ""}${mode ? ` · ${mode}` : ""}`,
      title:
        `This agent holds the single-writer lease on its worktree${key ? ` (key ${key})` : ""}` +
        `. Other agents' writes to it are ${mode === "warn" ? "allowed but warned about" : mode === "enforce" ? "refused" : "governed by the daemon's lease mode"}` +
        `.${mode ? ` Mode observed from this agent's own lease decisions: ${mode}.` : " No lease decision observed yet, so the mode is unknown."}`,
    });
  }
  const d = agent.lastWorktreeLeaseDenial;
  if (agent.worktreeLeaseDenied === true) {
    const owner = d?.owner ? d.owner.slice(0, 8) : "another agent";
    chips.push({
      kind: "denied",
      label: `⚠ worktree owned by ${owner}`,
      title:
        `A write from this agent was refused: the worktree${d?.workdirKey ? ` (key ${d.workdirKey})` : ""} is leased by ${d?.owner ?? "another agent"}` +
        `${d?.ownerState === "retained" ? ", whose session has ended but still retains the lease" : ""}` +
        `${d?.tool ? `. Refused tool: ${d.tool}` : ""}${d?.target ? ` → ${d.target}` : ""}` +
        `. Take it over with worktree_lease_handoff, or free it with worktree_lease_release.`,
    });
  }
  if (agent.worktreeLeaseContended) {
    chips.push({
      kind: "contended",
      label: "⚠ lease contended",
      title: `Starting this agent could not take the worktree lease: ${agent.worktreeLeaseContended.message}`,
    });
  }
  return chips;
}
