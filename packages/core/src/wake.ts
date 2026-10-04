import { execFile, spawn } from "node:child_process";

import { WAKE_SETUP_HINT, type WakeConfig } from "@chimera/protocol";

/** The fixed, root-owned wrapper path. A CONSTANT, never derived from config or env: an
 *  operator-settable path is a path an attacker can point at their own binary, and this string is
 *  the exact one the sudo policy drop-in grants. */
export const WAKE_WRAPPER_PATH = "/usr/local/libexec/chimera-wake";
export const WAKE_PROBE_TIMEOUT_MS = 2_000;
export const WAKE_PROBE_TTL_MS = 60_000;
/** armTimer runs once per bounded hop (60 s [F02]) for as long as any job is scheduled. Without
 *  this the daemon would shell out to sudo every minute, forever. A wake target that moved by less
 *  than a minute is not worth a privileged round trip. */
export const WAKE_RESCHEDULE_EPSILON_MS = 60_000;

/** F01(b): argv is a CONTRACT, not a detail, and every word of it is load-bearing:
 *  `-i` idle sleep, `-m` disk sleep, `-w <pid>` ties the assertion's life to this daemon so a
 *  SIGKILLed or panicked chimerad can never leave a Mac pinned awake forever.
 *  `-s` is deliberately ABSENT: caffeinate(8) says it is "valid only when system is running on
 *  AC power", so on battery it would silently do nothing while we claimed a guarantee.
 *  `-d`/`-u` are deliberately ABSENT: a job running at 03:00 must not light the display or reset
 *  the user-idle timer. */
export const CAFFEINATE_PATH = "/usr/bin/caffeinate";
/** Absolute, never resolved through PATH: what runs with elevated rights must not be decided by
 *  whatever environment the daemon happened to inherit. */
export const SUDO_PATH = "/usr/bin/sudo";
/** The one operator step that turns slice (a) on. Surfaced verbatim by job_status. Re-exported,
 *  not re-declared: the app renders the same string as its degraded-wake fallback and cannot
 *  import core, so protocol owns the single spelling (F01-QA-3). */
export { WAKE_SETUP_HINT } from "@chimera/protocol";

/** Wrapper diagnostics go into a user-visible reason string, so they are bounded to one line and
 *  200 chars — an unbounded stderr would put a wall of text into the jobs panel. */
function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 200);
}
export function caffeinateArgs(pid: number): string[] {
  return ["-i", "-m", "-w", String(pid)];
}

export type WakeCapability = {
  available: boolean; platform: string;
  reason: string | null; setupHint: string | null;
};

/** Released when the run(s) end. `release()` MUST be idempotent — settleRun, delete and detach
 *  all reach it and those overlap. */
export type SleepHold = { release(): void };

export type WakeScheduler = {
  /** Cached by the CALLER (JobScheduler.wakeStatus); this always does the real check. Never
   *  throws, never prompts, never escalates. */
  probe(): Promise<WakeCapability>;
  /** Ask the OS to wake at `atMs`. Rejects only on a programming error; an unavailable wrapper is
   *  reported through the resolved value. */
  scheduleWake(atMs: number): Promise<{ ok: boolean; error?: string }>;
  cancelWake(atMs: number): Promise<{ ok: boolean; error?: string }>;
  /** null when the platform or config says no. */
  holdAwake(): SleepHold | null;
};

/** The two child-process calls this module makes, behind one injectable seam each — so every
 *  branch is provable with no real process, no sudo and no caffeinate. */
export type WakeExec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export type WakeSpawn = (file: string, args: string[]) => { kill(sig: string): void };

export const realWakeExec: WakeExec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const errCode = (err as { code?: unknown } | null)?.code;
      resolve({
        code: err ? (typeof errCode === "number" ? errCode : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (err ? err.message : ""),
      });
    });
  });

export const realWakeSpawn: WakeSpawn = (file, args) => {
  const child = spawn(file, args, { stdio: "ignore" });
  // A MISSING binary does not throw here — node reports ENOENT asynchronously as an 'error'
  // event, and an 'error' event with no listener is an uncaught exception that takes the whole
  // daemon down. A machine without /usr/bin/caffeinate must degrade to a logged no-op.
  child.on("error", () => {});
  // The daemon must be able to exit without waiting on this child; `-w <our pid>` is what
  // actually ends it.
  child.unref();
  return { kill: (sig) => { child.kill(sig as NodeJS.Signals); } };
};

/** Every non-darwin platform, and the `deps.wake` absent case in jobs.ts. Named rather than
 *  inlined so "no wake support" is one object with one honest reason string. */
export function makeNoopWakeScheduler(platform: string): WakeScheduler {
  const cap: WakeCapability = {
    available: false, platform,
    // On darwin this scheduler is only ever reached when the operator turned BOTH switches off, so
    // "macOS only" would be a lie there. Two honest reasons, one no-op object.
    reason: platform === "darwin"
      ? "wake support is turned off in config (wake.scheduleWake and wake.holdAwakeDuringRuns)"
      : "RTC wake scheduling is implemented for macOS only",
    setupHint: null,
  };
  return {
    probe: () => Promise.resolve(cap),
    scheduleWake: () => Promise.resolve({ ok: false, error: "unsupported platform" }),
    cancelWake: () => Promise.resolve({ ok: false, error: "unsupported platform" }),
    holdAwake: () => null,
  };
}

export const NOOP_WAKE_SCHEDULER: WakeScheduler = makeNoopWakeScheduler(process.platform);

export function makeWakeScheduler(
  cfg: WakeConfig,
  platform: string = process.platform,
  exec: WakeExec = realWakeExec,
  spawnFn: WakeSpawn = realWakeSpawn,
): WakeScheduler {
  if (platform !== "darwin") return makeNoopWakeScheduler(platform);

  // The operator installed the wrapper but turned the RTC half off. Answered BEFORE any exec, and
  // with setupHint null — pointing them at the installer would be wrong advice for a state they
  // chose. The caffeinate hold below is governed by its own switch and stays live.
  const disabled: WakeCapability = {
    available: false, platform,
    reason: "RTC wake scheduling is turned off in config (wake.scheduleWake: false)",
    setupHint: null,
  };

  /** The wrapper's argument grammar is a whitelist for `^YYYY-MM-DDThh:mm:ssZ$` — second
   *  resolution, UTC, no millis. Cancel matches the scheduled event by EXACT string, so both verbs
   *  must convert an epoch the same way, and truncation (not rounding) is what keeps a round trip
   *  through `wakeScheduledFor` stable. */
  const toIsoZ = (atMs: number): string => new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  /** `-n` is MANDATORY and is the whole reason this is safe to call unattended: it makes sudo fail
   *  immediately instead of ever prompting, so a daemon with no NOPASSWD rule degrades to
   *  "unavailable" rather than hanging forever on a password read from a tty it does not have. */
  const invoke = (verb: string, arg?: string) =>
    exec(SUDO_PATH, ["-n", WAKE_WRAPPER_PATH, verb, ...(arg !== undefined ? [arg] : [])],
      { timeoutMs: WAKE_PROBE_TIMEOUT_MS });

  const run = async (verb: string, atMs: number): Promise<{ ok: boolean; error?: string }> => {
    if (!cfg.scheduleWake) return { ok: false, error: disabled.reason ?? "disabled" };
    try {
      const r = await invoke(verb, toIsoZ(atMs));
      return r.code === 0 ? { ok: true } : { ok: false, error: firstLine(r.stderr) || `exit ${String(r.code)}` };
    } catch (err) {
      // The seam is injectable, so a broken fake (or an exec that throws synchronously) must not
      // become a rejected promise on the fire path.
      return { ok: false, error: (err as Error).message };
    }
  };

  return {
    async probe(): Promise<WakeCapability> {
      if (!cfg.scheduleWake) return disabled;
      let code: number | null = null;
      let stderr = "";
      try {
        const r = await invoke("probe");
        code = r.code; stderr = r.stderr;
      } catch (err) {
        stderr = (err as Error).message;
      }
      if (code === 0) return { available: true, platform, reason: null, setupHint: null };
      // A non-zero exit, a 2s timeout, a missing file and a missing sudo rule are ONE outcome:
      // "we cannot ask this machine to wake". Never a throw, never an escalation attempt.
      const detail = firstLine(stderr);
      return {
        available: false, platform,
        reason: `RTC wake requires root — no NOPASSWD rule for ${WAKE_WRAPPER_PATH}${detail ? ` (${detail})` : ""}`,
        setupHint: WAKE_SETUP_HINT,
      };
    },
    scheduleWake: (atMs) => run("schedule", atMs),
    cancelWake: (atMs) => run("cancel", atMs),

    holdAwake(): SleepHold | null {
      if (!cfg.holdAwakeDuringRuns) return null;
      let child: { kill(sig: string): void };
      try {
        child = spawnFn(CAFFEINATE_PATH, caffeinateArgs(process.pid));
      } catch {
        // A failed power assertion must NEVER fail the run it was taken for — the job still runs,
        // the machine may just sleep under it.
        return null;
      }
      let done = false;
      return {
        release() {
          // Idempotent by contract: settleRun, job.delete and detach all reach this and overlap.
          if (done) return;
          done = true;
          try { child.kill("SIGTERM"); } catch { /* already gone */ }
        },
      };
    },
  };
}
