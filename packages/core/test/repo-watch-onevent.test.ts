import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EventLog } from "@chimera/core/events";
import { RepoWatcher } from "@chimera/core/repo-watch";
import { makeEngineHome } from "./helpers.js";

// HOOK-5 (repo-watch.ts onEvent branches): repo-watch.test.ts already covers the
// `status` failed/killed/archived unwatch paths; this file exercises the two remaining
// onEvent branches — an agent settling DONE via a `result` event (unwatch), and a project
// going live via a `status` {state:"created", path} event (watch). All three injectable
// seams (fakeTimer/fakeWatch/fakeRevParse) are faked so the debounce/emit assertions are
// fully deterministic — no real git, no wall-clock sleeps (RepoWatcher's real-git resolution
// is exercised in repo-watch.test.ts).

function fakeTimer() {
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
  const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
  const flushAll = () => { const batch = pending; pending = []; for (const p of batch) p.fn(); };
  return { setTimer, clearTimer, flushAll, pending: () => pending };
}

function fakeWatch() {
  const listeners = new Map<string, () => void>();
  const closed = new Set<string>();
  const watchFn = (path: string, listener: () => void) => {
    listeners.set(path, listener);
    return { close: () => { closed.add(path); listeners.delete(path); } };
  };
  const fire = (path: string) => listeners.get(path)?.();
  return { watchFn, fire, listeners, closed };
}

// Deterministic stand-in for the real `git rev-parse` resolution: the test sets the
// branch/sha a repo currently resolves to, so no real repo or wall-clock settle is needed.
function fakeRevParse() {
  const state = new Map<string, { branch: string; sha: string } | null>();
  const revParse = async (repo: string) => state.get(repo) ?? null;
  const set = (repo: string, v: { branch: string; sha: string } | null) => state.set(repo, v);
  return { revParse, set };
}

// check() short-circuits on a missing `${repo}/.git` before it ever calls revParse — the fake
// repos here don't exist on disk, so the tests point `repo` at THIS repo's real root (which
// does have a .git) to get past that guard while still resolving via the fake revParse.
const REPO = process.cwd();
const REFS_HEADS = join(REPO, ".git", "refs", "heads");

function movedEvents(events: EventLog, repo: string) {
  return events.tail(`repo:${repo}`, 10).filter((e) => e.kind === "repo_head_moved");
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("RepoWatcher onEvent (HOOK-5): result + live-project-create branches", () => {
  it("uses a repo whose .git exists so check() reaches the (faked) revParse", () => {
    expect(existsSync(join(REPO, ".git"))).toBe(true);   // guards the REPO assumption above
  });

  it("an agent settling DONE via a `result` event unwatches its repo (last referencer leaves)", async () => {
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const git = fakeRevParse();
    git.set(REPO, { branch: "main", sha: "sha0" });
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: git.revParse });

    watcher.watch(REPO, "agent-1");
    timer.flushAll();
    await flushMicrotasks();   // baseline resolves (no emit)
    expect(watch.closed.size).toBe(0);

    // `result` is the agent-done terminal signal (distinct from the failed/killed `status`
    // path repo-watch.test.ts covers) — it must drop agent-1's ref and close the watch.
    events.append({ agentId: "agent-1", kind: "result", data: { text: "ok", costUsd: 0.01 } });
    expect(watch.closed.size).toBeGreaterThan(0);   // refs/heads + packed-refs handles closed

    // a subsequent fs event on the now-stale listener is a no-op: no debounce timer armed
    watch.fire(REFS_HEADS);
    expect(timer.pending()).toHaveLength(0);

    watcher.stop();
  });

  it("a `result` for one of two referencers leaves the repo watched for the other", async () => {
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const git = fakeRevParse();
    git.set(REPO, { branch: "main", sha: "sha0" });
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: git.revParse });

    watcher.watch(REPO, "agent-1");
    timer.flushAll();
    await flushMicrotasks();
    watcher.watch(REPO, "agent-2");   // second referencer, already primed — no new baseline trigger
    expect(timer.pending()).toHaveLength(0);

    events.append({ agentId: "agent-1", kind: "result", data: { text: "ok" } });
    expect(watch.closed.size).toBe(0);   // agent-2 still holds the repo open

    git.set(REPO, { branch: "main", sha: "sha1" });   // HEAD moved
    watch.fire(REFS_HEADS);
    timer.flushAll();
    await waitUntil(() => movedEvents(events, REPO).length === 1);
    expect(movedEvents(events, REPO)[0]!.data["to"]).toBe("sha1");

    watcher.stop();
  });

  it("a live project-create `status` {state:created, path} event starts watching that repo and emits on a later move", async () => {
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const git = fakeRevParse();
    git.set(REPO, { branch: "main", sha: "sha0" });
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn, revParse: git.revParse });

    // No seedProjects here — the project is registered AFTER boot, picked up live via the
    // ProjectStore-shaped `created` status event (the branch onEvent guards on state+path).
    events.append({ agentId: "project:p1", kind: "status", data: { project: "p1", state: "created", path: REPO, origin: null } });
    expect(timer.pending()).toHaveLength(1);   // the new watch's baseline-priming trigger
    expect(watch.listeners.has(REFS_HEADS)).toBe(true);
    timer.flushAll();
    await flushMicrotasks();   // baseline resolves, no event yet
    expect(movedEvents(events, REPO)).toHaveLength(0);

    git.set(REPO, { branch: "main", sha: "sha1" });
    watch.fire(REFS_HEADS);
    timer.flushAll();
    await waitUntil(() => movedEvents(events, REPO).length === 1);
    expect(movedEvents(events, REPO)[0]!.data).toMatchObject({ repo: REPO, branch: "main", from: "sha0", to: "sha1" });

    watcher.stop();
  });

  it("a `created` status WITHOUT a path is a no-op — nothing watched, no timer armed", () => {
    const events = new EventLog(makeEngineHome());
    const timer = fakeTimer();
    const watch = fakeWatch();
    const watcher = new RepoWatcher({ events, setTimer: timer.setTimer, clearTimer: timer.clearTimer, watch: watch.watchFn });

    // The onEvent create branch is guarded on `typeof path === "string"` — a malformed/
    // pathless created event must never arm a watch.
    events.append({ agentId: "project:p2", kind: "status", data: { project: "p2", state: "created" } });
    expect(timer.pending()).toHaveLength(0);
    expect(watch.listeners.size).toBe(0);

    watcher.stop();
  });
});
