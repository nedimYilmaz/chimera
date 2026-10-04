import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepJournalEntrySchema, type TaskRecord, type UsageScope } from "@chimera/protocol";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { StepJournal, stepInputDigest, STEP_JOURNAL_QUERY_FILTER_KEYS, type StepAgentSnapshot } from "@chimera/core/step-journal";

// F11: the store is exercised DIRECTLY here — no QueueStore, no engine (that wiring is a
// separate task). Everything below therefore mimics what queues.ts does around it: push the
// stepHistory entry, THEN open(); close() BEFORE the entry gets its endedAt.

function home(): string {
  return mkdtempSync(join(tmpdir(), "chimera-step-journal-"));
}

type Step = { stepIndex: number; stepId: string; agentId: string | null; startedAt: number; endedAt: number | null; outcome: "passed" | "failed" | "retried" | null; reason?: string };

function task(taskId: string, opts: { queue?: string; stepAttempts?: number; stepHistory?: Step[] } = {}): TaskRecord {
  return {
    taskId,
    queue: opts.queue ?? "q",
    stepAttempts: opts.stepAttempts ?? 0,
    stepHistory: opts.stepHistory ?? [],
  } as unknown as TaskRecord;
}

// Mirrors QueueStore.startStep: the stepHistory entry exists BEFORE the journal sees the open.
function startStep(t: TaskRecord, stepIndex: number, stepId: string, agentId: string | null, at: number): void {
  (t.stepHistory as Step[]).push({ stepIndex, stepId, agentId, startedAt: at, endedAt: null, outcome: null });
}
function endStep(t: TaskRecord, outcome: "passed" | "failed" | "retried", at: number): void {
  const e = (t.stepHistory as Step[])[t.stepHistory.length - 1]!;
  e.endedAt = at; e.outcome = outcome;
}

const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0): UsageScope => ({ input, output, cacheRead, cacheCreation });

function snap(over: Partial<StepAgentSnapshot> = {}): StepAgentSnapshot {
  return { model: "sonnet", account: "main", provider: "claude", team: "core", costUsd: 0, usage: usage(0, 0), inputDigest: null, ...over };
}

describe("StepJournal: rows, folding and the per-attempt delta", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function make(opts: { agent?: () => StepAgentSnapshot | null; now?: () => number; retainMonths?: number; maxTotalBytes?: number } = {}) {
    const h = home(); dirs.push(h);
    const j = new StepJournal(h, {
      resolveAgent: () => (opts.agent ? opts.agent() : snap()),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.retainMonths !== undefined ? { retainMonths: opts.retainMonths } : {}),
      ...(opts.maxTotalBytes !== undefined ? { maxTotalBytes: opts.maxTotalBytes } : {}),
    });
    return { j, h, dir: join(h, "journal") };
  }

  it("writes an open row and a close row that share one entryId, and folds them into one entry", () => {
    let now = 1_000_000;
    const { j, dir } = make({ now: () => now });
    const t = task("t1", { queue: "build", stepAttempts: 2 });

    startStep(t, 0, "review", "a1", now);
    j.open(t, 0, "review", "a1");
    now += 5_000;
    j.close(t, "passed", "gate green");
    endStep(t, "passed", now);

    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(raw).toHaveLength(2);
    expect(raw[0].phase).toBe("open");
    expect(raw[1].phase).toBe("close");
    expect(raw[0].entryId).toBe("t1:0:1000000");
    expect(raw[1].entryId).toBe(raw[0].entryId);

    const { entries, matched } = j.query({ from: 0, to: now + 1 });
    expect(matched).toBe(1);
    const e = entries[0]!;
    expect(e).toMatchObject({
      taskId: "t1", queue: "build", stepIndex: 0, stepId: "review", attempt: 2, agentId: "a1",
      model: "sonnet", account: "main", provider: "claude", team: "core",
      outcome: "passed", reason: "gate green", durationMs: 5_000, open: false, source: "live",
    });
  });

  it("the entryId survives a millisecond tick between startStep and open (startedAt comes from stepHistory)", () => {
    let now = 5_000;
    const { j } = make({ now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    now += 1;                                  // the tick that used to orphan the open row
    j.open(t, 0, "s", "a1");
    now += 1;
    j.close(t, "failed");
    expect(j.query({ from: 0, to: now + 1 }).entries[0]).toMatchObject({ entryId: "t1:0:5000", open: false, outcome: "failed" });
  });

  it("derives the attempt's cost/token delta by subtracting the two cumulative snapshots", () => {
    let now = 1_000;
    let current = snap({ costUsd: 1.5, usage: usage(100, 20, 5, 1) });
    const { j } = make({ now: () => now, agent: () => current });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    current = snap({ costUsd: 4.0, usage: usage(400, 70, 15, 1) });
    now += 10;
    j.close(t, "passed");

    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e.costUsd).toBeCloseTo(2.5, 10);
    expect(e.usage).toEqual(usage(300, 50, 10, 0));
  });

  it("clamps a negative delta to zero when the record's counters restarted between open and close", () => {
    let now = 1_000;
    let current = snap({ costUsd: 9, usage: usage(900, 90) });
    const { j } = make({ now: () => now, agent: () => current });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    current = snap({ costUsd: 1, usage: usage(10, 1) });   // respawn: cumulative counters reset
    now += 10;
    j.close(t, "retried");
    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e.costUsd).toBe(0);
    expect(e.usage).toEqual(usage(0, 0, 0, 0));
  });

  it("leaves the delta null when a snapshot is missing (agent gone / backfilled row)", () => {
    let now = 1_000;
    const { j } = make({ now: () => now, agent: () => null });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now += 10;
    j.close(t, "passed");
    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e.costUsd).toBeNull();
    expect(e.usage).toBeNull();
  });

  it("stores only a truncated one-way digest of the step input — no prompt text ever reaches the file", () => {
    let now = 1_000;
    const digest = stepInputDigest("sonnet", "SECRET_INSTRUCTIONS", "SECRET_PROMPT");
    const { j, dir } = make({ now: () => now, agent: () => snap({ inputDigest: digest }) });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");

    expect(digest).toMatch(/^sha256:[0-9a-f]{32}$/);
    const bytes = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(bytes).not.toContain("SECRET_PROMPT");
    expect(bytes).not.toContain("SECRET_INSTRUCTIONS");
    expect(bytes).toContain(digest);
    // Same input ⇒ same digest; a different input ⇒ a different one. That is the whole contract.
    expect(stepInputDigest("sonnet", "SECRET_INSTRUCTIONS", "SECRET_PROMPT")).toBe(digest);
    expect(stepInputDigest("sonnet", "SECRET_INSTRUCTIONS", "other")).not.toBe(digest);
  });

  it("keeps an entry open when the close row never arrives — the crash-mid-step diagnostic", () => {
    const now = 1_000;
    const { j } = make({ now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e).toMatchObject({ open: true, endedAt: null, durationMs: null, outcome: null });
    expect(j.query({ from: 0, to: now + 1, outcome: "open" }).matched).toBe(1);
    expect(j.query({ from: 0, to: now + 1, outcome: "passed" }).matched).toBe(0);
  });

  it("writes nothing for a close with no still-open stepHistory entry", () => {
    const now = 1_000;
    const { j, dir } = make({ now: () => now });
    const t = task("t1");
    j.close(t, "passed");
    expect(existsSync(join(dir, "journal.jsonl"))).toBe(false);
  });

  it("truncates reason to 500 chars", () => {
    let now = 1_000;
    const { j } = make({ now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now += 1;
    j.close(t, "failed", "x".repeat(2_000));
    expect(j.query({ from: 0, to: now + 1 }).entries[0]!.reason).toHaveLength(500);
  });
});

describe("StepJournal: query filtering and paging", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function seeded(count: number) {
    const h = home(); dirs.push(h);
    let now = 1_000_000;
    const j = new StepJournal(h, { resolveAgent: (id) => snap({ team: id === "a1" ? "core" : "ui" }), now: () => now });
    for (let i = 0; i < count; i++) {
      const t = task(`t${i}`, { queue: i % 2 === 0 ? "build" : "review" });
      startStep(t, 0, `s${i}`, i % 2 === 0 ? "a1" : "a2", now);
      j.open(t, 0, `s${i}`, i % 2 === 0 ? "a1" : "a2");
      now += 1;
      j.close(t, i % 2 === 0 ? "passed" : "failed");
      now += 1_000;
    }
    return { j, end: now };
  }

  it("filters by taskId, queue, agentId, team, stepId and outcome", () => {
    const { j, end } = seeded(6);
    const win = { from: 0, to: end };
    expect(j.query({ ...win, taskId: "t3" }).matched).toBe(1);
    expect(j.query({ ...win, queue: "build" }).matched).toBe(3);
    expect(j.query({ ...win, agentId: "a2" }).matched).toBe(3);
    expect(j.query({ ...win, team: "core" }).matched).toBe(3);
    expect(j.query({ ...win, stepId: "s5" }).matched).toBe(1);
    expect(j.query({ ...win, outcome: "failed" }).matched).toBe(3);
  });

  it("filters by the from/to window on startedAt, half-open at `to`", () => {
    const { j, end } = seeded(3);
    expect(j.query({ from: 0, to: end }).matched).toBe(3);
    expect(j.query({ from: 1_000_000, to: 1_000_001 }).matched).toBe(1);      // only the first
    expect(j.query({ from: 1_000_001, to: end }).matched).toBe(2);            // `from` inclusive
    expect(j.query({ from: 0, to: 1_000_000 }).matched).toBe(0);              // `to` exclusive
  });

  it("pages newest-first with nextCursor, reporting the full matched count each time", () => {
    const { j, end } = seeded(5);
    const p1 = j.query({ from: 0, to: end, limit: 2 });
    expect(p1.matched).toBe(5);
    expect(p1.entries.map((e) => e.taskId)).toEqual(["t4", "t3"]);
    const p2 = j.query({ from: 0, to: end, limit: 2, cursor: p1.nextCursor });
    expect(p2.entries.map((e) => e.taskId)).toEqual(["t2", "t1"]);
    const p3 = j.query({ from: 0, to: end, limit: 2, cursor: p2.nextCursor });
    expect(p3.entries.map((e) => e.taskId)).toEqual(["t0"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("restarts at the top for an unknown cursor rather than reporting no results", () => {
    const { j, end } = seeded(3);
    const r = j.query({ from: 0, to: end, cursor: "aged:out:0" });
    expect(r.entries).toHaveLength(3);
  });

  it("clamps limit into [1, 500]", () => {
    const { j, end } = seeded(3);
    expect(j.query({ from: 0, to: end, limit: 0 }).entries).toHaveLength(1);
    expect(j.query({ from: 0, to: end, limit: 10_000 }).entries).toHaveLength(3);
  });
});

describe("StepJournal: rotation, retention and torn files", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const JAN = new Date(2026, 0, 15, 12).getTime();
  const FEB = new Date(2026, 1, 15, 12).getTime();

  it("seals the active file into journal.<YYYY-MM>.jsonl when the month turns, and still folds a pair that straddles it", () => {
    const h = home(); dirs.push(h);
    let now = JAN;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now = FEB;                                   // daemon ran across the month boundary
    j.close(t, "passed");

    const names = readdirSync(join(h, "journal")).sort();
    expect(names).toEqual(["journal.2026-01.jsonl", "journal.jsonl"]);
    // The open row is in the sealed segment, the close row in the new active one — query reads
    // every segment, so the pair is reunited rather than surfacing as a phantom open entry.
    const e = j.query({ from: 0, to: FEB + 1 }).entries[0]!;
    expect(e.open).toBe(false);
    expect(e.durationMs).toBe(FEB - JAN);
  });

  it("derives the active month from the file's own first row, so a boot after downtime still rotates", () => {
    const h = home(); dirs.push(h); mkdirSync(join(h, "journal"), { recursive: true });
    writeFileSync(join(h, "journal", "journal.jsonl"), `${JSON.stringify({
      entryId: "old:0:1", ts: JAN, phase: "open", source: "live", taskId: "old", queue: "q", stepIndex: 0,
      stepId: "s", attempt: 0, agentId: null, model: null, account: null, provider: null, team: null,
      inputDigest: null, startedAt: JAN, endedAt: null, outcome: null, reason: null,
      costUsdCumulative: null, usageCumulative: null,
    })}\n`);
    let now = FEB;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    expect(readdirSync(join(h, "journal")).sort()).toEqual(["journal.2026-01.jsonl", "journal.jsonl"]);
  });

  it("drops sealed segments past the retention window at rotation but never the active one", () => {
    const h = home(); dirs.push(h); mkdirSync(join(h, "journal"), { recursive: true });
    const jdir = join(h, "journal");
    writeFileSync(join(jdir, "journal.2025-10.jsonl"), "x\n");   // 4 months back — past a 2-month window
    writeFileSync(join(jdir, "journal.2025-12.jsonl"), "x\n");   // 2 months back — kept
    let now = JAN;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now, retainMonths: 2 });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now = FEB;
    j.open(t, 0, "s", "a1");                     // triggers rotation ⇒ retention

    const names = readdirSync(jdir).sort();
    expect(names).toContain("journal.jsonl");            // the active segment is never a candidate
    expect(names).toContain("journal.2026-01.jsonl");    // just sealed
    expect(names).toContain("journal.2025-12.jsonl");
    expect(names).not.toContain("journal.2025-10.jsonl");
  });

  it("evicts oldest-first once the sealed segments exceed the byte cap", () => {
    const h = home(); dirs.push(h); mkdirSync(join(h, "journal"), { recursive: true });
    const jdir = join(h, "journal");
    writeFileSync(join(jdir, "journal.2025-11.jsonl"), "x".repeat(1_000));
    writeFileSync(join(jdir, "journal.2025-12.jsonl"), "x".repeat(1_000));
    let now = JAN;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now, maxTotalBytes: 2_000 });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now = FEB;
    j.open(t, 0, "s", "a1");                     // rotation ⇒ retention

    const names = readdirSync(jdir).sort();
    expect(names).not.toContain("journal.2025-11.jsonl");   // oldest goes first
    expect(names).toContain("journal.2025-12.jsonl");
  });

  it("skips a torn last line instead of losing the whole segment", () => {
    let now = 1_000;
    const h = home(); dirs.push(h);
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    now += 1;
    j.close(t, "passed");
    const file = join(h, "journal", "journal.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"entryId":"torn","ts":1`);   // half-written row
    expect(j.query({ from: 0, to: now + 1 }).matched).toBe(1);
  });

  it("swallows an append failure — a journal write can never break the queue mutation that triggered it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = home(); dirs.push(h);
    const now = 1_000;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    rmSync(join(h, "journal"), { recursive: true, force: true });
    writeFileSync(join(h, "journal"), "not a directory");   // any append now fails with ENOTDIR
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    expect(() => j.open(t, 0, "s", "a1")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // F11.QA item 1: readRows() used to scan and zod-parse EVERY segment on every query, up to the
  // full 256MB retention cap, synchronously on the daemon RPC thread. Covered by the isolated
  // "F11.QA item 1" spec in step-journal-segment-scan.test.ts — it needs its own vi.mock("node:fs")
  // module graph (see that file's header comment for why it can't share this one).

  // F11.QA item 3: a clock stepping BACKWARDS across a month boundary (NTP correction, restored
  // store) can revisit a month that already has a sealed segment. rotateIfNeeded() used to
  // renameSync straight onto that path, silently clobbering the earlier rows. Oscillating
  // Jan → Feb → Jan → Feb forces a second seal of January onto a `journal.2026-01.jsonl` that
  // already holds the first January row — exactly the collision a plain rename would destroy.
  it("F11.QA item 3: rotating back into an already-sealed month appends instead of clobbering it", () => {
    const h = home(); dirs.push(h);
    let now = JAN;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });

    const t1 = task("t1");
    startStep(t1, 0, "s", "a1", now);
    j.open(t1, 0, "s", "a1");
    j.close(t1, "passed");

    now = FEB;                                    // seals January (t1) into journal.2026-01.jsonl
    const t2 = task("t2");
    startStep(t2, 0, "s", "a1", now);
    j.open(t2, 0, "s", "a1");
    j.close(t2, "passed");

    now = JAN;                                    // clock steps BACK — seals February (t2)
    const t3 = task("t3");
    startStep(t3, 0, "s", "a1", now);
    j.open(t3, 0, "s", "a1");
    j.close(t3, "passed");

    now = FEB;                                    // forward again — must re-seal the January
    const t4 = task("t4");                        // live file (t3) into the ALREADY-EXISTING
    startStep(t4, 0, "s", "a1", now);              // journal.2026-01.jsonl (t1)
    j.open(t4, 0, "s", "a1");
    j.close(t4, "passed");

    const taskIds = j.query({ from: 0, to: now + 1 }).entries.map((e) => e.taskId).sort();
    expect(taskIds).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("StepJournal.backfillOnce", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("seeds from stepHistory once and is a no-op on every later boot", () => {
    const h = home(); dirs.push(h);
    const now = 2_000_000;
    const tasks = [task("t1", {
      stepHistory: [
        { stepIndex: 0, stepId: "plan", agentId: "a1", startedAt: now - 1_000, endedAt: now - 500, outcome: "passed" },
        { stepIndex: 1, stepId: "build", agentId: "a2", startedAt: now - 100, endedAt: null, outcome: null },
      ],
    })];
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    expect(j.backfillOnce(tasks)).toBe(3);      // closed step ⇒ 2 rows, still-open step ⇒ 1

    const { entries, matched } = j.query({ from: 0, to: now + 1 });
    expect(matched).toBe(2);
    expect(entries.map((e) => e.stepId)).toEqual(["build", "plan"]);
    expect(entries[0]).toMatchObject({ source: "backfill", open: true, attempt: 0, model: null, costUsd: null });
    // A folded entry must satisfy its own schema — an open-only group whose identity fields are
    // already null is exactly the case that used to fold to `undefined` and fail here.
    for (const e of entries) expect(() => StepJournalEntrySchema.parse(e)).not.toThrow();
    expect(entries[1]).toMatchObject({ source: "backfill", open: false, outcome: "passed", durationMs: 500 });

    // Second boot: a segment already exists, so nothing is written twice.
    const j2 = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    expect(j2.backfillOnce(tasks)).toBe(0);
    expect(j2.query({ from: 0, to: now + 1 }).matched).toBe(2);
  });

  it("does not backfill over a journal that already has live rows", () => {
    const h = home(); dirs.push(h);
    const now = 2_000_000;
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    expect(j.backfillOnce([task("t9", { stepHistory: [{ stepIndex: 0, stepId: "old", agentId: null, startedAt: now - 5, endedAt: now - 4, outcome: "failed" }] })])).toBe(0);
    expect(j.query({ from: 0, to: now + 1 }).matched).toBe(1);
  });

  it("stamps backfilled rows with the append time, so the next boot does not seal them away", () => {
    const h = home(); dirs.push(h);
    const now = new Date(2026, 1, 15, 12).getTime();
    const old = new Date(2025, 0, 10, 12).getTime();          // 13 months back — past the retention cutoff
    const j = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    expect(j.backfillOnce([task("t1", {
      stepHistory: [{ stepIndex: 0, stepId: "plan", agentId: "a1", startedAt: old, endedAt: old + 500, outcome: "passed" }],
    })])).toBe(2);

    // Next boot derives the active month from the first row's ts. With a historic ts that month is
    // 2025-01, so the first live append would seal (and then retention-delete) the whole segment.
    const j2 = new StepJournal(h, { resolveAgent: () => snap(), now: () => now });
    const live = task("t2");
    startStep(live, 0, "s", "a1", now);
    j2.open(live, 0, "s", "a1");

    expect(readdirSync(join(h, "journal"))).toEqual(["journal.jsonl"]);
    expect(j2.query({ from: 0, to: now + 1 }).matched).toBe(2);
  });
});

// F11.QA: the two rows of a pair are snapshotted at very different moments, and the OPEN one is
// taken before the agent has settled. Which row a folded field comes from is therefore a
// correctness question, not a tie-break.
describe("StepJournal: which row a folded identity field comes from", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function journal(resolve: () => StepAgentSnapshot | null, now: () => number) {
    const h = home(); dirs.push(h);
    return new StepJournal(h, { resolveAgent: resolve, now });
  }

  it("reports the settled close-time model/account/provider, not the pre-flight guess taken at startStep", () => {
    // QueueStore.startStep fires the instant the agent is spawned (scheduler.ts:828) — BEFORE the
    // backend's first event tells the supervisor which model it actually bound
    // (supervisor.ts:1922), and before any rate-limit failover can move it to another account.
    // Only the close-row snapshot can satisfy plan A2 ("actualModel ?? spec.model").
    let now = 1_000_000;
    let settled = false;
    const j = journal(
      () => (settled
        ? snap({ model: "claude-sonnet-5-20260101", account: "acct-b", provider: "codex", costUsd: 3, usage: usage(300, 30) })
        : snap({ model: "sonnet", account: "acct-a", provider: "claude", costUsd: 0, usage: usage(0, 0) })),
      () => now,
    );
    const t = task("t1");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    settled = true;
    now = 1_000_500;
    j.close(t, "passed");

    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e.model).toBe("claude-sonnet-5-20260101");
    expect(e.account).toBe("acct-b");      // the account the step's cost was actually billed to
    expect(e.provider).toBe("codex");
    expect(e.costUsd).toBe(3);
  });

  it("falls back to the open row when the agent is already gone at close time", () => {
    // The counterpart risk of preferring the close row: scheduler.ts:1230 closes a step whose
    // agent may have already exited, so resolveAgent returns null and the close row's identity
    // fields are null. Those nulls must not erase what open recorded.
    let now = 2_000_000;
    let alive = true;
    const j = journal(() => (alive ? snap({ model: "opus", account: "acct-a" }) : null), () => now);
    const t = task("t2");
    startStep(t, 0, "s", "a1", now);
    j.open(t, 0, "s", "a1");
    alive = false;
    now = 2_000_400;
    j.close(t, "failed", "gate rejected");

    const e = j.query({ from: 0, to: now + 1 }).entries[0]!;
    expect(e.model).toBe("opus");
    expect(e.account).toBe("acct-a");
    expect(e.outcome).toBe("failed");
  });
});

// F11.QA: the default window is 7 days but retention is 12 months, so an unwindowed lookup of an
// older task is indistinguishable from "that task never ran". The tool descriptions in all three
// agent/operator-facing surfaces now warn about this — these tests are what pins the behaviour
// those descriptions promise.
describe("StepJournal.query: the undated default window", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("hides an entry older than 7 days from a query that passes no from, and returns it once from is given", () => {
    const MAR20 = Date.UTC(2026, 2, 20, 12);
    const MAR12 = Date.UTC(2026, 2, 12, 12); // 8 days earlier — same month, so no rotation in play
    let now = MAR12;
    const h = home(); dirs.push(h);
    const j = new StepJournal(h, { resolveAgent: () => snap({}), now: () => now });

    const old = task("old");
    startStep(old, 0, "s", "a1", now);
    j.open(old, 0, "s", "a1");
    j.close(old, "passed");

    now = MAR20;
    const recent = task("recent");
    startStep(recent, 0, "s", "a2", now);
    j.open(recent, 0, "s", "a2");
    j.close(recent, "passed");

    // `to` defaults to now() and the upper bound is EXCLUSIVE, so a frozen clock would filter out
    // the very entry it just wrote; advance it the way real wall-clock time would.
    now = MAR20 + 1_000;

    // Both rows are on disk and well inside the 12-month retention window...
    expect(j.query({ from: 0, to: now + 1 }).entries.map((e) => e.taskId).sort()).toEqual(["old", "recent"]);
    // ...but the undated query silently drops the 8-day-old one.
    expect(j.query({}).entries.map((e) => e.taskId)).toEqual(["recent"]);
    // Even when the caller names the task — the empty result reads exactly like "never ran".
    expect(j.query({ taskId: "old" }).entries).toEqual([]);
    expect(j.query({ taskId: "old", from: MAR12 - 1 }).entries.map((e) => e.taskId)).toEqual(["old"]);
  });
});

// F11.QA: plan A16 mandates this guard by name ("source guard: step-journal.ts opens no segment
// for writing except appendFileSync") but it was never written. Append-only is what makes a torn
// tail the WORST case: any rewrite-in-place — a "compaction", an in-place retention trim — turns a
// crash into arbitrary history loss, and the failure would only surface long after the commit that
// introduced it. Guarding the import list catches that at the earliest possible moment.
describe("StepJournal: append-only source guard (A16)", () => {
  it("opens no journal segment for writing except through appendFileSync", () => {
    const src = readFileSync(new URL("../src/step-journal.ts", import.meta.url), "utf8");
    const imported = /import\s*\{([^}]*)\}\s*from\s*"node:fs"/.exec(src)?.[1] ?? "";
    const names = imported.split(",").map((s) => s.trim()).filter(Boolean);
    // rmSync/renameSync are allowed: retention deletes and month sealing act on WHOLE sealed
    // segments, never on the bytes of a live one.
    expect(names.sort()).toEqual(
      ["appendFileSync", "existsSync", "mkdirSync", "readFileSync", "readdirSync", "renameSync", "rmSync", "statSync"].sort(),
    );
    for (const banned of ["writeFileSync", "openSync", "createWriteStream", "truncateSync", "ftruncateSync", "writeSync", "promises"]) {
      expect(src.includes(banned), `${banned} must not appear in step-journal.ts`).toBe(false);
    }
  });
});

// F11.QA item 2: `team` is a real StepJournal.query() filter (folded onto every entry, applied
// server-side) but the RPC-facing JournalQueryRequestSchema and journal_query's MCP inputSchema
// both omitted it, making the filter unreachable from outside the process. This test pins the
// internal filter-key list against the RPC contract's own schema shape so the two can never
// silently drift apart again the way they did here.
describe("StepJournal: RPC field parity (F11.QA item 2)", () => {
  it("STEP_JOURNAL_QUERY_FILTER_KEYS matches journal.query's RPC request schema exactly", () => {
    const rpcKeys = Object.keys(RPC_CONTRACT["journal.query"].request.shape).sort();
    expect(rpcKeys).toEqual([...STEP_JOURNAL_QUERY_FILTER_KEYS].sort());
  });
});
