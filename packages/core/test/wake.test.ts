import { describe, it, expect } from "vitest";
import {
  makeWakeScheduler, makeNoopWakeScheduler, caffeinateArgs,
  CAFFEINATE_PATH, SUDO_PATH, WAKE_WRAPPER_PATH, WAKE_SETUP_HINT,
  WAKE_PROBE_TIMEOUT_MS, WAKE_PROBE_TTL_MS, WAKE_RESCHEDULE_EPSILON_MS,
  type WakeExec, type WakeSpawn,
} from "@chimera/core/wake";
import type { WakeConfig } from "@chimera/protocol";

// F01(b): every branch is driven through the injected WakeSpawn/WakeExec seams — this file never
// spawns a real caffeinate, never shells out to sudo, and passes identically on Linux CI.

const CFG: WakeConfig = {
  holdAwakeDuringRuns: true, scheduleWake: true, leadMs: 120_000, lateFireThresholdMs: 120_000,
};

function recordingSpawn() {
  const calls: { file: string; args: string[] }[] = [];
  const kills: string[] = [];
  const spawn: WakeSpawn = (file, args) => {
    calls.push({ file, args });
    return { kill: (sig) => { kills.push(sig); } };
  };
  return { calls, kills, spawn };
}

describe("makeWakeScheduler holdAwake", () => {
  it("passes -i -m -w <pid> and never -s", () => {
    const rec = recordingSpawn();
    const hold = makeWakeScheduler(CFG, "darwin", undefined, rec.spawn).holdAwake();

    expect(hold).not.toBeNull();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.file).toBe(CAFFEINATE_PATH);
    expect(rec.calls[0]!.args).toEqual(["-i", "-m", "-w", String(process.pid)]);
    // -s is AC-only (caffeinate(8)), so on battery it would silently do nothing while we claimed
    // a guarantee; -d/-u would light the display or reset the idle timer at 03:00.
    expect(rec.calls[0]!.args).not.toContain("-s");
    expect(rec.calls[0]!.args).not.toContain("-d");
    expect(rec.calls[0]!.args).not.toContain("-u");
  });

  it("ties the assertion to this process id, so a killed daemon cannot pin the Mac awake", () => {
    expect(caffeinateArgs(4242)).toEqual(["-i", "-m", "-w", "4242"]);
  });

  it("returns null holdAwake on a non-darwin platform", () => {
    const rec = recordingSpawn();
    expect(makeWakeScheduler(CFG, "linux", undefined, rec.spawn).holdAwake()).toBeNull();
    expect(rec.calls).toHaveLength(0);
  });

  it("returns null holdAwake when holdAwakeDuringRuns is false", () => {
    const rec = recordingSpawn();
    const w = makeWakeScheduler({ ...CFG, holdAwakeDuringRuns: false }, "darwin", undefined, rec.spawn);
    expect(w.holdAwake()).toBeNull();
    expect(rec.calls).toHaveLength(0);
  });

  it("release() is idempotent and kills exactly once", () => {
    const rec = recordingSpawn();
    const hold = makeWakeScheduler(CFG, "darwin", undefined, rec.spawn).holdAwake()!;
    hold.release();
    hold.release();
    hold.release();
    expect(rec.kills).toEqual(["SIGTERM"]);
  });

  it("degrades to null when the spawner throws — a failed assertion never fails the run", () => {
    const boom: WakeSpawn = () => { throw new Error("ENOENT /usr/bin/caffeinate"); };
    expect(makeWakeScheduler(CFG, "darwin", undefined, boom).holdAwake()).toBeNull();
  });

  it("swallows a kill() that throws — the process is already gone", () => {
    const dead: WakeSpawn = () => ({ kill: () => { throw new Error("ESRCH"); } });
    const hold = makeWakeScheduler(CFG, "darwin", undefined, dead).holdAwake()!;
    expect(() => hold.release()).not.toThrow();
  });
});

/** Every privileged call goes through this — no test in this file ever reaches a real sudo. */
function recordingExec(result: { code: number | null; stdout?: string; stderr?: string } | (() => never)) {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const exec: WakeExec = (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs });
    if (typeof result === "function") result();
    return Promise.resolve({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  };
  return { calls, exec };
}

const AT = Date.UTC(2026, 8, 3, 3, 0, 0);

describe("makeWakeScheduler RTC path", () => {
  it("probes the wrapper itself with sudo -n, and reports available on exit 0", async () => {
    const e = recordingExec({ code: 0, stdout: "chimera-wake 1\n" });
    const cap = await makeWakeScheduler(CFG, "darwin", e.exec, recordingSpawn().spawn).probe();

    expect(cap).toEqual({ available: true, platform: "darwin", reason: null, setupHint: null });
    // `-n` is what makes this safe unattended: sudo fails instead of ever reading a password from
    // a tty the daemon does not have. The probe is the WRAPPER, not `sudo -n true` — the policy
    // drop-in grants exactly one path and /usr/bin/true is not it.
    expect(e.calls).toEqual([{ file: SUDO_PATH, args: ["-n", WAKE_WRAPPER_PATH, "probe"], timeoutMs: WAKE_PROBE_TIMEOUT_MS }]);
  });

  it("reports unavailable with the operator setup hint on any non-zero exit", async () => {
    const e = recordingExec({ code: 1, stderr: "sudo: a password is required\nmore noise" });
    const cap = await makeWakeScheduler(CFG, "darwin", e.exec, recordingSpawn().spawn).probe();

    expect(cap.available).toBe(false);
    expect(cap.setupHint).toBe(WAKE_SETUP_HINT);
    expect(cap.reason).toContain(WAKE_WRAPPER_PATH);
    expect(cap.reason).toContain("sudo: a password is required");
    expect(cap.reason).not.toContain("more noise");   // one bounded line, not a wall of stderr
  });

  it("never rejects on a timeout or a spawn error — an unusable wrapper is a value, not a throw", async () => {
    for (const e of [recordingExec({ code: null }), recordingExec(() => { throw new Error("ENOENT"); })]) {
      const w = makeWakeScheduler(CFG, "darwin", e.exec, recordingSpawn().spawn);
      await expect(w.probe()).resolves.toMatchObject({ available: false });
      await expect(w.scheduleWake(AT)).resolves.toMatchObject({ ok: false });
    }
  });

  it("converts an epoch to the second-resolution UTC ISO the wrapper's regex accepts", async () => {
    const e = recordingExec({ code: 0 });
    const w = makeWakeScheduler(CFG, "darwin", e.exec, recordingSpawn().spawn);
    // Millis are TRUNCATED, not rounded, so cancel's exact-match string round-trips through the
    // persisted epoch unchanged.
    await expect(w.scheduleWake(AT + 750)).resolves.toEqual({ ok: true });
    await expect(w.cancelWake(AT + 750)).resolves.toEqual({ ok: true });

    const iso = "2026-09-03T03:00:00Z";
    expect(iso).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    expect(e.calls.map((c) => c.args)).toEqual([
      ["-n", WAKE_WRAPPER_PATH, "schedule", iso],
      ["-n", WAKE_WRAPPER_PATH, "cancel", iso],
    ]);
  });

  it("answers the config off-switch BEFORE any privileged call, and without a setup hint", async () => {
    const e = recordingExec({ code: 0 });
    const w = makeWakeScheduler({ ...CFG, scheduleWake: false }, "darwin", e.exec, recordingSpawn().spawn);

    const cap = await w.probe();
    expect(cap).toMatchObject({ available: false, setupHint: null });   // they chose this; the installer is not the answer
    expect(await w.scheduleWake(AT)).toMatchObject({ ok: false });
    expect(e.calls).toHaveLength(0);
    // The other switch is independent: turning the RTC half off must not stop the sleep hold.
    expect(w.holdAwake()).not.toBeNull();
  });

  it("never reaches the wrapper at all off darwin", async () => {
    for (const platform of ["linux", "win32"]) {
      const e = recordingExec({ code: 0 });
      const w = makeWakeScheduler(CFG, platform, e.exec, recordingSpawn().spawn);
      const cap = await w.probe();
      expect(cap).toMatchObject({ available: false, platform });
      expect(await w.scheduleWake(AT)).toMatchObject({ ok: false });
      expect(await w.cancelWake(AT)).toMatchObject({ ok: false });
      expect(e.calls).toHaveLength(0);
    }
  });

  it("the no-op scheduler names the platform it cannot serve", async () => {
    const cap = await makeNoopWakeScheduler("linux").probe();
    expect(cap).toEqual({
      available: false, platform: "linux",
      reason: "RTC wake scheduling is implemented for macOS only", setupHint: null,
    });
  });

  it("pins the privileged wrapper path and the timing constants as constants, not config", () => {
    // The sudoers drop-in grants exactly this path; deriving it from config or env would let an
    // operator-settable string decide what runs as root.
    expect(WAKE_WRAPPER_PATH).toBe("/usr/local/libexec/chimera-wake");
    expect(SUDO_PATH).toBe("/usr/bin/sudo");   // absolute, never resolved through an inherited PATH
    expect(WAKE_PROBE_TTL_MS).toBe(60_000);
    expect(WAKE_RESCHEDULE_EPSILON_MS).toBe(60_000);
  });
});
