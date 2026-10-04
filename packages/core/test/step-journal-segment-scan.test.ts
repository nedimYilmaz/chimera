import { describe, it, expect, vi, afterEach } from "vitest";

// Isolated in its own file so the vi.mock("node:fs") only affects this module graph — mixing it
// into the large shared step-journal.test.ts (10+ describe blocks relying on real fs behavior)
// would be too invasive. vi.spyOn(fs, "readFileSync") does NOT work here: it throws "Cannot spy
// on export... Module namespace is not configurable in ESM", so the read paths are captured by
// wrapping the export inside the mock factory instead.
const readPaths: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      readPaths.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { StepJournal } = await import("@chimera/core/step-journal");

type Step = {
  stepIndex: number;
  stepId: string;
  agentId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: "passed" | "failed" | "retried" | null;
  reason?: string;
};

function home(): string {
  return mkdtempSync(join(tmpdir(), "chimera-step-journal-scan-"));
}

function task(taskId: string): any {
  return { taskId, queue: "q", stepAttempts: 0, stepHistory: [] };
}

function startStep(t: any, stepIndex: number, stepId: string, agentId: string | null, at: number): void {
  (t.stepHistory as Step[]).push({ stepIndex, stepId, agentId, startedAt: at, endedAt: null, outcome: null });
}

const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({ input, output, cacheRead, cacheCreation });

function snap(over: Record<string, unknown> = {}) {
  return { model: "sonnet", account: "main", provider: "claude", team: "core", costUsd: 0, usage: usage(0, 0), inputDigest: null, ...over };
}

describe("StepJournal: segment scan bound to the queried month range (F11.QA item 1)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); readPaths.length = 0; });

  const JAN = new Date(2026, 0, 15, 12).getTime();
  const FEB = new Date(2026, 1, 15, 12).getTime();
  const MAR = new Date(2026, 2, 15, 12).getTime();

  it("a query scoped to a later month never reads an out-of-range earlier segment", () => {
    const h = home(); dirs.push(h);
    let now = JAN;
    const j = new StepJournal(h, { resolveAgent: () => snap() as any, now: () => now });

    const t1 = task("t1");
    startStep(t1, 0, "s", "a1", now);
    j.open(t1, 0, "s", "a1");
    j.close(t1, "passed");

    now = FEB;                                    // seals January
    const t2 = task("t2");
    startStep(t2, 0, "s", "a1", now);
    j.open(t2, 0, "s", "a1");
    j.close(t2, "passed");

    now = MAR;                                    // seals February
    const t3 = task("t3");
    startStep(t3, 0, "s", "a1", now);
    j.open(t3, 0, "s", "a1");
    j.close(t3, "passed");

    const januaryPath = join(h, "journal", "journal.2026-01.jsonl");
    readPaths.length = 0;
    const result = j.query({ from: MAR, to: MAR + 1 });
    expect(result.matched).toBe(1);
    expect(result.entries[0]!.taskId).toBe("t3");
    expect(readPaths).not.toContain(januaryPath);
  });
});
