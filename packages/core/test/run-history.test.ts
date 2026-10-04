import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaskRecordSchema, JobRecordSchema, RunHistoryRowSchema, type TaskRecord, type JobRecord, type SliRollupResult } from "@chimera/protocol";
import { RunHistoryStore, RUN_HISTORY_JOURNAL_SCAN_MAX, type RunHistoryDeps } from "@chimera/core/run-history";
import type { AgentRecord } from "@chimera/core/supervisor";
import type { StepJournalEntry, StepJournalQueryResult } from "@chimera/core/step-journal";

// F13.0: RunHistoryStore is a READ-ONLY join over agents/tasks/jobs/the F11 journal/the F12
// rollup. These tests exercise the join logic against fake deps — no real supervisor/queue/job
// store is spun up, since the store only ever calls the four narrow RunHistoryDeps methods.

const NOW = 1_000_000_000_000;

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "agent-1", accountName: "main", provider: "claude", state: "running",
    depth: 0, treeId: "agent-1", createdAt: NOW, principal: "local", attempts: [],
    costUsd: 0, parentId: null, projectId: null,
    spec: {
      prompt: "brief", cwd: "/tmp/x", isolation: "worktree",
      account: "main", model: "claude-sonnet-5", permissionProfile: "acceptEdits",
      autonomy: "ask", acknowledgeCodexFullAccessRisk: false, maxTurns: 40,
      turnLimitPolicy: "fail", inherit: { settingSources: [] }, mcpServers: {},
      plugins: [], orchestration: { allow: false, maxDepth: 2 }, crossProviderFailover: false,
      deliverTo: null, maxBudgetUsd: null, conductor: false, session: false, persistent: false,
      on: { permissionRequest: "auto" }, providerOptions: {}, resume: null, resumeOnly: false,
      cause: null,
    } as unknown as AgentRecord["spec"],
    ...overrides,
  } as AgentRecord;
}

function makeTask(overrides: Partial<TaskRecord> & { taskId: string } = { taskId: "t-1" }): TaskRecord {
  return TaskRecordSchema.parse({
    queue: "work", prompt: "do the thing", createdAt: NOW,
    ...overrides,
  }) as TaskRecord;
}

function makeJob(overrides: Partial<JobRecord> & { name: string } = { name: "job-1" }): JobRecord {
  return JobRecordSchema.parse({
    schedule: { cron: "0 * * * *" }, target: { team: "eng" }, createdAt: NOW, lastRuns: [],
    ...overrides,
  }) as JobRecord;
}

const EMPTY_ROLLUP: SliRollupResult = {
  tasks: [], buckets: [], breakdown: [],
  totals: { tasks: 0, completed: 0, failed: 0, avgDurationMs: null, p50DurationMs: null, p95DurationMs: null, totalCostUsd: 0 },
  coverage: { replayed: false, events: 0, spans: 0, fromSeq: null, fromTs: null, truncated: false },
} as unknown as SliRollupResult;

function makeDeps(overrides: Partial<RunHistoryDeps> = {}): RunHistoryDeps {
  return {
    supervisor: { list: () => [] },
    queues: { allTasks: () => [] },
    jobs: { list: () => [] },
    journal: { query: (): StepJournalQueryResult => ({ entries: [], nextCursor: null, matched: 0 }) },
    rollup: () => EMPTY_ROLLUP,
    now: () => NOW,
    ...overrides,
  };
}

describe("RunHistoryStore — source guards", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/run-history.ts", import.meta.url)), "utf8");

  it("never writes to disk — no fs write API, no save()/append() call", () => {
    expect(source).not.toMatch(/from ["']node:fs["']/);
    expect(source).not.toMatch(/\bwriteFileSync\b|\bappendFileSync\b/);
    expect(source).not.toMatch(/\.save\s*\(|\.append\s*\(/);
  });

  it("imports isAgentUnseen from @chimera/protocol rather than reimplementing it", () => {
    expect(source).toMatch(/isAgentUnseen/);
    expect(source).toMatch(/import\s*\{[^}]*isAgentUnseen[^}]*\}\s*from\s*["']@chimera\/protocol["']/);
    expect(source).not.toMatch(/function\s+isAgentUnseen/);
  });
});

describe("RunHistoryStore — cost-triple-counting invariant", () => {
  it("a job -> task -> agent chain totals exactly once (booked agent cost only)", () => {
    const agent = makeAgent({ agentId: "a-1", jobName: "job-1", costUsd: 2.5, state: "done", createdAt: NOW - 1000 });
    const task = makeTask({ taskId: "t-1", agentId: "a-1", state: "done", createdAt: NOW - 2000, startedAt: NOW - 1500, endedAt: NOW - 500 });
    const job = makeJob({
      name: "job-1",
      lastRuns: [{ ts: NOW - 2000, trigger: "scheduled", result: "ok", agentId: "a-1", taskId: "t-1", costUsd: 2.5 }],
    });
    const store = new RunHistoryStore(makeDeps({
      supervisor: { list: () => [agent] },
      queues: { allTasks: () => [task] },
      jobs: { list: () => [job] },
    }));
    const res = store.runs({});
    expect(res.rows).toHaveLength(3);
    const basisByKind = new Map(res.rows.map((r) => [r.kind, r.costBasis]));
    expect(basisByKind.get("agent")).toBe("booked");
    expect(basisByKind.get("task")).toBe("rolled-up");
    expect(basisByKind.get("job")).toBe("rolled-up");
    // the SAME $2.50 shows up on all three rows for display, but totals must count it once.
    expect(res.totals.costUsd).toBeCloseTo(2.5);
    expect(res.totals.runs).toBe(3);
  });

  it("softening costBasis (summing every row) would triple the total — proves the guard is load-bearing", () => {
    const agent = makeAgent({ agentId: "a-1", jobName: "job-1", costUsd: 1, state: "done", createdAt: NOW - 1000 });
    const task = makeTask({ taskId: "t-1", agentId: "a-1", state: "done", createdAt: NOW - 2000 });
    const job = makeJob({ name: "job-1", lastRuns: [{ ts: NOW - 2000, trigger: "scheduled", result: "ok", agentId: "a-1", taskId: "t-1", costUsd: 1 }] });
    const store = new RunHistoryStore(makeDeps({
      supervisor: { list: () => [agent] },
      queues: { allTasks: () => [task] },
      jobs: { list: () => [job] },
      // the task's rolled-up cost comes from the journal fold, not the job's lastRuns entry —
      // fold in a matching $1 step so the task row displays the same booked dollar too.
      journal: {
        query: (): StepJournalQueryResult => ({
          entries: [{
            entryId: "e-1", source: "live", taskId: "t-1", queue: "work",
            stepIndex: 0, stepId: "s-1", attempt: 0, agentId: "a-1",
            model: "claude-sonnet-5", account: "main", provider: "claude", team: null,
            inputDigest: null, startedAt: NOW - 1500, endedAt: NOW - 1000, durationMs: 500,
            outcome: "passed", reason: null, costUsd: 1, usage: null, open: false,
          }],
          nextCursor: null, matched: 1,
        }),
      },
    }));
    const res = store.runs({});
    const naiveSum = res.rows.reduce((n, r) => n + r.costUsd, 0);
    expect(naiveSum).toBeCloseTo(3); // display-level sum WOULD be 3x if all rows counted
    expect(res.totals.costUsd).toBeCloseTo(1); // the real total must not be
  });
});

describe("RunHistoryStore — outcome normalization", () => {
  it("normalizes every agent state", () => {
    const states = ["done", "failed", "killed", "paused", "running"] as const;
    const expected = ["done", "failed", "killed", "running", "running"];
    const agents = states.map((state, i) => makeAgent({ agentId: `a-${i}`, state, createdAt: NOW - 1000 }));
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => agents } }));
    const res = store.runs({});
    for (let i = 0; i < states.length; i++) {
      const row = res.rows.find((r) => r.agentId === `a-${i}`)!;
      expect(row.outcome).toBe(expected[i]);
    }
  });

  it("normalizes every task state, including dead_letter -> failed and blocked -> running", () => {
    const states = ["pending", "in_progress", "done", "failed", "dead_letter", "blocked"] as const;
    const expected = ["pending", "running", "done", "failed", "failed", "running"];
    const tasks = states.map((state, i) => makeTask({ taskId: `t-${i}`, state, createdAt: NOW - 1000 }));
    const store = new RunHistoryStore(makeDeps({ queues: { allTasks: () => tasks } }));
    const res = store.runs({});
    for (let i = 0; i < states.length; i++) {
      const row = res.rows.find((r) => r.taskId === `t-${i}`)!;
      expect(row.outcome).toBe(expected[i]);
    }
  });

  it("normalizes every job run result", () => {
    const job = makeJob({
      name: "job-1",
      lastRuns: [
        { ts: NOW - 3000, trigger: "scheduled", result: "ok", agentId: null, taskId: null, attempt: 0 },
        { ts: NOW - 2000, trigger: "scheduled", result: "failed", agentId: null, taskId: null, attempt: 1 },
        { ts: NOW - 1000, trigger: "scheduled", result: "skipped", agentId: null, taskId: null, attempt: 2 },
      ],
    });
    const store = new RunHistoryStore(makeDeps({ jobs: { list: () => [job] } }));
    const res = store.runs({});
    const byAttempt = new Map(res.rows.map((r) => [r.id, r.outcome]));
    expect(byAttempt.get("job:job-1:999999997000:0")).toBe("done");
    expect(byAttempt.get("job:job-1:999999998000:1")).toBe("failed");
    expect(byAttempt.get("job:job-1:999999999000:2")).toBe("skipped");
  });
});

describe("RunHistoryStore — window handling", () => {
  it("defaults to a 24h window ending at now", () => {
    const store = new RunHistoryStore(makeDeps());
    const res = store.runs({});
    expect(res.to).toBe(NOW);
    expect(res.from).toBe(NOW - 24 * 60 * 60 * 1000);
  });

  it("includes rows that OVERLAP the window, not just rows fully contained by it", () => {
    // agent started well before the window and is still running (no endedAt) -> overlaps
    const longRunning = makeAgent({ agentId: "a-long", state: "running", createdAt: NOW - 100_000_000 });
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [longRunning] } }));
    const res = store.runs({ from: NOW - 1000, to: NOW });
    expect(res.rows.some((r) => r.agentId === "a-long")).toBe(true);
  });

  it("excludes rows entirely outside the window", () => {
    const old = makeAgent({ agentId: "a-old", state: "done", createdAt: NOW - 200_000, attempts: [] });
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [old] }, now: () => NOW }));
    const res = store.runs({ from: NOW - 1000, to: NOW });
    expect(res.rows.some((r) => r.agentId === "a-old")).toBe(false);
  });

  it("an empty window (no matching rows) returns zero totals without throwing", () => {
    const agent = makeAgent({ agentId: "a-1", state: "done", createdAt: NOW - 500_000 });
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [agent] } }));
    const res = store.runs({ from: NOW - 100, to: NOW });
    expect(res.rows).toHaveLength(0);
    expect(res.matched).toBe(0);
    expect(res.totals).toEqual({ runs: 0, costUsd: 0, failed: 0, unseen: 0 });
  });
});

describe("RunHistoryStore — journal fold and coverage", () => {
  function journalEntry(overrides: Partial<StepJournalEntry> = {}): StepJournalEntry {
    return {
      entryId: "e-1", source: "live", taskId: "t-1", queue: "work",
      stepIndex: 0, stepId: "s-1", attempt: 0, agentId: "a-1",
      model: "claude-sonnet-5", account: "main", provider: "claude", team: null,
      inputDigest: null, startedAt: NOW - 1000, endedAt: NOW - 500, durationMs: 500,
      outcome: "passed", reason: null, costUsd: 0.5, usage: null, open: false,
      ...overrides,
    };
  }

  it("folds journal entries once per query and rolls the cost/model/step data into the task row", () => {
    const task = makeTask({ taskId: "t-1", createdAt: NOW - 2000 });
    let queryCalls = 0;
    const store = new RunHistoryStore(makeDeps({
      queues: { allTasks: () => [task] },
      journal: {
        query: (): StepJournalQueryResult => {
          queryCalls++;
          return { entries: [journalEntry(), journalEntry({ entryId: "e-2", outcome: "failed", costUsd: 0.25 })], nextCursor: null, matched: 2 };
        },
      },
    }));
    const res = store.runs({});
    expect(queryCalls).toBe(1); // ONE scan per query, not one per row
    const row = res.rows.find((r) => r.taskId === "t-1")!;
    expect(row.costUsd).toBeCloseTo(0.75);
    expect(row.steps).toBe(2);
    expect(row.stepFailures).toBe(1);
    expect(row.model).toBe("claude-sonnet-5");
    expect(res.coverage.journalEntries).toBe(2);
    expect(res.coverage.journalTruncated).toBe(false);
  });

  it("caps the journal scan at RUN_HISTORY_JOURNAL_SCAN_MAX and reports truncated", () => {
    const task = makeTask({ taskId: "t-1", createdAt: NOW - 2000 });
    const entries = Array.from({ length: RUN_HISTORY_JOURNAL_SCAN_MAX + 50 }, (_, i) => journalEntry({ entryId: `e-${i}` }));
    const store = new RunHistoryStore(makeDeps({
      queues: { allTasks: () => [task] },
      journal: { query: (): StepJournalQueryResult => ({ entries, nextCursor: null, matched: entries.length }) },
    }));
    const res = store.runs({});
    expect(res.coverage.journalEntries).toBe(RUN_HISTORY_JOURNAL_SCAN_MAX);
    expect(res.coverage.journalTruncated).toBe(true);
  });

  it("tasks with no journal fold get null model/steps/stepFailures and zero rolled-up cost", () => {
    const task = makeTask({ taskId: "t-nofold", createdAt: NOW - 2000 });
    const store = new RunHistoryStore(makeDeps({ queues: { allTasks: () => [task] } }));
    const res = store.runs({});
    const row = res.rows.find((r) => r.taskId === "t-nofold")!;
    expect(row.model).toBeNull();
    expect(row.steps).toBeNull();
    expect(row.stepFailures).toBeNull();
    expect(row.costUsd).toBe(0);
  });

  it("reports span-rollup coverage from the F12 rollup, called once", () => {
    let rollupCalls = 0;
    const store = new RunHistoryStore(makeDeps({
      rollup: () => {
        rollupCalls++;
        return { ...EMPTY_ROLLUP, coverage: { replayed: true, events: 10, spans: 3, fromSeq: 1, fromTs: NOW - 1000, truncated: true } } as SliRollupResult;
      },
    }));
    const res = store.runs({});
    expect(rollupCalls).toBe(1);
    expect(res.coverage.spanRollupReplayed).toBe(true);
    expect(res.coverage.spanRollupTruncated).toBe(true);
  });
});

describe("RunHistoryStore — model resolution never emits the literal \"default\"", () => {
  // The old version of this test set spec.model to `undefined` and asserted `not.toBe("default")`,
  // which passes no matter what the code does. A9 is about a spec that literally SAYS "default"
  // (the placeholder meaning "let the provider choose") — that is the case worth pinning.
  const withModel = (model: string | undefined, actualModel?: string): AgentRecord =>
    makeAgent({ agentId: "a-1", state: "done", createdAt: NOW - 1000, actualModel,
      spec: { ...makeAgent().spec, model } as unknown as AgentRecord["spec"] });

  const modelOf = (agent: AgentRecord): string | null => {
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [agent] } }));
    return store.runs({}).rows.find((r) => r.agentId === "a-1")!.model;
  };

  it("resolves a real spec.model verbatim", () => {
    expect(modelOf(withModel("claude-sonnet-5"))).toBe("claude-sonnet-5");
  });

  it("treats spec.model === \"default\" as ABSENT and falls through to the provider default", () => {
    expect(modelOf(withModel("default"))).not.toBe("default");
  });

  it("treats actualModel === \"default\" as absent too", () => {
    expect(modelOf(withModel(undefined, "default"))).not.toBe("default");
  });

  it("prefers actualModel over spec.model when both are real", () => {
    expect(modelOf(withModel("claude-sonnet-5", "claude-opus-5"))).toBe("claude-opus-5");
  });
});

describe("RunHistoryStore — shadow agents and unseen propagation", () => {
  it("excludes shadow agent records from agent rows entirely", () => {
    const shadow = makeAgent({ agentId: "a-shadow", state: "running", shadow: true, createdAt: NOW - 1000 } as Partial<AgentRecord>);
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [shadow] } }));
    const res = store.runs({});
    expect(res.rows.some((r) => r.agentId === "a-shadow")).toBe(false);
  });

  it("propagates isAgentUnseen to agent rows, but job rows are always unseen:false", () => {
    const unseenAgent = makeAgent({ agentId: "a-unseen", state: "done", createdAt: NOW - 1000, attentionAt: NOW - 100, reviewedAt: NOW - 200 } as Partial<AgentRecord>);
    const job = makeJob({ name: "job-1", lastRuns: [{ ts: NOW - 1000, trigger: "scheduled", result: "ok", agentId: null, taskId: null, attempt: 0 }] });
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [unseenAgent] }, jobs: { list: () => [job] } }));
    const res = store.runs({});
    expect(res.rows.find((r) => r.agentId === "a-unseen")!.unseen).toBe(true);
    expect(res.rows.find((r) => r.kind === "job")!.unseen).toBe(false);
  });
});

describe("RunHistoryStore — filters, sort, pagination", () => {
  function threeAgents() {
    return [
      makeAgent({ agentId: "a-1", state: "done", createdAt: NOW - 3000, membership: { team: "eng" } as unknown as AgentRecord["membership"] }),
      makeAgent({ agentId: "a-2", state: "failed", createdAt: NOW - 2000, membership: { team: "ops" } as unknown as AgentRecord["membership"] }),
      makeAgent({ agentId: "a-3", state: "done", createdAt: NOW - 1000, membership: { team: "eng" } as unknown as AgentRecord["membership"] }),
    ];
  }

  it("ANDs field filters together (kind + outcome + team)", () => {
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => threeAgents() } }));
    const res = store.runs({ kind: "agent", outcome: "done", team: "eng" });
    expect(res.rows.map((r) => r.agentId).sort()).toEqual(["a-1", "a-3"]);
  });

  it("sorts by startedAt DESC with an id tiebreak", () => {
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => threeAgents() } }));
    const res = store.runs({});
    expect(res.rows.map((r) => r.agentId)).toEqual(["a-3", "a-2", "a-1"]);
  });

  it("pages by cursor, reporting matched over the whole filtered set and totals over the whole filtered set", () => {
    const agents = threeAgents().map((a) => ({ ...a, costUsd: 1 }));
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => agents } }));
    const page1 = store.runs({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.matched).toBe(3);
    expect(page1.totals.costUsd).toBeCloseTo(3);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = store.runs({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [F13.QA] regressions found reviewing the landed feature.
// ---------------------------------------------------------------------------
describe("RunHistoryStore — [F13.QA] default limit matches the advertised 100", () => {
  it("returns up to 100 rows when the caller passes no limit", () => {
    const agents = Array.from({ length: 120 }, (_, i) =>
      makeAgent({ agentId: `a-${String(i).padStart(3, "0")}`, state: "done", createdAt: NOW - 1000 - i }));
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => agents } }));
    const res = store.runs({});
    // history_runs' tool description promises "the last 24 hours, 100 rows"; a smaller
    // server-side default silently drops rows an MCP caller believes it asked for.
    expect(res.rows).toHaveLength(100);
    expect(res.matched).toBe(120);
    expect(res.nextCursor).not.toBeNull();
  });
});

describe("RunHistoryStore — [F13.QA] task cost falls back to the F12 span rollup", () => {
  it("uses spans[taskId].costUsd when the journal has no entry for the task", () => {
    const task = makeTask({ taskId: "t-span", state: "done", startedAt: NOW - 5000, endedAt: NOW - 1000 });
    const rollup = { ...EMPTY_ROLLUP, tasks: [{ taskId: "t-span", costUsd: 0.75 }] } as unknown as SliRollupResult;
    const store = new RunHistoryStore(makeDeps({ queues: { allTasks: () => [task] }, rollup: () => rollup }));
    const row = store.runs({}).rows.find((r) => r.id === "task:t-span")!;
    expect(row.costUsd).toBeCloseTo(0.75);
    // Still rolled-up: a span sum restates agent-booked dollars, it does not add new ones.
    expect(row.costBasis).toBe("rolled-up");
    expect(store.runs({}).totals.costUsd).toBeCloseTo(0);
  });

  it("prefers the journal fold over the span rollup when both know the task", () => {
    const task = makeTask({ taskId: "t-both", state: "done", startedAt: NOW - 5000, endedAt: NOW - 1000 });
    const entry = { ts: NOW - 3000, taskId: "t-both", costUsd: 0.25, model: "claude-sonnet-5", kind: "step", ok: true } as unknown as StepJournalEntry;
    const rollup = { ...EMPTY_ROLLUP, tasks: [{ taskId: "t-both", costUsd: 99 }] } as unknown as SliRollupResult;
    const store = new RunHistoryStore(makeDeps({
      queues: { allTasks: () => [task] },
      journal: { query: (): StepJournalQueryResult => ({ entries: [entry], nextCursor: null, matched: 1 }) },
      rollup: () => rollup,
    }));
    expect(store.runs({}).rows.find((r) => r.id === "task:t-both")!.costUsd).toBeCloseTo(0.25);
  });
});

describe("RunHistoryStore — [F13.QA] a stale cursor terminates instead of restarting", () => {
  it("returns an empty terminal page when the cursor row is no longer in the window", () => {
    const agents = [
      makeAgent({ agentId: "a-1", state: "done", createdAt: NOW - 3000 }),
      makeAgent({ agentId: "a-2", state: "done", createdAt: NOW - 2000 }),
    ];
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => agents } }));
    // `to` defaults to now, so an un-pinned window slides between pages and a cursor row can
    // drop out of it. findIndex()+1 === 0 handed back page 1 — an MCP caller paging in a
    // loop would never terminate.
    const res = store.runs({ limit: 1, cursor: "agent:a-vanished" });
    expect(res.rows).toEqual([]);
    expect(res.nextCursor).toBeNull();
    expect(res.matched).toBe(2);
  });
});

describe("RunHistoryStore — [F13.QA] reason is truncated to the schema cap", () => {
  it("clips a long TaskRecord.error to 200 chars so the row still validates", () => {
    const task = makeTask({ taskId: "t-err", state: "failed", error: "E".repeat(500), startedAt: NOW - 5000, endedAt: NOW - 1000 });
    const store = new RunHistoryStore(makeDeps({ queues: { allTasks: () => [task] } }));
    const row = store.runs({}).rows.find((r) => r.id === "task:t-err")!;
    expect(row.reason).toHaveLength(200);
    // RunHistoryRowSchema caps reason at 200; an untruncated error would fail response validation.
    expect(RunHistoryRowSchema.safeParse(row).success).toBe(true);
  });
});

describe("RunHistoryStore — [F13.QA M-2] a task row rolls up its bound agent's booked spend", () => {
  // index.ts's F13 header and the app footer both say a rolled-up dollar "is a display-only sum
  // over other rows' booked dollars", but a task's costUsd used to come ONLY from the journal fold
  // (or the F12 span rollup) — never from the agent bound to it, so the operator saw a $2.50 agent
  // sitting under a $0.00 ↺ task, which reads as "this task was free". This was an it.fails pin
  // until M-2 closed the gap; it is a normal assertion now.
  it("sums the bound agent's booked cost onto the task row", () => {
    const agent = makeAgent({ agentId: "a-1", state: "done", createdAt: NOW - 5000, costUsd: 2.5 });
    const task = makeTask({ taskId: "t-1", state: "done", agentId: "a-1", startedAt: NOW - 5000, endedAt: NOW - 1000 });
    const store = new RunHistoryStore(makeDeps({ supervisor: { list: () => [agent] }, queues: { allTasks: () => [task] } }));
    const row = store.runs({}).rows.find((r) => r.id === "task:t-1")!;
    expect(row.costUsd).toBeCloseTo(2.5);
  });
});

describe("RunHistoryStore — [F13.QA M-1] a job row says WHY the schedule fired", () => {
  it("emits kind:'schedule' carrying JobRunEntry.trigger as detail", () => {
    const job = makeJob({
      name: "nightly-digest",
      lastRuns: [
        { ts: NOW - 3000, trigger: "manual", result: "ok", costUsd: 0 },
        { ts: NOW - 2000, trigger: "catchup", result: "failed", costUsd: 0 },
      ],
    });
    const res = new RunHistoryStore(makeDeps({ jobs: { list: () => [job] } })).runs({});
    expect(res.rows.map((r) => r.trigger)).toEqual([
      { kind: "schedule", ref: "nightly-digest", detail: "catchup" },
      { kind: "schedule", ref: "nightly-digest", detail: "manual" },
    ]);
    // detail is required-nullable on the wire, so a row that forgot it fails to parse.
    for (const r of res.rows) expect(() => RunHistoryRowSchema.parse(r)).not.toThrow();
  });

  it("never guesses a fire reason for an agent dispatched BY a job — detail stays null", () => {
    const agent = makeAgent({ agentId: "a-1", jobName: "nightly-digest", state: "done", createdAt: NOW - 1000 });
    const row = new RunHistoryStore(makeDeps({ supervisor: { list: () => [agent] } })).runs({}).rows[0]!;
    expect(row.trigger).toEqual({ kind: "job", ref: "nightly-digest", detail: null });
  });
});

describe("RunHistoryStore — [F13.QA M-3] kinds/outcome are multi-select and server-side", () => {
  const deps = () => makeDeps({
    supervisor: { list: () => [
      makeAgent({ agentId: "a-ok", state: "done", createdAt: NOW - 5000 }),
      makeAgent({ agentId: "a-bad", state: "failed", createdAt: NOW - 4000 }),
    ] },
    queues: { allTasks: () => [makeTask({ taskId: "t-1", state: "failed", createdAt: NOW - 3000 })] },
    jobs: { list: () => [makeJob({ name: "j", lastRuns: [{ ts: NOW - 2000, trigger: "scheduled", result: "ok", costUsd: 0 }] })] },
  });

  it("keeps every selected kind and drops the rest", () => {
    const res = new RunHistoryStore(deps()).runs({ kinds: ["agent", "job"] });
    expect(new Set(res.rows.map((r) => r.kind))).toEqual(new Set(["agent", "job"]));
    expect(res.matched).toBe(3);
  });

  it("accepts an outcome ARRAY — the single-select shape could not express this", () => {
    const res = new RunHistoryStore(deps()).runs({ outcome: ["failed", "skipped"] });
    expect(res.rows.map((r) => r.id).sort()).toEqual(["agent:a-bad", "task:t-1"]);
  });

  it("still honours the scalar kind/jobName aliases an older client sends", () => {
    const store = new RunHistoryStore(deps());
    expect(store.runs({ kind: "job" }).rows.map((r) => r.kind)).toEqual(["job"]);
    expect(store.runs({ jobName: "j" }).rows.map((r) => r.jobName)).toEqual(["j"]);
    expect(store.runs({ jobName: "nope" }).rows).toHaveLength(0);
  });
});

describe("RunHistoryStore — [F13.QA M-4] totals describe the matched set, not the page", () => {
  it("counts failed and unseen beyond the limit the page could carry", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeAgent({
      agentId: `a-${i}`, state: i % 2 === 0 ? "failed" : "done", createdAt: NOW - 10_000 + i * 100,
      attentionAt: NOW - 100, reviewedAt: NOW - 200, costUsd: 1,
    } as Partial<AgentRecord>));
    const res = new RunHistoryStore(makeDeps({ supervisor: { list: () => agents } })).runs({ limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.matched).toBe(6);
    // A UI reducing over `rows` would have said "1 failed, 2 new" — the page is not the truth.
    expect(res.totals).toEqual({ runs: 6, costUsd: 6, failed: 3, unseen: 6 });
  });
});
