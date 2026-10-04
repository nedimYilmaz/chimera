import { describe, it, expect } from "vitest";
import type { CommandRunner, CommandRunResult } from "@chimera/core/jobs";
import type { WakeScheduler } from "@chimera/core/wake";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeJobRig, reopenJobs, waitUntil } from "./jobs-helpers.js";

// F01(b): the jobs.ts <-> wake.ts seam. The hold's source of truth is inFlight.size, never a
// refcount, so these tests are written entirely in terms of "how many runs are in flight" and
// assert the assertion count that follows from it. No real caffeinate is ever spawned.

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A runner that parks every command until the test resolves it by name — the only way to get two
 *  runs genuinely concurrent in flight without a real process. */
function deferredRunner() {
  const pending = new Map<string, (r: CommandRunResult) => void>();
  const run: CommandRunner = (t) => new Promise<CommandRunResult>((resolve) => { pending.set(t.command, resolve); });
  const finish = (command: string, exitCode = 0): void => {
    const resolve = pending.get(command)!;
    pending.delete(command);
    resolve({ exitCode, output: "", ...(exitCode === 0 ? {} : { error: `exited ${exitCode}` }) });
  };
  return { pending, run, finish };
}

function fakeWake(opts: { throwOnHold?: boolean } = {}) {
  const holds: { released: boolean }[] = [];
  const wake: WakeScheduler = {
    probe: async () => ({ available: false, platform: "test", reason: null, setupHint: null }),
    scheduleWake: async () => ({ ok: false }),
    cancelWake: async () => ({ ok: false }),
    holdAwake: () => {
      if (opts.throwOnHold) throw new Error("caffeinate is not installed");
      const h = { released: false };
      holds.push(h);
      return { release: () => { h.released = true; } };
    },
  };
  return { holds, wake, active: (): number => holds.filter((h) => !h.released).length };
}

/** Two command jobs both due at T0+10s, so ONE tick() puts both runs in flight. */
function twoJobRig(wake: WakeScheduler, run: CommandRunner) {
  const rig = makeJobRig([], T0, { runCommand: run, wake });
  for (const name of ["alpha", "beta"]) {
    rig.jobs.create({ name, schedule: { at: T0 + 10_000 }, target: { command: `cmd-${name}` }, tz: "UTC" });
  }
  return rig;
}

describe("F01(b) sleep hold: one assertion for as long as any job run is in flight", () => {
  it("holds exactly one sleep assertion for two concurrent runs and releases on the last settle", async () => {
    const w = fakeWake();
    const r = deferredRunner();
    const rig = twoJobRig(w.wake, r.run);

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 2);

    // TWO runs, ONE assertion — the second fire must not take a second caffeinate.
    expect(w.holds).toHaveLength(1);
    expect(w.active()).toBe(1);

    r.finish("cmd-alpha");
    await waitUntil(() => rig.jobs.get("alpha").lastRuns.length === 1);
    expect(w.active()).toBe(1);   // beta is still running: the machine must stay awake

    r.finish("cmd-beta");
    await waitUntil(() => rig.jobs.get("beta").lastRuns.length === 1);
    expect(w.active()).toBe(0);
    expect(w.holds).toHaveLength(1);   // released, never re-taken
  });

  it("releases the hold when the last run FAILS, not only when it succeeds", async () => {
    const w = fakeWake();
    const r = deferredRunner();
    const rig = twoJobRig(w.wake, r.run);

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 2);
    expect(w.active()).toBe(1);

    r.finish("cmd-alpha", 1);
    r.finish("cmd-beta", 1);
    await waitUntil(() => rig.jobs.get("beta").lastRuns.length === 1);
    expect(rig.jobs.get("alpha").lastRuns[0]!.result).toBe("failed");
    expect(w.active()).toBe(0);
  });

  it("releases the hold when the last in-flight job is deleted out from under its run", async () => {
    const w = fakeWake();
    const r = deferredRunner();
    const rig = twoJobRig(w.wake, r.run);

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 2);

    rig.jobs.delete("alpha");
    expect(w.active()).toBe(1);   // beta still in flight
    rig.jobs.delete("beta");
    expect(w.active()).toBe(0);
  });

  it("releases the hold on detach", async () => {
    const w = fakeWake();
    const r = deferredRunner();
    const rig = twoJobRig(w.wake, r.run);

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 2);
    expect(w.active()).toBe(1);

    // detach() releases DIRECTLY: inFlight is still populated at shutdown, so a sync-to-inFlight
    // would keep the operator's Mac awake after the daemon is gone.
    rig.jobs.detach();
    expect(w.active()).toBe(0);
  });

  it("takes no hold at all when no wake dep is injected — today's behaviour, exactly", async () => {
    const r = deferredRunner();
    const rig = makeJobRig([], T0, { runCommand: r.run });
    rig.jobs.create({ name: "solo", schedule: { at: T0 + 10_000 }, target: { command: "cmd-solo" } });

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 1);

    r.finish("cmd-solo");
    await waitUntil(() => rig.jobs.get("solo").lastRuns.length === 1);
    expect(rig.jobs.get("solo").lastRuns[0]!.result).toBe("ok");
  });

  it("a holdAwake that throws does not fail the run", async () => {
    const w = fakeWake({ throwOnHold: true });
    const r = deferredRunner();
    const rig = twoJobRig(w.wake, r.run);

    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => r.pending.size === 2);

    r.finish("cmd-alpha");
    await waitUntil(() => rig.jobs.get("alpha").lastRuns.length === 1);
    expect(rig.jobs.get("alpha").lastRuns[0]!.result).toBe("ok");
    expect(w.holds).toHaveLength(0);

    r.finish("cmd-beta");
    await waitUntil(() => rig.jobs.get("beta").lastRuns.length === 1);
    // A never-taken hold must also never be "released" — detach must stay a no-op.
    expect(() => rig.jobs.detach()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// F01(a): the RTC half of the seam. Every wrapper invocation is recorded through the injected
// WakeScheduler, so nothing here shells out to sudo and these pass identically on Linux CI.
// ---------------------------------------------------------------------------------------------

const LEAD = 120_000;
const SIX_HOURS = 6 * 3_600_000;

/** Records the wrapper verbs in order. `probe` counts separately because the TTL cache (A6) is
 *  asserted on how many times the privileged round trip actually happened. */
function rtcWake(opts: { available?: boolean; scheduleOk?: boolean } = {}) {
  const calls: string[] = [];
  const wake: WakeScheduler = {
    probe: async () => {
      calls.push("probe");
      return opts.available === false
        ? {
          available: false, platform: "darwin",
          reason: "RTC wake requires root — no NOPASSWD rule for /usr/local/libexec/chimera-wake",
          setupHint: "./scripts/install.sh --enable-wake",
        }
        : { available: true, platform: "darwin", reason: null, setupHint: null };
    },
    scheduleWake: async (at) => {
      calls.push(`schedule:${at}`);
      return opts.scheduleOk === false ? { ok: false, error: "wrapper refused" } : { ok: true };
    },
    cancelWake: async (at) => { calls.push(`cancel:${at}`); return { ok: true }; },
    holdAwake: () => null,
  };
  return { calls, wake, probes: (): number => calls.filter((c) => c === "probe").length };
}

/** One job six hours out — far enough that `nextRunTs - leadMs` is comfortably in the future. */
function oneJobRig(wake: WakeScheduler) {
  const rig = makeJobRig([], T0, { wake, wakeLeadMs: LEAD, runCommand: async () => ({ exitCode: 0, output: "" }) });
  rig.jobs.create({ name: "nightly", schedule: { at: T0 + SIX_HOURS }, target: { command: "echo hi" }, tz: "UTC" });
  return rig;
}

describe("F01(a) RTC wake: one outstanding OS wake, debounced, never on the fire path", () => {
  it("schedules one OS wake at nextRunTs minus leadMs when a job is armed", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;

    await waitUntil(() => w.calls.includes(`schedule:${target}`));
    expect(w.calls).toEqual(["probe", `schedule:${target}`]);

    const ev = rig.events.tail("wake", 10).find((e) => e.kind === "job_wake_scheduled");
    expect(ev?.data).toMatchObject({ atMs: target, forJob: "nightly", leadMs: LEAD });
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ available: true, scheduledFor: target });
  });

  it("does not re-invoke the wrapper across five re-arms with an unchanged soonest", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.calls.length === 2);

    // Every tick re-arms; without the debounce this would be a privileged round trip per hop,
    // forever, for a wake target that has not moved at all.
    for (let i = 0; i < 5; i++) await rig.jobs.tick();
    expect(w.calls).toHaveLength(2);
  });

  it("cancels the old wake before scheduling a moved one, in that order", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    const first = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${first}`));

    rig.jobs.update("nightly", { schedule: { at: T0 + 2 * SIX_HOURS } });
    const moved = T0 + 2 * SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${moved}`));

    // Exactly ONE chimera-owned event may exist at a time, so the cancel is not optional and its
    // ORDER is not incidental — scheduling first would leave two live events with one timestamp.
    expect(w.calls.indexOf(`cancel:${first}`)).toBeLessThan(w.calls.indexOf(`schedule:${moved}`));
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ scheduledFor: moved });
  });

  it("emits job_wake_failed and still arms the timer when the wrapper exits non-zero", async () => {
    const w = rtcWake({ scheduleOk: false });
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${target}`));

    const ev = rig.events.tail("wake", 10).find((e) => e.kind === "job_wake_failed");
    expect(ev?.data).toMatchObject({ atMs: target, reason: "wrapper refused" });
    // A refused wake must leave NO claim on disk, and must not stop the job from running late.
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ scheduledFor: null });

    rig.clock.box.t = T0 + SIX_HOURS;
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("nightly").lastRuns.length === 1);
    expect(rig.jobs.get("nightly").lastRuns[0]!.result).toBe("ok");
  });

  it("never attempts a schedule when the probe says unavailable, and emits no event spam", async () => {
    const w = rtcWake({ available: false });
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.probes() === 1);
    for (let i = 0; i < 3; i++) await rig.jobs.tick();

    expect(w.calls.every((c) => c === "probe")).toBe(true);
    // The degraded state is a STATUS, read when asked — one event on the FIRST unavailable probe
    // [F01-QA-follow-up (1)], never again per hop, so no "no spam" here means "no repeats".
    expect(rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability")).toHaveLength(1);
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({
      available: false, scheduledFor: null, setupHint: "./scripts/install.sh --enable-wake",
    });
  });

  it("probes once for ten wakeStatus calls inside the TTL, and again after invalidateWakeProbe", async () => {
    const w = rtcWake({ available: false });
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.probes() === 1);

    for (let i = 0; i < 10; i++) await rig.jobs.wakeStatus();
    expect(w.probes()).toBe(1);

    // What an operator does right after running the installer is touch a job — that must not wait
    // out a 60s cache before the UI stops saying "unavailable".
    rig.jobs.invalidateWakeProbe();
    await rig.jobs.wakeStatus();
    expect(w.probes()).toBe(2);
  });

  it("persists wakeScheduledFor across a reopen and cancels it on detach", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${target}`));

    // reopenJobs detaches first: the clean shutdown path cancels the outstanding event.
    const reopened = reopenJobs(rig, { wake: w.wake, wakeLeadMs: LEAD });
    expect(w.calls).toContain(`cancel:${target}`);

    // detach() cannot AWAIT that cancel, so the persisted timestamp is a claim, not a fact — the
    // next boot must re-cancel and schedule fresh rather than let the debounce trust it and go
    // silent forever.
    await waitUntil(() => w.calls.filter((c) => c === `cancel:${target}`).length === 2);
    await waitUntil(() => w.calls.filter((c) => c === `schedule:${target}`).length === 2);
    await expect(reopened.wakeStatus()).resolves.toMatchObject({ scheduledFor: target });
    reopened.detach();
  });
});

describe("F01(a) a failing wrapper is debounced too — no privileged retry storm", () => {
  it("does not re-attempt or re-emit for an unchanged target after a schedule failure", async () => {
    const w = rtcWake({ scheduleOk: false });
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${target}`));

    // armTimer runs once per bounded hop for as long as any job is scheduled. An installed-but-
    // refusing wrapper must not turn that into a privileged round trip AND a log line per minute.
    for (let i = 0; i < 5; i++) await rig.jobs.tick();
    expect(w.calls.filter((c) => c === `schedule:${target}`)).toHaveLength(1);
    expect(rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_failed")).toHaveLength(1);
  });

  it("retries once the target actually moves — debounced, not given up on", async () => {
    const w = rtcWake({ scheduleOk: false });
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.calls.includes(`schedule:${T0 + SIX_HOURS - LEAD}`));

    rig.jobs.update("nightly", { schedule: { at: T0 + 2 * SIX_HOURS } });
    const moved = T0 + 2 * SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${moved}`));
    // A failed attempt leaves nothing to cancel, so the move must not try to cancel a phantom.
    expect(w.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0);
  });
});

// F01(a) QA of 3c60fae3: armTimer's "nothing is armed" exit is the one path that leaves an OS wake
// event behind. The only cancel on the happy path runs when a NEW target replaces an old one, so a
// deleted/disabled last job used to leave the Mac scheduled to power on for a job that is gone.
describe("F01(a) QA: the outstanding OS wake is handed back when nothing is armed any more", () => {
  it("cancels the pending wake when the last job is deleted", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${target}`));

    rig.jobs.delete("nightly");
    await waitUntil(() => w.calls.includes(`cancel:${target}`));
    // ...and nothing may keep claiming a wake is armed, on disk or over RPC.
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ available: true, scheduledFor: null });
    // Persisted too: a restart must not read the dead timestamp back and re-adopt it.
    const persisted = JSON.parse(readFileSync(join(rig.dir, "jobs.json"), "utf8")) as { wakeScheduledFor: number | null };
    expect(persisted.wakeScheduledFor).toBeNull();
  });

  it("cancels the pending wake when the last job is disabled", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    const target = T0 + SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${target}`));

    rig.jobs.update("nightly", { enabled: false });
    await waitUntil(() => w.calls.includes(`cancel:${target}`));
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ scheduledFor: null });
  });

  it("re-arms a fresh wake after a release, so the release is not a one-way door", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.calls.includes(`schedule:${T0 + SIX_HOURS - LEAD}`));
    rig.jobs.delete("nightly");
    await waitUntil(() => w.calls.includes(`cancel:${T0 + SIX_HOURS - LEAD}`));

    rig.jobs.create({ name: "later", schedule: { at: T0 + 2 * SIX_HOURS }, target: { command: "echo hi" }, tz: "UTC" });
    const moved = T0 + 2 * SIX_HOURS - LEAD;
    await waitUntil(() => w.calls.includes(`schedule:${moved}`));
    await expect(rig.jobs.wakeStatus()).resolves.toMatchObject({ scheduledFor: moved });
  });

  // F01-QA-follow-up (3): releaseWake's early return ("nothing outstanding") must be silent —
  // it runs on every "last job gone" path, including the overwhelmingly common one where no wake
  // was ever scheduled (unavailable machine, or a job deleted before its first arm), so an event
  // there would spam the transcript on every day-to-day job deletion.
  it("emits no event when the last job is deleted with no outstanding wake to release", async () => {
    const w = rtcWake({ available: false });
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.probes() === 1);

    rig.jobs.delete("nightly");
    // Give any stray async release a tick to land before asserting silence.
    await Promise.resolve();
    expect(w.calls.some((c) => c.startsWith("cancel:"))).toBe(false);
    const events = rig.events.tail("wake", 20);
    expect(events.filter((e) => e.kind !== "job_wake_capability")).toHaveLength(0);
  });
});

// F01-QA-follow-up (1): a capability OBSERVATION (unlike job_wake_scheduled/failed, which stay
// silent on the common path) is worth exactly one event on the first unavailable probe, and again
// only if availability later flips — never once per armTimer hop.
describe("F01-QA-follow-up: job_wake_capability is emitted once per observed flip, not per hop", () => {
  it("emits once on the first unavailable probe and not again across further hops", async () => {
    const w = rtcWake({ available: false });
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.probes() === 1);
    for (let i = 0; i < 3; i++) await rig.jobs.tick();

    const evs = rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.data).toMatchObject({ available: false });
  });

  it("stays silent on the common path: available from the very first probe", async () => {
    const w = rtcWake();
    const rig = oneJobRig(w.wake);
    await waitUntil(() => w.calls.includes(`schedule:${T0 + SIX_HOURS - LEAD}`));
    for (let i = 0; i < 3; i++) await rig.jobs.tick();

    expect(rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability")).toHaveLength(0);
  });

  it("emits again when availability flips back", async () => {
    let available = false;
    const calls: string[] = [];
    const wake: WakeScheduler = {
      probe: async () => {
        calls.push("probe");
        return available
          ? { available: true, platform: "darwin", reason: null, setupHint: null }
          : { available: false, platform: "darwin", reason: "no NOPASSWD rule", setupHint: "./scripts/install.sh --enable-wake" };
      },
      scheduleWake: async (at) => { calls.push(`schedule:${at}`); return { ok: true }; },
      cancelWake: async (at) => { calls.push(`cancel:${at}`); return { ok: true }; },
      holdAwake: () => null,
    };
    const rig = oneJobRig(wake);
    await waitUntil(() => calls.includes("probe"));
    // The event append is a microtask past the probe call itself — give it a tick to land.
    await waitUntil(() => rig.events.tail("wake", 20).some((e) => e.kind === "job_wake_capability"));
    expect(rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability")).toHaveLength(1);

    available = true;
    rig.jobs.invalidateWakeProbe();
    await rig.jobs.wakeStatus();
    await rig.jobs.tick();
    await waitUntil(() => rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability").length === 2);
    const evs = rig.events.tail("wake", 20).filter((e) => e.kind === "job_wake_capability");
    expect(evs.map((e) => e.data)).toMatchObject([{ available: false }, { available: true }]);
  });
});
