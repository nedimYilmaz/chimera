import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { JobNotDeadLetteredError, DEFAULT_JOB_MAX_ATTEMPTS, JOB_FAILURE_REASON_MAX } from "@chimera/core/jobs";
import { JOB_FAILURE_REASONS_CAP, computeRetryDelayMs } from "@chimera/protocol";
import { makeJobRig, reopenJobs, waitUntil } from "./jobs-helpers.js";

const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.02 } }];
const FAIL: FakeStep[] = [{ fail: { message: "boom" } }];
const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }];

function setupTeamJob(
  rig: ReturnType<typeof makeJobRig>,
  name = "ping",
  extra: Partial<Parameters<ReturnType<typeof makeJobRig>["jobs"]["create"]>[0]> = {},
) {
  rig.queues.create({ name: "work", retryLimit: 0 });
  rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" });
  return rig.jobs.create({ name, schedule: { cron: "* * * * *" }, target: { team: "crew" }, prompt: "ping", overlapPolicy: "skip", ...extra });
}

async function runNFailures(rig: ReturnType<typeof makeJobRig>, name: string, n: number) {
  for (let i = 0; i < n; i++) {
    // Keyed on the CURRENT count, not a loop-local index: this helper is called more than once
    // against the same job in several tests, and a fresh loop restarting at i=0 would otherwise
    // wait on a count already satisfied by an earlier call, racing ahead of the run it's meant
    // to wait for.
    // Counts "failed" entries specifically, not raw lastRuns growth: a skipped/duplicate-occurrence
    // entry also grows lastRuns, and counting that as progress would silently undercount real
    // failures instead of timing out (see A6's baseMs: 0 race, fixed by keeping retries armed
    // safely in the future so this helper's manual runNow() never overlaps a real scheduled tick).
    const before = rig.jobs.get(name).lastRuns.filter((r) => r.result === "failed").length;
    await rig.jobs.runNow(name);
    await waitUntil(() => rig.jobs.get(name).lastRuns.filter((r) => r.result === "failed").length === before + 1);
  }
}

describe("F05: job retry / dead-letter / requeue", () => {
  // F05.QA-FIX: "arms" now means failure.retryAt, a clock of its own. nextRunTs stays the schedule
  // GRID — folding the two together turned every retry into a fresh occurrence at a drifted slot.
  it("A1: a failed run with a retryPolicy arms a backoff re-fire instead of waiting for the grid slot", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 2000, jitter: false } });
    const scheduledNext = rig.jobs.get("flaky").nextRunTs!;

    await runNFailures(rig, "flaky", 1);
    const job = rig.jobs.get("flaky");
    expect(job.enabled).toBe(true);
    expect(job.failure!.retryAt).toBe(start + 2000);
    expect(job.failure!.retryAt!).toBeLessThan(scheduledNext);
    expect(job.nextRunTs).toBe(scheduledNext);   // the grid never moves for a failure
    expect(job.failure).not.toBeNull();
    expect(job.failure!.deadLetterAt).toBeNull();
  });

  it("A2: exponential backoff follows computeRetryDelayMs across attempts 1 and 2", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 5, backoff: "exponential", baseMs: 1000, jitter: false } });

    await runNFailures(rig, "flaky", 1);
    expect(rig.jobs.get("flaky").failure!.retryAt).toBe(start + 1000);

    await runNFailures(rig, "flaky", 1);
    expect(rig.jobs.get("flaky").failure!.retryAt).toBe(start + 2000);
  });

  it("A3: a long exponential chain caps at maxDelayMs", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL, FAIL, FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 6, backoff: "exponential", baseMs: 1000, maxDelayMs: 3000, jitter: false } });

    await runNFailures(rig, "flaky", 4);
    const delay = rig.jobs.get("flaky").failure!.retryAt! - start;
    expect(delay).toBe(3000);
  });

  it("A4: jitter uses the injected rand seam for an exact armed instant", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL], start, { rand: () => 0.5 });
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: true } });

    await runNFailures(rig, "flaky", 1);
    const expected = computeRetryDelayMs({ maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: true }, 1, () => 0.5);
    expect(rig.jobs.get("flaky").failure!.retryAt).toBe(start + expected);
  });

  it("A5: dead-letters on exhaustion, emitting job_disabled and job_dead_letter with the last reasons", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 1000, jitter: false } });

    await runNFailures(rig, "flaky", 2);
    const job = rig.jobs.get("flaky");
    expect(job.enabled).toBe(false);
    expect(job.nextRunTs).toBeNull();
    expect(job.failure!.deadLetterAt).not.toBeNull();

    const deadLetter = rig.events.tail("job:flaky", 20).find((e) => e.kind === "job_dead_letter");
    expect(deadLetter).toBeDefined();
    expect((deadLetter!.data as { job: string; attempts: number; maxAttempts: number }).attempts).toBe(2);
    expect((deadLetter!.data as { maxAttempts: number }).maxAttempts).toBe(2);
    expect(rig.events.tail("job:flaky", 20).find((e) => e.kind === "job_disabled")).toBeDefined();
  });

  it("A6: failure.reasons is capped at JOB_FAILURE_REASONS_CAP, keeping the newest", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const scenarios: FakeStep[][] = Array.from({ length: 8 }, () => FAIL);
    const rig = makeJobRig(scenarios, start);
    // baseMs: 0 would arm nextRunTs === now, letting armTimer's setTimeout(0) race a real
    // scheduled tick() against the next manual runNow() in the loop below — whichever loses
    // becomes a deduped "skipped" lastRuns entry instead of a genuine failure, silently
    // undercounting consecutiveFailures/reasons. baseMs: 1000 keeps every retry armed safely
    // in the future so only the manual runNow() below ever fires it.
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 8, backoff: "fixed", baseMs: 1000, jitter: false } });

    await runNFailures(rig, "flaky", 8);
    const job = rig.jobs.get("flaky");
    expect(job.failure!.reasons.length).toBe(JOB_FAILURE_REASONS_CAP);
    expect(job.consecutiveFailures).toBe(8);
  });

  it("A7: an over-long failure reason is truncated at JOB_FAILURE_REASON_MAX and survives a reopen", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const longMessage = "x".repeat(JOB_FAILURE_REASON_MAX + 200);
    // A team-target job's failure text is hardcoded to a fixed literal (jobs.ts settleRun call
    // for a queue-routed task), never the underlying agent's own message — a command-target job
    // is the one path that propagates the real error text, so it's the only way to genuinely
    // exercise JOB_FAILURE_REASON_MAX's truncation instead of truncating a string already short.
    const rig = makeJobRig([], start, {
      runCommand: async () => ({ exitCode: 1, output: "", error: longMessage }),
    });
    rig.jobs.create({
      name: "flaky", schedule: { cron: "* * * * *" }, target: { command: "false" }, overlapPolicy: "skip",
      retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: false },
    });

    await runNFailures(rig, "flaky", 1);
    expect(rig.jobs.get("flaky").failure!.reasons.at(-1)!.error.length).toBe(JOB_FAILURE_REASON_MAX);

    const reopened = reopenJobs(rig);
    expect(reopened.get("flaky").failure!.reasons.at(-1)!.error.length).toBe(JOB_FAILURE_REASON_MAX);
  });

  it("A8: requeue() resets the failure budget and re-arms without retyping the spec", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 1000, jitter: false } });
    await runNFailures(rig, "flaky", 2);
    expect(rig.jobs.get("flaky").enabled).toBe(false);

    const requeued = rig.jobs.requeue("flaky");
    expect(requeued.enabled).toBe(true);
    expect(requeued.consecutiveFailures).toBe(0);
    expect(requeued.failure).toBeNull();
    expect(requeued.disabledReason).toBeNull();
    expect(requeued.nextRunTs).not.toBeNull();
  });

  it("A9: requeue() refuses a healthy job and a job still mid-retry", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL], start);
    const healthy = setupTeamJob(rig, "healthy");
    expect(() => rig.jobs.requeue(healthy.name)).toThrow(JobNotDeadLetteredError);

    // Reuses the "crew"/"work" team/queue setupTeamJob("healthy") already created above —
    // calling setupTeamJob again would try to create both a second time and collide.
    const midRetry = rig.jobs.create({
      name: "mid-retry", schedule: { cron: "* * * * *" }, target: { team: "crew" }, prompt: "ping", overlapPolicy: "skip",
      retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: false },
    });
    await runNFailures(rig, "mid-retry", 1);
    expect(rig.jobs.get(midRetry.name).failure).not.toBeNull();
    expect(() => rig.jobs.requeue(midRetry.name)).toThrow(JobNotDeadLetteredError);
  });

  it("A10: update({enabled:true}) clears dead-letter state through the same contract", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 2, backoff: "fixed", baseMs: 1000, jitter: false } });
    await runNFailures(rig, "flaky", 2);

    const rearmed = rig.jobs.update("flaky", { enabled: true });
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.failure).toBeNull();
    expect(rearmed.consecutiveFailures).toBe(0);
  });

  it("A11: with no retryPolicy, timing is unchanged from pre-F05: 3 strikes, no re-fire armed between them", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL, FAIL], start);
    setupTeamJob(rig, "flaky");
    const scheduledNext = rig.jobs.get("flaky").nextRunTs!;

    await runNFailures(rig, "flaky", 1);
    expect(rig.jobs.get("flaky").nextRunTs).toBe(scheduledNext);   // "wait": no re-fire armed

    await runNFailures(rig, "flaky", 2);
    const job = rig.jobs.get("flaky");
    expect(job.enabled).toBe(false);
    expect(job.consecutiveFailures).toBe(DEFAULT_JOB_MAX_ATTEMPTS);
  });

  it("A12: a successful run clears failure and consecutiveFailures", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, HAPPY("recovered")], start);
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: false } });

    await runNFailures(rig, "flaky", 1);
    expect(rig.jobs.get("flaky").failure).not.toBeNull();

    await rig.jobs.runNow("flaky");
    await waitUntil(() => rig.jobs.get("flaky").lastRuns.length === 2);
    const job = rig.jobs.get("flaky");
    expect(job.consecutiveFailures).toBe(0);
    expect(job.failure).toBeNull();
  });

  it("A13: an overlap skip is not an attempt against the retry budget", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([HOLD], start);
    setupTeamJob(rig, "held", { retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 1000, jitter: false } });

    await rig.jobs.runNow("held");
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);
    const second = await rig.jobs.runNow("held");
    expect(second.started).toBe(false);
    expect(second.skipped).toBe(true);

    const job = rig.jobs.get("held");
    expect(job.consecutiveFailures).toBe(0);
    expect(job.failure).toBeNull();

    const [agentId] = rig.scheduler.agentsFor("crew");
    await rig.sup.send(agentId!, "go");
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
  });

  it("A14: a retry keeps the original occurrence's anchor — an hourly job resumes on the hour, not skewed by the backoff instant", async () => {
    const start = Date.UTC(2026, 0, 1, 1, 0, 0);
    const rig = makeJobRig([FAIL, HAPPY("recovered")], start);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" });
    const job = rig.jobs.create({
      // `every` is the schedule that PROVES the fix: it has no absolute grid to snap back to, so it
      // re-anchors on whatever nextRunTs holds. When the backoff lived there the job re-phased to
      // :05 permanently. Cron would have hidden the bug by re-deriving the hour.
      name: "hourly", schedule: { every: { unit: "hours", n: 1 } }, target: { team: "crew" }, prompt: "ping", overlapPolicy: "skip",
      retryPolicy: { maxAttempts: 5, backoff: "fixed", baseMs: 5 * 60_000, jitter: false },
    });
    expect(job.nextRunTs).toBe(Date.UTC(2026, 0, 1, 2, 0, 0));

    rig.clock.box.t = Date.UTC(2026, 0, 1, 2, 0, 0);
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("hourly").lastRuns.some((r) => r.result === "failed"));
    const armed = rig.jobs.get("hourly").failure!.retryAt!;
    expect(armed).toBe(Date.UTC(2026, 0, 1, 2, 5, 0));   // backoff instant, nearer than 03:00
    expect(rig.jobs.get("hourly").nextRunTs).toBe(Date.UTC(2026, 0, 1, 3, 0, 0));   // grid, on the hour

    rig.clock.box.t = armed;
    await rig.jobs.tick();
    await waitUntil(() => rig.jobs.get("hourly").lastRuns.some((r) => r.result === "ok"));
    expect(rig.jobs.get("hourly").nextRunTs).toBe(Date.UTC(2026, 0, 1, 3, 0, 0));   // back on the grid, not 03:05
  });

  // Driven with TWO failures on purpose: the old ceiling only clamped attempt 1 (`prev === null`),
  // so from attempt 2 the backoff overwrote the grid and the slot vanished with no row and no event.
  it("A15: a retry never pushes out a nearer scheduled occurrence — at attempt 2, not just attempt 1", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL], start);
    // Cron slot is a minute away; both backoffs (120s, 240s) overshoot it.
    setupTeamJob(rig, "flaky", { retryPolicy: { maxAttempts: 5, backoff: "exponential", baseMs: 120_000, jitter: false } });
    const scheduledNext = rig.jobs.get("flaky").nextRunTs!;

    await runNFailures(rig, "flaky", 2);
    const job = rig.jobs.get("flaky");
    expect(job.consecutiveFailures).toBe(2);
    expect(job.nextRunTs).toBe(scheduledNext);                      // grid intact at attempt 2
    expect(job.failure!.retryAt!).toBeGreaterThan(scheduledNext);

    // The slot cannot RUN (the chain owns the target) but it is reported, never swallowed.
    rig.clock.box.t = scheduledNext;
    await rig.jobs.tick();
    const skipped = rig.jobs.get("flaky").lastRuns.filter((r) => r.reason === "retry-pending");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.result).toBe("skipped");
    expect(skipped[0]!.nominalFireTs).toBe(scheduledNext);
    expect(rig.jobs.get("flaky").nextRunTs).toBeGreaterThan(scheduledNext);
  });
});
