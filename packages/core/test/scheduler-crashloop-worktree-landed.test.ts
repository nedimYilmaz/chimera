import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker, type CrashLoopPolicy } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { RoleStore } from "@chimera/core/roles-store";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler } from "@chimera/core/scheduler";
import { fakeExec } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// Same real-git-plumbing timeout rationale as scheduler-killed-worktree-landed.test.ts.
vi.setConfig({ testTimeout: 45_000 });

// RESUMED-STEP-REVERIFIES-LANDED-WORK's own gap: settle()'s worktreeUnlanded===false carve-out
// only applied to rec.state === "killed". reportUnresponsive() (the liveness-probe reap path)
// ALSO calls stampWorktreeLanding before handing off to scheduleCrashRestart, but crash-loop
// circuit-breaker exhaustion lands the record in state "failed", not "killed" — so an agent
// reaped as unresponsive on an already-merged branch, whose crash-loop retries then exhaust,
// used to fall through to markFailedAttempt and re-queue (or burn a retry on) work that had
// already succeeded, exactly like the killed case this file's sibling covers.

const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
});

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

// maxRestarts: 0 -- the very first crash (crashCount 1 > 0) trips the breaker immediately, no
// need to script a real backoff wait.
const TRIP_IMMEDIATELY: CrashLoopPolicy = { maxRestarts: 0, baseDelayMs: 10, maxDelayMs: 50 };
const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never", costUsd: 0 } }];

function makeRig(scenarios: FakeStep[][], crashLoopPolicy: CrashLoopPolicy) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-crashloop-landed-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(SOLO),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    crashLoopPolicy,
  });
  const teams = new TeamManager(dir, events);
  const roles = new RoleStore(dir);
  const queues = new QueueStore(dir, events);
  const workflows = new WorkflowStore(dir, events);
  const artifacts = new ArtifactStore(dir, events);
  const scheduler = new QueueScheduler({ teams, queues, supervisor: sup, events, workflows, artifacts, roles });
  scheduler.attach();
  return { dir, fake, events, sup, teams, queues, scheduler };
}

describe("RESUMED-STEP-REVERIFIES-LANDED-WORK sibling: a crash-loop-exhausted agent's already-merged worktree settles as done", () => {
  it("liveness-probe reap + circuit-breaker trip on a branch already merged into main marks the task done, not failed", async () => {
    const rig = makeRig([RUNNING], TRIP_IMMEDIATELY);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    // Land the agent's work on main BEFORE the reap, exactly like the killed-agent sibling test.
    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "landed work"]);
    execFileSync("git", ["-C", rig.dir, "merge", "--no-ff", "-q", "-m", "merge", `chimera/${agentId}`]);

    // The liveness-probe reap path: stamps worktreeUnlanded, then trips the crash-loop circuit
    // breaker straight to state:"failed" (maxRestarts: 0).
    rig.sup.reportUnresponsive(agentId!, 999_999, 60_000);
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(false);
    await rig.scheduler.tick();

    await waitUntil(() => rig.queues.status("work").counts.done === 1 || rig.queues.status("work").counts.failed === 1, 20_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("done");
    expect(task.error).toBeNull();
  });

  it("liveness-probe reap + circuit-breaker trip on a branch NOT yet merged still settles the task as failed (unchanged)", async () => {
    const rig = makeRig([RUNNING], TRIP_IMMEDIATELY);
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

    rig.sup.reportUnresponsive(agentId!, 999_999, 60_000);
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(true);
    await rig.scheduler.tick();

    // Unchanged pre-existing behavior for the general "failed" branch (not my new carve-out):
    // markFailedAttempt with a retry policy configured parks the task for a retry rather than
    // failing it outright — this assertion only guards that the new worktreeUnlanded===false
    // carve-out didn't fire, not the exact retry-vs-fail semantics of that pre-existing branch.
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("in_progress");
    expect(task.error).not.toContain("already merged to main");
  });
});
