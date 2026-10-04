import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { EventLog } from "@chimera/core/events";
import { RepoWatcher, defaultRevParse, type RevParseFn } from "@chimera/core/repo-watch";
import { makeEngineHome } from "./helpers.js";

// Manual fake timer (mirrors ConfigWatcher's own test seam in config-d7.test.ts /
// notify.test.ts's fakeTimer): setTimer pushes {id, fn}; the test flushes it explicitly
// instead of waiting on a real clock — makes debounce/coalesce assertions deterministic.
function fakeTimer() {
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
  const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
  const flushAll = () => { const batch = pending; pending = []; for (const p of batch) p.fn(); };
  return { setTimer, clearTimer, flushAll, pending: () => pending };
}

// Captures the listener registered per watched path instead of touching real fs.watch —
// the test drives "a ref changed" by calling fire(path) itself. Real git commands still run
// against a real temp repo, so the resolved branch/sha in every assertion is real.
function fakeWatch() {
  const listeners = new Map<string, () => void>();
  const closed = new Set<string>();
  const watchFn = (path: string, listener: () => void) => {
    listeners.set(path, listener);
    return { close: () => { closed.add(path); listeners.delete(path); } };
  };
  const fire = (path: string) => listeners.get(path)?.();
  const fireAll = () => { for (const l of [...listeners.values()]) l(); };
  return { watchFn, fire, fireAll, listeners, closed };
}

function realGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-repo-watch-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "chimera", GIT_AUTHOR_EMAIL: "chimera@localhost",
    GIT_COMMITTER_NAME: "chimera", GIT_COMMITTER_EMAIL: "chimera@localhost",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir, env });
  return dir;
}

function commit(repo: string, file: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "chimera", GIT_AUTHOR_EMAIL: "chimera@localhost",
    GIT_COMMITTER_NAME: "chimera", GIT_COMMITTER_EMAIL: "chimera@localhost",
  };
  writeFileSync(join(repo, file), "content\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  execFileSync("git", ["commit", "-q", "-m", file], { cwd: repo, env });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function headSha(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function movedEvents(events: EventLog, repo: string) {
  return events.tail(`repo:${repo}`, 10).filter((e) => e.kind === "repo_head_moved");
}

// Wraps defaultRevParse so a test can deterministically wait for the real (async, real-`git`)
// baseline resolution to settle instead of guessing with a fixed sleep. Under load a `git` spawn
// can take far longer than any fixed sleep budget — REPO-WATCH-TEST-HANGS traced the 3 tests that
// hung to exactly this: a `sleep(80)` meant to let the priming baseline settle wasn't enough, so
// the test's `commit()` landed WHILE that first check() was still awaiting its git subprocess.
// The baseline read then resolved to the POST-commit sha, silently absorbing it as "the baseline"
// (RepoState's documented undefined-lastSha behavior) instead of ever emitting a move — and the
// following `waitUntil` polled for an event that could now never arrive, for its full timeout.
function trackedRevParse(): { fn: RevParseFn; settle: () => Promise<void> } {
  const inflight = new Set<Promise<unknown>>();
  const fn: RevParseFn = (repo) => {
    const p = defaultRevParse(repo);
    inflight.add(p);
    p.catch(() => {}).finally(() => inflight.delete(p));
    return p;
  };
  const settle = async () => { while (inflight.size > 0) await Promise.allSettled([...inflight]); };
  return { fn, settle };
}

// CORE-SUITE-BASELINE: every test shells out to real `git` for the async baseline/branch
// resolution — under this machine's concurrent-agent load the already-generous 30_000ms
// per-test overrides below still weren't enough at peak load; widened to 60_000ms, and a
// file-level default added for the tests with no explicit override.
vi.setConfig({ testTimeout: 45_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, timeoutMs = 140_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(5);
  }
}

describe("RepoWatcher (HOOK-5)", () => {
  it("a commit produces exactly one repo_head_moved event after the debounce fires", { timeout: 150_000 }, async () => {
    const repo = realGitRepo();
    const baseline = headSha(repo);
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const rp = trackedRevParse();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: rp.fn });

    watcher.watch(repo, "agent-1");
    expect(timer.pending()).toHaveLength(1);   // the baseline-priming trigger
    timer.flushAll();
    // wait for the baseline's async git resolution to actually settle before asserting nothing
    // fired for it (and before the commit below can race past it — see trackedRevParse)
    await rp.settle();
    expect(movedEvents(events, repo)).toHaveLength(0);

    const newSha = commit(repo, "a.txt");
    watch.fire(join(repo, ".git", "refs", "heads"));
    expect(timer.pending()).toHaveLength(1);
    timer.flushAll();

    await waitUntil(() => movedEvents(events, repo).length === 1);
    const fired = movedEvents(events, repo);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data).toMatchObject({ repo, branch: "main", from: baseline, to: newSha });

    watcher.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("a rapid double-commit coalesces into exactly one event carrying the LATEST sha", { timeout: 150_000 }, async () => {
    const repo = realGitRepo();
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const rp = trackedRevParse();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: rp.fn });

    watcher.watch(repo, "agent-1");
    timer.flushAll();
    await rp.settle();   // let the baseline resolution actually settle before the commit below

    commit(repo, "a.txt");
    watch.fire(join(repo, ".git", "refs", "heads"));
    expect(timer.pending()).toHaveLength(1);

    const finalSha = commit(repo, "b.txt");
    watch.fire(join(repo, ".git", "refs", "heads"));
    // the second fire cleared the first timer and armed a new one — still exactly one pending
    expect(timer.pending()).toHaveLength(1);

    timer.flushAll();
    await waitUntil(() => movedEvents(events, repo).length === 1);
    const fired = movedEvents(events, repo);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data["to"]).toBe(finalSha);

    watcher.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("a deleted repo dir degrades silently — no event, no throw", async () => {
    const repo = realGitRepo();
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn });

    watcher.watch(repo, "agent-1");
    timer.flushAll();
    await sleep(80);

    rmSync(repo, { recursive: true, force: true });
    watch.fire(join(repo, ".git", "refs", "heads"));
    expect(timer.pending()).toHaveLength(1);
    expect(() => timer.flushAll()).not.toThrow();
    await sleep(80);

    expect(movedEvents(events, repo)).toHaveLength(0);
    watcher.stop();
  });

  it("unwatch (agent settling failed/killed, or done via `result`) closes the watch when the last referencer leaves", async () => {
    const repo = realGitRepo();
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn });

    watcher.watch(repo, "agent-1");
    timer.flushAll();
    await sleep(80);
    expect(watch.closed.size).toBe(0);

    events.append({ agentId: "agent-1", kind: "status", data: { state: "failed" } });
    expect(watch.closed.size).toBeGreaterThan(0);   // refs/heads + packed-refs handles both closed

    // a subsequent fs event on the (now stale) listener must be a no-op: no timer armed
    watch.fire(join(repo, ".git", "refs", "heads"));
    expect(timer.pending()).toHaveLength(0);

    watcher.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("two referencers on the same repo: unwatching one leaves the watch live for the other", { timeout: 150_000 }, async () => {
    const repo = realGitRepo();
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const rp = trackedRevParse();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: rp.fn });

    watcher.watch(repo, "agent-1");
    timer.flushAll();
    await rp.settle();
    watcher.watch(repo, "agent-2");   // same repo, second referencer — no new baseline trigger (already primed)
    expect(timer.pending()).toHaveLength(0);

    events.append({ agentId: "agent-1", kind: "status", data: { state: "killed" } });
    expect(watch.closed.size).toBe(0);   // agent-2 still holds the repo open

    const newSha = commit(repo, "a.txt");
    watch.fire(join(repo, ".git", "refs", "heads"));
    timer.flushAll();
    await waitUntil(() => movedEvents(events, repo).length === 1);
    expect(movedEvents(events, repo)[0]!.data["to"]).toBe(newSha);

    watcher.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("seedProjects watches every non-archived project and picks up create/archive live via EventLog", async () => {
    const repo = realGitRepo();
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn });

    watcher.seedProjects([{ name: "p1", path: repo, archived: false }]);
    expect(timer.pending()).toHaveLength(1);   // baseline trigger for the seeded project
    timer.flushAll();
    await sleep(80);

    events.append({ agentId: "project:p1", kind: "status", data: { project: "p1", state: "archived" } });
    expect(watch.closed.size).toBeGreaterThan(0);

    watcher.stop();
    rmSync(repo, { recursive: true, force: true });
  });

  it("a hung git subprocess times out instead of hanging revParse forever", { timeout: 30_000 }, async () => {
    // Shadow `git` on PATH with a script that never exits (simulates a spawn stuck/queued
    // under concurrent-agent load) — before the run() timeout, this would hang the returned
    // promise indefinitely and check() would never settle.
    const binDir = mkdtempSync(join(tmpdir(), "chimera-fake-git-"));
    const fakeGit = join(binDir, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nsleep 30\n");
    chmodSync(fakeGit, 0o755);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}${delimiter}${originalPath ?? ""}`;

    try {
      const start = Date.now();
      await expect(defaultRevParse(tmpdir())).rejects.toThrow();
      const elapsed = Date.now() - start;
      // Bounded by the 5s execFile timeout, nowhere near the fake git's 30s sleep.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      process.env["PATH"] = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
