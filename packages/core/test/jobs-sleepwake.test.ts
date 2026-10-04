import { describe, it, expect } from "vitest";
import { LATE_FIRE_THRESHOLD_MS, CLOCK_JUMP_THRESHOLD_MS, type CommandRunner } from "@chimera/core/jobs";
import { makeJobRig, waitUntil, type JobRigOpts } from "./jobs-helpers.js";

// F01(c): a scheduled fire whose slot is far in the past is a run that was LATE — not a missed
// one, not a manual one. These tests drive the whole disposition off the injected clock, so a 9h
// overnight suspend is proven in 0ms and no machine ever sleeps.

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;
const NINE_H_13M = 33_180_000;   // the plan's canonical overnight-suspend gap

// Command targets keep these off the supervisor: the subject is the classification, not spawning.
const OK: CommandRunner = async () => ({ exitCode: 0, output: "" });

/** An hourly job created at T0, so its FIRST nominal slot is exactly T0 + 1h. Every lateness below
 *  is measured from that slot, never from create time. */
function hourlyRig(opts: JobRigOpts = {}) {
  const rig = makeJobRig([], T0, { runCommand: OK, ...opts });
  const created = rig.jobs.create({
    name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { command: "true" }, tz: "UTC",
  });
  expect(created.nextRunTs).toBe(T0 + HOUR);
  return rig;
}

const started = (rig: ReturnType<typeof makeJobRig>) =>
  rig.events.tail("job:hourly", 50).filter((e) => e.kind === "job_run_started");

const runsOf = (rig: ReturnType<typeof makeJobRig>, name = "hourly") => rig.jobs.get(name).lastRuns;

describe("F01(c) classifyFire: a late scheduled fire is trigger sleep-wake", () => {
  it("records a fire 9h13m after its slot as trigger sleep-wake with latenessMs", async () => {
    const rig = hourlyRig();
    rig.clock.box.t = T0 + HOUR + NINE_H_13M;
    await rig.jobs.tick();
    await waitUntil(() => runsOf(rig).length === 1);

    const run = runsOf(rig)[0]!;
    expect(run.trigger).toBe("sleep-wake");
    expect(run.latenessMs).toBe(NINE_H_13M);
    expect(run.result).toBe("ok");
  });

  it("coalesces 9 missed hourly occurrences into one run and records the count", async () => {
    const rig = hourlyRig();
    rig.clock.box.t = T0 + HOUR + NINE_H_13M;   // slots 02:00…10:00 elapsed inside the gap
    await rig.jobs.tick();
    await waitUntil(() => runsOf(rig).length === 1);

    // ONE fire, not ten: tick()'s `nextRunTs <= now` filter tests one timestamp per job.
    expect(started(rig)).toHaveLength(1);
    expect(runsOf(rig)).toHaveLength(1);
    expect(runsOf(rig)[0]!.coalescedOccurrences).toBe(9);
  });

  it("leaves a punctual run byte-identical to today: scheduled, latenessMs null", async () => {
    const rig = makeJobRig([], T0, { runCommand: OK });
    rig.jobs.create({ name: "soon", schedule: { at: T0 + 10_000 }, target: { command: "true" } });
    rig.clock.box.t = T0 + 10_000;
    await rig.jobs.tick();
    await waitUntil(() => runsOf(rig, "soon").length === 1);

    const run = runsOf(rig, "soon")[0]!;
    expect(run.trigger).toBe("scheduled");
    // null, not 0 — "we did not measure" must stay distinguishable from "it was on time".
    expect(run.latenessMs).toBeNull();
    expect(run.coalescedOccurrences).toBeNull();
  });

  it("classifies at the threshold boundary: threshold-1 is scheduled, threshold is sleep-wake", async () => {
    const under = hourlyRig();
    under.clock.box.t = T0 + HOUR + LATE_FIRE_THRESHOLD_MS - 1;
    await under.jobs.tick();
    await waitUntil(() => runsOf(under).length === 1);
    expect(runsOf(under)[0]!.trigger).toBe("scheduled");

    const at = hourlyRig();
    at.clock.box.t = T0 + HOUR + LATE_FIRE_THRESHOLD_MS;
    await at.jobs.tick();
    await waitUntil(() => runsOf(at).length === 1);
    expect(runsOf(at)[0]!.trigger).toBe("sleep-wake");
    expect(runsOf(at)[0]!.latenessMs).toBe(LATE_FIRE_THRESHOLD_MS);
  });

  it("defines the threshold BY REFERENCE to F02's, so a run and the clock_jump explaining it agree", () => {
    expect(LATE_FIRE_THRESHOLD_MS).toBe(CLOCK_JUMP_THRESHOLD_MS);
  });

  it("honours an injected lateFireThresholdMs", async () => {
    const tight = hourlyRig({ lateFireThresholdMs: 5_000 });
    tight.clock.box.t = T0 + HOUR + 6_000;
    await tight.jobs.tick();
    await waitUntil(() => runsOf(tight).length === 1);
    expect(runsOf(tight)[0]!.trigger).toBe("sleep-wake");

    const lax = hourlyRig();
    lax.clock.box.t = T0 + HOUR + 6_000;
    await lax.jobs.tick();
    await waitUntil(() => runsOf(lax).length === 1);
    expect(runsOf(lax)[0]!.trigger).toBe("scheduled");
  });

  it("never labels a runNow as sleep-wake, however overdue the job is", async () => {
    const rig = hourlyRig();
    rig.clock.box.t = T0 + HOUR + NINE_H_13M;
    await rig.jobs.runNow("hourly");
    await waitUntil(() => runsOf(rig).length === 1);

    // A human asking for a run is never a suspend, and a manual run must not move the schedule.
    expect(runsOf(rig)[0]!.trigger).toBe("manual");
    expect(runsOf(rig)[0]!.latenessMs).toBeNull();
    expect(rig.jobs.get("hourly").nextRunTs).toBe(T0 + HOUR);
  });

  it("an overlap-skipped late fire is skipped AND sleep-wake with the same latenessMs", async () => {
    // A command that never settles pins the job in `inFlight` for the whole test.
    const stuck: CommandRunner = () => new Promise(() => {});
    const rig = hourlyRig({ runCommand: stuck });

    rig.clock.box.t = T0 + HOUR;
    await rig.jobs.tick();                                  // punctual fire, never settles
    expect(rig.jobs.get("hourly").nextRunTs).toBe(T0 + 2 * HOUR);

    rig.clock.box.t = T0 + 2 * HOUR + NINE_H_13M;
    await rig.jobs.tick();                                  // due again, but the first run is stuck

    const skipped = runsOf(rig).filter((r) => r.result === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.trigger).toBe("sleep-wake");
    expect(skipped[0]!.latenessMs).toBe(NINE_H_13M);
    expect(skipped[0]!.coalescedOccurrences).toBe(9);
    // The overlap branch re-arms too, or the skipped slot stays due and re-skips every hop.
    expect(rig.jobs.get("hourly").nextRunTs!).toBeGreaterThan(rig.clock.box.t);
  });

  it("puts latenessMs and coalescedOccurrences on job_run_started, and neither on a punctual one", async () => {
    const late = hourlyRig();
    late.clock.box.t = T0 + HOUR + NINE_H_13M;
    await late.jobs.tick();
    expect(started(late)[0]!.data).toMatchObject({
      job: "hourly", trigger: "sleep-wake", latenessMs: NINE_H_13M, coalescedOccurrences: 9,
    });

    const punctual = hourlyRig();
    punctual.clock.box.t = T0 + HOUR;
    await punctual.jobs.tick();
    const data = started(punctual)[0]!.data;
    expect(data["trigger"]).toBe("scheduled");
    // Present together or not at all — half a lateness pair is worse than none.
    expect(data).not.toHaveProperty("latenessMs");
    expect(data).not.toHaveProperty("coalescedOccurrences");
  });

  // F01-QA follow-up: job_run_started previously only carried the run under agentId "job:<name>" —
  // ui-state's per-agent transcript stamp (and any other jobName-keyed consumer) needs a field
  // that survives independent of the target kind (command targets never get an agentId at all).
  it("carries jobName and a non-null runId on job_run_started for every target kind", async () => {
    const rig = hourlyRig();
    rig.clock.box.t = T0 + HOUR + NINE_H_13M;
    await rig.jobs.tick();
    const data = started(rig)[0]!.data;
    expect(data["jobName"]).toBe("hourly");
    expect(typeof data["runId"]).toBe("string");
    expect(data["runId"]).toBeTruthy();
  });

  // THE regression guard for plan §6's "single most important line": fire()'s tail re-arm accepts
  // "sleep-wake" as well as "scheduled". Without it a late fire leaves nextRunTs in the past, so
  // tick() re-fires the very same slot on every 60s hop [F02] — forever.
  it("advances the schedule after a late fire so the same slot never re-fires", async () => {
    const rig = hourlyRig();
    rig.clock.box.t = T0 + HOUR + NINE_H_13M;
    await rig.jobs.tick();
    await waitUntil(() => runsOf(rig).length === 1);

    const next = rig.jobs.get("hourly").nextRunTs!;
    expect(next).toBeGreaterThan(rig.clock.box.t);
    expect(next).toBe(T0 + 11 * HOUR);   // anchored on the served 01:00 slot, not on the wake instant

    await rig.jobs.tick();               // the next hop, same wall clock
    expect(started(rig)).toHaveLength(1);
    expect(runsOf(rig)).toHaveLength(1);
  });
});
