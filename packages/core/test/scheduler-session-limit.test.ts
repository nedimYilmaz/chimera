import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// Single account so an auto team worker has NO failover target — a session limit HOLDs (pauses)
// instead of failing over, which is the case that exercises the scheduler's paused-worker guard.
const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  caps: { maxAgentsTotal: 10, perAccount: {} },
});
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const sessionFail = (iso: string): FakeStep[] => [{ fail: { message: `session limit · resets at ${iso}` } }];

describe("QueueScheduler: a session-limited worker pauses without failing its task", () => {
  // 2026-09-02 harness triage (root-caused, not load): the pause window this test used to poll
  // for — task "in_progress" with 0 active agents, between the session-limit fail and the
  // resetAt-triggered auto-resume — is only as wide as the reset delay (~40ms here), and can be
  // MUCH narrower in practice: resetAt is an absolute wall-clock time snapshotted before rig
  // setup, so by the time the pause actually lands, most (or all) of that budget may already be
  // spent, and the auto-resume can fire within single-digit ms of the pause. waitUntil's 10ms
  // poll can step clean over that window; once the task reaches "done" the "in_progress"
  // condition can never become true again and the old assertion spun to its full deadline
  // (confirmed via an events.jsonl dump: pause → resume → done all inside one 10ms poll tick).
  // Fix: don't assert on the transient mid-pause state at all — wait directly for settlement,
  // then check that it settled via a genuine pause+resume cycle (2 spawns) and never failed.
  it("does not consume a retry when a worker pauses, and completes the task on auto-resume", async () => {
    // retryLimit 0: if the pause were mis-settled as a failed attempt, the task would go
    // permanently failed. reset ~40ms out → the worker auto-resumes and the 2nd scenario runs.
    const rig = makeCoordination([sessionFail(at(40)), [{ end: { resultText: "resumed done", costUsd: 0.01 } }]], SOLO);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "auto", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "limited" });
    await rig.scheduler.tick();

    // Wait for the task to settle one way or the other — never for the transient pause itself.
    // CORE-SUITE-BASELINE: kept generous (60000ms) purely for genuine concurrent-agent CPU
    // contention on this in-process, no-subprocess path; not what caused the original flake.
    await waitUntil(() => {
      const st = rig.queues.status("work");
      return st.counts.done === 1 || st.counts.failed === 1;
    }, 60000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(rig.queues.status("work").counts.failed).toBe(0);
    expect(task.resultText).toBe("resumed done");
    expect(rig.fake.spawns.length).toBe(2);   // initial run + the resumed re-launch: proves a pause+resume cycle, not a lucky single-shot success
  }, 65000);
});
