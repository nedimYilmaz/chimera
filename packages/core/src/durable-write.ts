import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// FEATURE-4 (snapshot durability): deps-injected exactly like reattach.ts's readFile/exists
// params, so tests can assert call order and simulate a crash mid-sequence (e.g. a renameSync
// that throws) without touching a real disk.
export type DurableWriteDeps = {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
};

export const realDurableWriteDeps: DurableWriteDeps = { openSync, writeSync, fsyncSync, closeSync, renameSync };

// Crash-safe replace-file-contents: write a sibling temp file, fsync its data, atomically
// rename it over the target, then fsync the CONTAINING DIRECTORY so the rename itself is
// durable too — a rename that only ever made it into the page cache can be rolled back by an
// unclean shutdown, silently leaving the OLD file in place even though this function already
// returned. Both fsyncs are required; either alone leaves a gap (data-without-rename, or
// rename-without-durable-data).
export function writeFileDurable(
  targetPath: string, data: string, deps: DurableWriteDeps = realDurableWriteDeps, platform: NodeJS.Platform = process.platform,
): void {
  const tmpPath = `${targetPath}.tmp`;
  const fd = deps.openSync(tmpPath, "w");
  try {
    deps.writeSync(fd, data);
    deps.fsyncSync(fd);
  } finally {
    deps.closeSync(fd);
  }
  deps.renameSync(tmpPath, targetPath);
  fsyncDirectory(dirname(targetPath), deps, platform);
}

// Makes a rename inside `dir` durable. Windows refuses fsync on a directory handle (EPERM), which
// failed the daemon's first state write so it never came up; NTFS journals the rename's metadata
// itself, so there is nothing to flush there.
export function fsyncDirectory(dir: string, deps: DurableWriteDeps = realDurableWriteDeps, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  fsyncPathDurable(dir, deps);
}

// fsync a path that's already fully written (a sealed segment, a directory-after-rename, ...) —
// fsync doesn't care that this is a freshly-opened fd rather than the one that did the writing,
// only that it references the same inode. Shared by EventLog.rotate() (sealed file + eventsDir)
// and anything else that needs to make an already-durable-on-disk write ALSO durable against an
// unclean shutdown (i.e. force the dirty page out of the OS cache).
export function fsyncPathDurable(path: string, deps: DurableWriteDeps = realDurableWriteDeps): void {
  const fd = deps.openSync(path, "r");
  try {
    deps.fsyncSync(fd);
  } finally {
    deps.closeSync(fd);
  }
}

// R2-DURABLE-LOG: the append-only-log durability primitive shared by EventLog and MailboxStore
// (both are "append-only recovery-critical log, one file per stream" with identical needs).
//
// The data WRITE is always synchronous (openSync+writeSync+closeSync completes before append()
// returns) in BOTH modes — a reader doing readFileSync right after append() always sees the new
// line, exactly like the bare appendFileSync this replaces. Only the FSYNC (durability against an
// unclean shutdown / power loss, not against a normal process exit) is mode-dependent:
//   "fsync-always"  — fsyncSync happens synchronously inside append() itself, every call. Max
//                      durability, one extra fsync per append.
//   "group-commit"  — append() skips the fsync; a pending counter tracks unflushed appends and
//                      either flush()es immediately (count hit groupCommitMaxBatch) or arms a
//                      timer (groupCommitMs) if none is armed yet. Bounds the worst-case
//                      durability-lag window without paying a per-append fsync.
//
// Deliberately no long-lived fd: every append()/flush() opens the path fresh and closes it. A
// long-lived fd would go stale the moment a caller (EventLog.rotate()) renames the path out from
// under it; re-opening by path on every call sidesteps that class of bug entirely, at the cost of
// a few extra syscalls (irrelevant next to the fsync cost this whole primitive exists to batch).
export type DurabilityMode = "fsync-always" | "group-commit";
export type TimerFn = (fn: () => void, ms: number) => unknown;   // mirrors notify.ts's TimerFn
export type ClearTimerFn = (h: unknown) => void;

export type DurableAppendLogOptions = {
  mode: DurabilityMode;
  groupCommitMs: number;
  groupCommitMaxBatch: number;
  deps?: DurableWriteDeps;
  setTimer?: TimerFn;
  clearTimer?: ClearTimerFn;
};

export class DurableAppendLog {
  private path: string;
  private mode: DurabilityMode;
  private groupCommitMs: number;
  private groupCommitMaxBatch: number;
  private deps: DurableWriteDeps;
  private setTimer: TimerFn;
  private clearTimer: ClearTimerFn;
  private pendingCount = 0;
  private timerHandle: unknown = null;

  constructor(path: string, opts: DurableAppendLogOptions) {
    this.path = path;
    this.mode = opts.mode;
    this.groupCommitMs = opts.groupCommitMs;
    this.groupCommitMaxBatch = opts.groupCommitMaxBatch;
    this.deps = opts.deps ?? realDurableWriteDeps;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  append(line: string): void {
    const fd = this.deps.openSync(this.path, "a");
    try {
      this.deps.writeSync(fd, line);
      if (this.mode === "fsync-always") {
        this.deps.fsyncSync(fd);   // synchronous — a failure here throws straight to the caller, no batching to hide it behind
        return;
      }
    } finally {
      this.deps.closeSync(fd);
    }
    // group-commit: data is already durable-to-page-cache (write+close above); only the fsync
    // barrier is deferred.
    this.pendingCount++;
    if (this.pendingCount >= this.groupCommitMaxBatch) {
      this.flush();
    } else if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => this.flush(), this.groupCommitMs);
    }
  }

  // Force any pending fsync now + clear the pending timer. Idempotent (no-op if nothing
  // pending). Called by rotate() before sealing a segment, by flushDurable() on shutdown, and
  // by append() itself once a batch/timer threshold is hit. A failure here is logged and
  // swallowed (not thrown) when it fires from the timer callback — there is no caller left to
  // propagate to by then (mirrors reattach.ts's fire-and-forget `.catch` convention).
  flush(): void {
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.pendingCount === 0) return;
    this.pendingCount = 0;
    try {
      fsyncPathDurable(this.path, this.deps);
    } catch (err) {
      console.error(`chimera: deferred fsync failed for ${this.path}: ${String((err as Error).message)}`);
    }
  }

  close(): void {
    this.flush();
  }
}
