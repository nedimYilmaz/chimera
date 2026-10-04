import { describe, it, expect, vi } from "vitest";
import {
  advanceOccurrence, MAX_HOP_MS, MAX_TIMER_DELAY_MS, CLOCK_JUMP_THRESHOLD_MS, type CommandRunner,
} from "@chimera/core/jobs";
import { makeJobRig, reopenJobs, type JobRigOpts } from "./jobs-helpers.js";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const NINE_H_13M = 33_180_000;   // the plan's canonical overnight-suspend gap
const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

// Command targets keep these tests off the supervisor entirely: the only thing under test is the
// timer/clock arithmetic, and a stub runner means no agent, no queue, no settle race.
const OK: CommandRunner = async () => ({ exitCode: 0, output: "" });

function rigWithFarJob(opts: JobRigOpts = {}) {
  const rig = makeJobRig([], T0, { runCommand: OK, ...opts });
  rig.jobs.create({ name: "far", schedule: { at: T0 + SIXTY_DAYS }, target: { command: "true" } });
  return rig;
}

const jumps = (rig: ReturnType<typeof makeJobRig>) =>
  rig.events.tail("clock", 20).filter((e) => e.kind === "clock_jump");

describe("F02 armTimer: every hop is bounded so a clock jump is noticed within a minute", () => {
  it("never arms a hop longer than MAX_HOP_MS even for a job 60 days out", () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      rig.jobs.create({ name: "far", schedule: { at: T0 + SIXTY_DAYS }, target: { command: "true" } });
      const delays = spy.mock.calls.map((c) => c[1] as number);
      expect(delays.length).toBeGreaterThan(0);
      for (const d of delays) expect(d).toBeLessThanOrEqual(MAX_HOP_MS);
    } finally { spy.mockRestore(); }
  });

  it("arms the exact remaining delay when the next run is inside one hop", () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      rig.jobs.create({ name: "soon", schedule: { at: T0 + 10_000 }, target: { command: "true" } });
      expect(spy.mock.calls.at(-1)![1]).toBe(10_000);   // the FINAL hop lands on the slot, not on a poll boundary
    } finally { spy.mockRestore(); }
  });

  // REGRESSION GUARD for the OUTER clamp. With MAX_HOP_MS (60s) inside the Math.min, the
  // MAX_TIMER_DELAY_MS arm is unreachable in production — so jobs.test.ts's
  // `expect(d).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)` can no longer fail, and deleting the arm
  // would break nothing that is tested. The maxHopMs seam is the only way to still exercise it,
  // and jobs.ts's own MAX_HOP_MS comment promises exactly this test ("a test that injects a huge
  // maxHopMs must still not overflow setTimeout"). Node coerces any delay > 2^31-1 to 1ms, which
  // would turn a 60-day schedule into a busy loop.
  it("still clamps at MAX_TIMER_DELAY_MS when an injected maxHopMs exceeds Node's timer ceiling", () => {
    // No tick() here on purpose: a frozen injected clock against a huge armed hop reads as a
    // backward jump, and this test is about the armed delay only.
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const rig = makeJobRig([], T0, { runCommand: OK, maxHopMs: Number.MAX_SAFE_INTEGER });
      rig.jobs.create({ name: "far", schedule: { at: T0 + SIXTY_DAYS }, target: { command: "true" } });
      expect(spy.mock.calls.at(-1)![1]).toBe(MAX_TIMER_DELAY_MS);
    } finally { spy.mockRestore(); }
  });
});

describe("F02 observeTick: clock-jump detection", () => {
  it("emits one clock_jump with the observed gap when a tick lands 9h13m after its armed hop", async () => {
    const rig = rigWithFarJob();
    rig.clock.box.t = T0 + MAX_HOP_MS + NINE_H_13M;
    await rig.jobs.tick();

    const found = jumps(rig);
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({
      driftMs: NINE_H_13M,
      observedGapMs: MAX_HOP_MS + NINE_H_13M,
      expectedGapMs: MAX_HOP_MS,
      thresholdMs: CLOCK_JUMP_THRESHOLD_MS,
      direction: "forward",
      source: "jobs",
    });
  });

  it("emits nothing when the tick lands on its armed deadline, and nothing on a frozen clock", async () => {
    const onTime = rigWithFarJob();
    onTime.clock.box.t = T0 + MAX_HOP_MS;
    await onTime.jobs.tick();
    expect(jumps(onTime)).toHaveLength(0);

    // A frozen injected clock reads as drift -MAX_HOP_MS — which is why the threshold must stay
    // strictly above the hop bound, or every clock-driven test in this repo would report a jump.
    const frozen = rigWithFarJob();
    await frozen.jobs.tick();
    expect(jumps(frozen)).toHaveLength(0);
  });

  it("reports a backward step beyond the threshold as direction backward", async () => {
    const rig = rigWithFarJob();
    rig.clock.box.t = T0 - 180_000;
    await rig.jobs.tick();

    const found = jumps(rig);
    expect(found).toHaveLength(1);
    expect(found[0]!.data["direction"]).toBe("backward");
    expect(found[0]!.data["driftMs"]).toBe(-240_000);
  });

  it("honours an injected clockJumpThresholdMs", async () => {
    const tight = rigWithFarJob({ clockJumpThresholdMs: 5_000 });
    tight.clock.box.t = T0 + MAX_HOP_MS + 6_000;
    await tight.jobs.tick();
    expect(jumps(tight)).toHaveLength(1);

    const lax = rigWithFarJob();
    lax.clock.box.t = T0 + MAX_HOP_MS + 6_000;
    await lax.jobs.tick();
    expect(jumps(lax)).toHaveLength(0);
  });

  it("never reports a jump for a tick with no armed expectation", async () => {
    const rig = makeJobRig([], T0, { runCommand: OK });   // nothing scheduled -> armTimer never armed
    rig.clock.box.t = T0 + NINE_H_13M;
    await rig.jobs.tick();
    expect(jumps(rig)).toHaveLength(0);
  });

  // F02-QA-5: an RPC-driven re-arm (create/update) between an overdue wake and the pending timer
  // callback must not let armTimer() reset armedAtMs/armedHopMs against the already-elapsed
  // expectation — that would make observeTick() measure ~0 drift on the next tick() and swallow a
  // real clock jump. create() below fires armTimer() as a side effect, mirroring the RPC path.
  it("still reports the full drift when create() re-arms the timer after the clock jumps but before tick()", async () => {
    const rig = rigWithFarJob();
    rig.clock.box.t = T0 + MAX_HOP_MS + NINE_H_13M;
    rig.jobs.create({ name: "other", schedule: { at: T0 + SIXTY_DAYS }, target: { command: "true" } });
    await rig.jobs.tick();

    const found = jumps(rig);
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({ driftMs: NINE_H_13M, direction: "forward", source: "jobs" });
  });
});

describe("F02 advanceOccurrence: the grid is anchored on the served slot, not on the wake instant", () => {
  it("re-arms an hourly job that fired 9h13m late onto the hour, not 9h13m past it", async () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    const created = rig.jobs.create({
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { command: "true" }, tz: "UTC",
    });
    expect(created.nextRunTs).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));

    rig.clock.box.t = Date.UTC(2026, 0, 1, 9, 13, 0);
    await rig.jobs.tick();

    expect(rig.jobs.get("hourly").nextRunTs).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
  });

  it("caps the occurrence walk and never re-arms in the past", () => {
    const now = T0 + 9 * 3_600_000;
    const { next, missed } = advanceOccurrence({ every: { unit: "seconds", n: 1 } }, "UTC", T0, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
    expect(missed).toBeGreaterThan(0);
  });

  it("returns no next occurrence for a one-shot `at`", () => {
    expect(advanceOccurrence({ at: T0 + 1_000 }, "UTC", T0 + 1_000, T0 + 2_000)).toEqual({ next: null, missed: 0 });
  });
});

describe("F02 lastTickMs survives a restart and explains the downtime", () => {
  it("persists lastTickMs across a reopen and reports downtimeMs + missedOccurrences on a missed-restart skip", async () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    rig.jobs.create({
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { command: "true" }, tz: "UTC",
    });
    await rig.jobs.tick();   // first tick flushes lastTickMs = T0

    rig.clock.box.t = T0 + NINE_H_13M;
    const reopened = reopenJobs(rig);
    try {
      expect(reopened.lastTickAt()).toBe(T0);
      const skipped = rig.events.tail("job:hourly", 20).filter((e) => e.kind === "job_skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.data).toMatchObject({
        job: "hourly", reason: "missed-restart", downtimeMs: NINE_H_13M, missedOccurrences: 8,
      });
      // anchored on the missed 01:00 slot, so a restart does not re-phase the schedule either
      expect(reopened.get("hourly").nextRunTs).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    } finally { reopened.detach(); }
  });

  // F02-QA-6: the catch-up fire path must report the same downtime/coalesced numbers as the
  // missed-restart skip above — reconcileBoot computes both BEFORE branching on job.catchUp, so a
  // catchUp:true job dropping them on job_run_started would be losing information it already had.
  it("with catchUp true, reports downtimeMs + missedOccurrences on the catch-up job_run_started", async () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    rig.jobs.create({
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { command: "true" }, tz: "UTC", catchUp: true,
    });
    await rig.jobs.tick();   // first tick flushes lastTickMs = T0

    rig.clock.box.t = T0 + NINE_H_13M;
    const reopened = reopenJobs(rig);
    try {
      const started = rig.events.tail("job:hourly", 20).filter((e) => e.kind === "job_run_started");
      expect(started).toHaveLength(1);
      expect(started[0]!.data).toMatchObject({
        job: "hourly", trigger: "catchup", latenessMs: NINE_H_13M, coalescedOccurrences: 8,
      });
      // same anchoring as the missed-restart skip: the served slot is 09:00, so the schedule
      // resumes from 10:00, not from 9h13m past the original 01:00 slot.
      expect(reopened.get("hourly").nextRunTs).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    } finally { reopened.detach(); }
  });
});
