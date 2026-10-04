import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };

// A one-shot turn, then either killed (retry-with-policy/exhaustion) or gracefully
// closeInput()'d (a terminal pass) by the scheduler — same shape as engine-workflows.test.ts's
// onFail:halt script (both teardown paths are scheduler-driven, not script-driven).
const ONE_TURN: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }];

// A command gate that fails the first N times it's invoked (tracked via a counter file — a
// FRESH `node -e` child process each attempt has no other state) then passes forever after.
function flakyGateArgs(counterPath: string, failCount: number): string[] {
  return ["-e", `
    const fs = require("fs");
    const p = ${JSON.stringify(counterPath)};
    const n = fs.existsSync(p) ? parseInt(fs.readFileSync(p, "utf8"), 10) : 0;
    if (n < ${failCount}) { fs.writeFileSync(p, String(n + 1)); process.exit(1); }
    process.exit(0);
  `];
}

describe("RETRY-BACKOFF: workflow step-gate delayed retry + dead-letter (scheduler.ts/queues.ts)", () => {
  it("exponential backoff: each retry's delay roughly doubles the previous one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-backoff-"));
    const counter = join(dir, "counter");
    const fake = new FakeAgentBackend([ONE_TURN, ONE_TURN, ONE_TURN]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "backoff", onFail: "retry",
        // baseMs is deliberately large (not the 20-40ms this suite usually uses elsewhere) —
        // under this sandbox's documented real-timer flakiness (concurrent test-file
        // contention delays setTimeout firing unevenly, see supervisor/scheduler-session-limit
        // tests' own notes), a small base leaves too little margin between "real backoff" and
        // "scheduling noise" to assert a stable growth ratio. A bigger base keeps the RELATIVE
        // jitter small enough for the loose ratio check below to hold reliably.
        retryPolicy: { backoff: "exponential", baseMs: 150, maxAttempts: 3 },
        steps: [{ id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: flakyGateArgs(counter, 2) } } }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "backoff" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.done === 1, 15000);

    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.stepHistory).toHaveLength(3);
    expect(final.stepHistory.map((h) => h.outcome)).toEqual(["retried", "retried", "passed"]);

    // the delay BEFORE each retry, measured from the previous attempt's gate evaluation
    // (endedAt) to the next attempt's fresh spawn (startedAt) — this is the actual wall-clock
    // backoff the scheduler applied, not just computeRetryDelayMs' pure output (already unit
    // tested, deterministically, in protocol/test/retry-policy.test.ts — this integration test's
    // only job is proving the scheduler actually WAITS and that later attempts wait LONGER, so
    // the tolerance here is deliberately loose).
    const gap1 = final.stepHistory[1]!.startedAt - final.stepHistory[0]!.endedAt!;
    const gap2 = final.stepHistory[2]!.startedAt - final.stepHistory[1]!.endedAt!;
    expect(gap1).toBeGreaterThanOrEqual(100);         // roughly baseMs (150ms), generous floor
    expect(gap2).toBeGreaterThan(gap1 * 1.15);        // grows with attempt count (300ms vs 150ms nominal)
  }, 20000);   // real-timer test (two real backoff delays, ~150ms + ~300ms) — vitest's 5000ms default is too tight

  it("exhaustion routes to dead_letter (not failed) and does NOT cascade-fail dependents", async () => {
    const fake = new FakeAgentBackend([ONE_TURN]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    // onFail defaults to "halt" — willRetry is false on the FIRST failure regardless of
    // retryPolicy.maxAttempts, so this exercises the EXHAUSTION branch immediately.
    await e.handle("workflow.create", {
      spec: {
        name: "poison", retryPolicy: { maxAttempts: 3 },
        steps: [{ id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "poison" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const poison = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    const downstream = await e.handle("queue.push", { queue: "work", prompt: "y", dependsOn: [poison.taskId] }) as TaskRecord;
    expect(downstream.state).toBe("blocked");

    await waitUntil(() => e.queues.getTask(poison.taskId).state === "dead_letter", 5000);
    const final = e.queues.getTask(poison.taskId);
    expect(final.error).toContain("gate failed");

    // give any (wrongly) fired cascade a moment to land before asserting its absence
    await new Promise((r) => setTimeout(r, 50));
    expect(e.queues.getTask(downstream.taskId).state).toBe("blocked");
  });

  it("queue.requeue replays a dead-lettered workflow task, resuming at its persisted step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-requeue-"));
    const marker = join(dir, "marker");
    // spawn 1: step0 (gate:none, trivial) passes -> advance to step1 (same role, same agent) ->
    // step1's gate fails (marker absent) -> dead_letter (onFail halt, retryPolicy set).
    // spawn 2 (post-requeue, fresh pickup at the persisted stepIndex 1): step1's gate now
    // passes (marker present) -> terminal -> graceful close.
    const fake = new FakeAgentBackend([
      [{ emit: { kind: "agent_started", data: {} } }, { turn: {} }, { awaitSend: true }, { turn: {} }],
      ONE_TURN,
    ]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "resumable",
        steps: [
          { id: "s0", title: "plan", gate: { kind: "none" } },
          {
            id: "s1", title: "test", retryPolicy: { maxAttempts: 3 },
            gate: { kind: "command", spec: { command: process.execPath, args: ["-e", `require("fs").existsSync(${JSON.stringify(marker)}) ? process.exit(0) : process.exit(1)`] } },
          },
        ],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "resumable" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.getTask(task.taskId).state === "dead_letter", 15000);
    const deadLettered = e.queues.getTask(task.taskId);
    expect(deadLettered.stepIndex).toBe(1);            // died at step1, not step0
    expect(deadLettered.attempts).toBe(0);              // this path never touches `attempts` (gate failure, not agent failure)

    // now make the gate pass, then requeue
    writeFileSync(marker, "1");
    // NOTE: like queue.push, the queue.requeue handler ticks the scheduler before returning —
    // `requeued` is the SAME live TaskRecord object requeue() mutated (QueueStore never clones),
    // so if that tick's fresh pickup races ahead synchronously, the returned snapshot can already
    // show "in_progress" instead of "pending". Assert only fields that pickup does NOT touch
    // (stepIndex/stepAttempts) plus "left dead_letter", not the exact transient state.
    const requeued = await e.handle("queue.requeue", { taskId: task.taskId }) as TaskRecord;
    expect(requeued.state).not.toBe("dead_letter");
    expect(requeued.stepIndex).toBe(1);                 // resumes at the SAME step, not step 0
    expect(requeued.stepAttempts).toBe(0);

    await waitUntil(() => e.queues.getTask(task.taskId).state === "done", 15000);
    const final = e.queues.getTask(task.taskId);
    expect(final.stepHistory.filter((h) => h.stepIndex === 0)).toHaveLength(1);   // step0 never re-ran
  }, 35000);   // real command-gate subprocess spawns (node -e) x2, plus two waitUntil polls — CORE-SUITE-BASELINE

  it("queue.requeue throws on a task that isn't dead-lettered", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await expect(e.handle("queue.requeue", { taskId: task.taskId })).rejects.toMatchObject({ code: "protocol" });
  });
});
