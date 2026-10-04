import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { jobOccurrenceKey, latestOccurrenceAtOrBefore } from "@chimera/core/jobs";
import { makeJobRig, openJobs, waitUntil } from "./jobs-helpers.js";

// F04 QA. The feature's own suite proves the happy invariants (one spawn per occurrence, boot
// re-adoption, the staleness matrix). These are the legs it does NOT ask about: what the ledger
// looks like after the race, what an out-of-band claim is keyed on, and what "served" means when
// the occurrence was never actually run.

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }];
const HAPPY: FakeStep[] = [{ end: { resultText: "done", costUsd: 0.01 } }];

const CREATED_AT = Date.UTC(2026, 0, 1, 2, 0, 0);
const SLOT = Date.UTC(2026, 0, 1, 3, 0, 0);

function dueJobRig(scenarios: FakeStep[][] = [HOLD]) {
  const rig = makeJobRig(scenarios, CREATED_AT);
  rig.jobs.create({
    name: "report", schedule: { cron: "0 3 * * *" }, catchUp: true,
    target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "write the report",
  });
  rig.clock.box.t = SLOT;
  return rig;
}

describe("F04 QA: the run ledger after a refused duplicate", () => {
  // Plan lines 249-251 required the duplicate skip row to be recorded AT MOST ONCE per occurrence,
  // precisely so a race cannot evict the runs the 20-entry history exists to explain. A manual
  // run_now never advances the schedule, so the slot stays due and every further press lands on
  // the duplicate guard again — an operator double-pressing run-now is the reproduction.
  it("an operator pressing run-now three times on a claimed slot writes ONE skip row, not three", async () => {
    const rig = dueJobRig();
    expect((await rig.jobs.runNow("report")).started).toBe(true);
    await waitUntil(() => rig.fake.spawns.length === 1);

    for (let i = 0; i < 3; i++) {
      const r = await rig.jobs.runNow("report");
      expect(r).toMatchObject({ started: false, skipped: true, reason: "duplicate-occurrence" });
    }

    expect(rig.fake.spawns.length).toBe(1);
    const dupes = rig.jobs.get("report").lastRuns.filter((r) => r.reason === "duplicate-occurrence");
    expect(dupes.length).toBe(1);
    rig.jobs.detach();
  });
});

describe("F04 QA: what an out-of-band manual claim is keyed on", () => {
  // Plan line 290 keyed a slot-less run `job:<name>:manual-<now>`. Reusing jobOccurrenceKey(name,
  // now) instead makes the claim indistinguishable from a real grid slot at 03:00:00.123 — every
  // key -> slot consumer (F05, the transcript, an operator grepping events) reads a phantom
  // occurrence out of it.
  it("a not-due run_now claims a key that cannot be mistaken for a grid slot", async () => {
    let onDisk: Record<string, unknown> | null = null;
    const rig = makeJobRig([], CREATED_AT, {
      runCommand: async () => {
        const raw = JSON.parse(readFileSync(join(rig.dir, "jobs.json"), "utf8")) as { jobs: { inFlight: Record<string, unknown> }[] };
        onDisk = raw.jobs[0]!.inFlight;
        return { exitCode: 0, output: "" };
      },
    });
    rig.jobs.create({ name: "prune", schedule: { cron: "0 3 * * *" }, target: { command: "git worktree prune" } });
    await rig.jobs.runNow("prune");                       // 03:00 is an hour away: no slot is served
    await waitUntil(() => rig.jobs.get("prune").lastRuns.length === 1);

    expect(onDisk).toMatchObject({ nominalFireTs: null });
    expect((onDisk as unknown as { idempotencyKey: string }).idempotencyKey).toBe(`job:prune:manual-${CREATED_AT}`);
    rig.jobs.detach();
  });
});

describe("F04 QA-A: a crash between the claim and the spawn", () => {
  // The carry-forward asks for a crash injected BETWEEN the durable claim and the spawn. That is
  // exactly the `kind:"starting"` marker: claimed, agentId null, nothing spawned. recoverInFlight
  // cannot adopt it (correct — there is nothing to adopt), so it is buried. The burial must NOT
  // stamp the slot: occurrenceServed() is a pure slot lookup, so a stamped burial would read as
  // service and the boot catch-up sweep that exists to recover exactly this would refuse the slot
  // as a duplicate — the occurrence neither recovered nor duplicated, but LOST. Burying it with
  // nominalFireTs null and reason "daemon-crash-prespawn" leaves the slot claimable, so catch-up
  // serves it, still subject to catchUpMaxStalenessMs like any other missed occurrence.
  it("leaves the slot unserved, so boot catch-up runs the occurrence instead of losing it", async () => {
    const rig = dueJobRig([HAPPY]);
    rig.jobs.detach();
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    raw.jobs[0]!["inFlight"] = {
      idempotencyKey: jobOccurrenceKey("report", SLOT), nominalFireTs: SLOT, trigger: "scheduled",
      startedAt: SLOT, kind: "starting", agentId: null, taskId: null,
    };
    raw.jobs[0]!["nextRunTs"] = SLOT;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    rig.clock.box.t = SLOT + 10 * 60_000;

    const reopened = openJobs(rig);
    await waitUntil(() => reopened.get("report").lastRuns.length === 2);
    expect(rig.fake.spawns).toHaveLength(1);

    const [buried, served] = reopened.get("report").lastRuns;
    expect(buried).toMatchObject({ result: "failed", reason: "daemon-crash-prespawn", nominalFireTs: null });
    expect(served).toMatchObject({ result: "ok", reason: null, nominalFireTs: SLOT, trigger: "catchup" });
    reopened.detach();
  });

  // The discriminator is `kind`, not "both ids are null": a "command" marker also carries two null
  // ids, but its command DID launch inside the dead process. Re-firing it would repeat a
  // half-finished side effect, so it stays stamped with its slot and stays refused.
  it("still buries a command marker against its slot — the command did run", async () => {
    const rig = makeJobRig([], CREATED_AT, { runCommand: async () => ({ exitCode: 0, output: "" }) });
    rig.jobs.create({ name: "prune", schedule: { cron: "0 3 * * *" }, catchUp: true, target: { command: "git worktree prune" } });
    rig.jobs.detach();
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    raw.jobs[0]!["inFlight"] = {
      idempotencyKey: jobOccurrenceKey("prune", SLOT), nominalFireTs: SLOT, trigger: "scheduled",
      startedAt: SLOT, kind: "command", agentId: null, taskId: null,
    };
    raw.jobs[0]!["nextRunTs"] = SLOT;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    rig.clock.box.t = SLOT + 10 * 60_000;

    const reopened = openJobs(rig, { runCommand: async () => ({ exitCode: 0, output: "" }) });
    const runs = reopened.get("prune").lastRuns;
    expect(runs.map((r) => r.reason)).toEqual(["daemon-crash", "duplicate-occurrence"]);
    expect(runs[0]!.nominalFireTs).toBe(SLOT);
    reopened.detach();
  });
});

describe("F04 QA-A: re-adoption is on the record, not only in the feed", () => {
  // A client that connects AFTER the restart holds no event backlog, so a marker derived from
  // `job_run_started … readopted:true` is invisible to it. The durable flag answers from job state
  // alone — this is the client's view with an empty feed.
  it("a re-adopted claim carries readopted:true in job state", async () => {
    const rig = dueJobRig();
    await rig.jobs.tick();
    await waitUntil(() => rig.fake.spawns.length === 1);
    expect(rig.jobs.get("report").inFlight).toMatchObject({ kind: "agent", readopted: false });

    const reopened = openJobs(rig);
    expect(reopened.get("report").inFlight).toMatchObject({ kind: "agent", readopted: true });
    reopened.detach();
  });
});

describe("F04 QA-C: the newest-occurrence walk can cap out", () => {
  // MAX_OCCURRENCE_SKIPS is reachable: a minutely job needs only ~7 days of downtime. Returning
  // the stale anchor there would judge the OLDEST missed slot, turning catchUpMaxStalenessMs back
  // into a bound on downtime; re-deriving from now would key catch-up on a FUTURE slot and get the
  // grid's own fire refused as a duplicate — the fire-storm hazard advanceOccurrence guards
  // against, inverted. Null says so instead.
  it("returns null rather than a wrong slot", () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 0, 0);
    const minutely = { every: { unit: "minutes", n: 1 } } as const;
    expect(latestOccurrenceAtOrBefore(minutely, "UTC", anchor, anchor + 60 * 60_000)).toBe(anchor + 60 * 60_000);
    expect(latestOccurrenceAtOrBefore(minutely, "UTC", anchor, anchor + 8 * 24 * 3600_000)).toBeNull();
  });

  it("reports an unnameable slot as swallowed by the restart, and fires nothing", async () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rig = makeJobRig([HAPPY], anchor);
    rig.jobs.create({
      name: "beat", schedule: { every: { unit: "minutes", n: 1 } }, catchUp: true,
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "beat",
    });
    rig.jobs.detach();
    const file = join(rig.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, unknown>[] };
    raw.jobs[0]!["nextRunTs"] = anchor;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    rig.clock.box.t = anchor + 8 * 24 * 3600_000;

    const reopened = openJobs(rig);
    expect(rig.fake.spawns).toHaveLength(0);
    expect(reopened.get("beat").lastRuns).toMatchObject([{ result: "skipped", reason: "missed-restart", nominalFireTs: null }]);
    reopened.detach();
  });
});
