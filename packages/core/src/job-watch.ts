// JOB-WATCH — supervising a long-running command whose OUTPUT is the signal.
//
// The scheduled-command target answers "do this every N minutes". This answers the other half:
// "keep this running and tell me when it says something". A `tail -F`, a `kubectl get -w`, a queue
// consumer, a log follower — things that already stream exactly the event you want an agent to
// react to, and that an agent would otherwise have to poll for on a timer, paying a turn each time
// to discover nothing happened.
//
// Supervised, not fire-and-forget: a monitor that quietly died is indistinguishable from one
// reporting nothing, and that is the failure mode that makes people stop trusting alerts. It is
// restarted with backoff and both the start and the death are events.

import { spawn } from "node:child_process";

export type WatchTarget = { command: string; cwd?: string; env?: Record<string, string> };

/** A running watch. `stop()` must be idempotent — the scheduler calls it on disable, on delete, on
 *  replace, and on shutdown, and those overlap. */
export type WatchHandle = { stop(): void; pid: number | null };

/** The process seam. Tests drive a watcher's whole lifecycle — lines, exit, restart — without a
 *  real process, exactly as CommandRunner does for the scheduled path. */
export type WatchSpawner = (
  target: WatchTarget,
  onLine: (line: string) => void,
  onExit: (code: number | null) => void,
) => WatchHandle;

/** A single line longer than this is truncated. An unbounded line (a process printing a megabyte
 *  with no newline) would otherwise accumulate in memory with nothing to flush it. */
const MAX_LINE = 8_000;

export const spawnWatchProcess: WatchSpawner = (target, onLine, onExit) => {
  // A LOGIN shell for the same reason the scheduled runner uses one: these commands are written the
  // way an operator would type them, and reach for tools on an interactive PATH.
  const child = spawn(target.command, {
    shell: process.env["SHELL"] ?? "/bin/sh",
    cwd: target.cwd,
    env: { ...process.env, ...(target.env ?? {}) },
    // Own process group, so stop() kills the whole tree. A `tail -F | grep` left half-alive is
    // exactly the leak this feature would otherwise create, once per restart, forever.
    detached: true,
  });

  let buf = "";
  const take = (chunk: Buffer): void => {
    buf += chunk.toString();
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.length > 0) onLine(line.slice(0, MAX_LINE));
    }
    // Guard against a producer that never emits a newline.
    if (buf.length > MAX_LINE * 2) { onLine(buf.slice(0, MAX_LINE)); buf = ""; }
  };
  child.stdout?.on("data", take);
  // stderr is watched too: a monitor's interesting line is as likely to be a warning as a result,
  // and dropping it would make the trigger silently miss half of what the process says.
  child.stderr?.on("data", take);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    // SIGTERM first so the process can clean up; SIGKILL only if it ignores it.
    const hard = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 2_000);
    hard.unref?.();
  };

  child.on("error", () => { if (!stopped) onExit(null); });
  child.on("close", (code) => {
    // A stop() we initiated is not a death to report or restart from.
    if (!stopped) onExit(code);
  });

  return { stop, pid: child.pid ?? null };
};
