import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import {
  CheckpointStore, NotAGitRepoError, UnknownCheckpointError, CheckpointBusyError,
} from "@chimera/core/checkpoints";

// D16 (checkpoints, coverage §C18, F20): git-plumbing checkpoint create/list/revert/
// status/gc, driven against REAL git repos (mirrors supervisor-gitbranch.test.ts's real
// `git` integration style — no injected exec seam, this module IS a thin git wrapper).

// CORE-SUITE-BASELINE: every test in this file shells out to real `git` — under this
// machine's concurrent-agent load a subprocess spawn can exceed vitest's 5000ms default;
// widened per existing precedent (supervisor-crash-loop.test.ts, supervisor-session-limit.test.ts).
vi.setConfig({ testTimeout: 45_000 });

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "chimera-ckpt-repo-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed"], { stdio: "ignore" });
  return repo;
}

function makeStore(opts: { isRepoBusy?: () => boolean; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-ckpt-home-"));
  const events = new EventLog(dir);
  return new CheckpointStore({ events, isRepoBusy: opts.isRepoBusy ?? (() => false), now: opts.now });
}

describe("CheckpointStore.status — non-git cwd stays dark", () => {
  it("returns {supported:false} for a directory that isn't a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ckpt-plain-"));
    const store = makeStore();
    expect(await store.status(dir)).toEqual({ supported: false, cwd: dir });
  });

  it("returns {supported:true, count, latest} for a git repo", async () => {
    const repo = initRepo();
    const store = makeStore();
    expect(await store.status(repo)).toMatchObject({ supported: true, cwd: repo, count: 0, latest: null });
    const rec = await store.create({ cwd: repo, trigger: "manual" });
    expect(await store.status(repo)).toMatchObject({ supported: true, count: 1, latest: rec });
  });
});

describe("CheckpointStore.create — git plumbing only", () => {
  it("never touches HEAD/index/history: the commit is unreachable from `git log`, only for-each-ref sees it", async () => {
    const repo = initRepo();
    const headBefore = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo, "untracked.txt"), "new-and-unstaged");   // present at checkpoint time, never added to the REAL index

    const store = makeStore();
    const rec = await store.create({ cwd: repo, trigger: "manual", agentId: "agent-1", taskId: "task-1" });
    expect(rec).toMatchObject({ id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", agentId: "agent-1", taskId: "task-1" });

    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(headBefore);
    // "normal" git log walks from HEAD only — a checkpoint ref (outside refs/heads) is
    // unreachable from it, so the checkpoint commit's own sha never appears there.
    const checkpointSha = execFileSync("git", ["-C", repo, "rev-parse", rec.ref], { encoding: "utf8" }).trim();
    const log = execFileSync("git", ["-C", repo, "log", "--format=%H"], { encoding: "utf8" });
    expect(log.split("\n")).not.toContain(checkpointSha);
    // but for-each-ref (or `git log --all`, which walks every ref/) does see it
    const forEachRef = execFileSync("git", ["-C", repo, "for-each-ref", "refs/chimera/checkpoints/"], { encoding: "utf8" });
    expect(forEachRef).toContain(rec.ref);
    // the REAL index is untouched: untracked.txt still shows up as untracked, not staged
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.trim()).toBe("?? untracked.txt");
  });

  it("captures untracked files into the snapshot tree", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "untracked.txt"), "captured");
    const store = makeStore();
    const rec = await store.create({ cwd: repo, trigger: "manual" });
    const lsTree = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", rec.ref], { encoding: "utf8" });
    expect(lsTree.split("\n")).toContain("untracked.txt");
  });

  it("ignores transient agent worktrees even without a project gitignore", async () => {
    const repo = initRepo();
    const nested = join(repo, ".chimera", "worktrees", "starting-agent");
    mkdirSync(nested, { recursive: true });
    // A worktree being initialized has no checked-out commit yet. Plain add -A
    // fails here, as it does when queue workers create/remove nested worktrees.
    execFileSync("git", ["-C", nested, "init"], { stdio: "ignore" });
    writeFileSync(join(repo, ".chimera", "project.json"), "project configuration");
    writeFileSync(join(repo, "source.txt"), "source");
    const rec = await makeStore().create({ cwd: repo, trigger: "task_start" });
    const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", rec.ref], { encoding: "utf8" });
    expect(files.split("\n").filter(Boolean)).toEqual([".chimera/project.json", "source.txt"]);
    expect(existsSync(join(nested, ".git"))).toBe(true);
  });

  it("assigns sequential ids per repo and lists newest-first", async () => {
    const repo = initRepo();
    const store = makeStore();
    const a = await store.create({ cwd: repo, trigger: "task_start" });
    const b = await store.create({ cwd: repo, trigger: "destructive_bash" });
    const c = await store.create({ cwd: repo, trigger: "manual" });
    expect([a.id, b.id, c.id]).toEqual(["1", "2", "3"]);
    const list = await store.list(repo);
    expect(list.map((r) => r.id)).toEqual(["3", "2", "1"]);
    expect(list.map((r) => r.trigger)).toEqual(["manual", "destructive_bash", "task_start"]);
  });

  it("works against an unborn HEAD (root commit, no parent)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-ckpt-unborn-"));
    execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "ignore" });
    writeFileSync(join(repo, "f.txt"), "x");
    const store = makeStore();
    const rec = await store.create({ cwd: repo, trigger: "manual" });
    expect(rec.id).toBe("1");
    const list = await store.list(repo);
    expect(list).toHaveLength(1);
  });

  it("throws NotAGitRepoError for a non-git cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ckpt-notgit-"));
    const store = makeStore();
    await expect(store.create({ cwd: dir, trigger: "manual" })).rejects.toThrow(NotAGitRepoError);
  });

  it("emits checkpoint_created", async () => {
    const repo = initRepo();
    const dir = mkdtempSync(join(tmpdir(), "chimera-ckpt-evt-"));
    const events = new EventLog(dir);
    const store = new CheckpointStore({ events, isRepoBusy: () => false });
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "checkpoint_created") seen.push(e.data); });
    const rec = await store.create({ cwd: repo, trigger: "manual", agentId: "a1" });
    // data.cwd is the git-resolved (symlink-free) toplevel — realpathSync(repo) mirrors
    // that resolution for the raw tmpdir path (macOS: /var/... is a symlink to /private/var/...).
    expect(seen).toEqual([{ id: rec.id, ref: rec.ref, trigger: "manual", ts: rec.ts, agentId: "a1", taskId: null, cwd: realpathSync(repo) }]);
  });
});

describe("CheckpointStore.revert — restores the working tree, never rewrites history", () => {
  it.each([false, true])("preserves runtime files when restoring a checkpoint (legacy tree: %s)", async legacy => {
    const repo = initRepo();
    const runtime = join(repo, ".chimera", "worktrees");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(repo, "source.txt"), "before");
    writeFileSync(join(runtime, "runtime.txt"), "before");
    const store = makeStore();
    let id: string;
    if (legacy) {
      // An older checkpoint may already contain runtime data; restore must also
      // protect that path when reading a pre-fix checkpoint tree.
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "legacy tree"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "update-ref", "refs/chimera/checkpoints/1", "HEAD"]);
      id = "1";
    } else id = (await store.create({ cwd: repo, trigger: "manual" })).id;
    writeFileSync(join(repo, "source.txt"), "after");
    writeFileSync(join(runtime, "runtime.txt"), "after");
    writeFileSync(join(runtime, "new-runtime.txt"), "new session");
    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const result = await store.revert(repo, id);
    expect(readFileSync(join(repo, "source.txt"), "utf8")).toBe("before");
    expect(readFileSync(join(runtime, "runtime.txt"), "utf8")).toBe("after");
    expect(readFileSync(join(runtime, "new-runtime.txt"), "utf8")).toBe("new session");
    expect(readFileSync(join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(result.restoredFiles).toBe(1);
  });

  it("restores modified, deleted, and newly-created files to the marker state", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "keep.txt"), "keep-v1");
    writeFileSync(join(repo, "will-delete.txt"), "still-here-at-checkpoint");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed2"], { stdio: "ignore" });

    const store = makeStore();
    const rec = await store.create({ cwd: repo, trigger: "manual" });
    const headBefore = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    writeFileSync(join(repo, "keep.txt"), "keep-v2-modified-after-checkpoint");
    rmSync(join(repo, "will-delete.txt"));
    writeFileSync(join(repo, "new-since-checkpoint.txt"), "should vanish on revert");

    const result = await store.revert(repo, rec.id);
    expect(result).toMatchObject({ id: rec.id, ref: rec.ref });

    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep-v1");
    expect(existsSync(join(repo, "will-delete.txt"))).toBe(true);
    expect(readFileSync(join(repo, "will-delete.txt"), "utf8")).toBe("still-here-at-checkpoint");
    expect(existsSync(join(repo, "new-since-checkpoint.txt"))).toBe(false);
    // never rewrites history: HEAD is exactly where it was
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(headBefore);
  });

  it("refuses while the repo is busy, and unblocks once it isn't (kill-first guard)", async () => {
    const repo = initRepo();
    let busy = true;
    const store = makeStore({ isRepoBusy: () => busy });
    const rec = await store.create({ cwd: repo, trigger: "manual" });

    await expect(store.revert(repo, rec.id)).rejects.toThrow(CheckpointBusyError);
    busy = false;   // "killing the agent" in the real system flips this via supervisor.list()
    await expect(store.revert(repo, rec.id)).resolves.toMatchObject({ id: rec.id });
  });

  it("throws UnknownCheckpointError for an id with no matching ref", async () => {
    const repo = initRepo();
    const store = makeStore();
    await expect(store.revert(repo, "999")).rejects.toThrow(UnknownCheckpointError);
  });

  it("throws NotAGitRepoError for a non-git cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ckpt-notgit2-"));
    const store = makeStore();
    await expect(store.revert(dir, "1")).rejects.toThrow(NotAGitRepoError);
  });

  it("emits checkpoint_reverted", async () => {
    const repo = initRepo();
    const homeDir = mkdtempSync(join(tmpdir(), "chimera-ckpt-evt2-"));
    const events = new EventLog(homeDir);
    const store = new CheckpointStore({ events, isRepoBusy: () => false });
    const rec = await store.create({ cwd: repo, trigger: "manual" });
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "checkpoint_reverted") seen.push(e.data); });
    await store.revert(repo, rec.id);
    expect(seen).toEqual([{ id: rec.id, ref: rec.ref, cwd: realpathSync(repo) }]);
  });
});

describe("CheckpointStore gc — keeps last 20 / 24h", () => {
  it("trims beyond the newest 20 (oldest evicted first)", { timeout: 90_000 }, async () => {
    // 25 sequential real-git checkpoints (several subprocess spawns each) — slow under a
    // parallel full-suite run, hence the generous timeout; the plumbing itself is fast.
    // CORE-SUITE-BASELINE: this per-test override previously sat BELOW the file's
    // vi.setConfig default (20_000, now 45_000) — a per-test timeout wins over
    // vi.setConfig, so it was silently capping this, the single heaviest test in the
    // file (25x the subprocess count of its siblings), at the file's OLD, lower ceiling.
    // Raised well above the file default to reflect its proportionally larger real cost.
    const repo = initRepo();
    let now = 1_000_000;
    const store = makeStore({ now: () => now });
    for (let i = 0; i < 25; i++) { await store.create({ cwd: repo, trigger: "manual" }); now += 1_000; }
    const list = await store.list(repo);
    expect(list).toHaveLength(20);
    const ids = list.map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));   // 1..5 evicted, 6..25 survive
  });

  it("evicts checkpoints older than 24h even when under the count cap", async () => {
    const repo = initRepo();
    let now = 0;
    const store = makeStore({ now: () => now });
    const old = await store.create({ cwd: repo, trigger: "manual" });
    now = 25 * 60 * 60 * 1000;   // +25h
    const recent = await store.create({ cwd: repo, trigger: "manual" });
    const list = await store.list(repo);
    expect(list.map((r) => r.id)).toEqual([recent.id]);
    expect(list.map((r) => r.id)).not.toContain(old.id);
  });
});
