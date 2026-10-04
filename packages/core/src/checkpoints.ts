import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckpointRecord, CheckpointStatus, CheckpointTrigger } from "@chimera/protocol";
import type { EventLog } from "./events.js";

// D16 (checkpoints, coverage §C18, F20): git-PLUMBING-only working-tree snapshots.
//
// MECHANICS: write-tree + commit-tree under refs/chimera/checkpoints/<n> in the target
// repo — HEAD/index/history are NEVER touched. Every mutating call below uses a private
// GIT_INDEX_FILE (a fresh temp path, never the repo's real .git/index) so the caller's
// staged changes survive byte-identical across a checkpoint create OR a revert; the
// checkpoint commit itself is built as a ROOT commit's tree (via `add -A` into that temp
// index) so it captures the FULL non-ignored working-tree state, not a diff. Refs live
// outside refs/heads/refs/remotes, so a normal `git log` (which walks from HEAD) never
// shows them — only `git log --all` / `for-each-ref` do. No separate coordination file:
// checkpoint metadata (trigger/agentId/taskId) rides the commit message as trailer lines,
// so a checkpoint's lifetime is exactly its ref's lifetime.
export class NotAGitRepoError extends Error { code = "protocol" as const; name = "NotAGitRepoError"; }
export class UnknownCheckpointError extends Error { code = "protocol" as const; name = "UnknownCheckpointError"; }
export class CheckpointBusyError extends Error { code = "guardrail" as const; name = "CheckpointBusyError"; }
export class GitCommandError extends Error { code = "protocol" as const; name = "GitCommandError"; }

// F20: "gc keeps last 20 / 24h" — the SAME dual bound as ArtifactStore's gc (D13): a
// checkpoint survives only if it is within the newest 20 AND younger than 24h.
const GC_MAX_CHECKPOINTS = 20;
const GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const REF_PREFIX = "refs/chimera/checkpoints/";
const REF_RE = /^refs\/chimera\/checkpoints\/(\d+)$/;
// Agent worktrees are independently owned, short-lived repositories. Traversing
// them races queue startup/cleanup, and restoring them would corrupt other sessions.
const RUNTIME_WORKTREES = ".chimera/worktrees";
const SNAPSHOT_PATHS = [".", `:(top,exclude)${RUNTIME_WORKTREES}`];

export type GitExecFn = (args: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<{ stdout: string; code: number; stderr: string }>;

const realGitExec: GitExecFn = (args, opts) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? 1 : 0 }));
  });

export type CheckpointCreateInput = {
  cwd: string;
  trigger: CheckpointTrigger;
  agentId?: string | null;
  taskId?: string | null;
  message?: string;
};

type RefRow = { seq: number; ref: string; sha: string; ts: number };

function defaultMessage(trigger: CheckpointTrigger): string {
  switch (trigger) {
    case "task_start": return "chimera checkpoint: task start";
    case "destructive_bash": return "chimera checkpoint: before destructive command";
    case "manual": return "chimera checkpoint: manual";
  }
}

export class CheckpointStore {
  private events: EventLog;
  // A LIVE predicate (function seam, not a snapshot — mirrors ToolPolicyStore.modeFor's
  // "read fresh per decision" contract): true when an agent is currently running
  // somewhere under the given repo TOPLEVEL. revert() refuses while this is true; killing
  // the agent flips it false on the very next call (AgentSupervisor.kill sets state
  // synchronously before its own await resolves).
  private isRepoBusy: (repoRoot: string) => boolean;
  private now: () => number;
  private git: GitExecFn;

  constructor(deps: { events: EventLog; isRepoBusy: (repoRoot: string) => boolean; now?: () => number; git?: GitExecFn }) {
    this.events = deps.events;
    this.isRepoBusy = deps.isRepoBusy;
    this.now = deps.now ?? Date.now;
    this.git = deps.git ?? realGitExec;
  }

  private async run(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    const { stdout, code, stderr } = await this.git(args, { cwd, env });
    if (code !== 0) throw new GitCommandError(`git ${args[0]} failed in "${cwd}": ${stderr.trim() || stdout.trim() || "(no output)"}`);
    return stdout.trim();
  }

  private async tryRun(cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> {
    const { stdout, code } = await this.git(args, { cwd, env });
    return code === 0 ? stdout.trim() : null;
  }

  async isGitRepo(cwd: string): Promise<boolean> {
    return (await this.tryRun(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  }

  // The repo's WORKTREE toplevel (not the shared .git/common dir) — file operations
  // (add -A, ls-files, checkout-index) are worktree-scoped by construction; refs
  // (refs/chimera/checkpoints/*) live in the shared object/ref store, so a checkpoint
  // created from one worktree of a repo is visible — and the busy-repo guard applies —
  // across every worktree sharing that repo, same as any ordinary git ref.
  async resolveRepoRoot(cwd: string): Promise<string> {
    const root = await this.tryRun(cwd, ["rev-parse", "--show-toplevel"]);
    if (!root) throw new NotAGitRepoError(`"${cwd}" is not inside a git working tree`);
    return root;
  }

  async status(cwd: string): Promise<CheckpointStatus> {
    if (!(await this.isGitRepo(cwd))) return { supported: false, cwd };
    const list = await this.list(cwd);
    return { supported: true, cwd, count: list.length, latest: list[0] ?? null };
  }

  private async listRefs(repoRoot: string): Promise<RefRow[]> {
    const out = await this.tryRun(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname) %(committerdate:unix)", REF_PREFIX]);
    if (!out) return [];
    const rows: RefRow[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [refname, sha, tsStr] = line.split(" ");
      const m = refname ? REF_RE.exec(refname) : null;
      if (!m || !sha || !tsStr) continue;
      rows.push({ seq: Number(m[1]), ref: refname!, sha, ts: Number(tsStr) * 1000 });
    }
    return rows;
  }

  private parseTrailers(commitObject: string): { trigger: CheckpointTrigger; agentId: string | null; taskId: string | null; message: string } {
    const blank = commitObject.indexOf("\n\n");
    const body = blank === -1 ? commitObject : commitObject.slice(blank + 2);
    const lines = body.split("\n");
    let trigger: CheckpointTrigger = "manual";
    let agentId: string | null = null;
    let taskId: string | null = null;
    for (const line of lines.slice(1)) {
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m as unknown as [string, string, string];
      if (key === "trigger" && (value === "task_start" || value === "destructive_bash" || value === "manual")) trigger = value;
      else if (key === "agentId") agentId = value === "-" ? null : value;
      else if (key === "taskId") taskId = value === "-" ? null : value;
    }
    return { trigger, agentId, taskId, message: lines[0] ?? "" };
  }

  async list(cwd: string): Promise<CheckpointRecord[]> {
    const repoRoot = await this.resolveRepoRoot(cwd);
    const refs = (await this.listRefs(repoRoot)).sort((a, b) => b.seq - a.seq);   // newest first
    const records: CheckpointRecord[] = [];
    for (const r of refs) {
      const raw = await this.tryRun(repoRoot, ["cat-file", "-p", r.sha]);
      const meta = this.parseTrailers(raw ?? "");
      records.push({ id: String(r.seq), ref: r.ref, trigger: meta.trigger, ts: r.ts, agentId: meta.agentId, taskId: meta.taskId, message: meta.message });
    }
    return records;
  }

  private async gc(repoRoot: string): Promise<void> {
    const cutoff = this.now() - GC_MAX_AGE_MS;
    const refs = (await this.listRefs(repoRoot)).sort((a, b) => a.ts - b.ts);   // oldest first
    const evict = new Set<string>();
    for (const r of refs) if (r.ts < cutoff) evict.add(r.ref);
    const survivors = refs.filter((r) => !evict.has(r.ref));
    const overflow = survivors.length - GC_MAX_CHECKPOINTS;
    if (overflow > 0) for (const r of survivors.slice(0, overflow)) evict.add(r.ref);
    for (const ref of evict) await this.tryRun(repoRoot, ["update-ref", "-d", ref]);
  }

  async create(input: CheckpointCreateInput): Promise<CheckpointRecord> {
    const repoRoot = await this.resolveRepoRoot(input.cwd);
    const existing = await this.listRefs(repoRoot);
    const seq = existing.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
    const ref = `${REF_PREFIX}${seq}`;
    // Git commit timestamps are SECOND-granularity — round down now so the record
    // returned here matches byte-for-byte what a later list() reconstructs from
    // %(committerdate:unix) (otherwise create()'s ts and list()'s ts would diverge by
    // up to 999ms for the exact same checkpoint).
    const ts = Math.floor(this.now() / 1000) * 1000;
    // The "@<unix-seconds> <tz>" form is git's INPUT raw-date format for
    // GIT_AUTHOR_DATE/GIT_COMMITTER_DATE — the bare "<seconds> <tz>" form (without "@")
    // is output-only and git rejects it here ("invalid date format").
    const dateEnv = `@${ts / 1000} +0000`;
    const gitEnv = {
      GIT_INDEX_FILE: join(tmpdir(), `chimera-ckpt-${randomUUID()}.index`),
      GIT_AUTHOR_NAME: "chimera", GIT_AUTHOR_EMAIL: "chimera@localhost", GIT_AUTHOR_DATE: dateEnv,
      GIT_COMMITTER_NAME: "chimera", GIT_COMMITTER_EMAIL: "chimera@localhost", GIT_COMMITTER_DATE: dateEnv,
    };
    const message = input.message ?? defaultMessage(input.trigger);
    const body = [message, "", `trigger: ${input.trigger}`, `agentId: ${input.agentId ?? "-"}`, `taskId: ${input.taskId ?? "-"}`].join("\n");
    try {
      // `add -A` from a FRESH (nonexistent) temp index stages every non-ignored path
      // present right now — the result is a full snapshot of the working tree, not a
      // diff against whatever HEAD/the real index happen to hold.
      await this.run(repoRoot, ["add", "-A", "--", ...SNAPSHOT_PATHS], gitEnv);
      const tree = await this.run(repoRoot, ["write-tree"], gitEnv);
      const parent = await this.tryRun(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
      const commitArgs = parent ? ["commit-tree", tree, "-p", parent, "-m", body] : ["commit-tree", tree, "-m", body];
      const commit = await this.run(repoRoot, commitArgs, gitEnv);
      await this.run(repoRoot, ["update-ref", ref, commit]);
    } finally {
      try { unlinkSync(gitEnv.GIT_INDEX_FILE); } catch { /* never created, or already gone */ }
    }
    const record: CheckpointRecord = {
      id: String(seq), ref, trigger: input.trigger, ts,
      agentId: input.agentId ?? null, taskId: input.taskId ?? null, message,
    };
    await this.gc(repoRoot);
    this.events.append({
      agentId: `checkpoint:${record.id}`, kind: "checkpoint_created",
      data: { id: record.id, ref, trigger: record.trigger, ts: record.ts, agentId: record.agentId, taskId: record.taskId, cwd: repoRoot },
    });
    return record;
  }

  async revert(cwd: string, id: string): Promise<{ id: string; ref: string; restoredFiles: number }> {
    const repoRoot = await this.resolveRepoRoot(cwd);
    if (this.isRepoBusy(repoRoot))
      throw new CheckpointBusyError(`refusing to revert "${repoRoot}": an agent is running in this repo — kill it first`);
    const ref = `${REF_PREFIX}${id}`;
    const sha = await this.tryRun(repoRoot, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (!sha) throw new UnknownCheckpointError(`unknown checkpoint "${id}"`);

    const tmpIndex = join(tmpdir(), `chimera-ckpt-revert-${randomUUID()}.index`);
    let target = new Set<string>();
    try {
      // Load the checkpoint's tree into a PRIVATE temp index (never the repo's real
      // .git/index) — read-tree/ls-files/checkout-index below never touch HEAD, the real
      // index, or any branch, only the worktree's files.
      await this.run(repoRoot, ["read-tree", sha], { GIT_INDEX_FILE: tmpIndex });
      // Older checkpoints may contain runtime files. Strip them from the private
      // restore index too, without touching either the working files or real index.
      await this.run(repoRoot, ["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", RUNTIME_WORKTREES], { GIT_INDEX_FILE: tmpIndex });
      const targetOut = await this.run(repoRoot, ["ls-files"], { GIT_INDEX_FILE: tmpIndex });
      target = new Set(targetOut.split("\n").filter((p) => p !== ""));
      const currentOut = await this.run(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SNAPSHOT_PATHS]);
      const current = currentOut.split("\n").filter((p) => p !== "");
      // Writes every checkpoint-tree file into the worktree, overwriting current content.
      await this.run(repoRoot, ["checkout-index", "-a", "-f"], { GIT_INDEX_FILE: tmpIndex });
      // A path present now but absent from the checkpoint tree didn't exist (as tracked
      // OR untracked-but-visible content) at checkpoint time — created/renamed-in since,
      // so it's removed to match "the tree state at the marker". Ignored paths are never
      // in `current` (--exclude-standard) or `target` (add -A skips them) — untouched.
      for (const path of current) if (!target.has(path)) { try { unlinkSync(join(repoRoot, path)); } catch { /* already gone */ } }
    } finally {
      try { unlinkSync(tmpIndex); } catch { /* never created, or already gone */ }
    }
    this.events.append({ agentId: `checkpoint:${id}`, kind: "checkpoint_reverted", data: { id, ref, cwd: repoRoot } });
    return { id, ref, restoredFiles: target.size };
  }
}
