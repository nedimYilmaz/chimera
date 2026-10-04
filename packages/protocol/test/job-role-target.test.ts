import { describe, it, expect } from "vitest";
import { JobInFlightSchema, JobRecordSchema, JobRunEntrySchema, JobTargetSchema } from "../src/index.js";

// JOB-ROLE-TARGET: JobTargetSchema widened from a 2-way to a 3-way union — a team target
// gained an optional `role` key (GAP A) and a brand-new role-library target was added
// (GAP B, literally RoleBindingSchema). Every pre-existing persisted JobRecord (team-only,
// or agentSpec) must still parse byte-identically — this is additive, not a migration.
describe("JobTargetSchema (JOB-ROLE-TARGET)", () => {
  it("a pre-existing {team} target (no role key) parses byte-identically", () => {
    const legacy = { team: "crew" };
    const parsed = JobTargetSchema.parse(legacy);
    expect(parsed).toEqual({ team: "crew" });
    expect("role" in parsed).toBe(false);
  });

  it("a pre-existing {agentSpec} target parses unaffected", () => {
    const legacy = { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" as const } };
    const parsed = JobTargetSchema.parse(legacy);
    expect("agentSpec" in parsed && parsed.agentSpec.cwd).toBe("/tmp");
  });

  it("{team, role} pins a team-local role key", () => {
    const parsed = JobTargetSchema.parse({ team: "crew", role: "reviewer" });
    expect(parsed).toEqual({ team: "crew", role: "reviewer" });
  });

  it("{role, overrides} resolves as a RoleBindingSchema-shaped role-library target", () => {
    const parsed = JobTargetSchema.parse({ role: "gh-cr-finder", overrides: { model: "opus" } });
    expect(parsed).toEqual({ role: "gh-cr-finder", overrides: { model: "opus" } });
  });

  it("{role} with no overrides defaults overrides to {} (matches RoleBindingSchema)", () => {
    const parsed = JobTargetSchema.parse({ role: "gh-cr-finder" });
    expect(parsed).toEqual({ role: "gh-cr-finder", overrides: {} });
  });

  it("rejects a {team, agentSpec} object that satisfies no union member", () => {
    expect(() => JobTargetSchema.parse({ team: "crew", agentSpec: {} })).toThrow();
  });

  it("a full pre-existing JobRecord (team target, no role) round-trips unchanged through parse -> encode -> parse", () => {
    const legacy = {
      name: "gh-cr-hourly",
      schedule: { cron: "0 * * * *" },
      tz: "UTC",
      target: { team: "gh-cr-finder" },
      prompt: "find PRs to review",
      overlapPolicy: "skip" as const,
      maxBudgetUsd: null,
      enabled: true,
      catchUp: false,
      createdAt: 1234,
      nextRunTs: 5678,
      lastRuns: [],
      consecutiveFailures: 0,
      disabledReason: null,
    };
    const parsed = JobRecordSchema.parse(legacy);
    const reparsed = JobRecordSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
    // JOB-UPDATE-DELIVERTO-GUARD: additive field, defaults in for any pre-existing record —
    // the rest of the shape stays byte-identical. F04 adds catchUpMaxStalenessMs and inFlight,
    // F05 adds `failure` (the retry/dead-letter state) — same guarantee: each is .default(null),
    // so a jobs.json written before that feature existed materializes it as null, never absent.
    expect(parsed).toEqual({
      ...legacy, deliveryDroppedAt: null, catchUpMaxStalenessMs: null, inFlight: null, failure: null,
    });
  });

  // F01(c): every jobs.json on disk today was written without latenessMs/coalescedOccurrences.
  // Both are .default(null), so an old record must still parse — and a run written by the new
  // build must still say "not measured" rather than "on time" (null, never 0).
  it("parses a pre-F01 job record: latenessMs and coalescedOccurrences default to null", () => {
    const preF01 = {
      name: "nightly",
      schedule: { cron: "0 3 * * *" },
      tz: "UTC",
      target: { command: "true" },
      overlapPolicy: "skip" as const,
      maxBudgetUsd: null,
      enabled: true,
      catchUp: false,
      createdAt: 1234,
      nextRunTs: 5678,
      lastRuns: [
        { ts: 1000, trigger: "scheduled", result: "ok", agentId: null, taskId: null, costUsd: 0, error: null, exitCode: 0, output: null },
      ],
      consecutiveFailures: 0,
      disabledReason: null,
    };
    const parsed = JobRecordSchema.parse(preF01);
    expect(parsed.lastRuns[0]!.latenessMs).toBeNull();
    expect(parsed.lastRuns[0]!.coalescedOccurrences).toBeNull();
    expect(JobRecordSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts the sleep-wake trigger with its lateness pair", () => {
    const parsed = JobRunEntrySchema.parse({
      ts: 2000, trigger: "sleep-wake", result: "ok", costUsd: 0,
      latenessMs: 33_180_000, coalescedOccurrences: 9,
    });
    expect(parsed.trigger).toBe("sleep-wake");
    expect(parsed.coalescedOccurrences).toBe(9);
    // 0 missed slots is a MEANINGFUL value (late, but only one slot elapsed) and must survive.
    expect(JobRunEntrySchema.parse({ ts: 1, trigger: "sleep-wake", result: "ok", latenessMs: 1, coalescedOccurrences: 0 }).coalescedOccurrences).toBe(0);
  });
});

describe("F04.QA-B: the occurrence key's attempt component is back-compatible", () => {
  // jobs.json files written before F04.QA-B have no `attempt` anywhere; they must read as attempt 0
  // (the first, and until F05 the only, attempt) rather than fail the whole file's parse.
  it("a run entry and an in-flight claim without `attempt` parse as attempt 0", () => {
    const entry = JobRunEntrySchema.parse({ ts: 1, trigger: "scheduled", result: "failed", nominalFireTs: 1 });
    expect(entry.attempt).toBe(0);
    const claim = JobInFlightSchema.parse({ idempotencyKey: "job:report:1", nominalFireTs: 1, trigger: "scheduled", startedAt: 1, kind: "starting" });
    expect(claim.attempt).toBe(0);
  });
});
