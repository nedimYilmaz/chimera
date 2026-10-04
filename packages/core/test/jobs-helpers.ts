import type { FakeStep } from "@chimera/core/backends/fake";
import { JobScheduler, type CommandRunner } from "@chimera/core/jobs";
import type { WatchSpawner } from "@chimera/core/job-watch";
import type { WakeScheduler } from "@chimera/core/wake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

export { waitUntil };

// A mutable, injectable clock: tests advance `clock.t` directly instead of waiting on
// real wall-clock time — JobScheduler's own setTimeout still fires off `Date.now()
// - nextRunTs` deltas, but with the clock fixed far past nextRunTs that delay clamps to
// ~0, so `tick()` (called directly) settles deterministically without a real wait.
export function makeClock(startMs: number) {
  const box = { t: startMs };
  return { box, now: () => box.t };
}

// F02: maxHopMs/clockJumpThresholdMs are pass-throughs for the same reason `now` is — a test must
// be able to prove hop bounding and clock-jump detection without sleeping through a real 60s hop.
export type JobRigOpts = {
  cooldownMs?: number; runCommand?: CommandRunner; spawnWatch?: WatchSpawner;
  maxHopMs?: number; clockJumpThresholdMs?: number;
  // F01(c): same reason — a test proves a 9h suspend in 0ms by lowering the late-fire threshold
  // instead of sleeping through 120s.
  lateFireThresholdMs?: number;
  // F01(b)/(a): the OS power seam — injected so no test ever spawns a real caffeinate or sudo.
  wake?: WakeScheduler;
  wakeLeadMs?: number;
  // F05: computeRetryDelayMs's jitter seam — a retry-delay test asserts an EXACT armed instant,
  // not a range, so it needs Math.random() pinned like `now` pins the clock.
  rand?: () => number;
};

function clockSeams(opts: JobRigOpts) {
  return {
    ...(opts.maxHopMs !== undefined ? { maxHopMs: opts.maxHopMs } : {}),
    ...(opts.clockJumpThresholdMs !== undefined ? { clockJumpThresholdMs: opts.clockJumpThresholdMs } : {}),
    ...(opts.lateFireThresholdMs !== undefined ? { lateFireThresholdMs: opts.lateFireThresholdMs } : {}),
    ...(opts.wake !== undefined ? { wake: opts.wake } : {}),
    ...(opts.wakeLeadMs !== undefined ? { wakeLeadMs: opts.wakeLeadMs } : {}),
    ...(opts.rand !== undefined ? { rand: opts.rand } : {}),
  };
}

export function makeJobRig(
  scenarios: FakeStep[][],
  startMs: number,
  opts: JobRigOpts = {},
) {
  const rig = makeCoordination(scenarios, undefined, opts);
  const clock = makeClock(startMs);
  const jobs = new JobScheduler({
    home: rig.dir, teams: rig.teams, queues: rig.queues, supervisor: rig.sup, scheduler: rig.scheduler, events: rig.events,
    roles: rig.roles,
    now: clock.now,
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
    ...(opts.spawnWatch ? { spawnWatch: opts.spawnWatch } : {}),
    ...clockSeams(opts),
  });
  return { ...rig, jobs, clock };
}

export function reopenJobs(rig: ReturnType<typeof makeJobRig>, opts: JobRigOpts = {}) {
  rig.jobs.detach();
  return openJobs(rig, opts);
}

/** Boot a scheduler over the rig's home WITHOUT shutting the previous one down. Tests that
 *  hand-write jobs.json need this: detach() saves, so `reopenJobs` after an edit would flush the
 *  old in-memory records straight back over the file being tested. */
export function openJobs(rig: ReturnType<typeof makeJobRig>, opts: JobRigOpts = {}) {
  return new JobScheduler({
    home: rig.dir, teams: rig.teams, queues: rig.queues, supervisor: rig.sup, scheduler: rig.scheduler, events: rig.events,
    roles: rig.roles,
    now: rig.clock.now,
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
    ...(opts.spawnWatch ? { spawnWatch: opts.spawnWatch } : {}),
    ...clockSeams(opts),
  });
}
