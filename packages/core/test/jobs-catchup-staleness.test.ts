import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { decideCatchUp } from "@chimera/core/jobs";
import { makeJobRig, openJobs, reopenJobs, waitUntil } from "./jobs-helpers.js";

// F04: catchUp used to mean "fire it whenever we next come up, however stale". After a long
// outage that is not a report — it is a stampede of yesterday's work landing at once, each run
// acting on data that has since moved. catchUpMaxStalenessMs bounds the AGE OF THE OCCURRENCE
// (not the length of the outage): a 03:00 report opened at 08:37 is still worth having; the one
// from three days ago is not.

const HAPPY: FakeStep[] = [{ end: { resultText: "done", costUsd: 0.01 } }];
const HOUR = 3_600_000;
const CREATED_AT = Date.UTC(2026, 0, 1, 2, 0, 0);
const SLOT = Date.UTC(2026, 0, 1, 3, 0, 0);

function dailyJob(rig: ReturnType<typeof makeJobRig>, over: Record<string, unknown> = {}) {
  return rig.jobs.create({
    name: "report", schedule: { cron: "0 3 * * *" }, catchUp: true,
    target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "write the report",
    ...over,
  });
}

// A WEEKLY Thursday 03:00 job (2026-01-01 is a Thursday). The daily job above can never present a
// three-day-old occurrence — by then the grid has produced two fresher ones — so "the occurrence
// itself is stale" needs a schedule sparse enough to hold one.
const weeklyJob = (rig: ReturnType<typeof makeJobRig>, over: Record<string, unknown> = {}) =>
  dailyJob(rig, { schedule: { cron: "0 3 * * 4" }, ...over });

const skip = (rig: ReturnType<typeof makeJobRig>) =>
  rig.events.tail("job:report", 50).find((e) => e.kind === "job_skipped");

describe("decideCatchUp", () => {
  const late = (h: number) => SLOT + h * HOUR;

  it("fires an occurrence inside the window", () => {
    expect(decideCatchUp({ catchUp: true, catchUpMaxStalenessMs: 6 * HOUR }, SLOT, late(5.6))).toEqual({ fire: true });
  });

  it("refuses one past it, and says by how much", () => {
    expect(decideCatchUp({ catchUp: true, catchUpMaxStalenessMs: 6 * HOUR }, SLOT, late(72)))
      .toEqual({ fire: false, reason: "stale-beyond-window", lateMs: 72 * HOUR, maxStalenessMs: 6 * HOUR });
  });

  it("an UNSET bound is unbounded — pre-F04 catchUp keeps its exact meaning", () => {
    expect(decideCatchUp({ catchUp: true, catchUpMaxStalenessMs: null }, SLOT, late(72))).toEqual({ fire: true });
  });

  it("a bound on a catchUp:false job changes nothing — it was never going to fire", () => {
    expect(decideCatchUp({ catchUp: false, catchUpMaxStalenessMs: 6 * HOUR }, SLOT, late(1)))
      .toEqual({ fire: false, reason: "missed-restart" });
  });
});

describe("a bounded catch-up at boot", () => {
  it("fires the 03:00 occurrence when the daemon comes back at 08:37", async () => {
    const rig = makeJobRig([HAPPY], CREATED_AT);
    dailyJob(rig, { catchUpMaxStalenessMs: 6 * HOUR });
    rig.clock.box.t = SLOT + 5 * HOUR + 37 * 60_000;

    const reopened = reopenJobs(rig);
    await waitUntil(() => rig.fake.spawns.length === 1);
    const started = rig.events.tail("job:report", 20).find((e) => e.kind === "job_run_started")!;
    expect(started.data["trigger"]).toBe("catchup");
    expect(started.data["nominalFireTs"]).toBe(SLOT);
    reopened.detach();
  });

  it("refuses one three days stale, and records what it refused and against which bound", async () => {
    const rig = makeJobRig([HAPPY], CREATED_AT);
    weeklyJob(rig, { catchUpMaxStalenessMs: 6 * HOUR });
    rig.clock.box.t = SLOT + 72 * HOUR;

    const reopened = reopenJobs(rig);
    expect(rig.fake.spawns).toHaveLength(0);
    const ev = skip(rig)!;
    expect(ev.data).toMatchObject({ reason: "stale-beyond-window", nominalFireTs: SLOT, lateMs: 72 * HOUR, maxStalenessMs: 6 * HOUR });
    expect(reopened.get("report").lastRuns.at(-1)).toMatchObject({ result: "skipped", reason: "stale-beyond-window", trigger: "catchup", nominalFireTs: SLOT });
    // Refusing the stale slot must still leave the job scheduled for the NEXT one.
    expect(reopened.get("report").nextRunTs).toBe(SLOT + 168 * HOUR);
    expect(reopened.get("report").enabled).toBe(true);
    expect(reopened.get("report").consecutiveFailures).toBe(0);   // a refusal is not a failure
    reopened.detach();
  });

  it("with catchUp off, a bound is inert — the miss is still reported as missed-restart", async () => {
    const rig = makeJobRig([HAPPY], CREATED_AT);
    dailyJob(rig, { catchUp: false, catchUpMaxStalenessMs: 6 * HOUR });
    rig.clock.box.t = SLOT + 2 * HOUR;

    const reopened = reopenJobs(rig);
    expect(rig.fake.spawns).toHaveLength(0);
    expect(skip(rig)!.data["reason"]).toBe("missed-restart");
    expect(reopened.get("report").lastRuns.at(-1)).toMatchObject({ result: "skipped", reason: "missed-restart", nominalFireTs: SLOT });
    reopened.detach();
  });

  it("with no bound, a three-day-old occurrence still fires — F04 changes nothing unopted-into", async () => {
    const rig = makeJobRig([HAPPY], CREATED_AT);
    weeklyJob(rig);
    rig.clock.box.t = SLOT + 72 * HOUR;

    const reopened = reopenJobs(rig);
    await waitUntil(() => rig.fake.spawns.length === 1);
    reopened.detach();
  });

  it("a three-day outage still delivers TODAY's report — the bound ages the occurrence, not the outage", async () => {
    // The scenario the two acceptance examples are really one of: the daemon has been down since
    // Monday and comes back at 08:37. Judging the OLDEST missed slot would refuse everything and
    // make a bound strictly WORSE than no bound; the newest elapsed slot is 5h37m old, is worth
    // having, and is the slot the run is keyed on.
    const rig = makeJobRig([HAPPY], CREATED_AT);
    dailyJob(rig, { catchUpMaxStalenessMs: 6 * HOUR });
    rig.clock.box.t = SLOT + 72 * HOUR + 5 * HOUR + 37 * 60_000;

    const reopened = reopenJobs(rig);
    await waitUntil(() => rig.fake.spawns.length === 1);
    const started = rig.events.tail("job:report", 20).find((e) => e.kind === "job_run_started")!;
    expect(started.data["trigger"]).toBe("catchup");
    expect(started.data["nominalFireTs"]).toBe(SLOT + 72 * HOUR);
    expect(skip(rig)).toBeUndefined();          // the superseded slots are coalesced, not refused
    reopened.detach();
  });
});

describe("a jobs.json written before F04", () => {
  it("loads, defaults the new fields, and behaves exactly as it did", async () => {
    const rig = makeJobRig([HAPPY], CREATED_AT);
    dailyJob(rig);
    await rig.jobs.runNow("report");
    await waitUntil(() => rig.jobs.get("report").lastRuns.length === 1);
    rig.jobs.detach();

    // Strip every field F04 added — JobRecordSchema is .strict(), so this is the real shape an
    // older daemon left behind, not an approximation of it.
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    const job = raw.jobs[0]!;
    delete job["inFlight"];
    delete job["catchUpMaxStalenessMs"];
    for (const r of job["lastRuns"] as Record<string, unknown>[]) { delete r["reason"]; delete r["nominalFireTs"]; }
    writeFileSync(file, JSON.stringify(raw, null, 2));

    rig.clock.box.t = SLOT + 72 * HOUR;
    const reopened = openJobs(rig);
    const loaded = reopened.get("report");
    expect(loaded.catchUpMaxStalenessMs).toBeNull();               // absent field -> unbounded, as before
    expect(loaded.lastRuns[0]).toMatchObject({ result: "ok", reason: null, nominalFireTs: null });
    // A history with no nominalFireTs can never collide with a live occurrence, so the pre-F04
    // catch-up still fires — an upgrade must not silently swallow the first run after it. Boot
    // takes the claim synchronously, so the loaded record already carries one by now.
    expect(loaded.inFlight).toMatchObject({ nominalFireTs: SLOT + 72 * HOUR, trigger: "catchup" });
    await waitUntil(() => rig.fake.spawns.length === 1);
    reopened.detach();
  });
});
