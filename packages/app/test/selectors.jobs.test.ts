import { describe, expect, it } from "vitest";
import { JOB_LAST_RUNS_CAP, WAKE_SETUP_HINT } from "@chimera/protocol";
import {
  buildJobSpec, buildJobUpdatePatch, defaultScheduleFormValues, scheduleFormValuesFromSpec, jobRow,
  jobRunHistory, runRetentionLabel, nextRunLabel, clockJumpNotice, CLOCK_JUMP_NOTICE_WINDOW_MS,
  scheduleGapBanner, missedRunsClause, OVERDUE_THRESHOLD_MS, triggerLabel, lateRunLabel, wakeNotice,
  lastResultLabel, inFlightLabel, inFlightKeyLabel, inFlightRecovered, runReasonLabel,
  catchUpStalenessMs, runNowNoticeLabel, validateScheduleForm, CATCH_UP_HELP,
  jobStateLabel, deadLetterReasonLines, latestJobSeq,
  triggerTitle, runOutcomeLabels, retryProgressLabel, requeueNoticeLabel, type JobRunView,
} from "../src/state/selectors.jobs";

// W16 (F15/D11) — the schedules "e" edit chip: job.update patch shape + the
// job.status/job.list raw-spec → ScheduleFormCard prefill round-trip.

describe("buildJobUpdatePatch", () => {
  it("is buildJobSpec's output minus the immutable name key", () => {
    const v = { ...defaultScheduleFormValues(), name: "nightly", team: "crew", prompt: "run it" };
    const spec = buildJobSpec(v);
    const patch = buildJobUpdatePatch(v);
    expect(patch).not.toHaveProperty("name");
    expect(patch).toEqual((() => { const { name: _n, ...rest } = spec; return rest; })());
  });
});

describe("scheduleFormValuesFromSpec", () => {
  it("retains account, permissions, delivery and command triggers on a schedule-only edit", () => {
    const base = { name: "daily", schedule: { cron: "0 8 * * *" }, prompt: "review" };
    const agentSpec = { cwd: "/repo", model: "chosen-model", isolation: "none", account: "private-account", autonomy: "ask", permissionProfile: "readonly", deliverTo: "conductor" };
    const values = scheduleFormValuesFromSpec({ ...base, target: { agentSpec } });
    expect(buildJobUpdatePatch({ ...values, cron: "0 9 * * *" }).target).toEqual({ agentSpec });
    const target = { command: "check", cwd: "/repo", env: { MODE: "safe" }, timeoutMs: 12000, trigger: { example: "retained" } };
    expect(buildJobUpdatePatch(scheduleFormValuesFromSpec({ ...base, prompt: undefined, target })).target).toEqual(target);
  });
  it("round-trips an exact existing-agent pin and clears a previous spawn budget", () => {
    const v = { ...defaultScheduleFormValues(), name: "pinned", targetKind: "existing" as const, existingAgentId: " agent-123 ", prompt: "review", maxBudgetUsd: "10" };
    const spec = buildJobSpec(v);
    expect(spec.target).toEqual({ existingAgentId: "agent-123" });
    expect(spec.maxBudgetUsd).toBeNull();
    expect(scheduleFormValuesFromSpec(spec)).toMatchObject({ targetKind: "existing", existingAgentId: "agent-123", prompt: "review" });
    expect(validateScheduleForm({ ...v, existingAgentId: "" })).not.toBeNull();
  });
  it("round-trips a team-target cron job.status spec", () => {
    const v = { ...defaultScheduleFormValues(), name: "nightly", team: "crew", prompt: "run it", cron: "0 3 * * *" };
    const spec = buildJobSpec(v);
    const back = scheduleFormValuesFromSpec(spec);
    expect(back).toMatchObject({
      name: "nightly", targetKind: "team", team: "crew", prompt: "run it", scheduleKind: "cron", cron: "0 3 * * *",
    });
  });
  it("round-trips an agent-target every-N job.status spec", () => {
    const v = { ...defaultScheduleFormValues(), name: "poller", targetKind: "agent" as const, cwd: "/work", model: "claude-haiku-4-5", prompt: "poll", scheduleKind: "every" as const, everyN: "15", everyUnit: "minutes" as const };
    const back = scheduleFormValuesFromSpec(buildJobSpec(v));
    expect(back).toMatchObject({
      name: "poller", targetKind: "agent", cwd: "/work", model: "claude-haiku-4-5", scheduleKind: "every", everyN: "15", everyUnit: "minutes",
    });
  });
  it("defaults enabled to true unless explicitly false", () => {
    expect(scheduleFormValuesFromSpec({ name: "j", target: { team: "t" }, schedule: { cron: "* * * * *" }, prompt: "p" }).enabled).toBe(true);
    expect(scheduleFormValuesFromSpec({ name: "j", target: { team: "t" }, schedule: { cron: "* * * * *" }, prompt: "p", enabled: false }).enabled).toBe(false);
  });

  // JOB-ROLE-TARGET GAP A: a team target can pin a team-local role key.
  it("round-trips a team-target job pinning a role key", () => {
    const v = { ...defaultScheduleFormValues(), name: "cr-hourly", team: "cr-team", teamRole: "reviewer", prompt: "review" };
    const spec = buildJobSpec(v);
    expect(spec["target"]).toEqual({ team: "cr-team", role: "reviewer" });
    const back = scheduleFormValuesFromSpec(spec);
    expect(back).toMatchObject({ targetKind: "team", team: "cr-team", teamRole: "reviewer" });
  });

  it("omits the pinned role key from target when teamRole is blank (byte-identical to today)", () => {
    const spec = buildJobSpec({ ...defaultScheduleFormValues(), name: "n", team: "crew", prompt: "p" });
    expect(spec["target"]).toEqual({ team: "crew" });
  });

  // JOB-ROLE-TARGET GAP B: a role-library target spawns directly, no team/queue.
  it("round-trips a role-target job", () => {
    const v = { ...defaultScheduleFormValues(), name: "gh-cr-hourly-v2", targetKind: "role" as const, role: "gh-cr-finder", prompt: "find PRs" };
    const spec = buildJobSpec(v);
    expect(spec["target"]).toEqual({ role: "gh-cr-finder" });
    const back = scheduleFormValuesFromSpec(spec);
    expect(back).toMatchObject({ targetKind: "role", role: "gh-cr-finder" });
  });
});

describe("jobRow target projection (JOB-ROLE-TARGET)", () => {
  it("labels a role-library target distinctly from team/agent", () => {
    const row = jobRow({ name: "gh-cr-hourly-v2", enabled: true, target: { role: "gh-cr-finder", overrides: {} }, lastRuns: [] });
    expect(row.targetKind).toBe("role");
    expect(row.targetLabel).toBe("role · gh-cr-finder");
  });

  it("labels a pinned team-role target with the role suffix", () => {
    const row = jobRow({ name: "cr-hourly", enabled: true, target: { team: "cr-team", role: "reviewer" }, lastRuns: [] });
    expect(row.targetKind).toBe("team");
    expect(row.targetLabel).toBe("team cr-team · role reviewer");
  });

  it("an unpinned team target is unaffected (byte-identical label)", () => {
    const row = jobRow({ name: "j", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(row.targetLabel).toBe("team crew");
  });
});

// JOB-UPDATE-DELIVERTO-GUARD: the narrow "used to deliver, now doesn't" signal — never
// invented for a job that simply never had a deliverTo (the common, non-noisy case).
describe("jobRow deliveryDroppedAt projection", () => {
  it("projects a stamped deliveryDroppedAt through unchanged", () => {
    const row = jobRow({ name: "slack-watch", enabled: true, target: { role: "slack-cronjob", overrides: {} }, lastRuns: [], deliveryDroppedAt: 12345 });
    expect(row.deliveryDroppedAt).toBe(12345);
  });

  it("defaults to null for a job that was never flagged", () => {
    const row = jobRow({ name: "gh-janitor", enabled: true, target: { role: "gh-janitor", overrides: {} }, lastRuns: [] });
    expect(row.deliveryDroppedAt).toBeNull();
  });
});

// Schedule detail run history pane — the W17 "20 ok runs, delivery silently
// dropped" incident was invisible because only the single latest run was
// ever rendered; jobRunHistory surfaces the full retained list.
describe("jobRunHistory", () => {
  it("returns [] for a null spec (job.status still loading)", () => {
    expect(jobRunHistory(null)).toEqual([]);
  });

  it("returns [] for a job with no runs yet (clean empty state, not a crash)", () => {
    expect(jobRunHistory({ name: "j", lastRuns: [] })).toEqual([]);
  });

  it("orders newest-first, the reverse of the daemon's oldest-first append order", () => {
    const raw = {
      name: "slack-watch-heartbeat",
      lastRuns: [
        { ts: 1000, trigger: "scheduled", result: "ok", costUsd: 0.4 },
        { ts: 2000, trigger: "scheduled", result: "ok", costUsd: 0.44 },
        { ts: 3000, trigger: "manual", result: "failed", error: "deliverTo dropped", costUsd: 0.5 },
      ],
    };
    const runs = jobRunHistory(raw);
    expect(runs.map((r) => r.ts)).toEqual([3000, 2000, 1000]);
  });

  it("carries trigger, result, cost, agentId and error through for a failed run", () => {
    const raw = { name: "j", lastRuns: [{ ts: 5, trigger: "manual", result: "failed", agentId: "a1", taskId: "t1", costUsd: 0.12, error: "boom" }] };
    expect(jobRunHistory(raw)).toEqual([{ ts: 5, trigger: "manual", result: "failed", agentId: "a1", taskId: "t1", costUsd: 0.12, error: "boom", latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null }]);
  });

  it("defaults a missing costUsd/trigger/error (protocol schema defaults) without throwing", () => {
    const runs = jobRunHistory({ name: "j", lastRuns: [{ ts: 1, result: "ok" }] });
    expect(runs).toEqual([{ ts: 1, trigger: "scheduled", result: "ok", agentId: null, taskId: null, costUsd: 0, error: null, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null }]);
  });

  it("reads reason and nominalFireTs defensively, defaulting to null when absent", () => {
    const runs = jobRunHistory({ name: "j", lastRuns: [{ ts: 1, result: "skipped", reason: "overlap", nominalFireTs: 900 }] });
    expect(runs[0]!.reason).toBe("overlap");
    expect(runs[0]!.nominalFireTs).toBe(900);
    const bare = jobRunHistory({ name: "j", lastRuns: [{ ts: 1, result: "ok" }] });
    expect(bare[0]!.reason).toBeNull();
    expect(bare[0]!.nominalFireTs).toBeNull();
  });

  it("carries latenessMs/coalescedOccurrences through for a sleep-wake run", () => {
    const raw = { name: "j", lastRuns: [{ ts: 9, trigger: "sleep-wake", result: "ok", costUsd: 0, latenessMs: 33_180_000, coalescedOccurrences: 9 }] };
    const runs = jobRunHistory(raw);
    expect(runs[0]!.latenessMs).toBe(33_180_000);
    expect(runs[0]!.coalescedOccurrences).toBe(9);
  });
});

describe("triggerLabel", () => {
  it("passes non sleep-wake triggers through unchanged", () => {
    expect(triggerLabel({ ts: 1, trigger: "scheduled", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null })).toBe("scheduled");
    expect(triggerLabel({ ts: 1, trigger: "manual", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null })).toBe("manual");
  });

  // F01-QA: the trigger cell is a 60px grid column — the numbers belong on the sub-row, not here.
  it("reduces a sleep-wake run to the one-word species", () => {
    expect(triggerLabel({ ts: 1, trigger: "sleep-wake", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: 33_180_000, coalescedOccurrences: 9, reason: null, nominalFireTs: null })).toBe("slept");
  });
});

describe("lateRunLabel", () => {
  it("is null for a punctual run, so nothing renders", () => {
    expect(lateRunLabel({ ts: 1, trigger: "scheduled", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null })).toBeNull();
  });

  // The exact operator sentence F01 promises. "coalesced" — never "missed", never "hung".
  it("spells out the lateness and the coalesced count", () => {
    expect(lateRunLabel({ ts: 1, trigger: "sleep-wake", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: 33_180_000, coalescedOccurrences: 3, reason: null, nominalFireTs: null }))
      .toBe("ran late by 9h 13m (machine was asleep) \u00b7 3 occurrences coalesced");
  });

  it("keeps the count singular at 1", () => {
    expect(lateRunLabel({ ts: 1, trigger: "sleep-wake", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: 120000, coalescedOccurrences: 1, reason: null, nominalFireTs: null }))
      .toBe("ran late by 2m (machine was asleep) \u00b7 1 occurrence coalesced");
  });

  it("omits the coalesced clause when nothing was folded in", () => {
    expect(lateRunLabel({ ts: 1, trigger: "sleep-wake", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: 120000, coalescedOccurrences: 0, reason: null, nominalFireTs: null }))
      .toBe("ran late by 2m (machine was asleep)");
  });

  it("still names the cause when lateness was never measured", () => {
    expect(lateRunLabel({ ts: 1, trigger: "sleep-wake", result: "ok", error: null, agentId: null, taskId: null, costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null }))
      .toBe("ran late (machine was asleep)");
  });
});

describe("wakeNotice", () => {
  it("renders a placeholder while job.status is still in flight", () => {
    expect(wakeNotice(null, 0)).toEqual({ text: "checking wake scheduling\u2026", tone: "muted", command: null, holding: false, loading: true });
  });

  // An older daemon does not read the setup hint, so inventing one would be a lie.
  it("stays silent when the daemon reported no wakeScheduling at all", () => {
    expect(wakeNotice({ name: "j" }, 0)).toBeNull();
  });

  it("offers the daemon's setupHint as the copyable command when degraded", () => {
    const spec = { wakeScheduling: { available: false, platform: "darwin", reason: "wrapper not installed", setupHint: "./scripts/install.sh --enable-wake", scheduledFor: null, holdingAwake: false } };
    const n = wakeNotice(spec, 0)!;
    expect(n.tone).toBe("warn");
    expect(n.command).toBe("./scripts/install.sh --enable-wake");
    expect(n.text).toContain("(wrapper not installed)");
    expect(n.text).toContain("late and coalesced");
  });

  it("falls back to the protocol's spelling when a degraded daemon sent no hint", () => {
    const spec = { wakeScheduling: { available: false, platform: "darwin", reason: null, setupHint: null, scheduledFor: null, holdingAwake: false } };
    expect(wakeNotice(spec, 0)!.command).toBe(WAKE_SETUP_HINT);
  });

  it("names the next wake time when enabled", () => {
    const scheduledFor = new Date(2026, 0, 1, 7, 58).getTime();
    const spec = { wakeScheduling: { available: true, platform: "darwin", reason: null, setupHint: null, scheduledFor, holdingAwake: false } };
    const n = wakeNotice(spec, 0)!;
    expect(n).toEqual({ text: "wake scheduling enabled \u2014 next wake at 07:58:00", tone: "muted", command: null, holding: false, loading: false });
  });

  it("says no wake is needed yet rather than going blank", () => {
    const spec = { wakeScheduling: { available: true, platform: "darwin", reason: null, setupHint: null, scheduledFor: null, holdingAwake: false } };
    expect(wakeNotice(spec, 0)!.text).toBe("wake scheduling enabled \u2014 no wake needed yet");
  });

  // F01(b): the caffeinate hold is reported even while wake scheduling itself is degraded.
  it("surfaces the live caffeinate hold in either state", () => {
    const on = { wakeScheduling: { available: true, platform: "darwin", reason: null, setupHint: null, scheduledFor: null, holdingAwake: true } };
    const off = { wakeScheduling: { available: false, platform: "linux", reason: "unsupported", setupHint: null, scheduledFor: null, holdingAwake: true } };
    expect(wakeNotice(on, 0)!.holding).toBe(true);
    expect(wakeNotice(off, 0)!.holding).toBe(true);
  });
});

describe("runRetentionLabel", () => {
  it("never implies truncation below the cap", () => {
    expect(runRetentionLabel(0)).toBe("0 runs");
    expect(runRetentionLabel(1)).toBe("1 run");
    expect(runRetentionLabel(JOB_LAST_RUNS_CAP - 1)).toBe(`${JOB_LAST_RUNS_CAP - 1} runs`);
  });

  it("labels honestly once the retention cap is hit", () => {
    expect(runRetentionLabel(JOB_LAST_RUNS_CAP)).toBe(`last ${JOB_LAST_RUNS_CAP} runs · older runs not retained`);
  });
});

// JOB-ROLE-OVERRIDES: a {role, overrides} job target could BIND a library role but never adjust
// it from the app — so "the nightly run, but on a cheaper model" meant cloning the role, which is
// exactly how a role library ends up with five near-identical entries. The patch round-trips
// through the form so an edit doesn't silently drop it.
describe("scheduled job role overrides", () => {
  it("emits no `overrides` key at all when the patch is empty — byte-identical to before", () => {
    const spec = buildJobSpec({ ...defaultScheduleFormValues(), name: "n", targetKind: "role", role: "reviewer", prompt: "p" });
    expect(spec["target"]).toEqual({ role: "reviewer" });
  });

  it("carries a non-empty override patch onto the target", () => {
    const spec = buildJobSpec({
      ...defaultScheduleFormValues(), name: "n", targetKind: "role", role: "reviewer", prompt: "p",
      roleOverrides: { model: "claude-sonnet-5", effort: "low" },
    });
    expect(spec["target"]).toEqual({ role: "reviewer", overrides: { model: "claude-sonnet-5", effort: "low" } });
  });

  it("round-trips an existing job's overrides back into the edit form", () => {
    const values = scheduleFormValuesFromSpec({
      name: "n", prompt: "p", schedule: { every: { n: 1, unit: "hour" } },
      target: { role: "reviewer", overrides: { model: "m" } },
    } as never);
    expect(values.role).toBe("reviewer");
    expect(values.roleOverrides).toEqual({ model: "m" });
  });
});

// JOB-COMMAND-TARGET: a scheduled job with no agent. The form has to stop sending the two fields
// the daemon rejects for it — a prompt (its command IS the instruction) and a budget (it spends
// no tokens) — or the operator fills in something that is silently dropped.
describe("command-target schedules", () => {
  const base = { ...defaultScheduleFormValues(), name: "sso", scheduleKind: "cron" as const, cron: "0 9 * * *" };

  it("builds a {command} target and omits prompt and budget", () => {
    const spec = buildJobSpec({ ...base, targetKind: "command", command: "aws sso login --no-browser", maxBudgetUsd: "5", prompt: "ignored" });
    expect(spec["target"]).toEqual({ command: "aws sso login --no-browser" });
    expect(spec["prompt"]).toBeUndefined();
    expect(spec["maxBudgetUsd"]).toBeUndefined();
  });

  it("carries cwd and a timeout expressed in seconds", () => {
    const spec = buildJobSpec({ ...base, targetKind: "command", command: "git worktree prune", cwd: "/repo", commandTimeoutSec: "90" });
    expect(spec["target"]).toEqual({ command: "git worktree prune", cwd: "/repo", timeoutMs: 90_000 });
  });

  it("still sends prompt and budget for every other target", () => {
    const spec = buildJobSpec({ ...base, targetKind: "team", team: "crew", prompt: "audit deps", maxBudgetUsd: "5" });
    expect(spec["prompt"]).toBe("audit deps");
    expect(spec["maxBudgetUsd"]).toBe(5);
  });

  it("round-trips a command job back into the edit form", () => {
    const values = scheduleFormValuesFromSpec({
      name: "sso", schedule: { cron: "0 9 * * *" }, tz: "UTC", overlapPolicy: "skip", enabled: true,
      target: { command: "aws sso login", cwd: "/home/me", timeoutMs: 45_000 },
    });
    expect(values.targetKind).toBe("command");
    expect(values.command).toBe("aws sso login");
    expect(values.cwd).toBe("/home/me");
    expect(values.commandTimeoutSec).toBe("45");
  });
});

// JOB-WATCH — a supervised job's nextRunTs is null BY DESIGN, which in the UI is the same value an
// expired one-shot has. Without a distinct rendering, the one job kind that is supposed to be
// running continuously reads exactly like one that will never run again.
describe("a watch job reports whether it is UP, not when it next runs", () => {
  const watchRaw = (watch: unknown) => ({
    name: "k8s-watch", enabled: true, schedule: { watch: true },
    target: { command: "kubectl get pods -w" }, nextRunTs: null, lastRuns: [],
    ...(watch === undefined ? {} : { watch }),
  });

  it("labels the schedule 'watching' instead of an em dash", () => {
    expect(jobRow(watchRaw({ running: true, pid: 1 })).scheduleLabel).toBe("watching");
  });

  it("says running / down rather than '—'", () => {
    const now = Date.now();
    expect(nextRunLabel(null, now, { running: true })).toBe("running");
    expect(nextRunLabel(null, now, { running: false })).toBe("down");
  });

  it("leaves every non-watch job's label exactly as it was", () => {
    const now = Date.now();
    expect(nextRunLabel(null, now, null)).toBe("—");
    expect(nextRunLabel(null, now)).toBe("—");
    expect(nextRunLabel(now + 3_600_000, now, null)).toBe("in 1h");
  });

  it("carries no watch state for a job that has none", () => {
    expect(jobRow(watchRaw(undefined)).watch).toBeNull();
  });
});

// F02 — the schedules panel's suspend/resume banner: newest clock_jump inside the notice
// window, forward vs backward wording, and no phantom notice once it ages out.
describe("clockJumpNotice", () => {
  const clockAt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  // The payload shape JobScheduler.observeTick actually appends (jobs.ts observeTick): driftMs =
  // observedGapMs - expectedGapMs, and BOTH are negative for a backward step. An earlier version of
  // this suite used a positive observedGapMs for the backward case — a payload the emitter can
  // never produce — which hid the "stepped back 0s" bug (fmtDuration floors anything < 1000ms).
  const jumpEvent = (ts: number, seq: number, data: Record<string, unknown>) =>
    ({ ts, seq, kind: "clock_jump" as const, data });
  const FORWARD = { driftMs: 33_180_000, observedGapMs: 33_240_000, expectedGapMs: 60_000, direction: "forward" };
  const BACKWARD = { driftMs: -780_000, observedGapMs: -720_000, expectedGapMs: 60_000, direction: "backward" };

  it("formats a forward jump as 'slept' with the DRIFT, not the observed gap", () => {
    const now = 10_000_000;
    const ts = now - 60_000;
    // 9h 13m is the unaccounted-for wall time (driftMs). observedGapMs is 9h 14m — it includes the
    // 60s hop the scheduler meant to sleep, which was not a suspend.
    expect(clockJumpNotice([jumpEvent(ts, 1, FORWARD)], now))
      .toBe(`⏱ slept 9h 13m at ${clockAt(ts)} — schedules re-armed`);
  });

  it("formats a backward jump as 'stepped back' with a magnitude, not '0s'", () => {
    const now = 10_000_000;
    const ts = now - 60_000;
    expect(clockJumpNotice([jumpEvent(ts, 1, BACKWARD)], now))
      .toBe(`⏱ clock stepped back 13m at ${clockAt(ts)} — schedules re-armed`);
  });

  it("agrees with the system.woke topic payload, which publishes sleptMs = driftMs", () => {
    const now = 10_000_000;
    const notice = clockJumpNotice([jumpEvent(now - 60_000, 1, FORWARD)], now)!;
    expect(notice).toContain("9h 13m");   // === fmtDuration(payload.sleptMs)
  });

  it("is null with no clock_jump event", () => {
    expect(clockJumpNotice([], 10_000_000)).toBeNull();
  });

  it("picks the newest clock_jump when several are in the feed", () => {
    const now = 10_000_000;
    const older = jumpEvent(now - 500_000, 1, BACKWARD);
    const newer = jumpEvent(now - 60_000, 2, FORWARD);
    expect(clockJumpNotice([older, newer], now)).toBe(`⏱ slept 9h 13m at ${clockAt(newer.ts)} — schedules re-armed`);
  });

  it("is null once the newest jump ages out of the notice window", () => {
    const now = 10_000_000;
    const ts = now - CLOCK_JUMP_NOTICE_WINDOW_MS - 1;
    expect(clockJumpNotice([jumpEvent(ts, 1, FORWARD)], now)).toBeNull();
  });
});

// F02.UI — the operator-facing half of the sleep story. The two gap signals are mutually
// exclusive by construction, so each test feeds ONE of the shapes the emitters can actually
// produce: observeTick's clock_jump (live suspend, no skip events — the late job just fires) or
// reconcileBoot's job_skipped cluster (restart; armedAtMs is null there, so no clock_jump).
describe("F02.UI schedules-panel gap banner", () => {
  const NOW = 10_000_000;
  const at = NOW - 60_000;
  const clockAt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const jump = (data: Record<string, unknown>) => ({ ts: at, seq: 1, kind: "clock_jump" as const, data });
  const FORWARD = { driftMs: 33_180_000, observedGapMs: 33_240_000, expectedGapMs: 60_000, direction: "forward" };
  const BACKWARD = { driftMs: -780_000, observedGapMs: -720_000, expectedGapMs: 60_000, direction: "backward" };
  const skipped = (ts: number, seq: number, job: string, missedOccurrences: unknown, downtimeMs: unknown = 33_180_000) =>
    ({ ts, seq, kind: "job_skipped" as const, data: { job, reason: "missed-restart", missedOccurrences, downtimeMs } });

  it("tones a completed sleep as muted and a backward step as warn", () => {
    expect(scheduleGapBanner([jump(FORWARD)], NOW)!.tone).toBe("muted");
    expect(scheduleGapBanner([jump(BACKWARD)], NOW)!.tone).toBe("warn");
  });

  it("leaves the contract sentence byte-identical for a live suspend (which carries no skips)", () => {
    expect(scheduleGapBanner([jump(FORWARD)], NOW)!.text).toBe(clockJumpNotice([jump(FORWARD)], NOW));
  });

  it("answers 'did my hourly job miss 9 runs?' from a restart cluster", () => {
    const evs = [skipped(at, 2, "hourly-report", 9)];
    expect(scheduleGapBanner(evs, NOW)!)
      .toEqual({ text: `⏱ back after 9h 13m down at ${clockAt(at)} — hourly-report missed 9 runs`, tone: "muted" });
  });

  it("sums across schedules and says only what it knows when downtimeMs is absent", () => {
    const evs = [skipped(at, 2, "a", 9), skipped(at, 3, "b", 3)];
    expect(scheduleGapBanner(evs, NOW)!.text).toBe(`⏱ back after 9h 13m down at ${clockAt(at)} — 12 runs missed across 2 schedules`);
    const old = [skipped(at, 2, "a", undefined, null)];
    expect(scheduleGapBanner(old, NOW)!.text).toBe(`⏱ restarted at ${clockAt(at)} — a missed 1 run`);
  });

  it("never folds an EARLIER restart's skips into this one", () => {
    const evs = [skipped(at - 3_600_000, 1, "old", 4), skipped(at, 2, "a", 2)];
    expect(scheduleGapBanner(evs, NOW)!.text).toMatch(/— a missed 2 runs$/);
    expect(missedRunsClause(evs, at)).toBe("a missed 2 runs");
  });

  it("shows whichever gap is newer, and ages both out of the notice window", () => {
    const newerJump = { ts: at + 1_000, seq: 9, kind: "clock_jump" as const, data: FORWARD };
    expect(scheduleGapBanner([skipped(at, 2, "a", 9), newerJump], NOW)!.text).toMatch(/^⏱ slept /);
    expect(scheduleGapBanner([newerJump, skipped(at + 2_000, 3, "a", 9)], NOW)!.text).toMatch(/^⏱ back after /);
    const stale = NOW + CLOCK_JUMP_NOTICE_WINDOW_MS + 1;
    expect(scheduleGapBanner([jump(FORWARD)], stale)).toBeNull();
    expect(scheduleGapBanner([skipped(at, 2, "a", 9)], stale)).toBeNull();
  });

  it("reads a slept-through slot as scheduler lateness, not '9h ago' in a next-run column", () => {
    expect(nextRunLabel(NOW - 33_180_000, NOW, null)).toBe("overdue by 9h");
    // A tick a few seconds late is ordinary — MAX_HOP_MS is 60s — and must not flag.
    expect(nextRunLabel(NOW - OVERDUE_THRESHOLD_MS + 1_000, NOW, null)).toBe("1m ago");
    expect(nextRunLabel(NOW + 240_000, NOW, null)).toBe("in 4m");
  });
});

// F04: an operator staring at "⊘ skipped" has no way to tell a duplicate-occurrence skip from a
// stale-catch-up skip from an overlap — lastResultLabel spells out the reason in plain words.
describe("lastResultLabel", () => {
  const run = (over: Partial<Parameters<typeof lastResultLabel>[0] & object>) => ({
    ts: 1, trigger: "scheduled", result: "skipped", error: null, agentId: null, taskId: null,
    costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null, ...over,
  });

  it("appends nothing when reason is null (unchanged bare glyph)", () => {
    expect(lastResultLabel(run({ reason: null }))).toBe("⊘ skipped");
  });

  it("appends the plain-English gloss for each known skip reason", () => {
    expect(lastResultLabel(run({ reason: "duplicate-occurrence" }))).toBe("⊘ skipped · duplicate occurrence — already run for this slot");
    expect(lastResultLabel(run({ reason: "stale-beyond-window" }))).toBe("⊘ skipped · too late to catch up");
    expect(lastResultLabel(run({ reason: "overlap" }))).toBe("⊘ skipped · previous run still going");
    expect(lastResultLabel(run({ reason: "missed-restart" }))).toBe("⊘ skipped · missed while the daemon was down");
    expect(lastResultLabel(run({ reason: "daemon-crash" }))).toBe("⊘ skipped · daemon restarted mid-run");
  });

  it("lets a failed run's error win over any reason", () => {
    expect(lastResultLabel(run({ result: "failed", error: "boom", reason: "overlap" }))).toBe("✗ failed: boom");
  });

  it("returns — for no run at all", () => {
    expect(lastResultLabel(null)).toBe("—");
  });
});

// F04: jobRow.inFlight — the durable claimed-slot marker, so a crash-recovered or still-running
// run is visible even before it produces a lastRun entry.
describe("jobRow inFlight projection", () => {
  it("defaults to null when the daemon reports nothing in flight", () => {
    const row = jobRow({ name: "j", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(row.inFlight).toBeNull();
  });

  it("projects a populated inFlight marker through", () => {
    const row = jobRow({
      name: "j", enabled: true, target: { team: "crew" }, lastRuns: [],
      inFlight: { idempotencyKey: "k1", startedAt: 1000, trigger: "scheduled", nominalFireTs: 900, kind: "agent" },
    });
    expect(row.inFlight).toEqual({ startedAt: 1000, trigger: "scheduled", nominalFireTs: 900, kind: "agent", idempotencyKey: "k1", readopted: false });
  });
});

// F04: the schedule detail's in-flight row — "still running" or "was running when the daemon
// crashed" must read the same to an operator, since inFlight alone can't distinguish them.
describe("inFlightLabel", () => {
  const clockAt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  it("is null when nothing is claimed", () => {
    const row = jobRow({ name: "j", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(inFlightLabel(row, 0)).toBeNull();
  });

  it("names the scheduled slot when nominalFireTs is present", () => {
    const slot = 32_400_000;
    const row = jobRow({
      name: "j", enabled: true, target: { team: "crew" }, lastRuns: [],
      inFlight: { idempotencyKey: "k1", startedAt: 0, trigger: "scheduled", nominalFireTs: slot },
    });
    expect(inFlightLabel(row, 240_000)).toBe(`● running since 4m ago · scheduled slot ${clockAt(slot)}`);
  });

  it("says 'manual' when the run claimed no slot", () => {
    const row = jobRow({
      name: "j", enabled: true, target: { team: "crew" }, lastRuns: [],
      inFlight: { idempotencyKey: "k1", startedAt: 0, trigger: "manual", nominalFireTs: null },
    });
    expect(inFlightLabel(row, 240_000)).toBe("● running since 4m ago · manual");
  });
});

// ---------------------------------------------------------------------------
// F04.UI — the operator-facing half of job idempotency keys: a pre-spawn claim
// that says so, a refusal an operator can read, and an editable catch-up bound.
// ---------------------------------------------------------------------------

const jr = (over: Record<string, unknown> = {}) => ({
  ts: 1, trigger: "scheduled", result: "skipped", error: null, agentId: null, taskId: null,
  costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null, ...over,
}) as Parameters<typeof runReasonLabel>[0];

const rowWith = (inFlight: Record<string, unknown> | null) =>
  jobRow({ name: "j", enabled: true, target: { team: "crew" }, lastRuns: [], ...(inFlight ? { inFlight } : {}) });

describe("inFlightLabel — the starting window (QA gap 1)", () => {
  it("says 'starting', not 'running', for a claim written before anything was spawned", () => {
    const row = rowWith({ idempotencyKey: "k", startedAt: 0, trigger: "scheduled", nominalFireTs: null, kind: "starting" });
    expect(inFlightLabel(row, 240_000)).toBe("◌ starting since 4m ago · manual");
  });

  it("keeps the pre-F04.UI wording when an older daemon omits kind", () => {
    const row = rowWith({ idempotencyKey: "k", startedAt: 0, trigger: "manual", nominalFireTs: null });
    expect(inFlightLabel(row, 240_000)).toBe("● running since 4m ago · manual");
  });
});

describe("inFlightKeyLabel / inFlightRecovered", () => {
  it("surfaces the claim's key so a manual- run is distinguishable from a grid slot", () => {
    expect(inFlightKeyLabel(rowWith({ idempotencyKey: "job:j:manual-17", startedAt: 0, trigger: "manual", nominalFireTs: null, kind: "agent" })))
      .toBe("job:j:manual-17");
    expect(inFlightKeyLabel(rowWith(null))).toBeNull();
  });

  it("marks a claim re-adopted across a restart, and only that claim", () => {
    const row = rowWith({ idempotencyKey: "k1", startedAt: 0, trigger: "scheduled", nominalFireTs: 900, kind: "agent" });
    expect(inFlightRecovered([{ kind: "job_run_started", data: { idempotencyKey: "k1", readopted: true } }], row)).toBe(true);
    expect(inFlightRecovered([{ kind: "job_run_started", data: { idempotencyKey: "k1" } }], row)).toBe(false);
    expect(inFlightRecovered([{ kind: "job_run_started", data: { idempotencyKey: "other", readopted: true } }], row)).toBe(false);
    // No backlog and a pre-F04.QA-A daemon (no durable flag) ⇒ no marker rather than a wrong one.
    expect(inFlightRecovered([], row)).toBe(false);
  });

  // F04.QA-A: the fact now rides on the record, so an app that connects after the restart — with
  // an empty event feed — still shows the marker. This is that client's whole world.
  it("reads the durable readopted flag with no event feed at all", () => {
    const row = rowWith({ idempotencyKey: "k1", startedAt: 0, trigger: "scheduled", nominalFireTs: 900, kind: "agent", readopted: true });
    expect(row.inFlight?.readopted).toBe(true);
    expect(inFlightRecovered([], row)).toBe(true);
  });

  it("reads the NEWEST job_run_started for the key — a re-adopted claim that later restarted clean", () => {
    const row = rowWith({ idempotencyKey: "k1", startedAt: 0, trigger: "scheduled", nominalFireTs: 900, kind: "agent" });
    const events = [
      { kind: "job_run_started", data: { idempotencyKey: "k1", readopted: true } },
      { kind: "job_run_started", data: { idempotencyKey: "k1" } },
    ];
    expect(inFlightRecovered(events, row)).toBe(false);
  });
});

describe("runReasonLabel — the run-history sub-row", () => {
  it("is null for a run with nothing to explain", () => {
    expect(runReasonLabel(jr({ result: "ok" }))).toBeNull();
  });

  it("separates a refused manual run from a duplicate scheduled fire", () => {
    expect(runReasonLabel(jr({ reason: "duplicate-occurrence", trigger: "manual" })))
      .toBe("duplicate manual run refused — this slot has already run");
    expect(runReasonLabel(jr({ reason: "duplicate-occurrence", trigger: "catchup" })))
      .toBe("duplicate fire — this slot was already claimed");
  });

  it("quotes the catch-up limit the slot lost to, when the spec has one", () => {
    expect(runReasonLabel(jr({ reason: "stale-beyond-window" }), 7_200_000)).toBe("too stale to catch up (catch-up limit 2h)");
    expect(runReasonLabel(jr({ reason: "stale-beyond-window" }), null)).toBe("too stale to catch up");
  });

  it("glosses the daemon-authored reasons a raw row would leave as an enum", () => {
    expect(runReasonLabel(jr({ reason: "daemon-crash", result: "failed" }))).toBe("daemon restarted mid-run");
    expect(runReasonLabel(jr({ reason: "who-knows" }))).toBeNull();
  });

  it("glosses a grid slot the daemon skipped because a retry chain still owns the target", () => {
    expect(runReasonLabel(jr({ reason: "retry-pending" }))).toBe("a retry of an earlier run is still pending");
  });
});

describe("lastResultLabel — daemon-voice reasons (QA gap 2)", () => {
  const run = (over: Record<string, unknown>) => jr(over);

  it("prefers the gloss over the daemon's own machine-voice error string", () => {
    expect(lastResultLabel(run({ result: "failed", reason: "daemon-crash", error: "daemon crashed while the run was in flight" })))
      .toBe("✗ failed · daemon restarted mid-run");
    expect(lastResultLabel(run({ result: "failed", reason: "start-failed", error: "" })))
      .toBe("✗ failed · could not be started");
  });

  it("still lets a TARGET's error win — that text says more than any gloss", () => {
    expect(lastResultLabel(run({ result: "failed", error: "boom", reason: "overlap" }))).toBe("✗ failed: boom");
  });
});

describe("runNowNoticeLabel — the refused duplicate toast (QA gap 3)", () => {
  it("is silent when the run actually started", () => {
    expect(runNowNoticeLabel("nightly", { started: true })).toBeNull();
    expect(runNowNoticeLabel("nightly", null)).toBeNull();
  });

  it("names the job and the reason in plain words", () => {
    expect(runNowNoticeLabel("nightly", { started: false, reason: "duplicate-occurrence" }))
      .toBe('"nightly" not run — this slot has already run (duplicate refused)');
    expect(runNowNoticeLabel("nightly", { started: false, reason: "overlap" }))
      .toBe('"nightly" not run — the previous run is still going');
    expect(runNowNoticeLabel("nightly", { started: false })).toBe('"nightly" was not started');
  });
});

describe("catch-up form fields", () => {
  it("sends an explicit null when the limit is cleared, so an old bound cannot survive an edit", () => {
    const v = { ...defaultScheduleFormValues(), name: "n", team: "crew", prompt: "p", catchUp: true };
    expect(buildJobUpdatePatch(v)).toMatchObject({ catchUp: true, catchUpMaxStalenessMs: null });
  });

  it("round-trips minutes ⇄ ms through the spec prefill", () => {
    const v = { ...defaultScheduleFormValues(), name: "n", team: "crew", prompt: "p", catchUp: true, catchUpMaxStalenessMin: "90" };
    const spec = buildJobSpec(v);
    expect(spec).toMatchObject({ catchUp: true, catchUpMaxStalenessMs: 5_400_000 });
    expect(scheduleFormValuesFromSpec(spec)).toMatchObject({ catchUp: true, catchUpMaxStalenessMin: "90" });
  });

  it("rejects a non-positive / fractional limit before the daemon has to", () => {
    const base = { ...defaultScheduleFormValues(), name: "n", team: "crew", prompt: "p", catchUp: true };
    expect(validateScheduleForm({ ...base, catchUpMaxStalenessMin: "0" })).toBe("catch-up limit: minutes must be a positive integer");
    expect(validateScheduleForm({ ...base, catchUpMaxStalenessMin: "1.5" })).toBe("catch-up limit: minutes must be a positive integer");
    expect(validateScheduleForm({ ...base, catchUpMaxStalenessMin: "" })).toBeNull();
  });

  it("explains catch-up without naming the field", () => {
    expect(CATCH_UP_HELP).toContain("asleep");
    expect(CATCH_UP_HELP).toContain("blank = any age");
  });

  it("reads the bound off a raw job.status spec for the history sub-row", () => {
    expect(catchUpStalenessMs({ catchUpMaxStalenessMs: 60_000 })).toBe(60_000);
    expect(catchUpStalenessMs({ catchUpMaxStalenessMs: null })).toBeNull();
    expect(catchUpStalenessMs(null)).toBeNull();
  });
});

// F05: the schedules panel's next-run cell state ladder — dead-letter and retry-in-flight both
// pre-empt the ordinary schedule/disabled/next-run reading.
describe("jobStateLabel", () => {
  const NOW = 1_700_000_000_000;

  it("reads the ordinary next-run label for a healthy enabled job", () => {
    const row = jobRow({ name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], nextRunTs: NOW + 240_000 });
    expect(jobStateLabel(row, NOW)).toBe("in 4m");
  });

  it("reads disabled for a healthy but disabled job", () => {
    const row = jobRow({ name: "n", enabled: false, target: { team: "crew" }, lastRuns: [] });
    expect(jobStateLabel(row, NOW)).toBe("disabled");
  });

  // F05.UI: the number an operator needs is the attempt that is ABOUT to run, not the count of
  // burnt ones — "retry 2/5" after two failures reads as if one is still in hand when three are.
  it("reads the PENDING attempt when failure is set but not dead-lettered", () => {
    const row = jobRow({
      name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 2,
      retryPolicy: { maxAttempts: 5 },
      failure: { nominalRunTs: NOW, reasons: [{ ts: NOW, error: "boom" }], deadLetterAt: null },
    });
    expect(jobStateLabel(row, NOW)).toBe("↻ retry 3/5");
  });

  it("reads dead-letter once failure.deadLetterAt is stamped, even though the job is now disabled", () => {
    const row = jobRow({
      name: "n", enabled: false, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 3,
      failure: { nominalRunTs: NOW, reasons: [{ ts: NOW, error: "boom" }], deadLetterAt: NOW },
    });
    expect(jobStateLabel(row, NOW)).toBe("⚠ dead-letter");
  });
});

describe("deadLetterReasonLines", () => {
  const NOW = 1_700_000_000_000;

  it("returns empty for a healthy job (no failure)", () => {
    const row = jobRow({ name: "n", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(deadLetterReasonLines(row, NOW)).toEqual([]);
  });

  it("renders newest-first, though JobFailureState.reasons is stored oldest-first", () => {
    const row = jobRow({
      name: "n", enabled: false, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 2,
      failure: {
        nominalRunTs: NOW,
        deadLetterAt: NOW,
        reasons: [
          { ts: NOW - 120_000, error: "connection reset" },
          { ts: NOW - 60_000, error: "timeout" },
        ],
      },
    });
    expect(deadLetterReasonLines(row, NOW)).toEqual([
      "1m ago · timeout",
      "2m ago · connection reset",
    ]);
  });
});

describe("latestJobSeq", () => {
  it("picks up a job_dead_letter event alongside the other job-scheduler kinds", () => {
    expect(latestJobSeq([
      { seq: 5, kind: "job_run_started" },
      { seq: 9, kind: "job_dead_letter" },
      { seq: 3, kind: "unrelated" },
    ])).toBe(9);
  });

  it("returns 0 when no job-scheduler event is present", () => {
    expect(latestJobSeq([{ seq: 5, kind: "unrelated" }])).toBe(0);
  });
});

// ── F05.UI ────────────────────────────────────────────────────────────────────
// The run-history vocabulary and the retry/requeue lines.

const RUN = (over: Partial<JobRunView> = {}): JobRunView => ({
  ts: 1, trigger: "scheduled", result: "ok", error: null, agentId: null, taskId: null,
  costUsd: 0, latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null,
  ...over,
});

describe("triggerLabel/triggerTitle (F05.UI vocabulary)", () => {
  it("de-jargons the catchup wire word", () => {
    expect(triggerLabel(RUN({ trigger: "catchup" }))).toBe("catch-up");
  });

  it("keeps the 60px cell short and puts the long phrase in the hover title", () => {
    expect(triggerLabel(RUN({ trigger: "sleep-wake" }))).toBe("slept");
    expect(triggerTitle(RUN({ trigger: "sleep-wake" }))).toBe("ran late after sleep");
  });
});

describe("runOutcomeLabels", () => {
  const NOW = 1_700_000_000_000;

  it("leaves a healthy history untouched", () => {
    const row = jobRow({ name: "n", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(runOutcomeLabels(row, [RUN(), RUN({ result: "skipped" })])).toEqual(["ok", "skipped"]);
  });

  // The attempt number is DERIVED from the leading failed streak, not from JobRunEntry.attempt:
  // F05 FIX-1 means a backoff re-fire is stored as a fresh occurrence with attempt 0, so the
  // stored field would render "1 of 3" three times over.
  it("numbers the leading failed streak newest-highest and marks the dead-lettered run", () => {
    const row = jobRow({
      name: "n", enabled: false, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 3,
      failure: { nominalRunTs: NOW, reasons: [{ ts: NOW, error: "boom" }], deadLetterAt: NOW },
    });
    const runs = [RUN({ result: "failed" }), RUN({ result: "failed" }), RUN({ result: "failed" }), RUN()];
    expect(runOutcomeLabels(row, runs)).toEqual([
      "failed attempt 3 of 3 · dead-lettered",
      "failed attempt 2 of 3",
      "failed attempt 1 of 3",
      "ok",
    ]);
  });

  it("does not number failures older than the current retry chain", () => {
    const row = jobRow({
      name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 1,
      failure: { nominalRunTs: NOW, reasons: [{ ts: NOW, error: "boom" }], deadLetterAt: null },
    });
    expect(runOutcomeLabels(row, [RUN({ result: "failed" }), RUN({ result: "failed" })]))
      .toEqual(["failed attempt 1 of 3", "failed"]);
  });
});

describe("retryProgressLabel", () => {
  const NOW = 1_700_000_000_000;

  it("is null for a healthy job and for a dead-lettered one (the ⚠ block speaks instead)", () => {
    const healthy = jobRow({ name: "n", enabled: true, target: { team: "crew" }, lastRuns: [] });
    expect(retryProgressLabel(healthy, NOW)).toBeNull();
    const dead = jobRow({
      name: "n", enabled: false, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 3,
      failure: { nominalRunTs: NOW, reasons: [], deadLetterAt: NOW },
    });
    expect(retryProgressLabel(dead, NOW)).toBeNull();
  });

  it("warns when the pending attempt is the last one before dead-letter", () => {
    const row = jobRow({
      name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 2,
      nextRunTs: NOW + 60_000,
      failure: { nominalRunTs: NOW, reasons: [], deadLetterAt: null },
    });
    expect(retryProgressLabel(row, NOW))
      .toBe("retry 3 of 3 — next attempt in 1m · last attempt before dead-letter");
  });

  it("omits the warning while attempts remain", () => {
    const row = jobRow({
      name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 1,
      nextRunTs: NOW + 60_000, retryPolicy: { maxAttempts: 5 },
      failure: { nominalRunTs: NOW, reasons: [], deadLetterAt: null },
    });
    expect(retryProgressLabel(row, NOW)).toBe("retry 2 of 5 — next attempt in 1m");
  });

  // F05.QA-FIX split the two clocks: nextRunTs is the schedule grid (an hour out here), retryAt is
  // when the attempt actually fires. Reading nextRunTs would promise the operator the wrong instant.
  it("names the retry instant, not the next grid slot", () => {
    const row = jobRow({
      name: "n", enabled: true, target: { team: "crew" }, lastRuns: [], consecutiveFailures: 1,
      nextRunTs: NOW + 3_600_000, retryPolicy: { maxAttempts: 5 },
      failure: { nominalRunTs: NOW, retryAt: NOW + 60_000, reasons: [], deadLetterAt: null },
    });
    expect(retryProgressLabel(row, NOW)).toBe("retry 2 of 5 — next attempt in 1m");
  });
});

describe("requeueNoticeLabel", () => {
  const NOW = 1_700_000_000_000;

  // The daemon emits NO event for a requeue, so this client-side notice is the ONLY receipt an
  // operator gets — it has to say when the schedule actually comes back.
  it("names the job and when it next runs", () => {
    expect(requeueNoticeLabel("nightly", NOW + 3_600_000, NOW)).toBe("requeued nightly — next run in 1h");
  });
});
