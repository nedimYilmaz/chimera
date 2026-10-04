import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { EvidenceStore } from "@chimera/core/evidence";
import { branchNameFor } from "@chimera/core/workdir";

// FEATURE-10 (Changes & Evidence Review): EvidenceStore is a thin git wrapper (like
// CheckpointStore) — driven against REAL git repos/worktrees rather than a faked exec
// seam, mirroring checkpoints.test.ts's own convention for this kind of module.

// CORE-SUITE-BASELINE: many tests here chain several real `git worktree`/`git merge`
// calls — under this machine's concurrent-agent load that easily exceeds vitest's 5000ms
// default; widened generously per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 90_000 });

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "chimera-evid-repo-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed"], { stdio: "ignore" });
  return repo;
}

// Mirrors ensureWorkdir's own convention (workdir.ts:47): a live isolated worktree lives
// at <mainRepo>/.chimera/worktrees/<key> on branch branchNameFor(key).
function addLiveWorktree(mainRepo: string, key: string): { path: string; branch: string } {
  const branch = branchNameFor(key);
  const path = join(mainRepo, ".chimera", "worktrees", key);
  mkdirSync(join(mainRepo, ".chimera", "worktrees"), { recursive: true });
  execFileSync("git", ["-C", mainRepo, "worktree", "add", "-b", branch, path], { stdio: "ignore" });
  return { path, branch };
}

function commitFile(cwd: string, relPath: string, contents: string, message: string): void {
  writeFileSync(join(cwd, relPath), contents);
  execFileSync("git", ["-C", cwd, "add", relPath], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], { stdio: "ignore" });
}

// Simulates the land-on-main workflow (merge --no-ff, worktree removed) WITHOUT going
// through a real worktree removal — just what evidence.ts's "merged" path actually reads:
// a merge commit on mainRepo whose message names the branch, plus no live worktree dir.
function mergeAndRemoveWorktree(mainRepo: string, worktreePath: string, branch: string): void {
  execFileSync("git", ["-C", mainRepo, "merge", "--no-ff", branch, "-m", `Merge branch '${branch}' — test feature`], { stdio: "ignore" });
  execFileSync("git", ["-C", mainRepo, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
}

function makeStores(): { queues: QueueStore; workflows: WorkflowStore; artifacts: ArtifactStore } {
  const dir = mkdtempSync(join(tmpdir(), "chimera-evid-home-"));
  const events = new EventLog(dir);
  return { queues: new QueueStore(dir, events), workflows: new WorkflowStore(dir, events), artifacts: new ArtifactStore(dir, events) };
}

function makeEvidenceStore(stores: ReturnType<typeof makeStores>, cwdByAgent: Record<string, string | undefined>): EvidenceStore {
  return new EvidenceStore({
    queues: stores.queues, workflows: stores.workflows, artifacts: stores.artifacts,
    resolveAgentCwd: (agentId) => cwdByAgent[agentId] ?? null,
  });
}

describe("EvidenceStore.getTaskEvidence — non-workflow task", () => {
  it("resolves a LIVE diff for a single agentId-keyed worktree, plus registered artifacts", async () => {
    const repo = initRepo();
    const agentId = "agent-live-1";
    const { path: wtPath } = addLiveWorktree(repo, agentId);
    commitFile(wtPath, "hello.txt", "hi\n", "add hello");

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);
    stores.artifacts.add({ kind: "link", url: "https://x", label: "note", agentId, taskId: task.taskId });

    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.taskId).toBe(task.taskId);
    expect(result.workflow).toBeNull();
    expect(result.steps).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.provenance).toHaveLength(1);
    const [prov] = result.provenance;
    expect(prov.worktreeKey).toBe(agentId);
    expect(prov.branch).toBe(branchNameFor(agentId));
    expect(prov.mainRepo).toBe(repo);
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.source).toBe("live");
      expect(prov.diff.files.map((f) => f.path)).toEqual(["hello.txt"]);
      expect(prov.diff.files[0]).toMatchObject({ status: "added", insertions: 1, deletions: 0 });
      expect(prov.diff.dirty).toBe(0);
    }
  });

  it("attaches insertions/deletions to a renamed-AND-edited file (numstat rename-path matching)", async () => {
    const repo = initRepo();
    // a.ts must already exist at the merge-base (shared ancestor) — otherwise the whole
    // rename happens WITHIN the diffed range and git just reports b.ts as freshly "added".
    const original = Array.from({ length: 20 }, (_, i) => `line${i}\n`).join("");
    commitFile(repo, "a.ts", original, "add a.ts");
    const agentId = "agent-live-rename";
    const { path: wtPath } = addLiveWorktree(repo, agentId);
    execFileSync("git", ["-C", wtPath, "mv", "a.ts", "b.ts"], { stdio: "ignore" });
    writeFileSync(join(wtPath, "b.ts"), original + "line20\n");
    execFileSync("git", ["-C", wtPath, "add", "b.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", wtPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "rename+edit"], { stdio: "ignore" });

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.files).toHaveLength(1);
      expect(prov.diff.files[0]).toMatchObject({ path: "b.ts", status: "renamed", insertions: 1, deletions: 0 });
    }
  });

  // LIVE DIFF (watch it work): the live diff must show EVERYTHING the agent has changed so far
  // — committed history since base PLUS whatever's still uncommitted, including untracked files
  // — not just base..HEAD. This is what lets the Review Room show a running agent's progress
  // before it lands (previously "no patch available" until the merge existed).
  it("includes uncommitted AND untracked changes in the live diff, not just committed history", async () => {
    const repo = initRepo();
    const agentId = "agent-live-dirty";
    const { path: wtPath } = addLiveWorktree(repo, agentId);
    commitFile(wtPath, "committed.txt", "a\n", "commit one");
    writeFileSync(join(wtPath, "unstaged.txt"), "not committed, not staged");
    execFileSync("git", ["-C", wtPath, "add", "committed.txt"], { stdio: "ignore" });   // no-op re-add, sanity
    writeFileSync(join(wtPath, "staged.txt"), "staged but not committed");
    execFileSync("git", ["-C", wtPath, "add", "staged.txt"], { stdio: "ignore" });

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.files.map((f) => f.path).sort()).toEqual(["committed.txt", "staged.txt", "unstaged.txt"]);
      expect(prov.diff.files.find((f) => f.path === "unstaged.txt")).toMatchObject({ status: "added" });
      expect(prov.diff.files.find((f) => f.path === "staged.txt")).toMatchObject({ status: "added" });
      expect(prov.diff.patches.find((p) => p.path === "unstaged.txt")?.hunks[0]?.lines[0]).toMatchObject({ kind: "addition", text: "not committed, not staged" });
      expect(prov.diff.dirty).toBe(2);   // unstaged.txt + staged.txt
    }

    // the agent's REAL index must be untouched by the scratch-index trick (staged.txt still
    // shows as staged, not reverted to untracked) — evidence.ts must never mutate live state.
    const statusAfter = execFileSync("git", ["-C", wtPath, "status", "--porcelain"]).toString();
    expect(statusAfter).toContain("A  staged.txt");
  });

  // "no changes yet" (Review Room soft-empty state): an in_progress task whose live worktree
  // has made zero changes yet (agent just started) must resolve as an available-but-empty
  // diff — NOT an error — so the app can render a friendly "no changes yet" placeholder
  // instead of a hard "no patch available"/"no patch to review" failure.
  it("an in_progress task with a clean live worktree (no changes yet) yields an available, empty diff", async () => {
    const repo = initRepo();
    const agentId = "agent-live-clean";
    addLiveWorktree(repo, agentId);   // fresh worktree, agent hasn't touched anything yet

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);

    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.state).toBe("in_progress");
    const [prov] = result.provenance;
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.files).toEqual([]);
      expect(prov.diff.dirty).toBe(0);
    }
  });

  it("resolves a MERGED diff once the worktree is gone, via the 'Merge branch' commit message convention", async () => {
    const repo = initRepo();
    const agentId = "agent-merged-1";
    const { path: wtPath, branch } = addLiveWorktree(repo, agentId);
    commitFile(wtPath, "feature.txt", "shipped\n", "add feature");
    mergeAndRemoveWorktree(repo, wtPath, branch);

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.source).toBe("merged");
      expect(prov.diff.mergeCommitSha).not.toBeNull();
      expect(prov.diff.files.map((f) => f.path)).toEqual(["feature.txt"]);
      expect(prov.diff.dirty).toBeNull();
    }
  });

  it("reports available:false when neither a live worktree nor a merge commit exists", async () => {
    const repo = initRepo();
    const agentId = "agent-ghost-1";   // never actually got a worktree

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff).toMatchObject({ available: false });
    if (!prov.diff.available) expect(prov.diff.reason).toMatch(/no live worktree/);
  });

  it("reports mainRepo:null and available:false when the recording agent's cwd is unknown (daemon restarted)", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});   // resolveAgentCwd never resolves anything
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, "agent-unknown");

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.mainRepo).toBeNull();
    expect(prov.diff).toMatchObject({ available: false });
  });

  it("a task with no agentId at all (never picked up) has zero provenance entries", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });

    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.provenance).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it("throws (UnknownTaskError-shaped) for an unknown taskId", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    await expect(evid.getTaskEvidence("ghost-task")).rejects.toMatchObject({ code: "protocol" });
  });
});

// FEATURE-10 fix (evidence conflation): a persistent pool worker reuses ONE agentId-keyed
// worktree/branch across many tasks. `recordWorkStart`/`checkpointStep` calls below stand in
// for scheduler.ts's captureStepCheckpoint, which now fires on every task bind to that worker
// (fresh spawn AND idle-pool-worker reuse alike) — exactly what a real daemon would persist.
describe("EvidenceStore.getTaskEvidence — reused persistent-pool-worker worktree", () => {
  function checkpointFor(workdirKey: string, commitSha: string, capturedAt: number) {
    return { stepIndex: 0, idempotencyKey: `k:${capturedAt}`, workdirKey, branch: branchNameFor(workdirKey), commitSha, gateAttempts: 0, capturedAt, mainRepo: null };
  }

  it("task-1's LIVE diff excludes task-2's later commit on the same reused worktree/branch", async () => {
    const repo = initRepo();
    const agentId = "agent-pool-1";
    const { path: wtPath } = addLiveWorktree(repo, agentId);

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });

    const task1 = stores.queues.push("q1", { prompt: "task one" });
    stores.queues.markInProgress(task1.taskId, agentId);
    const startSha1 = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    stores.queues.checkpointStep(task1.taskId, checkpointFor(agentId, startSha1, 1000));
    commitFile(wtPath, "fileA.txt", "a\n", "task-1 commit");

    // task-1 settles; the worker goes idle and gets reused for task-2 in the SAME worktree.
    const task2 = stores.queues.push("q1", { prompt: "task two" });
    stores.queues.markInProgress(task2.taskId, agentId);
    const startSha2 = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    stores.queues.checkpointStep(task2.taskId, checkpointFor(agentId, startSha2, 2000));
    commitFile(wtPath, "fileB.txt", "b\n", "task-2 commit");

    const [prov1] = (await evid.getTaskEvidence(task1.taskId)).provenance;
    expect(prov1.diff.available).toBe(true);
    if (prov1.diff.available) {
      expect(prov1.diff.files.map((f) => f.path)).toEqual(["fileA.txt"]);   // NOT fileB.txt
    }

    const [prov2] = (await evid.getTaskEvidence(task2.taskId)).provenance;
    expect(prov2.diff.available).toBe(true);
    if (prov2.diff.available) {
      expect(prov2.diff.files.map((f) => f.path)).toEqual(["fileB.txt"]);   // NOT fileA.txt
    }
  });

  it("reports available:false for a task with no checkpoint of its own when a sibling proves the key is shared", async () => {
    const repo = initRepo();
    const agentId = "agent-pool-2";
    const { path: wtPath } = addLiveWorktree(repo, agentId);
    commitFile(wtPath, "old.txt", "x\n", "pre-existing commit");

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { [agentId]: repo });
    stores.queues.create({ name: "q1" });

    // task1 predates the checkpoint mechanism (e.g. a pre-fix task) — no checkpoint recorded.
    const task1 = stores.queues.push("q1", { prompt: "legacy task" });
    stores.queues.markInProgress(task1.taskId, agentId);

    // task2 reuses the same worker and DOES get a checkpoint — proof the key is shared.
    const task2 = stores.queues.push("q1", { prompt: "task two" });
    stores.queues.markInProgress(task2.taskId, agentId);
    const startSha2 = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    stores.queues.checkpointStep(task2.taskId, checkpointFor(agentId, startSha2, 2000));

    const [prov1] = (await evid.getTaskEvidence(task1.taskId)).provenance;
    expect(prov1.diff).toMatchObject({ available: false });
    if (!prov1.diff.available) expect(prov1.diff.reason).toMatch(/shared by more than one task/);
  });
});

// REVIEW-ROOM-UNBOUND-TASKS: the review room was empty for every landed PLAIN task because (a)
// the merged-diff lookup grepped `Merge branch '<branch>'`, but real land-on-main workers write
// arbitrary merge messages, and (b) mainRepo came from a live agent record that no longer exists
// once the task is done. These exercise the fixed path: message-agnostic second-parent scan,
// mainRepo recovered from the task's own durable checkpoint, and honest degrade reasons.
describe("EvidenceStore.getTaskEvidence — landed plain task after its agent is gone", () => {
  const cp = (agentId: string, commitSha: string, mainRepo: string | null, capturedAt = 1000) =>
    ({ stepIndex: 0, idempotencyKey: `k:${capturedAt}`, workdirKey: agentId, branch: branchNameFor(agentId), commitSha, gateAttempts: 0, capturedAt, mainRepo });

  // land-on-main with a CUSTOM merge message (no "Merge branch" text) AND branch deletion — what
  // a real team worker's `git merge --no-ff <branch> -m "Merge: ..."` + `git branch -D` produces.
  function landAndDelete(mainRepo: string, worktreePath: string, branch: string, message: string): void {
    execFileSync("git", ["-C", mainRepo, "merge", "--no-ff", branch, "-m", message], { stdio: "ignore" });
    execFileSync("git", ["-C", mainRepo, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
    execFileSync("git", ["-C", mainRepo, "branch", "-D", branch], { stdio: "ignore" });
  }

  it("derives the landed diff via second-parent scan (custom merge msg, branch deleted, agent gone)", async () => {
    const repo = initRepo();
    const agentId = "agent-landed-1";
    const { path: wtPath, branch } = addLiveWorktree(repo, agentId);
    const base = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    commitFile(wtPath, "shipped.txt", "done\n", "implement feature");
    landAndDelete(repo, wtPath, branch, "Merge: ship the feature [FEATURE-X]");

    const stores = makeStores();
    // resolveAgentCwd resolves NOTHING — the agent terminated; mainRepo must come from checkpoint.
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);
    stores.queues.checkpointStep(task.taskId, cp(agentId, base, repo));

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.mainRepo).toBe(repo);           // recovered from the checkpoint, not a live agent
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.source).toBe("merged");
      expect(prov.diff.mergeCommitSha).not.toBeNull();
      expect(prov.diff.baseSha).toBe(base);      // base..merge^2 range (this task's own fork point)
      expect(prov.diff.files.map((f) => f.path)).toEqual(["shipped.txt"]);
    }
  });

  it("isolates each task's merge on a persistent-pool branch merged once per task (both deleted)", async () => {
    const repo = initRepo();
    const agentId = "agent-pool-landed";
    const { path: wtPath, branch } = addLiveWorktree(repo, agentId);
    const base1 = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    commitFile(wtPath, "fileA.txt", "a\n", "task-1 work");
    execFileSync("git", ["-C", repo, "merge", "--no-ff", branch, "-m", "Merge: task one [A]"], { stdio: "ignore" });
    const base2 = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    commitFile(wtPath, "fileB.txt", "b\n", "task-2 work");
    landAndDelete(repo, wtPath, branch, "Merge: task two [B]");

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task1 = stores.queues.push("q1", { prompt: "one" });
    stores.queues.markInProgress(task1.taskId, agentId);
    stores.queues.checkpointStep(task1.taskId, cp(agentId, base1, repo, 1000));
    const task2 = stores.queues.push("q1", { prompt: "two" });
    stores.queues.markInProgress(task2.taskId, agentId);
    stores.queues.checkpointStep(task2.taskId, cp(agentId, base2, repo, 2000));

    const [p1] = (await evid.getTaskEvidence(task1.taskId)).provenance;
    const [p2] = (await evid.getTaskEvidence(task2.taskId)).provenance;
    expect(p1.diff.available && p1.diff.files.map((f) => f.path)).toEqual(["fileA.txt"]);
    expect(p2.diff.available && p2.diff.files.map((f) => f.path)).toEqual(["fileB.txt"]);
  });

  it("degrades honestly for an isolation:\"none\" task that committed directly on main", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, "agent-none-1");
    // isolation:"none" checkpoint — no worktree/branch (all null); worker named its commit.
    stores.queues.checkpointStep(task.taskId, { stepIndex: 0, idempotencyKey: "k", workdirKey: null, branch: null, commitSha: null, gateAttempts: 0, capturedAt: 1, mainRepo: null });
    stores.queues.markDone(task.taskId, "landed directly on main as commit deadbee1234");

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff).toMatchObject({ available: false });
    if (!prov.diff.available) {
      expect(prov.diff.reason).toMatch(/directly on main/);
      expect(prov.diff.reason).toContain("deadbee1234");   // the sha the worker reported
    }
  });

  it("prefers the exact branch-tip match when the branch ref still exists (custom merge msg, worktree gone)", async () => {
    const repo = initRepo();
    const agentId = "agent-landed-tip";
    const { path: wtPath, branch } = addLiveWorktree(repo, agentId);
    const base = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    commitFile(wtPath, "kept.txt", "tip\n", "implement feature");
    const branchTip = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"]).toString().trim();
    // land with a CUSTOM merge message and remove ONLY the worktree — the branch ref survives
    // (no `git branch -D`), so findLandedMerge's exact branch-tip match should win outright.
    execFileSync("git", ["-C", repo, "merge", "--no-ff", branch, "-m", "Merge: keep the branch [KEEP]"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" });

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);
    stores.queues.checkpointStep(task.taskId, cp(agentId, base, repo));

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff.available).toBe(true);
    if (prov.diff.available) {
      expect(prov.diff.source).toBe("merged");
      expect(prov.diff.headSha).toBe(branchTip);   // the surviving ref's tip, matched exactly
      expect(prov.diff.files.map((f) => f.path)).toEqual(["kept.txt"]);
    }
  });

  it("does NOT append a 'worker reported commit' hint for a bare hex token with no commit/merge/sha cue", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, "agent-none-nocue");
    // isolation:"none" checkpoint — degrade reason runs reportedShaHint over resultText.
    stores.queues.checkpointStep(task.taskId, { stepIndex: 0, idempotencyKey: "k", workdirKey: null, branch: null, commitSha: null, gateAttempts: 0, capturedAt: 1, mainRepo: null });
    // a stray 7+ hex token in prose (looks like a hash) but with NO commit/merge/sha cue word.
    stores.queues.markDone(task.taskId, "cleaned up artifact abc1234 and finished");

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.diff).toMatchObject({ available: false });
    if (!prov.diff.available) {
      expect(prov.diff.reason).toMatch(/directly on main/);
      expect(prov.diff.reason).not.toContain("worker reported");   // no cue -> "" hint
      expect(prov.diff.reason).not.toContain("abc1234");
    }
  });

  it("degrades with 'no landed merge commit' when a worktree task never merged (agent gone)", async () => {
    const repo = initRepo();
    const agentId = "agent-unmerged";
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();

    const stores = makeStores();
    const evid = makeEvidenceStore(stores, {});
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.markInProgress(task.taskId, agentId);
    stores.queues.checkpointStep(task.taskId, cp(agentId, base, repo));   // branch never created/merged

    const [prov] = (await evid.getTaskEvidence(task.taskId)).provenance;
    expect(prov.mainRepo).toBe(repo);
    expect(prov.diff).toMatchObject({ available: false });
    if (!prov.diff.available) expect(prov.diff.reason).toMatch(/no landed merge commit/);
  });
});

const COMMAND_GATE = { kind: "command" as const, spec: { command: "true", args: [] as string[] } };

describe("EvidenceStore.getTaskEvidence — workflow-bound task", () => {
  it("joins each stepHistory row to its WorkflowStep's gate/title, across passed/failed/retried outcomes", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { "agent-a": "/tmp/main" });
    const wf = stores.workflows.create({
      name: "review-flow",
      steps: [
        { id: "s0", title: "lint", gate: COMMAND_GATE },
        { id: "s1", title: "review", gate: { kind: "critic", spec: { criteria: "looks good", maxRounds: 1 } } },
      ],
    });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    stores.queues.startStep(task.taskId, 0, "s0", "agent-a");
    stores.queues.closeStep(task.taskId, "failed", "lint failed: 3 errors");
    stores.queues.startStep(task.taskId, 0, "s0", "agent-a");
    stores.queues.closeStep(task.taskId, "retried", "lint failed: 3 errors");
    stores.queues.startStep(task.taskId, 0, "s0", "agent-a");
    stores.queues.closeStep(task.taskId, "passed");
    stores.queues.advanceStep(task.taskId, 1);
    stores.queues.startStep(task.taskId, 1, "s1", "agent-a");
    stores.queues.closeStep(task.taskId, "passed");

    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.workflow).toEqual({ name: "review-flow", version: 1 });
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0]).toMatchObject({ stepId: "s0", title: "lint", outcome: "failed", reason: "lint failed: 3 errors", gate: { kind: "command" } });
    expect(result.steps[1]).toMatchObject({ stepId: "s0", outcome: "retried" });
    expect(result.steps[2]).toMatchObject({ stepId: "s0", outcome: "passed", reason: null });
    expect(result.steps[3]).toMatchObject({ stepId: "s1", title: "review", outcome: "passed", gate: { kind: "critic" } });
  });

  it("(failed-gate run) still returns full evidence for a task that never passed its gate — never throws", async () => {
    const stores = makeStores();
    const evid = makeEvidenceStore(stores, { "agent-a": "/tmp/main" });
    const wf = stores.workflows.create({ name: "gated", steps: [{ id: "s0", title: "build", gate: COMMAND_GATE }] });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    stores.queues.startStep(task.taskId, 0, "s0", "agent-a");
    stores.queues.closeStep(task.taskId, "failed", "build error: exit 1");
    stores.queues.markFailed(task.taskId, "gate failed permanently");

    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.state).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ outcome: "failed", reason: "build error: exit 1" });
  });

  it("a step-role workflow shares ONE task-<id>-keyed provenance entry across multiple agentIds", async () => {
    const repo = initRepo();
    const stores = makeStores();
    const wf = stores.workflows.create({
      name: "handoff-flow",
      steps: [
        { id: "s0", title: "write", role: "writer", gate: COMMAND_GATE },
        { id: "s1", title: "review", role: "reviewer", gate: COMMAND_GATE },
      ],
    });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    const sharedKey = `task-${task.taskId}`;
    addLiveWorktree(repo, sharedKey);
    stores.queues.startStep(task.taskId, 0, "s0", "agent-writer");
    stores.queues.closeStep(task.taskId, "passed");
    stores.queues.advanceStep(task.taskId, 1);
    stores.queues.startStep(task.taskId, 1, "s1", "agent-reviewer");
    stores.queues.closeStep(task.taskId, "passed");

    const evid = makeEvidenceStore(stores, { "agent-writer": repo, "agent-reviewer": repo });
    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]).toMatchObject({ worktreeKey: sharedKey, branch: branchNameFor(sharedKey) });
    expect(result.provenance[0].agentIds.sort()).toEqual(["agent-reviewer", "agent-writer"]);
  });

  it("a NO-shared-workdir workflow (no roles, no critic gate) reports one provenance entry PER distinct agentId", async () => {
    const repo = initRepo();
    const stores = makeStores();
    const wf = stores.workflows.create({
      name: "plain-flow",
      steps: [
        { id: "s0", title: "build", gate: COMMAND_GATE },
        { id: "s1", title: "test", gate: COMMAND_GATE },
      ],
    });
    stores.queues.create({ name: "q1" });
    const task = stores.queues.push("q1", { prompt: "do work" });
    stores.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    addLiveWorktree(repo, "agent-build");
    addLiveWorktree(repo, "agent-test");
    stores.queues.startStep(task.taskId, 0, "s0", "agent-build");
    stores.queues.closeStep(task.taskId, "passed");
    stores.queues.advanceStep(task.taskId, 1);
    stores.queues.startStep(task.taskId, 1, "s1", "agent-test");
    stores.queues.closeStep(task.taskId, "passed");

    const evid = makeEvidenceStore(stores, { "agent-build": repo, "agent-test": repo });
    const result = await evid.getTaskEvidence(task.taskId);
    expect(result.provenance).toHaveLength(2);
    expect(result.provenance.map((p) => p.worktreeKey).sort()).toEqual(["agent-build", "agent-test"]);
  });
});
