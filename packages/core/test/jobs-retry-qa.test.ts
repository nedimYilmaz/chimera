import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY_REFUSED_REARM_MS } from "@chimera/core/jobs";
import { makeJobRig, openJobs, waitUntil } from "./jobs-helpers.js";

const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.02 } }];
const FAIL: FakeStep[] = [{ fail: { message: "boom" } }];
// Stays in_progress until a step advance is sent — used to hold a MANUAL run in flight so a
// retry attempt can be dispatched into it and observed as refused, without ever settling
// (settling either way would touch job.failure/consecutiveFailures and confound the assertions).
const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }];
const H = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m, 0);

function crew(rig: ReturnType<typeof makeJobRig>) {
  rig.queues.create({ name: "work", retryLimit: 0 });
  rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" });
}

const failedRows = (rig: ReturnType<typeof makeJobRig>, n: string) => rig.jobs.get(n).lastRuns.filter((r) => r.result === "failed");

describe("F05.QA: the retry chain's occurrence identity", () => {
  // QA-B1 — the plan's A14, written with the schedule the plan actually names
  // (`every:{unit:"hours",n:1}`). The shipped A14 uses `cron:"0 * * * *"`, an ABSOLUTE grid that
  // cannot be re-phased by any anchor, so it passes without exercising the property.
  // Green as of F05.QA-FIX: the backoff moved to failure.retryAt, so the anchor advanceSchedule
  // reads is still the 02:00 grid slot and the phase survives. Before the fix this resumed at
  // 03:05 (02:00 slot + one 5m backoff hop) and stayed skewed forever.
  it("QA-B1: an `every` schedule keeps its phase across a retry (02:00 job resumes at 03:00, not 03:05)", async () => {
    const rig = makeJobRig([FAIL, HAPPY("recovered")], H(1));
    crew(rig);
    const job = rig.jobs.create({
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });
    expect(job.nextRunTs).toBe(H(2));

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(3));               // grid, untouched by the failure
    expect(rig.jobs.get("hourly").failure!.retryAt).toBe(H(2, 5));     // backoff, on its own clock

    rig.clock.box.t = H(2, 5);
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("hourly").lastRuns.some((r) => r.result === "ok"));
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(3));
  });

  // QA-B2 — the plan's "vs F04" requirement: the re-fire must serve the SAME occurrence at a
  // DISTINCT attempt (`fire(..., { attempt: job.consecutiveFailures })`).
  // Green as of F05.QA-FIX: tick() dispatches the re-fire with opts.attempt, so it keys
  // job:<name>:<slot>#1 instead of job:<name>:<backoffInstant>#0 and F04 can tell a retry from a
  // fresh occurrence.
  it("QA-B2: the backoff re-fire serves the original occurrence at attempt 1", async () => {
    const rig = makeJobRig([FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);
    expect(failedRows(rig, "hourly")[0]!.nominalFireTs).toBe(H(2));
    expect(failedRows(rig, "hourly")[0]!.attempt).toBe(0);

    rig.clock.box.t = H(2, 5);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 2);
    const retry = failedRows(rig, "hourly")[1]!;
    expect(retry.nominalFireTs).toBe(H(2));   // same occurrence...
    expect(retry.attempt).toBe(1);            // ...distinct attempt
  });

  // QA-D — A15 ("a retry never pushes out a nearer scheduled occurrence") at attempt 2+. The
  // shipped A15 drives ONE failure, which is the only case the `prev === null` ceiling covers.
  // Green as of F05.QA-FIX: the ceiling (and its prev === null gate) is gone because the backoff
  // never touches the grid. The 03:00 occurrence still cannot RUN — the chain owns the target —
  // but it is now reported as a retry-pending skip instead of vanishing.
  it("QA-D: a second-attempt backoff does not swallow the next grid occurrence", async () => {
    const rig = makeJobRig([FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 5, backoff: "exponential", baseMs: 30 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(3));
    expect(rig.jobs.get("hourly").failure!.retryAt).toBe(H(2, 30));

    rig.clock.box.t = H(2, 30);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 2);
    // 03:00 is a real occurrence and the next backoff lands at 03:30, past it.
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(3));
    expect(rig.jobs.get("hourly").failure!.retryAt).toBe(H(3, 30));

    // 03:00 arrives with attempt 2 still pending: the slot cannot run, but the operator SEES it.
    rig.clock.box.t = H(3);
    await rig.jobs.tick();
    const skipped = rig.jobs.get("hourly").lastRuns.filter((r) => r.reason === "retry-pending");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.result).toBe("skipped");
    expect(skipped[0]!.nominalFireTs).toBe(H(3));
    const ev = rig.events.tail("job:hourly", 100)
      .filter((e) => e.kind === "job_skipped" && (e.data as { reason: string }).reason === "retry-pending");
    expect(ev.length).toBe(1);
    expect((ev[0]!.data as { nominalFireTs: number; attempt: number })).toMatchObject({ nominalFireTs: H(3), attempt: 2 });
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(4));   // grid moves on; the chain keeps its own clock
  });

  // QA-B3 — the F04.QA-B interaction (memory 2df4b5e7). A dead-lettered chain leaves attempt 0 AND
  // attempt 1 rows on its slot, and requeue() resets consecutiveFailures to 0. If anything still
  // pointed at that slot the next fire would be attempt 0 of an occurrence already served — F04
  // would refuse it as a duplicate and the operator would get a skip they never asked for.
  it("QA-B3: a requeue after a dead-lettered chain re-arms a fresh slot, never attempt 0 of the served one", async () => {
    const rig = makeJobRig([FAIL, FAIL, HAPPY("green")], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);
    rig.clock.box.t = H(2, 5);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 2);
    expect(rig.jobs.get("hourly").failure!.nominalRunTs).toBe(H(2));
    expect(failedRows(rig, "hourly").map((r) => r.attempt)).toEqual([0, 1]);

    rig.clock.box.t = H(2, 30);
    const revived = rig.jobs.requeue("hourly");
    expect(revived.consecutiveFailures).toBe(0);
    expect(revived.failure).toBeNull();     // the retry clock dies with the chain
    expect(revived.nextRunTs).toBe(H(3));   // a FRESH slot, not the already-served H(2)

    rig.clock.box.t = H(3);
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("hourly").lastRuns.some((r) => r.result === "ok"));
    const ok = rig.jobs.get("hourly").lastRuns.find((r) => r.result === "ok")!;
    expect(ok.nominalFireTs).toBe(H(3));
    expect(ok.attempt).toBe(0);
    expect(rig.jobs.get("hourly").lastRuns.some((r) => r.reason === "duplicate-occurrence")).toBe(false);
  });

  // QA-B4 — the restart case the fix newly owns: reconcileBoot now has to tell "the daemon was
  // down over a grid slot a live chain is blocking" from "the daemon was down for less than the
  // backoff". Catching the elapsed slot up while a retry is armed would run the target twice.
  it("QA-B4: a restart mid-backoff keeps the armed retry and never catches its slot up", async () => {
    const rig = makeJobRig([FAIL, HAPPY("after-restart")], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", catchUp: true,
      retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);

    // Restart INSIDE the backoff window: no grid slot has elapsed, so reconcileBoot must leave the
    // chain exactly as the dead process persisted it — the retry instant survives the restart.
    rig.clock.box.t = H(2, 3);
    rig.jobs.detach();
    const boot = openJobs(rig);
    expect(boot.get("hourly").failure!.retryAt).toBe(H(2, 5));
    expect(boot.get("hourly").nextRunTs).toBe(H(3));
    expect(boot.get("hourly").lastRuns.some((r) => r.reason === "retry-pending")).toBe(false);

    rig.clock.box.t = H(2, 5);
    await boot.tick();
    await waitUntil(() => boot.get("hourly").lastRuns.some((r) => r.result === "ok"));
    const ok = boot.get("hourly").lastRuns.find((r) => r.result === "ok")!;
    expect(ok.nominalFireTs).toBe(H(2));   // still the ORIGINAL occurrence…
    expect(ok.attempt).toBe(1);            // …at the next attempt, not a fresh 02:05 one
    boot.detach();
  });

  // The other half of QA-B4: down long enough that a grid slot really was swallowed. catchUp:true
  // would otherwise fire 03:00 at attempt 0 while the 02:00 chain is still owed an attempt.
  it("QA-B4b: a restart past a blocked grid slot reports it skipped instead of catching it up", async () => {
    const rig = makeJobRig([FAIL, HAPPY("after-restart")], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", catchUp: true,
      retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);

    rig.clock.box.t = H(3, 10);
    rig.jobs.detach();
    const boot = openJobs(rig);
    const skipped = boot.get("hourly").lastRuns.filter((r) => r.reason === "retry-pending");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.nominalFireTs).toBe(H(3));
    expect(boot.get("hourly").nextRunTs).toBe(H(4));          // grid moved on, once
    expect(boot.get("hourly").failure!.retryAt).toBe(H(2, 5)); // the chain still owns the job

    await boot.tick();
    await waitUntil(() => boot.get("hourly").lastRuns.some((r) => r.result === "ok"));
    const ok = boot.get("hourly").lastRuns.find((r) => r.result === "ok")!;
    expect(ok.nominalFireTs).toBe(H(2));
    expect(ok.attempt).toBe(1);
    expect(boot.get("hourly").nextRunTs).toBe(H(4));
    boot.detach();
  });
});

describe("F05.QA: requeue", () => {
  // QA-C — clearFailure() mutates the record in place and only THEN calls validateSchedule(),
  // which throws for a schedule that can no longer fire. The throw leaves the live record (get()
  // returns the map object, jobs.ts:1327) half-revived: enabled, failure gone, dead-letter reasons
  // gone — while disk still says dead-lettered, until any later save() persists the half-apply.
  it("QA-C: a requeue that cannot re-arm leaves the job dead-lettered, not half-revived", async () => {
    const rig = makeJobRig([FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "oneshot", schedule: { at: H(2) }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 60_000, jitter: false },
    });
    for (let i = 0; i < 2; i++) {
      const before = failedRows(rig, "oneshot").length;
      await rig.jobs.runNow("oneshot");
      await waitUntil(() => failedRows(rig, "oneshot").length === before + 1);
    }
    expect(rig.jobs.get("oneshot").failure!.deadLetterAt).not.toBeNull();

    rig.clock.box.t = H(3);   // the one-shot instant is now in the past
    expect(() => rig.jobs.requeue("oneshot")).toThrow(/job_update|new schedule/);

    const after = rig.jobs.get("oneshot");
    expect(after.failure).not.toBeNull();
    expect(after.failure!.deadLetterAt).not.toBeNull();
    expect(after.enabled).toBe(false);
  });

  // QA-F — protocol/src/index.ts:1904 documents job_dead_letter as "job_requeue is the only exit".
  // It is not: job_update{enabled:true} takes the same `reenabled` branch (jobs.ts:1452-1456) and
  // clears failure/consecutiveFailures/disabledReason just as thoroughly. Pinned so the two exits
  // stay deliberately equivalent instead of drifting apart unnoticed.
  it("QA-F: job_update{enabled:true} is a second, undocumented exit from dead-letter", async () => {
    const rig = makeJobRig([FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 60_000, jitter: false },
    });
    for (let i = 0; i < 2; i++) {
      const before = failedRows(rig, "hourly").length;
      await rig.jobs.runNow("hourly");
      await waitUntil(() => failedRows(rig, "hourly").length === before + 1);
    }
    expect(rig.jobs.get("hourly").failure!.deadLetterAt).not.toBeNull();

    rig.clock.box.t = H(1, 30);
    const revived = rig.jobs.update("hourly", { enabled: true });
    expect(revived.enabled).toBe(true);
    expect(revived.failure).toBeNull();
    expect(revived.consecutiveFailures).toBe(0);
    expect(revived.disabledReason).toBeNull();
    expect(revived.nextRunTs).toBe(H(2));
  });

  // QA-A — the TRUE behaviour of requeue, pinned so the tool description cannot drift back to
  // claiming it "re-drives the ONE occurrence that was dead-lettered with a fresh attempt".
  // It re-arms the NEXT grid occurrence and runs nothing; the plan (line 430) says exactly that.
  it("QA-A: requeue re-arms the next occurrence and runs nothing immediately", async () => {
    const rig = makeJobRig([FAIL, FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 60_000, jitter: false },
    });
    for (let i = 0; i < 2; i++) {
      const before = failedRows(rig, "hourly").length;
      await rig.jobs.runNow("hourly");
      await waitUntil(() => failedRows(rig, "hourly").length === before + 1);
    }
    expect(rig.jobs.get("hourly").failure!.deadLetterAt).not.toBeNull();

    const rowsBefore = rig.jobs.get("hourly").lastRuns.length;
    rig.clock.box.t = H(1, 30);
    const revived = rig.jobs.requeue("hourly");
    expect(revived.enabled).toBe(true);
    expect(revived.failure).toBeNull();
    expect(revived.nextRunTs).toBe(H(2));                          // the next GRID slot, not now
    expect(rig.jobs.get("hourly").lastRuns.length).toBe(rowsBefore);   // nothing re-driven
  });

  // QA-R — the carry-forward's "a requeue that fails again dead-letters again (no infinite loop)".
  // A8 only pins that requeue() RESETS the budget; the closed loop is the thing an operator
  // actually depends on, so drive it: revive, fail the whole fresh budget, land in a SECOND
  // dead-letter, and prove nothing keeps firing after it.
  it("QA-R: a requeued job that fails again dead-letters again and then stays stopped", async () => {
    const rig = makeJobRig([FAIL, FAIL, FAIL, FAIL], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });
    const burn = async (slot: number, retry: number) => {
      for (const t of [slot, retry]) {
        const before = failedRows(rig, "hourly").length;
        rig.clock.box.t = t;
        await rig.jobs.tick();
        await waitUntil(() => failedRows(rig, "hourly").length === before + 1);
      }
    };

    await burn(H(2), H(2, 5));
    expect(rig.jobs.get("hourly").failure!.deadLetterAt).toBe(H(2, 5));

    rig.clock.box.t = H(2, 30);
    expect(rig.jobs.requeue("hourly").nextRunTs).toBe(H(3));

    await burn(H(3), H(3, 5));                            // the fresh budget burns down the same way
    const dead = rig.jobs.get("hourly");
    expect(dead.failure!.deadLetterAt).toBe(H(3, 5));     // a SECOND dead-letter, not a re-loop
    expect(dead.failure!.reasons.length).toBe(2);         // reasons are per-life, not cumulative
    expect(dead.consecutiveFailures).toBe(2);
    expect(dead.enabled).toBe(false);
    expect(dead.nextRunTs).toBeNull();
    const dl = rig.events.tail("job:hourly", 100).filter((e) => e.kind === "job_dead_letter");
    expect(dl.length).toBe(2);                            // one per life — no event storm

    // the loop is closed: a later tick with the job dead-lettered spawns nothing
    const rowsBefore = rig.jobs.get("hourly").lastRuns.length;
    rig.clock.box.t = H(4);
    await rig.jobs.tick();
    expect(rig.jobs.get("hourly").lastRuns.length).toBe(rowsBefore);
  });
});

describe("F05.QA: the operator's end-to-end chain (F02 → F01 → F04 → F05)", () => {
  // The brief's rig scenario, end to end: schedule → 9h machine sleep → wake → fail → retry →
  // fail → dead-letter → requeue → succeed. It exists to pin what the OPERATOR sees in the run
  // history, not just that the state machine terminates: one spawn per attempt, the wake fire
  // labelled `sleep-wake` with a measured lateness, the retry labelled `scheduled`, exactly ONE
  // durable job_dead_letter, and a post-requeue run that is a normal scheduled fire.
  it("QA-E2E: sleep 9h → late fire fails → retry fails → dead-letter → requeue → next slot succeeds", async () => {
    const rig = makeJobRig([FAIL, FAIL, HAPPY("green")], H(1), { lateFireThresholdMs: 60_000 });
    crew(rig);
    const job = rig.jobs.create({
      name: "nightly", schedule: { cron: "0 * * * *" }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });
    expect(job.nextRunTs).toBe(H(2));

    // ── the machine sleeps through 02:00 and wakes at 11:00 ─────────────────────────────────
    rig.clock.box.t = H(11);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "nightly").length === 1);
    const wakeRun = failedRows(rig, "nightly")[0]!;
    expect(wakeRun.trigger).toBe("sleep-wake");           // F01(c) classification survives F05
    expect(wakeRun.latenessMs).toBe(H(11) - H(2));        // 9h, measured — not null, not 0
    expect(rig.jobs.get("nightly").consecutiveFailures).toBe(1);
    expect(rig.jobs.get("nightly").failure!.retryAt).toBe(H(11, 5));
    expect(rig.jobs.get("nightly").nextRunTs).toBe(H(12));   // the grid moved past the failed slot

    // ── the backoff re-fire, 5m later ───────────────────────────────────────────────────────
    rig.clock.box.t = H(11, 5);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "nightly").length === 2);
    expect(failedRows(rig, "nightly")[1]!.trigger).toBe("scheduled");

    // ── retry budget spent → dead-letter, exactly once, durably ─────────────────────────────
    const dead = rig.jobs.get("nightly");
    expect(dead.enabled).toBe(false);
    expect(dead.failure!.deadLetterAt).toBe(H(11, 5));
    expect(dead.failure!.reasons.length).toBe(2);
    expect(dead.nextRunTs).toBeNull();
    const dl = rig.events.tail("job:nightly", 50).filter((e) => e.kind === "job_dead_letter");
    expect(dl.length).toBe(1);                            // exactly ONE, per the carry-forward
    expect((dl[0]!.data as { attempts: number }).attempts).toBe(2);

    // ── the operator requeues ───────────────────────────────────────────────────────────────
    rig.clock.box.t = H(11, 30);
    const spawnsBefore = rig.jobs.get("nightly").lastRuns.length;
    const revived = rig.jobs.requeue("nightly");
    expect(revived.enabled).toBe(true);
    expect(revived.failure).toBeNull();
    expect(revived.consecutiveFailures).toBe(0);          // fresh budget, so a re-failure can
    expect(revived.nextRunTs).toBe(H(12));                // dead-letter AGAIN rather than loop
    expect(rig.jobs.get("nightly").lastRuns.length).toBe(spawnsBefore);   // nothing re-driven

    // ── the next real occurrence succeeds ───────────────────────────────────────────────────
    rig.clock.box.t = H(12);
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("nightly").lastRuns.some((r) => r.result === "ok"));
    const rows = rig.jobs.get("nightly").lastRuns;
    expect(rows.length).toBe(3);                          // one spawn per attempt, no double-fire
    expect(rows.map((r) => `${r.trigger}:${r.result}`)).toEqual([
      "sleep-wake:failed", "scheduled:failed", "scheduled:ok",
    ]);
    // Distinct taskIds ARE the "one spawn per attempt" proof: no attempt reuses another's work.
    // agentId stays null on every row for a team target (the run is a queued task, and nothing
    // backfills the agent that drained it) — see qa/F05.md UI-4.
    expect(new Set(rows.map((r) => r.taskId)).size).toBe(3);
    expect(rows.every((r) => r.agentId === null)).toBe(true);
    expect(rig.jobs.get("nightly").failure).toBeNull();
  });
});

describe("F05.QA: pre-F05 store migration", () => {
  // The shape of the operator's REAL ~/.chimera/jobs.json as of this review (5 jobs, none with a
  // `failure` or `retryPolicy` key, `lastRuns` rows with no `reason`/`attempt`). F05 added three
  // record fields and two run-entry fields, and jobs.ts:500 turns ANY parse miss into a hard
  // "corrupt coordination state" throw that stops the whole scheduler from booting — so the
  // defaults are load-bearing, not cosmetic. Verified against a copy of the live file too.
  const PRE_F05 = {
    jobs: [{
      name: "daily-digest-0800", schedule: { cron: "0 8 * * *" }, tz: "UTC",
      target: { team: "crew" }, prompt: "digest", overlapPolicy: "skip",
      maxBudgetUsd: null, enabled: true, catchUp: false,
      createdAt: H(0), nextRunTs: H(8), consecutiveFailures: 2, disabledReason: null,
      deliveryDroppedAt: null,
      lastRuns: [{ ts: H(0), trigger: "scheduled", result: "failed", agentId: null, taskId: "t1", costUsd: 0, error: "boom" }],
    }],
    lastTickMs: H(0),
  };

  it("QA-M: a pre-F05 jobs.json loads, and its inherited failure count now leads to dead-letter", async () => {
    const rig = makeJobRig([FAIL], H(1));
    crew(rig);
    writeFileSync(join(rig.dir, "jobs.json"), JSON.stringify(PRE_F05, null, 2));
    const store = openJobs(rig);

    const loaded = store.get("daily-digest-0800");
    expect(loaded.failure).toBeNull();               // .default(null) carries the old record
    expect(loaded.retryPolicy).toBeUndefined();      // optional, no default — "no policy"
    expect(loaded.consecutiveFailures).toBe(2);      // inherited from the pre-F05 file
    expect(loaded.lastRuns[0]!.attempt).toBe(0);
    expect(loaded.lastRuns[0]!.reason).toBeNull();

    // MIGRATION CONSEQUENCE: with no retryPolicy the count still stops at DEFAULT_JOB_MAX_ATTEMPTS
    // (3) exactly as pre-F05 — but the third failure now DEAD-LETTERS (failure block + a
    // job_dead_letter event) where it used to only disable. A policy-less job never gets a backoff
    // retry (onRunFailed returns "wait"), so the only behaviour change is the richer stop state.
    rig.clock.box.t = H(8);
    await store.tick();
    await waitUntil(() => store.get("daily-digest-0800").lastRuns.filter((r) => r.result === "failed").length === 2);
    const after = store.get("daily-digest-0800");
    expect(after.consecutiveFailures).toBe(3);
    expect(after.enabled).toBe(false);
    expect(after.failure!.deadLetterAt).not.toBeNull();
    expect(after.disabledReason).toMatch(/dead-letter after 3 attempts/);
    expect(rig.events.tail("job:daily-digest-0800", 50).filter((e) => e.kind === "job_dead_letter").length).toBe(1);
    store.detach();
  });
});

describe("F05.QA-FIX2: a retry attempt refused by an in-flight manual run", () => {
  // A retry attempt is dispatched via fire(job,"scheduled",...,{retry:true}) exactly like any
  // other, so it can be REFUSED by fire()'s existing overlap guard when a manual runNow already
  // owns the job's in-flight slot. tick() clears failure.retryAt BEFORE the dispatch (load-bearing:
  // it must not re-arm the very run in flight) — so before F05.QA-FIX2 a refusal here left retryAt
  // null forever: the chain went silently idle until the next grid slot happened to revive it,
  // with no run row, no event, and no dead-letter. This pins the fix: the refusal re-arms a short
  // fixed re-check (not the exponential backoff — the attempt never ran, so it is not a further
  // failure) and is reported through the exact skipForRetry-shaped run row + event.
  it("re-arms the chain and reports the refusal instead of losing the attempt silently", async () => {
    const rig = makeJobRig([FAIL, HOLD], H(1));
    crew(rig);
    rig.jobs.create({
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { team: "crew" }, prompt: "ping",
      overlapPolicy: "skip", retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });

    rig.clock.box.t = H(2);
    await rig.jobs.tick();
    await waitUntil(() => failedRows(rig, "hourly").length === 1);
    expect(rig.jobs.get("hourly").nextRunTs).toBe(H(3));
    expect(rig.jobs.get("hourly").failure!.retryAt).toBe(H(2, 5));
    expect(rig.jobs.get("hourly").consecutiveFailures).toBe(1);

    // A manual run now takes the in-flight slot and holds it — never settling — for the
    // duration of the test, so the retry attempt below has something to be refused by.
    await rig.jobs.runNow("hourly");
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);

    const runsBefore = rig.jobs.get("hourly").lastRuns.length;
    rig.clock.box.t = H(2, 5);   // the retry's backoff instant comes due while the manual run holds
    await rig.jobs.tick();

    const after = rig.jobs.get("hourly");
    // (2) the attempt never ran — it must not count as a further failure.
    expect(after.consecutiveFailures).toBe(1);
    // (4) the grid did not move for a refused RETRY (unlike skipForRetry, which does for a
    // swallowed GRID slot — a different collision this is not).
    expect(after.nextRunTs).toBe(H(3));
    // the chain is neither dead-lettered nor left with a dangling null retryAt: it re-armed a
    // short fixed re-check rather than the exponential backoff.
    expect(after.failure!.deadLetterAt).toBeNull();
    expect(after.failure!.retryAt).toBe(H(2, 5) + RETRY_REFUSED_REARM_MS);
    expect(after.enabled).toBe(true);
    // (3) the operator gets a run row + event for the refusal, reusing skipForRetry's shape.
    expect(after.lastRuns.length).toBe(runsBefore + 1);
    const refusal = after.lastRuns.at(-1)!;
    expect(refusal.result).toBe("skipped");
    expect(refusal.reason).toBe("overlap");
    expect(refusal.nominalFireTs).toBe(H(2));
    expect(refusal.attempt).toBe(1);
    expect(rig.events.tail("job:hourly", 20).filter((e) => e.kind === "job_skipped" && (e.data as { reason?: string }).reason === "overlap").length).toBe(1);

    // (1) the chain still retries afterwards rather than idling until the next grid slot: it goes
    // on re-checking (and re-arming) at the fixed cadence for as long as the overlap persists,
    // instead of the retryAt staying stuck at null.
    rig.clock.box.t = after.failure!.retryAt!;
    await rig.jobs.tick();
    const again = rig.jobs.get("hourly");
    expect(again.enabled).toBe(true);
    expect(again.failure!.deadLetterAt).toBeNull();
    expect(again.failure!.retryAt).toBe(H(2, 5) + 2 * RETRY_REFUSED_REARM_MS);
    expect(again.consecutiveFailures).toBe(1);
    expect(again.nextRunTs).toBe(H(3));
  });
});
