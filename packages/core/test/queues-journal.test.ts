import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";
import { StepJournal, stepInputDigest, type StepAgentSnapshot } from "@chimera/core/step-journal";

// F11.1: the QueueStore↔StepJournal wiring. The journal itself is unit-tested in
// step-journal.test.ts; what these tests own is the seam — that startStep/closeStep (and
// markDone's close path) write through, that the rows outlive prune() and a restart, and
// that a store built WITHOUT a journal is byte-for-byte the old behaviour.

// The whole time range: query() otherwise defaults to a 7-day window ending at now(), which
// silently excludes anything a test stamps outside it.
const ALL = { from: 0, to: Number.MAX_SAFE_INTEGER };

function rig(opts?: { maxTerminalPerQueue?: number; resolveAgent?: (agentId: string) => StepAgentSnapshot | null }) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-journal-"));
  const events = new EventLog(dir);
  let calls = 0;
  const journal = new StepJournal(dir, {
    resolveAgent: opts?.resolveAgent ?? ((agentId) => {
      // Cumulative counters that grow between open and close — the reader subtracts them.
      calls += 1;
      return {
        model: "claude-opus-5", account: "acc-1", provider: "claude", team: "t1",
        costUsd: calls * 0.25,
        usage: { input: calls * 100, output: calls * 10, cacheRead: 0, cacheCreation: 0 },
        // Must be a real digest: StepJournalRowSchema regex-checks it and a bad row is
        // silently DROPPED (appends never throw), which reads as "the wiring is broken".
        inputDigest: stepInputDigest("claude-opus-5", null, agentId),
      };
    }),
  });
  const q = new QueueStore(dir, events, { journal, maxTerminalPerQueue: opts?.maxTerminalPerQueue });
  return { dir, events, journal, q };
}

describe("QueueStore ↔ StepJournal wiring (F11.1)", () => {
  it("startStep/closeStep write through to an injected journal", () => {
    const { q, journal } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "step it" });
    q.markInProgress(t.taskId, "ag-1");

    const opened = q.startStep(t.taskId, 0, "build", "ag-1");
    const startedAt = opened.stepHistory[0]!.startedAt;
    // Open row only, so far: visible as an in-flight attempt.
    const inflight = journal.query({ ...ALL, taskId: t.taskId });
    expect(inflight.entries).toHaveLength(1);
    expect(inflight.entries[0]).toMatchObject({ open: true, outcome: null, endedAt: null, stepId: "build", agentId: "ag-1" });

    q.closeStep(t.taskId, "passed", "gate ok");
    const closed = journal.query({ ...ALL, taskId: t.taskId });
    expect(closed.entries).toHaveLength(1);
    const e = closed.entries[0]!;
    // The entryId pairs the two rows via the stepHistory entry's OWN startedAt, not a
    // second now() — a mismatch here would orphan every close row from its open row.
    expect(e.entryId).toBe(`${t.taskId}:0:${startedAt}`);
    expect(e).toMatchObject({ open: false, outcome: "passed", reason: "gate ok", queue: "work", model: "claude-opus-5", team: "t1" });
    expect(e.startedAt).toBe(startedAt);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    // Cumulative-not-delta: the stored counters are absolute, the delta is the subtraction.
    expect(e.costUsd).toBeCloseTo(0.25, 10);
    expect(e.usage).toEqual({ input: 100, output: 10, cacheRead: 0, cacheCreation: 0 });
  });

  it("markDone's dangling-step close is journalled too, not left open forever", () => {
    const { q, journal } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "settle race" });
    q.markInProgress(t.taskId, "ag-1");
    q.startStep(t.taskId, 2, "final", "ag-1");
    // No closeStep: markDone closes the dangling entry itself (the settle() race).
    q.markDone(t.taskId, "ok");

    const entries = journal.query({ ...ALL, taskId: t.taskId }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ open: false, outcome: "passed", stepIndex: 2 });
  });

  it("a journal entry outlives MAX_TERMINAL_PER_QUEUE eviction", () => {
    // Cap injected small: eviction is cap-independent, so this proves the same property as
    // the production 200 without the O(n)-prune-per-save cost of pushing 205 tasks.
    const { q, journal } = rig({ maxTerminalPerQueue: 2 });
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "the evicted one" });
    q.markInProgress(t.taskId, "ag-1");
    q.startStep(t.taskId, 0, "build", "ag-1");
    q.closeStep(t.taskId, "passed");
    q.markDone(t.taskId, "ok");

    for (let i = 0; i < 5; i++) {
      const filler = q.push("work", { prompt: `filler ${i}` });
      q.markInProgress(filler.taskId, `ag-f${i}`);
      q.markDone(filler.taskId, "ok");
    }

    expect(q.status("work").tasks.find((s) => s.taskId === t.taskId)).toBeUndefined();
    expect(q.allTasks().find((r) => r.taskId === t.taskId)).toBeUndefined();
    const survived = journal.query({ ...ALL, taskId: t.taskId }).entries;
    expect(survived).toHaveLength(1);
    expect(survived[0]).toMatchObject({ outcome: "passed", stepId: "build", open: false });
  });

  it("entries survive a simulated daemon restart, including a crash-mid-step open entry", () => {
    const { dir, q } = rig();
    q.create({ name: "work", retryLimit: 0 });
    const done = q.push("work", { prompt: "finished" });
    q.markInProgress(done.taskId, "ag-1");
    q.startStep(done.taskId, 0, "build", "ag-1");
    q.closeStep(done.taskId, "failed", "gate said no");

    const crashed = q.push("work", { prompt: "never closed" });
    q.markInProgress(crashed.taskId, "ag-2");
    q.startStep(crashed.taskId, 0, "build", "ag-2");   // daemon dies here

    // A fresh process: new journal instance over the same home, nothing in memory.
    const reopened = new StepJournal(dir, { resolveAgent: () => null });
    expect(reopened.query({ ...ALL, taskId: done.taskId }).entries[0]).toMatchObject({ outcome: "failed", reason: "gate said no", open: false });
    const openOnly = reopened.query({ ...ALL, outcome: "open" }).entries;
    expect(openOnly.map((e) => e.taskId)).toEqual([crashed.taskId]);
    expect(openOnly[0]).toMatchObject({ open: true, outcome: null, endedAt: null, durationMs: null });
  });

  it("a QueueStore constructed without a journal behaves exactly as before", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-q-nojournal-"));
    const q = new QueueStore(dir, new EventLog(dir));
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "unjournalled" });
    q.markInProgress(t.taskId, "ag-1");
    q.startStep(t.taskId, 0, "build", "ag-1");
    const closed = q.closeStep(t.taskId, "passed", "fine");

    expect(closed.stepHistory).toHaveLength(1);
    expect(closed.stepHistory[0]).toMatchObject({ stepIndex: 0, stepId: "build", agentId: "ag-1", outcome: "passed", reason: "fine" });
    expect(closed.stepHistory[0]!.endedAt).not.toBeNull();
    // No journal ⇒ no journal directory is even created.
    expect(existsSync(join(dir, "journal"))).toBe(false);
  });

  it("a throwing resolveAgent never propagates into the queue mutation", () => {
    const { q, journal } = rig({ resolveAgent: () => { throw new Error("supervisor exploded"); } });
    q.create({ name: "work", retryLimit: 0 });
    const t = q.push("work", { prompt: "hostile attribution" });
    q.markInProgress(t.taskId, "ag-1");
    expect(() => q.startStep(t.taskId, 0, "build", "ag-1")).not.toThrow();
    expect(() => q.closeStep(t.taskId, "retried")).not.toThrow();

    const e = journal.query({ ...ALL, taskId: t.taskId }).entries[0]!;
    expect(e).toMatchObject({ outcome: "retried", model: null, account: null, costUsd: null });
  });

  it("backfillOnce seeds from allTasks() and a second boot writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-q-backfill-"));
    mkdirSync(dir, { recursive: true });
    // A queues.json as it exists on the boot BEFORE the journal was introduced.
    writeFileSync(join(dir, "queues.json"), JSON.stringify({
      queues: [{ name: "work", retryLimit: 1 }],
      tasks: [
        { taskId: "t-1", queue: "work", prompt: "old", createdAt: 1, state: "done",
          stepHistory: [{ stepIndex: 0, stepId: "build", agentId: "ag-old", startedAt: 1000, endedAt: 2000, outcome: "passed" }] },
        { taskId: "t-2", queue: "work", prompt: "older", createdAt: 1, state: "failed",
          stepHistory: [{ stepIndex: 0, stepId: "test", agentId: null, startedAt: 3000, endedAt: null, outcome: null }] },
      ],
    }));
    const q = new QueueStore(dir, new EventLog(dir));
    expect(q.allTasks().map((t) => t.taskId).sort()).toEqual(["t-1", "t-2"]);

    const journal = new StepJournal(dir, { resolveAgent: () => null });
    expect(journal.backfillOnce(q.allTasks())).toBe(3);   // t-1 open+close, t-2 open only
    const rowsAfterFirst = readFileSync(join(dir, "journal", "journal.jsonl"), "utf8");

    // Second boot: the guard is "does any segment exist", re-checked at call time.
    const second = new StepJournal(dir, { resolveAgent: () => null });
    expect(second.backfillOnce(q.allTasks())).toBe(0);
    expect(readFileSync(join(dir, "journal", "journal.jsonl"), "utf8")).toBe(rowsAfterFirst);

    const entries = second.query({ ...ALL }).entries;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.taskId === "t-1")).toMatchObject({ source: "backfill", outcome: "passed", open: false, attempt: 0 });
    expect(entries.find((e) => e.taskId === "t-2")).toMatchObject({ source: "backfill", outcome: null, open: true });
  });
});
