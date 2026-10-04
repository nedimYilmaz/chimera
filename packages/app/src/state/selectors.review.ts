import type { EvidenceFilePatch, TaskEvidence } from "@chimera/protocol";

export type ReviewFileRow = EvidenceFilePatch & { branch: string; agentIds: string[]; mergeCommitSha: string | null };

export function reviewFiles(evidence: TaskEvidence | null): ReviewFileRow[] {
  if (!evidence) return [];
  return evidence.provenance.flatMap((entry) => {
    const diff = entry.diff;
    return diff.available ? diff.patches.map((patch) => ({ ...patch, branch: entry.branch, agentIds: entry.agentIds, mergeCommitSha: diff.mergeCommitSha })) : [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

// REVIEW-ROOM-UNBOUND-TASKS: when no patch renders (a plain task that landed direct-on-main, an
// abandoned task, no git evidence captured, etc.), the room must say WHY per branch rather than a
// bare "no patch available". One row per provenance entry whose diff is unavailable, carrying the
// daemon's human-readable reason verbatim.
export type ReviewUnavailableRow = { branch: string; agentIds: string[]; reason: string };

export function reviewUnavailable(evidence: TaskEvidence | null): ReviewUnavailableRow[] {
  if (!evidence) return [];
  return evidence.provenance.flatMap((entry) =>
    entry.diff.available ? [] : [{ branch: entry.branch, agentIds: entry.agentIds, reason: entry.diff.reason }]);
}

// A task still being worked (no landed merge, possibly no worktree yet) is "live" — the room
// should badge it and poll it, and render an empty/unavailable diff as a soft "no changes yet"
// rather than the hard "no patch available"/"no patch to review" wording reserved for a task
// that's actually done and genuinely has nothing to show.
export function reviewIsLive(evidence: TaskEvidence | null): boolean {
  return evidence?.state === "in_progress";
}

export function nextReviewHunk(files: readonly ReviewFileRow[], current: string | null, delta: number): { path: string; hunkId: string } | null {
  const all = files.flatMap((file) => file.hunks.map((hunk) => ({ path: file.path, hunkId: hunk.id })));
  if (!all.length) return null;
  const at = Math.max(0, all.findIndex((h) => h.hunkId === current));
  return all[(at + delta + all.length) % all.length] ?? null;
}
