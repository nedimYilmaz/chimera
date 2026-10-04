import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeSetupHook } from "@chimera/protocol";
import { splitCommand } from "./hooks.js";

export class WorktreeSetupError extends Error {
  code = "guardrail" as const;
  name = "WorktreeSetupError";
  // Carried on the error, not just in the message, so a spawn that JOINED an in-flight setup
  // (AgentSupervisor.setupInFlight) can mirror the leader's real outcome — without these a
  // joiner's fail event would say "exit null" for a hook that plainly exited 1.
  constructor(message: string, readonly exitCode: number | null = null, readonly timedOut = false, readonly stderrTail = "") {
    super(message);
  }
}

// One "worktree_setup" event per call — the caller (AgentSupervisor.launch, T1) owns stamping
// agentId/kind; this module only decides WHAT happened, never WHERE it's logged.
export type WorktreeSetupSink = (data: Record<string, unknown>) => void;

const KILL_GRACE_MS = 10_000;
const HARD_CEILING_GRACE_MS = 30_000;
const FLUSH_INTERVAL_MS = 500;
const MAX_CHUNK_EVENTS = 40;
const MAX_CHUNK_CHARS = 4000;
// GATE-FAILURE-DISCARDS-ITS-OWN-DIAGNOSTICS (scheduler.ts) — same head+tail cap discipline,
// duplicated here rather than imported so this file stays dependency-light (doesn't pull
// scheduler.ts's much larger graph in just for one helper).
const STREAM_CAP = 1000;
const HEAD_CAP = Math.ceil(STREAM_CAP * 0.6);
const TAIL_CAP = STREAM_CAP - HEAD_CAP;
// How much of the captured output rides along on the terminal `fail` event for the transcript.
const FAIL_TAIL_CHARS = 1000;

// The cap must apply DURING accumulation, not at format time: a chatty hook (verbose install,
// progress bar) streams for up to timeoutSec (max 900s), so holding every chunk to trim it once
// the child is dead balloons daemon RSS by hundreds of MB. Head/tail split and marker wording
// match the old format-time helper exactly, so messages under the cap are byte-identical.
export class BoundedCapture {
  private head = "";
  private tail = "";
  private omitted = 0;

  push(text: string): void {
    let rest = text;
    if (this.head.length < HEAD_CAP) {
      const room = HEAD_CAP - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    if (this.tail.length > TAIL_CAP) {
      this.omitted += this.tail.length - TAIL_CAP;
      this.tail = this.tail.slice(this.tail.length - TAIL_CAP);
    }
  }

  get omittedChars(): number {
    return this.omitted;
  }

  render(): string {
    if (this.omitted === 0) return this.head + this.tail;
    return `${this.head}\n...[${this.omitted} chars truncated]...\n${this.tail}`;
  }
}

function formatFailure(stdout: string, stderr: string, fallback: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  const parts: string[] = [];
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (!parts.length) parts.push(fallback);
  return parts.join("\n\n");
}

// A linked worktree's `.git` is a FILE whose sole line is "gitdir: <abs path to
// mainRepo/.git/worktrees/<name>>" (verified live) — the main checkout's `.git` is a DIRECTORY.
// Returns null for the main checkout (a hook must never mark it — mirrors
// setupWorktreeNodeModules's main-checkout refusal, workdir.ts) or an unreadable `.git`.
export function setupMarkerPath(workdir: string): string | null {
  const gitPath = join(workdir, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return null;
  let contents: string;
  try {
    contents = readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!m) return null;
  return join(m[1]!.trim(), "chimera-worktree-setup.json");
}

// Drops EVERY /^CHIMERA_/ key before handing the environment to an untrusted, daemon-privileged
// child — the account credential and any inject-granted secrets never live in `base` for this
// call site (they only exist in launch()'s local env object), so scrubbing is the ONLY guard
// against leaking the daemon's own CHIMERA_* orchestration context into the hook's process.
export function scrubHookEnv(base: NodeJS.ProcessEnv, inject: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^CHIMERA_/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...inject };
}

type Marker = { command: string; ranAt: number; durationMs: number };

export async function runWorktreeSetup(input: {
  hook: WorktreeSetupHook; workdir: string; mainRepo: string; branch: string | null;
  project: string; emit: WorktreeSetupSink; now?: () => number;
}): Promise<{ ran: boolean; durationMs: number }> {
  const { hook, workdir, mainRepo, branch, project, emit } = input;
  const now = input.now ?? Date.now;
  if (!hook.enabled) return { ran: false, durationMs: 0 };

  const marker = setupMarkerPath(workdir);
  if (marker === null) {
    throw new WorktreeSetupError("refusing to run a setup hook outside a linked worktree");
  }
  if (existsSync(marker)) {
    try {
      const parsed = JSON.parse(readFileSync(marker, "utf8")) as Marker;
      if (parsed.command === hook.command) return { ran: false, durationMs: 0 };
    } catch {
      // unreadable/corrupt marker — treat as "no marker" and re-run below.
    }
  }

  emit({ phase: "start", project, command: hook.command });
  const [program, args] = splitCommand(hook.command);
  const env = scrubHookEnv(process.env, {
    CHIMERA_WORKTREE: workdir, CHIMERA_MAIN_REPO: mainRepo, CHIMERA_BRANCH: branch ?? "",
    CHIMERA_SETUP_HOOK: "1",
  });

  const startedAt = now();
  const stdoutCap = new BoundedCapture();
  const stderrCap = new BoundedCapture();
  let chunkEventCount = 0;
  let pendingFlush = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    if (!pendingFlush) return;
    if (chunkEventCount >= MAX_CHUNK_EVENTS) { pendingFlush = ""; return; }
    chunkEventCount++;
    emit({ phase: "chunk", project, command: hook.command, text: pendingFlush.slice(0, MAX_CHUNK_CHARS) });
    pendingFlush = "";
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  };

  const result = await new Promise<{ ok: boolean; exitCode: number | null; message: string; timedOut?: boolean }>((resolve) => {
    let settled = false;
    // AC5 requires the rejection MESSAGE to name the timeout. The SIGTERM/SIGKILL path ends in
    // `close` with code null (killed by signal), which is indistinguishable from any other
    // signal death — only this flag, set by the soft timer that fired the kill, can tell the
    // close handler that the death was OUR deadline rather than the hook exiting on its own.
    let timedOut = false;
    // Declared with `let` (assigned below, after spawn) rather than `const` so the catch on a
    // synchronous spawn() throw — which runs settleOnce before these exist — can't hit a TDZ
    // ReferenceError; that would surface as the wrong error type to the caller.
    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const settleOnce = (r: { ok: boolean; exitCode: number | null; message: string; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      settleOnce({ ok: false, exitCode: null, message: (e as Error).message });
      return;
    }

    const onData = (buf: Buffer, sink: BoundedCapture) => {
      const text = buf.toString();
      sink.push(text);
      pendingFlush += text;
      scheduleFlush();
    };
    child.stdout?.on("data", (b: Buffer) => onData(b, stdoutCap));
    child.stderr?.on("data", (b: Buffer) => onData(b, stderrCap));

    const boundMs = hook.timeoutSec * 1000;
    child.on("error", (e) => {
      settleOnce({ ok: false, exitCode: null, message: e.message });
    });
    child.on("close", (code) => {
      if (code === 0 && !timedOut) { settleOnce({ ok: true, exitCode: code, message: "" }); return; }
      const why = timedOut
        ? `setup hook "${hook.command}" timed out after ${boundMs}ms and was killed`
        : `"${hook.command}" exited with code ${code}`;
      settleOnce({
        ok: false, exitCode: code, timedOut,
        // The timeout reason is prepended, not used as formatFailure's fallback: a hook that
        // printed output before hanging would otherwise have its deadline silently replaced by
        // that output and AC5's "message names the timeout" would regress unnoticed.
        message: timedOut ? `${why}\n\n${formatFailure(stdoutCap.render(), stderrCap.render(), "")}`.trimEnd() : formatFailure(stdoutCap.render(), stderrCap.render(), why),
      });
    });

    softTimer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch { /* already dead */ } }, boundMs);
    softTimer.unref?.();
    killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, boundMs + KILL_GRACE_MS);
    killTimer.unref?.();
    hardTimer = setTimeout(() => {
      settleOnce({
        ok: false, exitCode: null, timedOut: true,
        message: `setup hook "${hook.command}" did not exit within ${boundMs + HARD_CEILING_GRACE_MS}ms of its ${boundMs}ms timeout (forced) — process may be unkillable`,
      });
    }, boundMs + HARD_CEILING_GRACE_MS);
    hardTimer.unref?.();
  });

  if (flushTimer) { clearTimeout(flushTimer); flush(); }
  const durationMs = now() - startedAt;

  if (result.ok) {
    const record: Marker = { command: hook.command, ranAt: now(), durationMs };
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify(record));
    emit({ phase: "ok", project, command: hook.command, exitCode: 0, durationMs });
    return { ran: true, durationMs };
  }

  // The fail event used to carry no output at all, so the ENOENT path (which emits zero chunk
  // events) left its reason nowhere in any UI. stderr wins, then stdout, then the failure message
  // itself — the reducer already reads `stderrTail`.
  const captured = stderrCap.render().trim() || stdoutCap.render().trim() || result.message.trim();
  const stderrTail = captured.length > FAIL_TAIL_CHARS ? captured.slice(captured.length - FAIL_TAIL_CHARS) : captured;
  emit({ phase: "fail", project, command: hook.command, exitCode: result.exitCode, durationMs, timedOut: result.timedOut === true, truncated: chunkEventCount >= MAX_CHUNK_EVENTS || stdoutCap.omittedChars + stderrCap.omittedChars > 0, stderrTail });
  throw new WorktreeSetupError(result.message, result.exitCode, result.timedOut === true, stderrTail);
}
