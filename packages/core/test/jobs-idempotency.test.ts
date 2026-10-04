import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { jobOccurrenceKey, occurrenceServed } from "@chimera/core/jobs";
import { JobRunEntrySchema, JobInFlightSchema } from "@chimera/protocol";
import { makeJobRig, openJobs, reopenJobs, waitUntil } from "./jobs-helpers.js";

// F04: one occurrence, one run. The scheduler now has THREE paths that can reach the same grid
// slot — a scheduled tick, a boot catch-up (daemon was down) and a manual job_run — and F01's
// sleep-wake fire is a fourth. Before this, "did anyone already serve 03:00?" had no answer
// anywhere: inFlight was in-memory only and was not even populated until AFTER the spawn round
// trip. The claim is now taken BEFORE the spawn and persisted, so the answer survives both a
// concurrent path and a crash.

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }];
const HAPPY: FakeStep[] = [{ end: { resultText: "done", costUsd: 0.01 } }];

const CREATED_AT = Date.UTC(2026, 0, 1, 2, 0, 0);
const SLOT = Date.UTC(2026, 0, 1, 3, 0, 0);   // the 03:00 occurrence every ordering below races for

/** A daily 03:00 agent job whose run HOLDS, so the occurrence stays claimed for the whole test. */
function dueJobRig(scenarios: FakeStep[][] = [HOLD, HOLD, HOLD]) {
  const rig = makeJobRig(scenarios, CREATED_AT);
  const job = rig.jobs.create({
    name: "report", schedule: { cron: "0 3 * * *" }, catchUp: true,
    target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "write the report",
  });
  expect(job.nextRunTs).toBe(SLOT);
  rig.clock.box.t = SLOT;   // the slot is now due
  return rig;
}

const skips = (rig: ReturnType<typeof makeJobRig>) =>
  rig.events.tail("job:report", 50).filter((e) => e.kind === "job_skipped").map((e) => e.data["reason"]);

describe("F04: the three-way race for one occurrence resolves to exactly one spawn", () => {
  // qa/F01 §3 window 1, in all three orderings the recorded race can arrive in. The invariant is
  // ONE SPAWN — not one identical reason: which guard catches a leg depends on whether the slot is
  // still the job's nextRunTs when that leg arrives, and a manual run is only ever assigned a slot
  // while the job is still due for it (see the "never refuses an out-of-band run" test below).
  it("manual first, then boot catch-up, then a scheduled tick", async () => {
    const rig = dueJobRig();
    expect((await rig.jobs.runNow("report")).started).toBe(true);
    await waitUntil(() => rig.fake.spawns.length === 1);

    const reopened = reopenJobs(rig);        // boot catch-up: nextRunTs is still the claimed 03:00
    await waitUntil(() => skips(rig).includes("duplicate-occurrence"));
    await reopened.tick();

    expect(rig.fake.spawns.length).toBe(1);
    const dup = rig.events.tail("job:report", 50).find((e) => e.data["reason"] === "duplicate-occurrence")!;
    expect(dup.data["nominalFireTs"]).toBe(SLOT);
    expect(dup.data["idempotencyKey"]).toBe(jobOccurrenceKey("report", SLOT));
    expect(dup.data["trigger"]).toBe("catchup");
    reopened.detach();
  });

  it("scheduled tick first, then a manual run, then boot catch-up", async () => {
    const rig = dueJobRig();
    await rig.jobs.tick();
    await waitUntil(() => rig.fake.spawns.length === 1);

    // The tick moved nextRunTs to tomorrow, so this manual run is NOT the 03:00 occurrence any
    // more — it is an ordinary overlap, which is the honest classification.
    expect((await rig.jobs.runNow("report")).started).toBe(false);
    const reopened = reopenJobs(rig);
    await reopened.tick();

    expect(rig.fake.spawns.length).toBe(1);
    expect(skips(rig)).toContain("overlap");
    reopened.detach();
  });

  it("boot catch-up first, then a scheduled tick, then a manual run", async () => {
    const rig = dueJobRig();
    const reopened = reopenJobs(rig);        // the daemon comes up with 03:00 already elapsed
    await waitUntil(() => rig.fake.spawns.length === 1);
    expect(rig.events.tail("job:report", 50).find((e) => e.kind === "job_run_started")!.data["trigger"]).toBe("catchup");

    await reopened.tick();                   // catch-up advanced the schedule: nothing is due
    expect((await reopened.runNow("report")).started).toBe(false);

    expect(rig.fake.spawns.length).toBe(1);
    reopened.detach();
  });

  it("a scheduled tick for a slot a manual run already claimed is refused as a duplicate", async () => {
    const rig = dueJobRig();
    await rig.jobs.runNow("report");
    await waitUntil(() => rig.fake.spawns.length === 1);
    await rig.jobs.tick();

    expect(rig.fake.spawns.length).toBe(1);
    const entry = rig.jobs.get("report").lastRuns.at(-1)!;
    expect(entry.result).toBe("skipped");
    expect(entry.reason).toBe("duplicate-occurrence");
    expect(entry.nominalFireTs).toBe(SLOT);
    // Refused, but the schedule still moved — a duplicate that stayed due would re-fire on every
    // 60s hop [F02] forever.
    expect(rig.jobs.get("report").nextRunTs).toBe(Date.UTC(2026, 0, 2, 3, 0, 0));
  });

  it("a POST-WAKE fire for a slot a manual run already claimed is refused as a duplicate", async () => {
    // F01(c)'s path into the same slot: the operator runs the job by hand as the lid closes, and the
    // wake tick re-fires the occurrence the scheduler still thinks is owed. The duplicate guard has
    // to re-arm on a "sleep-wake" trigger exactly as on "scheduled" — a refused late fire that
    // stayed due would re-fire on every 60s hop forever.
    const rig = makeJobRig([HOLD], CREATED_AT, { lateFireThresholdMs: 5_000 });
    rig.jobs.create({
      name: "report", schedule: { cron: "0 3 * * *" }, catchUp: true,
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "write the report",
    });
    rig.clock.box.t = SLOT;
    expect((await rig.jobs.runNow("report")).started).toBe(true);
    await waitUntil(() => rig.fake.spawns.length === 1);

    rig.clock.box.t = SLOT + 9 * 3_600_000;   // nine hours asleep; 03:00 is still the job's nextRunTs
    await rig.jobs.tick();
    expect((await rig.jobs.runNow("report")).started).toBe(false);   // third leg: no longer due -> overlap

    expect(rig.fake.spawns.length).toBe(1);
    const entry = rig.jobs.get("report").lastRuns.find((r) => r.reason === "duplicate-occurrence")!;
    expect(entry).toMatchObject({ result: "skipped", trigger: "sleep-wake", nominalFireTs: SLOT });
    expect(rig.jobs.get("report").nextRunTs).toBe(Date.UTC(2026, 0, 2, 3, 0, 0));
  });
});

describe("F04: what the occurrence key must NOT refuse", () => {
  it("an out-of-band manual run is never deduped — it belongs to no slot", async () => {
    const rig = makeJobRig([HAPPY, HAPPY], CREATED_AT);
    rig.jobs.create({
      name: "adhoc", schedule: { cron: "0 3 * * *" },
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "go",
    });   // 03:00 is an hour away: the job is NOT due, so neither run serves an occurrence

    await rig.jobs.runNow("adhoc");
    await waitUntil(() => rig.jobs.get("adhoc").lastRuns.length === 1);
    await rig.jobs.runNow("adhoc");
    await waitUntil(() => rig.jobs.get("adhoc").lastRuns.length === 2);

    expect(rig.fake.spawns.length).toBe(2);
    expect(rig.jobs.get("adhoc").lastRuns.map((r) => [r.result, r.nominalFireTs]))
      .toEqual([["ok", null], ["ok", null]]);
  });
});

describe("F04: the claim is durable before anything is spawned", () => {
  it("jobs.json already carries the occurrence key at the instant the target is invoked", async () => {
    let onDisk: Record<string, unknown> | null = null;
    const rig = makeJobRig([], CREATED_AT, {
      runCommand: async () => {
        // Read from DISK, not from the record: the point is that a process killed right here
        // leaves a recoverable claim behind, not that the in-memory object looks right.
        const raw = JSON.parse(readFileSync(join(rig.dir, "jobs.json"), "utf8")) as { jobs: { inFlight: Record<string, unknown> }[] };
        onDisk = raw.jobs[0]!.inFlight;
        return { exitCode: 0, output: "" };
      },
    });
    rig.jobs.create({ name: "prune", schedule: { cron: "0 3 * * *" }, target: { command: "git worktree prune" } });
    rig.clock.box.t = SLOT;
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("prune").lastRuns.length === 1);

    expect(onDisk).toMatchObject({ idempotencyKey: jobOccurrenceKey("prune", SLOT), nominalFireTs: SLOT, trigger: "scheduled" });
    expect(rig.jobs.get("prune").inFlight).toBeNull();   // and it is released once the run settles
  });
});

describe("F04: a run in flight across a daemon restart", () => {
  it("is re-adopted, not re-spawned, and settles exactly once", async () => {
    const rig = dueJobRig();
    await rig.jobs.tick();
    await waitUntil(() => rig.fake.spawns.length === 1);
    const agentId = rig.jobs.get("report").inFlight!.agentId!;

    const reopened = reopenJobs(rig);
    expect(rig.fake.spawns.length).toBe(1);
    expect(reopened.get("report").lastRuns).toHaveLength(0);   // adoption is not a run of its own
    expect(reopened.get("report").inFlight).toMatchObject({ kind: "agent", agentId, nominalFireTs: SLOT });
    expect(rig.events.tail("job:report", 50).some((e) => e.kind === "job_run_started" && e.data["readopted"] === true)).toBe(true);

    await rig.sup.send(agentId, "go");   // the adopted agent finishes under the NEW scheduler
    await waitUntil(() => reopened.get("report").lastRuns.length === 1);
    const entry = reopened.get("report").lastRuns[0]!;
    expect(entry.result).toBe("ok");
    expect(entry.agentId).toBe(agentId);
    expect(entry.nominalFireTs).toBe(SLOT);
    expect(reopened.get("report").inFlight).toBeNull();
    reopened.detach();
  });

  it("an orphaned claim is buried as a daemon-crash, and does not count toward the failure guard", async () => {
    const rig = dueJobRig([HAPPY]);
    rig.jobs.detach();   // detach() SAVES — the file may only be edited once the old scheduler is down
    // The one state the process itself can never produce: a claim whose agent died with the daemon.
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    raw.jobs[0]!["inFlight"] = {
      idempotencyKey: jobOccurrenceKey("report", SLOT), nominalFireTs: SLOT, trigger: "scheduled",
      startedAt: SLOT, kind: "agent", agentId: "agent-ghost", taskId: null,
    };
    writeFileSync(file, JSON.stringify(raw, null, 2));

    const reopened = openJobs(rig);
    const job = reopened.get("report");
    expect(job.inFlight).toBeNull();
    expect(job.lastRuns[0]).toMatchObject({ result: "failed", reason: "daemon-crash", nominalFireTs: SLOT, agentId: "agent-ghost" });
    // The daemon crashed; the job did not misbehave. Counting it would let an outage disable a
    // perfectly healthy job after three restarts.
    expect(job.consecutiveFailures).toBe(0);
    expect(job.enabled).toBe(true);
    expect(rig.events.tail("job:report", 50).some((e) => e.kind === "job_run_finished" && e.data["reason"] === "daemon-crash")).toBe(true);
    // The slot was SERVED (badly) — burying it does not hand it back to the boot catch-up sweep,
    // which would otherwise re-run every crashed occurrence on top of a half-finished one. The
    // sweep still RECORDS its refusal, so the operator sees why 03:00 was not retried.
    expect(rig.fake.spawns).toHaveLength(0);
    expect(job.lastRuns.map((r) => r.reason)).toEqual(["daemon-crash", "duplicate-occurrence"]);
    expect(job.inFlight).toBeNull();
    reopened.detach();
  });
});

describe("F04.QA-B: attempt is the third key component, so a retry is not a duplicate", () => {
  // 40-verdict.md:95 specified the key as {jobId, nominalFireTs}; that shape is result-blind, so a
  // FAILED run stamps its slot and the slot is then refused for the whole JOB_LAST_RUNS_CAP
  // horizon — no F05 backoff re-fire could ever be admitted. Amended to {jobId, nominalFireTs,
  // attempt}; the three-way race still collapses to one because all three legs are attempt 0.
  const ledgerEntry = (nominalFireTs: number, attempt?: number) =>
    JobRunEntrySchema.parse({ ts: nominalFireTs, trigger: "scheduled", result: "failed", nominalFireTs,
      ...(attempt === undefined ? {} : { attempt }) });

  it("history: the same attempt is served, a HIGHER attempt is not, a LOWER one still is", () => {
    const failedAt0 = { inFlight: null, lastRuns: [ledgerEntry(SLOT, 0)] };
    expect(occurrenceServed(failedAt0, SLOT, 0)).toBe(true);    // (a) duplicate of the same attempt
    expect(occurrenceServed(failedAt0, SLOT, 1)).toBe(false);   // (b) F05's retry of that occurrence
    // `>=`, not `===`: F05 keys on job-wide consecutiveFailures, so attempt numbers can SKIP
    // values — a stale attempt-1 leg arriving after attempt 2 ran must still be refused.
    expect(occurrenceServed({ inFlight: null, lastRuns: [ledgerEntry(SLOT, 2)] }, SLOT, 1)).toBe(true);
    expect(occurrenceServed(failedAt0, SLOT + 1, 0)).toBe(false);   // a different slot is untouched
  });

  it("a claim in flight owns its slot at EVERY attempt", () => {
    // Otherwise a higher-attempt fire would fall through to the overlap guard and, under
    // overlapPolicy:"queue", be parked as a slot-less pendingRerun — a retry silently downgraded.
    const claimed = { inFlight: JobInFlightSchema.parse({ idempotencyKey: jobOccurrenceKey("report", SLOT), nominalFireTs: SLOT, trigger: "scheduled", startedAt: SLOT, kind: "starting" }), lastRuns: [] };
    expect(occurrenceServed(claimed, SLOT, 0)).toBe(true);
    expect(occurrenceServed(claimed, SLOT, 7)).toBe(true);
  });

  it("a jobs.json written before this parses as attempt 0, and its slot is still refused at 0", async () => {
    const rig = dueJobRig([HAPPY]);
    rig.jobs.detach();   // detach() SAVES — edit the file only once the old scheduler is down
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    // (c) a pre-F04.QA-B ledger: a failed run for the slot, with NO `attempt` key anywhere.
    raw.jobs[0]!["lastRuns"] = [{ ts: SLOT, trigger: "scheduled", result: "failed", error: "boom", nominalFireTs: SLOT }];
    raw.jobs[0]!["nextRunTs"] = SLOT;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    rig.clock.box.t = SLOT + 60_000;

    const reopened = openJobs(rig);
    expect(reopened.get("report").lastRuns[0]!.attempt).toBe(0);
    // The boot catch-up sweep serves the same slot at attempt 0 and is refused, exactly as before.
    await waitUntil(() => reopened.get("report").lastRuns.some((r) => r.reason === "duplicate-occurrence"));
    expect(rig.fake.spawns).toHaveLength(0);

    // (b) through the real fire path — the seam F05 drives, passing job.consecutiveFailures.
    await (reopened as unknown as { fire: (...a: unknown[]) => Promise<unknown> })
      .fire(reopened.get("report"), "manual", SLOT, null, { attempt: 1 });
    await waitUntil(() => rig.fake.spawns.length === 1);
    const started = rig.events.tail("job:report", 50).find((e) => e.kind === "job_run_started")!;
    expect(started.data["idempotencyKey"]).toBe(jobOccurrenceKey("report", SLOT, 1));
    await waitUntil(() => reopened.get("report").lastRuns.some((r) => r.attempt === 1 && r.result === "ok"));
    expect(reopened.get("report").lastRuns.filter((r) => r.nominalFireTs === SLOT && r.attempt === 1)).toHaveLength(1);
    reopened.detach();
  });
});
