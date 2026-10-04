import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { resolveRole } from "@chimera/core/shared-roles";
import { parseCron, computeNextCron, validateSchedule, JobError, MAX_TIMER_DELAY_MS, MAX_HOP_MS } from "@chimera/core/jobs";
import { makeJobRig, reopenJobs, waitUntil } from "./jobs-helpers.js";

const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.02 } }];
const FAIL: FakeStep[] = [{ fail: { message: "boom" } }];
const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0 } }];

function setupTeamJob(rig: ReturnType<typeof makeJobRig>, name = "ping") {
  rig.queues.create({ name: "work", retryLimit: 0 });   // retryLimit 0: one failed attempt = one job-level failed run
  rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" });
  return rig.jobs.create({ name, schedule: { cron: "* * * * *" }, target: { team: "crew" }, prompt: "ping", overlapPolicy: "skip" });
}

describe("cron parsing + next-run computation", () => {
  it("every-minute cron fires at the next minute boundary (UTC)", () => {
    const cron = parseCron("* * * * *");
    const from = Date.UTC(2026, 0, 1, 10, 30, 15);
    expect(computeNextCron(cron, "UTC", from)).toBe(Date.UTC(2026, 0, 1, 10, 31, 0));
  });

  it("*/1 is equivalent to *", () => {
    const from = Date.UTC(2026, 0, 1, 10, 30, 0);
    expect(computeNextCron(parseCron("*/1 * * * *"), "UTC", from))
      .toBe(computeNextCron(parseCron("* * * * *"), "UTC", from));
  });

  it("specific minute/hour cron finds the next matching day once today's slot has passed", () => {
    const cron = parseCron("30 9 * * *");
    const from = Date.UTC(2026, 0, 1, 10, 0, 0);
    expect(computeNextCron(cron, "UTC", from)).toBe(Date.UTC(2026, 0, 2, 9, 30, 0));
  });

  it("dom/dow OR semantics: the earlier of either field wins", () => {
    // Jan 1 2026 is a Thursday; the next Monday (dow=1) is Jan 5, before the 15th (dom).
    const cron = parseCron("0 0 15 * 1");
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(computeNextCron(cron, "UTC", from)).toBe(Date.UTC(2026, 0, 5, 0, 0, 0));
  });

  it("rejects a malformed cron expression", () => {
    expect(() => parseCron("* * * *")).toThrow(JobError);
    expect(() => parseCron("60 * * * *")).toThrow(JobError);
  });

  it("rejects a structurally unsatisfiable cron (Feb 30th)", () => {
    expect(() => validateSchedule({ cron: "0 0 30 2 *" }, "UTC", Date.UTC(2026, 0, 1))).toThrow(JobError);
  });
});

describe("job.create validation (rejected inline, never persisted)", () => {
  it("rejects a bad cron expression", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    expect(() => rig.jobs.create({ name: "bad", schedule: { cron: "not a cron" }, target: { team: "crew" }, prompt: "go" }))
      .toThrow();
    expect(rig.jobs.list()).toEqual([]);
  });

  it("rejects an unknown team target", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    expect(() => rig.jobs.create({ name: "orphan", schedule: { cron: "* * * * *" }, target: { team: "ghost" }, prompt: "go" }))
      .toThrow();
    expect(rig.jobs.list()).toEqual([]);
  });

  it("GAP A: rejects a team target pinning a role key the team doesn't have", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: {} } }, maxConcurrent: 2, queue: null });
    expect(() => rig.jobs.create({
      name: "orphan-role", schedule: { cron: "* * * * *" }, target: { team: "crew", role: "reviewer" }, prompt: "go",
    })).toThrow();
    expect(rig.jobs.list()).toEqual([]);
  });

  it("GAP B: rejects an unknown role-library target at create time, not at fire time", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    expect(() => rig.jobs.create({
      name: "ghost-role", schedule: { cron: "* * * * *" }, target: { role: "no-such-role" }, prompt: "go",
    })).toThrow();
    expect(rig.jobs.list()).toEqual([]);
  });

  it("rejects a duplicate job name", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    setupTeamJob(rig, "dup");
    expect(() => setupTeamJob(rig, "dup")).toThrow();
  });
});

describe("JobScheduler: cron fire, run-now, overlap, restart, failure guard", () => {
  it("a */1 (every-minute) job fires exactly at its computed next-run boundary", async () => {
    const start = Date.UTC(2026, 0, 1, 10, 30, 15);
    const rig = makeJobRig([HAPPY("pong")], start);
    const job = setupTeamJob(rig);
    const expectedNext = Date.UTC(2026, 0, 1, 10, 31, 0);
    expect(job.nextRunTs).toBe(expectedNext);

    rig.clock.box.t = expectedNext;   // advance the injected clock to the due instant — no real wait needed
    await rig.jobs.tick();

    const started = rig.events.tail(`job:${job.name}`, 10).find((e) => e.kind === "job_run_started");
    expect(started).toBeDefined();
    await waitUntil(() => rig.jobs.get(job.name).lastRuns.some((r) => r.result === "ok"));
    const record = rig.jobs.get(job.name);
    expect(record.lastRuns.at(-1)!.result).toBe("ok");
    expect(record.nextRunTs).toBe(Date.UTC(2026, 0, 1, 10, 32, 0));   // schedule advanced exactly one minute
  });

  it("run-now fires immediately regardless of the schedule, and never moves it", async () => {
    const start = Date.UTC(2026, 0, 1, 8, 0, 0);
    const rig = makeJobRig([HAPPY("now-run")], start);
    const job = setupTeamJob(rig);
    expect(job.nextRunTs).toBeGreaterThan(start);
    const scheduledNext = job.nextRunTs;

    const result = await rig.jobs.runNow(job.name);
    expect(result.started).toBe(true);
    expect(result.taskId).toBeDefined();
    await waitUntil(() => rig.jobs.get(job.name).lastRuns.some((r) => r.result === "ok"));
    expect(rig.jobs.get(job.name).nextRunTs).toBe(scheduledNext);
  });

  it('overlapPolicy "skip" no-ops against a still-running previous run and emits job_skipped', async () => {
    const start = Date.UTC(2026, 0, 1, 9, 0, 0);
    const rig = makeJobRig([HOLD], start);
    const job = setupTeamJob(rig);

    await rig.jobs.runNow(job.name);
    await waitUntil(() => rig.queues.status("work").counts.in_progress === 1);

    const second = await rig.jobs.runNow(job.name);
    expect(second.started).toBe(false);
    expect(second.skipped).toBe(true);
    expect(rig.fake.spawns.length).toBe(1);   // no second spawn

    const skipped = rig.jobs.get(job.name).lastRuns.find((r) => r.result === "skipped");
    expect(skipped).toBeDefined();
    expect(rig.events.tail(`job:${job.name}`, 20).filter((e) => e.kind === "job_skipped").length).toBe(1);

    const [agentId] = rig.scheduler.agentsFor("crew");
    await rig.sup.send(agentId!, "go");
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
  });

  it("a daemon restart preserves jobs and their next-run times (no drift, no double-fire)", () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    const rig = makeJobRig([], start);
    const job = setupTeamJob(rig, "restart-job");
    const before = job.nextRunTs;

    const reopened = reopenJobs(rig);   // fresh JobScheduler over the same jobs.json + clock — simulates a restart
    expect(reopened.get("restart-job").nextRunTs).toBe(before);
    expect(reopened.list().length).toBe(1);
  });

  it("3 consecutive failed runs auto-disables the job", async () => {
    const start = Date.UTC(2026, 0, 1, 14, 0, 0);
    const rig = makeJobRig([FAIL, FAIL, FAIL], start);
    setupTeamJob(rig, "flaky");

    for (let i = 0; i < 3; i++) {
      await rig.jobs.runNow("flaky");
      await waitUntil(() => rig.jobs.get("flaky").lastRuns.length === i + 1);
    }
    const record = rig.jobs.get("flaky");
    expect(record.enabled).toBe(false);
    // F05: no retryPolicy ⇒ DEFAULT_JOB_MAX_ATTEMPTS (3) dead-letters on the 3rd failure, routed
    // through disable() — same job_disabled event, a disabledReason that now names the cause.
    // A team-target job's settleRun call always reports the fixed literal below, never the
    // underlying agent's own failure message ("boom") — see jobs-retry.test.ts A7's comment.
    expect(record.disabledReason).toMatch(/^dead-letter after 3 attempts: task failed$/);
    expect(record.nextRunTs).toBeNull();
    expect(record.failure?.deadLetterAt).not.toBeNull();
    expect(record.failure?.reasons.at(-1)?.error).toBe("task failed");
    expect(rig.events.tail("job:flaky", 20).find((e) => e.kind === "job_disabled")).toBeDefined();
    expect(rig.events.tail("job:flaky", 20).find((e) => e.kind === "job_dead_letter")).toBeDefined();
  });

  it('job.update({enabled:true}) re-arms a failure-disabled job (the "space" re-arm)', async () => {
    const start = Date.UTC(2026, 0, 1, 15, 0, 0);
    const rig = makeJobRig([FAIL, FAIL, FAIL], start);
    setupTeamJob(rig, "flaky2");
    for (let i = 0; i < 3; i++) {
      await rig.jobs.runNow("flaky2");
      await waitUntil(() => rig.jobs.get("flaky2").lastRuns.length === i + 1);
    }
    expect(rig.jobs.get("flaky2").enabled).toBe(false);

    const rearmed = rig.jobs.update("flaky2", { enabled: true });
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.disabledReason).toBeNull();
    expect(rearmed.consecutiveFailures).toBe(0);
    expect(rearmed.nextRunTs).not.toBeNull();
    expect(rearmed.failure).toBeNull();   // F05: re-enable clears the terminal failure state too
  });
});

describe("JobScheduler: agent target", () => {
  it("spawns directly, stamped with the job's principal, applying maxBudgetUsd to the tree", async () => {
    const start = Date.UTC(2026, 0, 1, 6, 0, 0);
    const rig = makeJobRig([HAPPY("agent-run")], start);
    const job = rig.jobs.create({
      name: "solo", schedule: { cron: "* * * * *" },
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } },
      prompt: "go solo", maxBudgetUsd: 5,
    });
    const result = await rig.jobs.runNow(job.name);
    expect(result.agentId).toBeDefined();
    await waitUntil(() => rig.fake.spawns.length === 1);
    expect(rig.fake.spawns[0]!.maxBudgetUsd).toBe(5);
    expect(rig.sup.status(result.agentId!).principal).toBe("job:solo");
    // JOB-FLEET-GROUPING: the DURABLE agent->job link (AgentRecord.jobName) — unlike the old
    // JobScheduler.jobForAgent in-flight map, this survives the run settling (see the
    // waitUntil below), which is exactly what usage.query's groupBy:"job" needed to stop
    // collapsing every row to "none".
    expect(rig.sup.status(result.agentId!).jobName).toBe("solo");
    await waitUntil(() => rig.jobs.get("solo").lastRuns.some((r) => r.result === "ok"));
    expect(rig.sup.status(result.agentId!).jobName).toBe("solo");
  });
});

describe("JobScheduler: JOB-ROLE-TARGET GAP A (team target pins a role key)", () => {
  it("pushes the task carrying the pinned role, and an unpinned {team} job behaves exactly as before", async () => {
    const start = Date.UTC(2026, 0, 1, 7, 0, 0);
    const rig = makeJobRig([HAPPY("finder-run"), HAPPY("reviewer-run")], start);
    rig.queues.create({ name: "cr-tasks", retryLimit: 0 });
    rig.teams.create({
      name: "cr-team",
      roles: {
        finder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },
        reviewer: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } },
      },
      maxConcurrent: 2, queue: "cr-tasks",
    });

    const pinned = rig.jobs.create({
      name: "cr-hourly", schedule: { cron: "* * * * *" },
      target: { team: "cr-team", role: "reviewer" }, prompt: "review PRs", overlapPolicy: "skip",
    });
    const result = await rig.jobs.runNow(pinned.name);
    expect(result.taskId).toBeDefined();
    expect(rig.queues.getTask(result.taskId!).role).toBe("reviewer");

    // an existing {team}-only job (no role key) still routes to the team's default —
    // byte-identical to pre-GAP-A behavior.
    const unpinned = setupTeamJob(rig, "cr-default");
    expect(unpinned.target).toEqual({ team: "crew" });
  });
});

describe("job.update: JOB-UPDATE-DELIVERTO-GUARD (postmortem chimera/slack, silent delivery loss)", () => {
  function setupRoleTargetJob(rig: ReturnType<typeof makeJobRig>, name: string, deliverTo: string) {
    rig.roles.create({ name: "slack-cronjob", cwd: "/tmp", account: "main", isolation: "none" });
    return rig.jobs.create({
      name, schedule: { cron: "*/5 * * * *" },
      target: { role: "slack-cronjob", overrides: { deliverTo } },
      prompt: "scan", maxBudgetUsd: 0.5,
    });
  }

  it("THE EXACT INCIDENT: a schedule/budget-only patch that restates `target` without `overrides` is rejected, not silently applied", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    setupRoleTargetJob(rig, "slack-watch", "conductor-1");

    // The postmortem's actual patch shape: schedule + maxBudgetUsd changed, target restated
    // with only `role` (as any UI/caller re-submitting the target's "type" field would),
    // dropping `overrides` (and therefore deliverTo) entirely.
    expect(() => rig.jobs.update("slack-watch", {
      schedule: { cron: "*/15 * * * *" },
      maxBudgetUsd: 2,
      target: { role: "slack-cronjob", overrides: {} },
    })).toThrow(JobError);

    // Nothing persisted — deliverTo survives the rejected patch untouched.
    const job = rig.jobs.get("slack-watch");
    expect((job.target as { overrides: Record<string, unknown> }).overrides["deliverTo"]).toBe("conductor-1");
    expect(job.schedule).toEqual({ cron: "*/5 * * * *" });   // rejected as a whole, not partially applied
    expect(job.deliveryDroppedAt).toBeNull();
  });

  it("restating deliverTo alongside an unrelated target change succeeds with no flag needed", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    setupRoleTargetJob(rig, "slack-watch", "conductor-1");

    const updated = rig.jobs.update("slack-watch", {
      maxBudgetUsd: 2,
      target: { role: "slack-cronjob", overrides: { deliverTo: "conductor-1" } },
    });
    expect((updated.target as { overrides: Record<string, unknown> }).overrides["deliverTo"]).toBe("conductor-1");
    expect(updated.maxBudgetUsd).toBe(2);
    expect(updated.deliveryDroppedAt).toBeNull();
  });

  it("dropDeliverTo:true allows an intentional removal and stamps deliveryDroppedAt", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1, 0, 0, 0));
    setupRoleTargetJob(rig, "janitor", "conductor-1");

    rig.clock.box.t = Date.UTC(2026, 0, 1, 1, 0, 0);
    const updated = rig.jobs.update("janitor", {
      target: { role: "slack-cronjob", overrides: {} },
      dropDeliverTo: true,
    });
    expect((updated.target as { overrides: Record<string, unknown> }).overrides["deliverTo"]).toBeUndefined();
    expect(updated.deliveryDroppedAt).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));

    // Re-adding deliverTo later clears the warning.
    const restored = rig.jobs.update("janitor", { target: { role: "slack-cronjob", overrides: { deliverTo: "conductor-2" } } });
    expect(restored.deliveryDroppedAt).toBeNull();
  });

  it("a job created with no deliverTo at all is never flagged (the common, legitimate case)", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    rig.roles.create({ name: "gh-janitor", cwd: "/tmp", account: "main", isolation: "none" });
    const job = rig.jobs.create({
      name: "gh-janitor-job", schedule: { cron: "0 3 * * *" },
      target: { role: "gh-janitor", overrides: {} }, prompt: "clean up",
    });
    expect(job.deliveryDroppedAt).toBeNull();

    // Patching it (e.g. changing its schedule) never invents a warning out of nothing.
    const updated = rig.jobs.update("gh-janitor-job", { schedule: { cron: "0 4 * * *" } });
    expect(updated.deliveryDroppedAt).toBeNull();
  });

  it("a team-target job (no deliverTo concept — queue/conductor-routed) patches `target` freely, guard never fires", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    const job = setupTeamJob(rig, "queue-routed");
    expect(() => rig.jobs.update("queue-routed", { target: { team: "crew", role: "dev" } })).not.toThrow();
    expect(rig.jobs.get("queue-routed").deliveryDroppedAt).toBeNull();
    void job;
  });

  it("an agentSpec-target job also guards its direct deliverTo field", () => {
    const rig = makeJobRig([], Date.UTC(2026, 0, 1));
    rig.jobs.create({
      name: "solo-watch", schedule: { cron: "* * * * *" },
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none", deliverTo: "conductor-1" } },
      prompt: "go solo",
    });

    expect(() => rig.jobs.update("solo-watch", {
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } },
    })).toThrow(JobError);

    const updated = rig.jobs.update("solo-watch", {
      target: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } },
      dropDeliverTo: true,
    });
    expect(updated.deliveryDroppedAt).not.toBeNull();
  });
});

describe("JobScheduler: JOB-ROLE-TARGET GAP B (role-library target, no team/queue)", () => {
  it("spawns an agent whose resolved spec matches resolveRole's own output, overrides applied, stamped with the job's principal", async () => {
    const start = Date.UTC(2026, 0, 1, 8, 0, 0);
    const rig = makeJobRig([HAPPY("role-run")], start);
    rig.roles.create({
      name: "gh-cr-finder", cwd: "/tmp", account: "main", isolation: "none", model: "sonnet", permissionProfile: "readOnly",
    });
    const overrides = { model: "opus" };
    const job = rig.jobs.create({
      name: "gh-cr-hourly-v2", schedule: { cron: "* * * * *" },
      target: { role: "gh-cr-finder", overrides }, prompt: "find PRs", maxBudgetUsd: 3,
    });

    const result = await rig.jobs.runNow(job.name);
    expect(result.agentId).toBeDefined();
    await waitUntil(() => rig.fake.spawns.length === 1);

    const expected = resolveRole(rig.roles, { role: "gh-cr-finder", overrides });
    expect(rig.fake.spawns[0]!.model).toBe(expected.model);
    expect(rig.fake.spawns[0]!.model).toBe("opus");   // the override actually applied, not just the role default
    expect(rig.fake.spawns[0]!.maxBudgetUsd).toBe(3);
    // JOB-FLEET-GROUPING: the role-library spawn path stamps jobName too (both agent-target
    // fire() call sites do).
    expect(rig.sup.status(result.agentId!).jobName).toBe("gh-cr-hourly-v2");
    expect(rig.sup.status(result.agentId!).principal).toBe("job:gh-cr-hourly-v2");
    await waitUntil(() => rig.jobs.get("gh-cr-hourly-v2").lastRuns.some((r) => r.result === "ok"));
  });
});

describe("armTimer: a schedule past Node's ~24.8-day setTimeout ceiling is clamped, not overflowed", () => {
  function setupCrew(rig: ReturnType<typeof makeJobRig>) {
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" });
  }

  it("never arms setTimeout with a delay Node would silently coerce to ~1ms (a busy-loop trigger)", () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rig = makeJobRig([], start);
    setupCrew(rig);
    const dueAt = start + 60 * 24 * 60 * 60 * 1000;   // 60 days out, past the ~24.8-day 32-bit ceiling

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    rig.jobs.create({ name: "far-out", schedule: { at: dueAt }, target: { team: "crew" }, prompt: "ping" });

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    setTimeoutSpy.mockRestore();
  });

  it("still fires once the injected clock reaches a nextRunTs beyond the clamp ceiling", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rig = makeJobRig([HAPPY("far")], start);
    setupCrew(rig);
    const dueAt = start + 60 * 24 * 60 * 60 * 1000;
    const job = rig.jobs.create({ name: "far-out", schedule: { at: dueAt }, target: { team: "crew" }, prompt: "ping" });
    expect(job.nextRunTs).toBe(dueAt);

    rig.clock.box.t = dueAt;
    await rig.jobs.tick();

    await waitUntil(() => rig.jobs.get("far-out").lastRuns.some((r) => r.result === "ok"));
    expect(rig.jobs.get("far-out").lastRuns.at(-1)!.result).toBe("ok");
  });

  // The hop's whole contract is that an early wake RE-ARMS rather than fires: armTimer() only ever
  // sleeps MAX_HOP_MS at a time, so a far-out job is reached in hops. Nothing above proves that hop
  // — those tests drive tick() by hand, bypassing the timer. This one lets the timer actually fire
  // while the job is still in the future, and pins all three ways the hop could go wrong: firing
  // early, dropping the schedule, or failing to re-arm at all.
  it("an early (hop-bounded) wake re-arms for the remaining time instead of firing or dropping the job", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const rig = makeJobRig([HAPPY("far")], start);
    setupCrew(rig);
    // 30 days out: far beyond one hop, so both the first and the re-armed delay saturate at
    // MAX_HOP_MS rather than landing on the slot.
    const dueAt = start + 30 * 24 * 60 * 60 * 1000;

    // Fake timers go in AFTER the rig is built (so the supervisor/scheduler keep real timers) and
    // the spy AFTER the fake install (or it would be replaced by it).
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      rig.jobs.create({ name: "far-out", schedule: { at: dueAt }, target: { team: "crew" }, prompt: "ping" });
      expect(setTimeoutSpy.mock.calls.at(-1)![1]).toBe(MAX_HOP_MS);   // bounded, not the full 30 days

      // Advance the injected clock in lockstep with the fake timers — the wake is real time
      // passing, and armTimer recomputes the next delay off this.now().
      rig.clock.box.t += MAX_HOP_MS;
      await vi.advanceTimersByTimeAsync(MAX_HOP_MS);

      const job = rig.jobs.get("far-out");
      expect(job.lastRuns).toEqual([]);            // did not fire early
      expect(job.nextRunTs).toBe(dueAt);           // did not drop or advance the schedule
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(setTimeoutSpy.mock.calls.at(-1)![1]).toBe(MAX_HOP_MS);   // re-armed for another hop
    } finally {
      // A leaked fake-timer install hangs every later test in this file — waitUntil() spins on a
      // real setTimeout(10).
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
