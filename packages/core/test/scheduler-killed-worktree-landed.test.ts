import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import type { FakeStep } from "@chimera/core/backends/fake";

// CORE-SUITE-RESIDUAL: this file landed after the CORE-SUITE-BASELINE sweep (d8c8896,
// RESUMED-STEP-REVERIFIES-LANDED-WORK) and was never widened — each test shells out to real
// `git worktree add`/`commit`/`merge` plus a scheduler tick, which can exceed vitest's bare
// 5000ms default under this machine's concurrent-agent load. First widened to 25_000ms
// (scheduler-gate-exec.test.ts's value) but that still starved once under a full 261-file
// parallel suite run; raised to 45_000ms to match supervisor-worktree-landing.test.ts, which
// does the same worktree add/commit/merge work and holds up at that value under the same load.
vi.setConfig({ testTimeout: 45_000 });

// RESUMED-STEP-REVERIFIES-LANDED-WORK: a task whose agent lands its work on main (a real merge,
// verified via git) and is THEN killed (reap, or an operator cancel that arrives just late) used
// to be recorded "failed" unconditionally — settle()'s "killed" branch never consulted
// AgentRecord.worktreeUnlanded (STALE-WORKTREE-RECORD's own fact, stamped by kill() moments
// earlier in the very same call). A conductor reading "failed" would re-dispatch already-merged
// work: the resumed step re-verifies an empty (because already-merged) branch, fails loudly, and
// burns a retry on work that had already succeeded.

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never", costUsd: 0 } }];

describe("RESUMED-STEP-REVERIFIES-LANDED-WORK: a killed agent's already-merged worktree settles as done", () => {
  it("kill() on a branch already merged into main marks the task done, not failed", async () => {
    const rig = makeCoordination([RUNNING]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    // Materialize the worktree by hand exactly the way a real backend would (the fake backend
    // never calls ensureWorkdir — same precedent as supervisor-worktree-landing.test.ts), do the
    // agent's "work", and land it on main BEFORE the kill — mirrors the observed incident:
    // land-on-main happens as the agent's own git actions, ahead of any turn_complete the engine
    // could use to notice success.
    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "landed work"]);
    execFileSync("git", ["-C", rig.dir, "merge", "--no-ff", "-q", "-m", "merge", `chimera/${agentId}`]);

    await rig.sup.kill(agentId!);
    await rig.scheduler.tick();   // exactly what Engine's agent.kill case does (Task 8)

    await waitUntil(() => rig.queues.status("work").counts.done === 1 || rig.queues.status("work").counts.failed === 1, 40_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("done");
    expect(task.error).toBeNull();
  });

  // STALE-WORKTREE-RECORD-GAP: same incident, narrower trigger -- a CONCURRENT process (a
  // separate merge/cleanup, or the daemon's own worktree janitor) removes the worktree
  // DIRECTORY right after the merge but before this agent's reap runs. checkWorktreeUnlanded
  // used to bail to null the instant the directory was gone, regardless of whether the branch
  // (which `git worktree remove` does NOT delete) still proved the work had landed -- so this
  // reap fell through to the exact same "failed" misreport RESUMED-STEP-REVERIFIES-LANDED-WORK
  // fixed for the directory-still-there case.
  it("kill() on a branch already merged into main, but whose worktree DIRECTORY was already removed, still marks the task done (not failed)", async () => {
    const rig = makeCoordination([RUNNING]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "landed work"]);
    execFileSync("git", ["-C", rig.dir, "merge", "--no-ff", "-q", "-m", "merge", `chimera/${agentId}`]);
    // The branch survives (git worktree remove never deletes it by itself) -- only the
    // checked-out directory a live agent was running in disappears here.
    execFileSync("git", ["-C", rig.dir, "worktree", "remove", wt]);

    await rig.sup.kill(agentId!);
    await rig.scheduler.tick();

    await waitUntil(() => rig.queues.status("work").counts.done === 1 || rig.queues.status("work").counts.failed === 1, 40_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("done");
    expect(task.error).toBeNull();
  });

  it("kill() on a branch NOT yet merged still settles the task as failed (unchanged)", async () => {
    const rig = makeCoordination([RUNNING]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);

    await rig.sup.kill(agentId!);
    await rig.scheduler.tick();

    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).toBe("agent killed");
  });
});
