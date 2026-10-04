import { execFile } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "./events.js";

// HOOK-5 (PLAN-HOOKS.md §5/§10): merge-to-main visibility with ZERO polling. Debounced
// fs.watch on a known main repo's .git/refs/heads + packed-refs; on change, resolve the
// checked-out branch's HEAD and diff it against the last known sha, emitting repo_head_moved
// only on a real move. Mirrors ConfigWatcher's injectable-seam / degrade-silently posture
// (configstore.ts:302-305 — a failing watch must never crash the daemon) and NotifyEvaluator's
// EventLog.subscribe wiring (notify.ts) — that ONE subscription both unwatches a
// settled/failed/killed agent's repo AND tracks a project's create/archive/delete, so no
// extra supervisor/engine call site is needed beyond the single `watch()` at spawn time.

export type WatchHandle = { close(): void };
export type WatchFn = (path: string, listener: () => void) => WatchHandle;
export type RevParseFn = (repo: string) => Promise<{ branch: string; sha: string } | null>;
export type TimerFn = (fn: () => void, ms: number) => unknown;
export type ClearTimerFn = (h: unknown) => void;

const DEFAULT_DEBOUNCE_MS = 500;

// Bounded like supervisor.ts's analogous git probes (WD Stage 1, execFile + timeout, no
// shell) — without a timeout a stuck/queued subprocess under concurrent-agent load never
// settles this promise, and check() then hangs forever waiting on it.
const GIT_TIMEOUT_MS = 5_000;

function run(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { timeout: GIT_TIMEOUT_MS }, (err: Error | null, stdout: string) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// Detached HEAD (no branch to name) and a missing/broken repo both reject → null, the
// "nothing to report this round" signal `check()` already treats as silent degrade.
// Exported so a test can exercise the GIT_TIMEOUT_MS bound directly (a hung git process
// must reject, not hang the caller forever).
export const defaultRevParse: RevParseFn = async (repo) => {
  const branch = await run(repo, ["symbolic-ref", "--short", "HEAD"]);
  const sha = await run(repo, ["rev-parse", "HEAD"]);
  return { branch, sha };
};

type RepoState = {
  refs: Set<string>;          // referencer ids (agentId, or "project:<name>") keeping this repo watched
  handles: WatchHandle[];
  timer: unknown;
  // undefined ⇒ no baseline resolved yet — the FIRST check() after watch() primes lastBranch/
  // lastSha but never emits (nothing to diff against); only the SECOND+ divergence is a real move.
  lastBranch: string | undefined;
  lastSha: string | undefined;
};

export class RepoWatcher {
  private repos = new Map<string, RepoState>();        // keyed by repo (mainRepo) path
  private refToRepos = new Map<string, Set<string>>(); // refId -> repo paths it's holding open
  private debounceMs: number;
  private setTimer: TimerFn;
  private clearTimer: ClearTimerFn;
  private watchFn: WatchFn;
  private revParse: RevParseFn;
  private unsubscribeEvents: () => void;

  constructor(private opts: {
    events: EventLog;
    debounceMs?: number;
    setTimer?: TimerFn;
    clearTimer?: ClearTimerFn;
    watch?: WatchFn;
    revParse?: RevParseFn;
  }) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.watchFn = opts.watch ?? ((p, l) => watch(p, l));
    this.revParse = opts.revParse ?? defaultRevParse;
    this.unsubscribeEvents = opts.events.subscribe((e) => this.onEvent(e));
  }

  // Seed watches for every already-registered, non-archived project at boot — called once
  // engine.ts's ProjectStore has loaded (constructed AFTER the supervisor/repoWatcher, so this
  // can't happen at construction time). Every project created/archived/deleted AFTER boot is
  // picked up live via the EventLog subscription in onEvent below.
  seedProjects(projects: Array<{ name: string; path: string; archived: boolean }>): void {
    for (const p of projects) if (!p.archived) this.watch(p.path, `project:${p.name}`);
  }

  // Register `refId`'s interest in `repo`. Idempotent per (repo, refId) pair. A repo already
  // watched by another referencer just gains a refcount; a brand-new repo gets fs.watch
  // handles + an initial (non-emitting) baseline resolution.
  watch(repo: string, refId: string): void {
    let held = this.refToRepos.get(refId);
    if (!held) { held = new Set(); this.refToRepos.set(refId, held); }
    if (held.has(repo)) return;
    held.add(repo);
    let state = this.repos.get(repo);
    if (state) { state.refs.add(refId); return; }
    state = { refs: new Set([refId]), handles: [], timer: null, lastBranch: undefined, lastSha: undefined };
    this.repos.set(repo, state);
    // A failing watch (deleted repo, permissions, no .git yet) must never crash the daemon —
    // best-effort, same posture as ConfigWatcher.start() (configstore.ts:302-305).
    try { state.handles.push(this.watchFn(join(repo, ".git", "refs", "heads"), () => this.trigger(repo))); } catch { /* best-effort */ }
    try { state.handles.push(this.watchFn(join(repo, ".git", "packed-refs"), () => this.trigger(repo))); } catch { /* best-effort */ }
    this.trigger(repo);   // establish the baseline within one debounce window — never emits itself
  }

  // Drop `refId`'s interest in every repo it registered. The last referencer leaving a repo
  // closes its watch handles and clears its debounce timer.
  unwatch(refId: string): void {
    const held = this.refToRepos.get(refId);
    if (!held) return;
    this.refToRepos.delete(refId);
    for (const repo of held) {
      const state = this.repos.get(repo);
      if (!state) continue;
      state.refs.delete(refId);
      if (state.refs.size > 0) continue;
      for (const h of state.handles) { try { h.close(); } catch { /* already closed */ } }
      if (state.timer !== null) this.clearTimer(state.timer);
      this.repos.delete(repo);
    }
  }

  // Test/shutdown hook: close every live watch and drop the EventLog subscription (mirrors
  // ConfigWatcher.stop()).
  stop(): void {
    for (const [, state] of this.repos) {
      for (const h of state.handles) { try { h.close(); } catch { /* already closed */ } }
      if (state.timer !== null) this.clearTimer(state.timer);
    }
    this.repos.clear();
    this.refToRepos.clear();
    this.unsubscribeEvents();
  }

  private trigger(repo: string): void {
    const state = this.repos.get(repo);
    if (!state) return;
    if (state.timer !== null) this.clearTimer(state.timer);
    state.timer = this.setTimer(() => {
      state.timer = null;
      void this.check(repo);
    }, this.debounceMs);
  }

  private async check(repo: string): Promise<void> {
    const state = this.repos.get(repo);
    if (!state) return;
    if (!existsSync(join(repo, ".git"))) return;   // deleted repo dir → silent degrade
    const r = await this.revParse(repo).catch(() => null);
    if (!r) return;                                 // git failure (detached HEAD, corrupt repo, ...) → silent degrade
    const { lastBranch, lastSha } = state;
    if (r.sha === lastSha && r.branch === lastBranch) return;
    state.lastBranch = r.branch;
    state.lastSha = r.sha;
    if (lastSha === undefined) return;               // first resolution after watch(): baseline only, no event
    this.opts.events.append({
      agentId: `repo:${repo}`, kind: "repo_head_moved",
      data: { repo, branch: r.branch, from: lastSha, to: r.sha },
    });
  }

  // The ONE EventLog subscription driving both halves of "unwatch on last referencing agent
  // gone": an agent settling terminal (done via `result`, failed/killed via `status`) drops its
  // agentId; a project's own lifecycle status events (ProjectStore) add/drop its `project:<name>`
  // referencer. Mirrors NotifyEvaluator's onEvent (notify.ts) — runs synchronously inside
  // EventLog.append's listener loop, so this must never throw or block.
  private onEvent(e: { agentId: string; kind: string; data: Record<string, unknown> }): void {
    if (e.kind === "result") { this.unwatch(e.agentId); return; }
    if (e.kind === "status") {
      const state = e.data["state"];
      if (state === "failed" || state === "killed") { this.unwatch(e.agentId); return; }
      const project = e.data["project"];
      if (typeof project === "string") {
        if (state === "created" && typeof e.data["path"] === "string") this.watch(e.data["path"] as string, `project:${project}`);
        else if (state === "archived" || state === "deleted") this.unwatch(`project:${project}`);
      }
    }
  }
}
