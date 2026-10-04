import { execFile } from "node:child_process";
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EvidenceDiff, EvidenceFileChange, EvidenceFilePatch, EvidenceDiffLine, EvidenceProvenanceEntry, EvidenceStep, TaskEvidence,
  TaskRecord, TaskStepCheckpoint, WorkflowRecord,
} from "@chimera/protocol";
import type { QueueStore } from "./queues.js";
import type { WorkflowStore } from "./workflows.js";
import type { ArtifactStore } from "./artifacts.js";
import { branchNameFor } from "./workdir.js";

// FEATURE-10 (Changes & Evidence Review): a READ-ONLY aggregator over data that already
// exists elsewhere — TaskRecord.stepHistory, ArtifactStore, and git itself. Never mutates
// anything (no writes to queues/workflows/artifacts, no git commands beyond read-only
// diff/log/status/rev-parse/merge-base).
//
// PROVENANCE/DIFF: there is no persisted branch/merge-commit field anywhere in this codebase
// (see PLAN.md's "what's missing" section) — ensureWorkdir's {branch,baseSha,mainRepo}
// (workdir.ts) only ever feeds an agent's own prompt text. So this resolves provenance from
// the SAME deterministic convention the scheduler/workdir already use to construct it:
//   worktreeKey = `task-${taskId}` when the task's pinned workflow has step roles or a critic
//     gate (Scheduler.sharedWorkdirKey/hasStepRoles/hasCriticGate, scheduler.ts:449-457),
//     else each distinct stepHistory agentId (workdir.ts:25-26).
//   branch = branchNameFor(worktreeKey) (workdir.ts, imported directly so this never drifts
//     out of sync with ensureWorkdir's own derivation).
// A LIVE worktree (`.chimera/worktrees/<key>` still exists) means the task hasn't landed yet —
// diff against merge-base(branch, mainRepo HEAD). Once landed, the worktree AND branch are both
// removed by the agent's own land-on-main steps; the landed diff is then recovered by finding the
// merge commit whose SECOND parent is this branch's tip — message-agnostic (workers write
// arbitrary merge messages), anchored on the task's captured fork point (base). See findLandedMerge.
// LIVE DIFF (watch it work): a live worktree's diff is base vs its CURRENT on-disk state —
// committed history since base PLUS whatever's uncommitted (staged/unstaged/untracked) right
// now — not just base..HEAD. See workingTreeDiff. This is skipped only when a LATER task has
// since reused the same worktree/branch (scope.boundedHead set): the current on-disk state then
// belongs to that later task, so this task's diff stays pinned to its own committed range.
// REVIEW-ROOM-UNBOUND-TASKS: mainRepo/base come from the task's own durable checkpoint (captured at
// bind, scheduler.ts), NOT a live agent record — evidence is opened long after the agent is gone.
// Nothing derivable (isolation:"none" direct-on-main, task abandoned, no checkpoint) ⇒
// `diff.available:false` with a human-readable reason naming WHY — NEVER an error; this is always a
// best-effort surface.
//
// FEATURE-10 fix: the merge-base/latest-merge-commit heuristics above assume a key's
// worktree/branch belongs to exactly ONE task. That's false for a persistent pool worker: it
// reuses the SAME agentId-keyed worktree/branch across every (non-workflow-bound) task it's
// ever handed, so an earlier task's "live" diff would otherwise silently swallow a later
// task's commits too (and a branch merged more than once would misattribute the LATEST merge
// to every task sharing it). `taskDiffScope` uses scheduler.ts's per-task checkpoint capture
// (now unconditional, not just workflow-bound — see captureStepCheckpoint) to anchor this
// task's own start commit and, when a later task has since reused the same key, bound the
// diff to stop before that task's work. A task with no checkpoint of its own on a key another
// task's checkpoint proves IS shared ⇒ `available:false` rather than a guess (never silently
// wrong — matches this module's existing best-effort contract).

export type GitExecFn = (args: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<{ stdout: string; code: number; stderr: string }>;

const realGitExec: GitExecFn = (args, opts) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? 1 : 0 }));
  });

// git diff --stat text is capped the same way a gate failure `reason` is (scheduler.ts's
// 2000-char truncation) — this is a review surface, not a full-patch viewer (see PLAN.md
// follow-ups).
const STAT_MAX_CHARS = 4000;
const FILES_MAX = 500;

export class EvidenceStore {
  private queues: QueueStore;
  private workflows: WorkflowStore;
  private artifacts: ArtifactStore;
  private resolveAgentCwd: (agentId: string) => string | null;
  private git: GitExecFn;

  constructor(deps: {
    queues: QueueStore;
    workflows: WorkflowStore;
    artifacts: ArtifactStore;
    resolveAgentCwd: (agentId: string) => string | null;
    git?: GitExecFn;
  }) {
    this.queues = deps.queues;
    this.workflows = deps.workflows;
    this.artifacts = deps.artifacts;
    this.resolveAgentCwd = deps.resolveAgentCwd;
    this.git = deps.git ?? realGitExec;
  }

  private async run(cwd: string, args: string[], env?: Record<string, string>): Promise<{ stdout: string; code: number }> {
    const { stdout, code } = await this.git(args, { cwd, env });
    return { stdout: stdout.trim(), code };
  }

  async getTaskEvidence(taskId: string): Promise<TaskEvidence> {
    const task = this.queues.getTask(taskId);   // throws UnknownTaskError for a bad id
    let wf: WorkflowRecord | null = null;
    if (task.workflow) {
      try {
        wf = this.workflows.get(task.workflow.name, task.workflow.version);
      } catch {
        wf = null;   // pinned workflow version was since deleted — steps[] just loses gate/title detail
      }
    }
    const steps = this.buildSteps(task, wf);
    const artifacts = this.artifacts.list({ taskId });
    const provenance = await this.resolveProvenance(task, wf);
    return { taskId: task.taskId, queue: task.queue, state: task.state, workflow: task.workflow, steps, artifacts, provenance };
  }

  private buildSteps(task: TaskRecord, wf: WorkflowRecord | null): EvidenceStep[] {
    return task.stepHistory.map((h): EvidenceStep => {
      const stepDef = wf?.steps.find((s) => s.id === h.stepId) ?? null;
      return {
        stepIndex: h.stepIndex,
        stepId: h.stepId,
        title: stepDef?.title ?? null,
        agentId: h.agentId,
        startedAt: h.startedAt,
        endedAt: h.endedAt,
        outcome: h.outcome,
        reason: h.reason ?? null,
        handoffSummary: h.handoffSummary ?? null,
        gate: stepDef ? { kind: stepDef.gate.kind, spec: (stepDef.gate.spec ?? {}) as Record<string, unknown> } : null,
      };
    });
  }

  private candidateKeys(task: TaskRecord, wf: WorkflowRecord | null): Array<{ key: string; agentIds: string[] }> {
    const sharedWorkdir = !!wf && (wf.steps.some((s) => s.role !== undefined) || wf.steps.some((s) => s.gate.kind === "critic"));
    if (sharedWorkdir) {
      const agentIds = [...new Set(task.stepHistory.map((h) => h.agentId).filter((a): a is string => !!a))];
      return [{ key: `task-${task.taskId}`, agentIds }];
    }
    const agentIds = task.stepHistory.length > 0
      ? [...new Set(task.stepHistory.map((h) => h.agentId).filter((a): a is string => !!a))]
      : task.agentId
        ? [task.agentId]
        : [];
    return agentIds.map((id) => ({ key: id, agentIds: [id] }));
  }

  private async resolveProvenance(task: TaskRecord, wf: WorkflowRecord | null): Promise<EvidenceProvenanceEntry[]> {
    const keys = this.candidateKeys(task, wf);
    const entries: EvidenceProvenanceEntry[] = [];
    for (const { key, agentIds } of keys) entries.push(await this.resolveOne(key, agentIds, task));
    return entries;
  }

  // FEATURE-10 fix: this task's own [start, next-reuse) window on `key`'s worktree/branch —
  // `preciseBase` anchors the diff to exactly when THIS task began (instead of the branch's
  // original creation point, which stays fixed across every task a reused worker ever
  // processes); `boundedHead` stops it before whichever OTHER task next reused the same key,
  // if any (found via checkpoint capturedAt ordering — see scheduler.ts's captureStepCheckpoint,
  // now called at every bind including persistent-pool idle-reuse). `sharedUnscoped` is true
  // when this task has NO checkpoint of its own on `key` but a SIBLING task's checkpoint proves
  // the key is shared — i.e. we know reuse happened but can't isolate this task's window at
  // all (legacy/pre-fix task, or isolation:"none"); callers must refuse to guess in that case.
  private taskDiffScope(key: string, task: TaskRecord): { preciseBase: string | null; boundedHead: string | null; sharedUnscoped: boolean } {
    const mine = task.checkpoint;
    const siblings: TaskStepCheckpoint[] = this.queues.tasksByCheckpointWorkdir(key, task.taskId)
      .map((t) => t.checkpoint)
      .filter((c): c is TaskStepCheckpoint => !!c && c.commitSha !== null);
    if (mine && mine.workdirKey === key && mine.commitSha !== null) {
      const later = siblings.filter((c) => c.capturedAt > mine.capturedAt).sort((a, b) => a.capturedAt - b.capturedAt);
      return { preciseBase: mine.commitSha, boundedHead: later[0]?.commitSha ?? null, sharedUnscoped: false };
    }
    return { preciseBase: null, boundedHead: null, sharedUnscoped: siblings.length > 0 };
  }

  private async resolveOne(key: string, agentIds: string[], task: TaskRecord): Promise<EvidenceProvenanceEntry> {
    const branch = branchNameFor(key);
    const cp = task.checkpoint;
    // REVIEW-ROOM-UNBOUND-TASKS: isolation:"none" tasks never got a worktree/branch — they
    // committed straight into their cwd (typically main itself), so there is no chimera/<key>
    // range to diff. The checkpoint proves this (workdirKey null ⟺ isolation !== "worktree";
    // see scheduler.captureStepCheckpoint). Degrade with a reason that names the direct-on-main
    // landing (and any commit sha the worker reported) instead of a misleading "no merge commit
    // for branch chimera/<key>".
    if (cp && cp.workdirKey === null && cp.commitSha === null) {
      const directMainRepo = agentIds.map((id) => this.resolveAgentCwd(id)).find((c): c is string => !!c) ?? cp.mainRepo ?? null;
      return {
        worktreeKey: key, branch, mainRepo: directMainRepo, agentIds,
        diff: { available: false, reason: `landed directly on main (isolation:"none") — no task branch or worktree was created for this task${reportedShaHint(task)}` },
      };
    }
    // Prefer a live agent's cwd; fall back to the repo path this task durably captured in its
    // own checkpoint (REVIEW-ROOM-UNBOUND-TASKS) — the live record is gone for a done/pruned
    // agent or after a daemon restart, which is exactly when a review is opened.
    let mainRepo = agentIds.map((id) => this.resolveAgentCwd(id)).find((cwd): cwd is string => !!cwd) ?? null;
    if (!mainRepo && cp?.workdirKey === key && cp.mainRepo) mainRepo = cp.mainRepo;
    if (!mainRepo) {
      return {
        worktreeKey: key, branch, mainRepo: null, agentIds,
        diff: { available: false, reason: "no live agent record for this task's worktree — cwd unknown (daemon may have restarted since)" },
      };
    }
    const scope = this.taskDiffScope(key, task);
    if (scope.sharedUnscoped) {
      return {
        worktreeKey: key, branch, mainRepo, agentIds,
        diff: {
          available: false,
          reason: `worktree/branch "${branch}" is shared by more than one task (persistent pool worker reuse) and this task has no recorded start commit to scope its own diff — refusing to show a possibly-conflated diff`,
        },
      };
    }
    const worktreePath = join(mainRepo, ".chimera", "worktrees", key);
    if (existsSync(worktreePath)) {
      return { worktreeKey: key, branch, mainRepo, agentIds, diff: await this.liveDiff(mainRepo, worktreePath, branch, scope) };
    }
    const merged = await this.mergedDiff(mainRepo, branch, scope);
    return {
      worktreeKey: key, branch, mainRepo, agentIds,
      diff: merged ?? { available: false, reason: `no live worktree and no landed merge commit found for branch "${branch}"${reportedShaHint(task)}` },
    };
  }

  private async liveDiff(
    mainRepo: string, worktreePath: string, branch: string,
    scope: { preciseBase: string | null; boundedHead: string | null },
  ): Promise<EvidenceDiff> {
    let baseSha: string;
    if (scope.preciseBase) {
      baseSha = scope.preciseBase;
    } else {
      const baseRun = await this.run(mainRepo, ["merge-base", branch, "HEAD"]);
      if (baseRun.code !== 0 || !baseRun.stdout) {
        return { available: false, reason: `could not resolve a merge-base for branch "${branch}" in "${mainRepo}"` };
      }
      baseSha = baseRun.stdout;
    }
    // FEATURE-10 fix: once a LATER task has taken over this shared worktree (boundedHead set),
    // the worktree's CURRENT on-disk state belongs to that later task, not this one — showing
    // it here would misattribute someone else's in-flight (possibly uncommitted) work to this,
    // already-superseded, task. Fall back to the plain committed base..boundedHead range, and
    // report `dirty` as unknown (null) rather than a count that isn't ours either.
    if (scope.boundedHead) {
      const { files, patches, patchTruncated, statText, truncated } = await this.diffBetween(worktreePath, baseSha, scope.boundedHead);
      return { available: true, source: "live", baseSha, headSha: scope.boundedHead, mergeCommitSha: null, files, patches, patchTruncated, statText, truncated, dirty: null };
    }
    const headRun = await this.run(worktreePath, ["rev-parse", "HEAD"]);
    const headSha = headRun.stdout || baseSha;
    // LIVE-DIFF (watch the agent work): this task hasn't landed yet, and isn't superseded, so
    // its worktree's CURRENT state (committed history since base PLUS whatever's uncommitted,
    // staged/unstaged/untracked) IS the full picture of what the agent has changed so far.
    const { files, patches, patchTruncated, statText, truncated } = await this.workingTreeDiff(worktreePath, baseSha);
    const dirty = await this.dirtyCount(worktreePath);
    return { available: true, source: "live", baseSha, headSha, mergeCommitSha: null, files, patches, patchTruncated, statText, truncated, dirty };
  }

  // Diffs `base` against the worktree's CURRENT on-disk state (committed + uncommitted +
  // untracked) in one pass. `git diff <base>` (no second ref) already compares the base tree
  // directly to on-disk file content for every path the index knows about — the trick is
  // getting untracked paths INTO that enumeration without touching the agent's real index
  // (it may be mid-edit: staged hunks, a partial `git add`, etc., all of which must survive
  // untouched). `add -N .` (intent-to-add) registers a path with an empty blob so the diff
  // reads its real on-disk content as a pure addition — run against a SCRATCH COPY of the
  // index (via GIT_INDEX_FILE) so the real index file on disk is never written.
  private async workingTreeDiff(worktreePath: string, base: string): Promise<{ files: EvidenceFileChange[]; patches: EvidenceFilePatch[]; patchTruncated: boolean; statText: string; truncated: boolean }> {
    const gitDirRun = await this.run(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const scratchDir = mkdtempSync(join(tmpdir(), "chimera-evid-idx-"));
    try {
      const scratchIndex = join(scratchDir, "index");
      const realIndex = gitDirRun.stdout ? join(gitDirRun.stdout, "index") : null;
      if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, scratchIndex);
      const env = { GIT_INDEX_FILE: scratchIndex };
      await this.git(["add", "-N", "."], { cwd: worktreePath, env });
      return await this.diffBetween(worktreePath, base, null, env);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  private async dirtyCount(worktreePath: string): Promise<number | null> {
    const statusRun = await this.run(worktreePath, ["status", "--porcelain"]);
    return statusRun.code === 0 ? statusRun.stdout.split("\n").filter((l) => l.trim().length > 0).length : null;
  }

  // REVIEW-ROOM-UNBOUND-TASKS: locate the merge commit that landed `branch` onto main. The old
  // implementation grepped `Merge branch '<branch>'`, but real land-on-main workers write custom
  // merge messages (`Merge: <desc> [TAG]`) with no branch name in them, so that never matched and
  // every plain landed task showed "no patch available". This is now message-AGNOSTIC: it finds
  // the merge whose SECOND parent (the branch side) is this task's branch tip. The branch itself
  // is usually already deleted by review time (land-on-main runs `git branch -D`), so:
  //   - if the branch ref happens to still exist, match its tip exactly (unambiguous);
  //   - else, with this task's captured fork point (preciseBase), scan every merge landed on main
  //     since that fork point and take the earliest whose branch-side parent descends from it —
  //     the first point this task's own commits could have landed (also isolates ONE task's merge
  //     on a persistent-pool worker's branch that lands once per task);
  //   - else (legacy task, no checkpoint), fall back to the historical `Merge branch` grep.
  private async findLandedMerge(
    mainRepo: string, branch: string,
    scope: { preciseBase: string | null },
  ): Promise<string | null> {
    const tipRun = await this.run(mainRepo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    const branchTip = tipRun.code === 0 && tipRun.stdout ? tipRun.stdout : null;

    let candidates: string[];
    if (scope.preciseBase) {
      const run = await this.run(mainRepo, ["log", "--merges", "--format=%H", "--reverse", `${scope.preciseBase}..HEAD`]);
      candidates = run.code === 0 ? run.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    } else {
      const run = await this.run(mainRepo, ["log", "--all", "--grep", `Merge branch '${branch}'`, "--format=%H", "--reverse"]);
      candidates = run.code === 0 ? run.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    }
    if (!candidates.length) return null;

    // Exact branch-tip match wins whenever the ref survives — unambiguous even for two tasks that
    // forked from the same commit and merged concurrently.
    if (branchTip) {
      for (const sha of candidates) {
        if ((await this.run(mainRepo, ["rev-parse", `${sha}^2`])).stdout === branchTip) return sha;
      }
    }
    if (scope.preciseBase) {
      for (const sha of candidates) {
        const parent2 = (await this.run(mainRepo, ["rev-parse", `${sha}^2`])).stdout;
        if (!parent2 || parent2 === scope.preciseBase) continue;   // branch side must have commits beyond the base
        if ((await this.run(mainRepo, ["merge-base", "--is-ancestor", scope.preciseBase, parent2])).code === 0) return sha;
      }
      return null;   // scoping impossible — caller reports available:false, never a guess
    }
    return candidates[candidates.length - 1] ?? null;   // legacy grep path: latest match, unchanged
  }

  private async mergedDiff(
    mainRepo: string, branch: string,
    scope: { preciseBase: string | null; boundedHead: string | null },
  ): Promise<EvidenceDiff | null> {
    const mergeSha = await this.findLandedMerge(mainRepo, branch, scope);
    if (!mergeSha) return null;
    const headSha = (await this.run(mainRepo, ["rev-parse", `${mergeSha}^2`])).stdout;   // branch tip that landed
    // Diff from THIS task's own fork point (base..merge^2) when known — captures exactly this
    // task's commits even if main advanced (other tasks landed) before this branch merged. Fall
    // back to the merge's first parent (main-at-merge-time) only for a legacy, checkpoint-less task.
    const baseSha = scope.preciseBase ?? (await this.run(mainRepo, ["rev-parse", `${mergeSha}^1`])).stdout;
    if (!baseSha || !headSha) return null;
    const { files, patches, patchTruncated, statText, truncated } = await this.diffBetween(mainRepo, baseSha, headSha);
    return { available: true, source: "merged", baseSha, headSha, mergeCommitSha: mergeSha, files, patches, patchTruncated, statText, truncated, dirty: null };
  }

  // `head: null` diffs `base` against the worktree's CURRENT on-disk state (working tree +
  // index) instead of a second commit — used by workingTreeDiff for the live in-progress path.
  private async diffBetween(cwd: string, base: string, head: string | null, env?: Record<string, string>): Promise<{ files: EvidenceFileChange[]; patches: EvidenceFilePatch[]; patchTruncated: boolean; statText: string; truncated: boolean }> {
    const headArgs = head ? [head] : [];
    // -z on both: without it, renamed-and-edited files come back from --numstat as a combined
    // `old => new` (or `{old => new}` prefix-collapsed) path that never equals the --name-status
    // new-path key, so the insertion/deletion counts silently fail to attach (+0/-0 in the UI).
    // With -z, a rename's path field is NUL-separated old/new names — matching --name-status -z.
    const nameStatusRun = await this.run(cwd, ["diff", "--name-status", "-z", base, ...headArgs], env);
    const files = parseNameStatus(nameStatusRun.stdout).slice(0, FILES_MAX);
    const numstatRun = await this.run(cwd, ["diff", "--numstat", "-z", base, ...headArgs], env);
    applyNumstat(files, numstatRun.stdout);
    const statRun = await this.run(cwd, ["diff", "--stat", base, ...headArgs], env);
    const patchRun = await this.run(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=3", base, ...headArgs], env);
    const patchMax = 512_000;
    const patchTruncated = patchRun.stdout.length > patchMax;
    const patches = patchTruncated ? [] : parseUnifiedDiff(patchRun.stdout, files);
    return { files, patches, patchTruncated, statText: statRun.stdout.slice(0, STAT_MAX_CHARS), truncated: statRun.stdout.length > STAT_MAX_CHARS };
  }
}

// REVIEW-ROOM-UNBOUND-TASKS: best-effort commit-sha extraction from the worker's own report
// (resultText usually names the merge commit). Used only to enrich a degrade `reason` — a
// pointer the human can `git show`, never trusted as structured data. Requires a leading "commit"
// / "merge" / "sha" cue so a stray 7+ hex token in prose (a file hash, an id) isn't mistaken for
// a commit; returns "" when nothing plausible is present.
function reportedShaHint(task: TaskRecord): string {
  const m = /\b(?:commit|merge(?:d| commit)?|sha)\b[^\n]{0,40}?\b([0-9a-f]{7,40})\b/i.exec(task.resultText ?? "");
  return m ? ` — worker reported commit ${m[1]}` : "";
}

const languageFor = (path: string): string | null => ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json", css: "css", md: "markdown", py: "python", rs: "rust", go: "go" } as Record<string, string>)[path.split(".").pop() ?? ""] ?? null;

/** Deterministic, deliberately small unified-diff parser used by both live and landed evidence. */
export function parseUnifiedDiff(text: string, changes: readonly EvidenceFileChange[]): EvidenceFilePatch[] {
  const byPath = new Map(changes.map((f) => [f.path, f]));
  const out: EvidenceFilePatch[] = [];
  let file: EvidenceFilePatch | null = null;
  let hunk: EvidenceFilePatch["hunks"][number] | null = null;
  let oldPath: string | null = null;
  let oldLine = 0, newLine = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) { file = null; hunk = null; oldPath = null; continue; }
    if (raw.startsWith("--- ")) { const token = raw.slice(4); oldPath = token === "/dev/null" ? null : token.replace(/^a\//, ""); continue; }
    if (raw.startsWith("Binary files ")) { if (file) file.binary = true; continue; }
    if (raw.startsWith("+++ ")) {
      const token = raw.slice(4);
      const path = token === "/dev/null" ? oldPath : token.replace(/^b\//, "");
      const change = path ? byPath.get(path) : undefined;
      if (path && change) { file = { path, oldPath: change.status === "renamed" ? oldPath : null, status: change.status, language: languageFor(path), binary: false, truncated: false, hunks: [] }; out.push(file); }
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (match && file) {
      oldLine = Number(match[1]); newLine = Number(match[3]);
      const id = `${file.path}:${oldLine}:${match[2] ?? "1"}:${newLine}:${match[4] ?? "1"}`;
      hunk = { id, header: raw, oldStart: oldLine, oldLines: Number(match[2] ?? 1), newStart: newLine, newLines: Number(match[4] ?? 1), lines: [] };
      file.hunks.push(hunk); continue;
    }
    if (!hunk) continue;
    let line: EvidenceDiffLine;
    if (raw.startsWith("+")) line = { kind: "addition", oldLine: null, newLine: newLine++, text: raw.slice(1) };
    else if (raw.startsWith("-")) line = { kind: "deletion", oldLine: oldLine++, newLine: null, text: raw.slice(1) };
    else if (raw.startsWith("\\")) line = { kind: "meta", oldLine: null, newLine: null, text: raw };
    else line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw };
    hunk.lines.push(line);
  }
  return out;
}

// -z record splitter shared by name-status and numstat parsing below: drops the trailing
// empty string left by the final NUL terminator.
function splitNulRecords(text: string): string[] {
  const parts = text.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function parseNameStatus(text: string): EvidenceFileChange[] {
  const out: EvidenceFileChange[] = [];
  const parts = splitNulRecords(text);
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    const isRenameOrCopy = code.startsWith("R") || code.startsWith("C");
    const path = isRenameOrCopy ? parts[i + 2] : parts[i + 1];
    i += isRenameOrCopy ? 3 : 2;
    if (!path) continue;
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
    out.push({ path, status, insertions: 0, deletions: 0 });
  }
  return out;
}

function applyNumstat(files: EvidenceFileChange[], text: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const parts = splitNulRecords(text);
  let i = 0;
  while (i < parts.length) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i] ?? "");
    i += 1;
    if (!m) continue;
    const [, insRaw, delRaw, inlinePath] = m;
    // an empty inline path means a rename/copy: the old and new names follow as their own
    // NUL-terminated records (mirrors --name-status -z), so consume two more.
    const path = inlinePath === "" ? parts[i + 1] : inlinePath;
    if (inlinePath === "") i += 2;
    const f = path ? byPath.get(path) : undefined;
    if (!f) continue;
    f.insertions = insRaw === "-" ? 0 : parseInt(insRaw, 10) || 0;
    f.deletions = delRaw === "-" ? 0 : parseInt(delRaw, 10) || 0;
  }
}
