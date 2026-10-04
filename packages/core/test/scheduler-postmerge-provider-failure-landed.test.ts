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
import { CooldownTracker } from "@chimera/core/failover";
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

// POST-LANDING-PROVIDER-FAILURE: the incident this covers — queue task 1eabcfe1, agent 05033cec
// implemented + merged its fix (main commit 6a46e7ee), and IMMEDIATELY afterward the backend threw
// "Codex model capabilities unavailable; check the configured Codex CLI and account login" — an
// error that classifies "unknown" (no CRASH/rate-limit/bad-request pattern match), so it fell
// straight through onError's plain fail-loud path to markFailed, which (unlike kill()/
// reportUnresponsive()) never called stampWorktreeLanding first. scheduler.ts settle() then saw
// state:"failed" with worktreeUnlanded === undefined (no fact), fell through to the generic
// markFailedAttempt branch, and requeued already-landed work — spawning two more agents that
// re-did nothing useful before exhausting retries.
vi.setConfig({ testTimeout: 45_000 });

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

const UNKNOWN_PROVIDER_ERROR: FakeStep[] = [
  { awaitSend: true },
  { fail: { message: "Codex model capabilities unavailable; check the configured Codex CLI and account login" } },
];

function makeRig(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-postmerge-provider-fail-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(SOLO),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
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

describe("POST-LANDING-PROVIDER-FAILURE: an unclassified provider error right after a merge must not retry landed work", () => {
  it("branch merged to main, then an unknown-class provider error -> task settles done, no requeue", async () => {
    const rig = makeRig([UNKNOWN_PROVIDER_ERROR]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    // Land the agent's work on main BEFORE the provider error fires.
    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "landed work"]);
    execFileSync("git", ["-C", rig.dir, "merge", "--no-ff", "-q", "-m", "merge", `chimera/${agentId}`]);

    // Fire the awaited turn -- the fake's second step throws the unclassified provider error,
    // routing through onError's plain fail-loud path (no failoverAccount/restartInPlace match).
    rig.sup.send(agentId!, { from: "op", kind: "user", text: "go" });
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(false);

    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1 || rig.queues.status("work").counts.failed === 1, 20_000);

    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("done");
    expect(task.error).toBeNull();
    // No second spawn: the queue-side attempt counter (only incremented by failAttempt on the
    // requeue path) never moved, proving the "done" carve-out short-circuited before any retry.
    expect(task.attempts).toBe(0);
  });

  it("branch NOT merged, then the same provider error -> unchanged: task fails, not falsely marked done", async () => {
    // retryLimit: 0 -- the single failed attempt immediately exhausts retries and terminates as
    // "failed" (queues.ts markFailedAttempt: attempts(1) > retryLimit(0)), so the assertion below
    // is race-free: no second agent gets a chance to spawn and race the check.
    const rig = makeRig([UNKNOWN_PROVIDER_ERROR]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);
    // deliberately NOT merged into main

    rig.sup.send(agentId!, { from: "op", kind: "user", text: "go" });
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(true);

    await waitUntil(() => rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!.state === "failed", 20_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).not.toContain("already merged to main");
  });

  it("unrelated main movement after the branch merge does not mask a genuinely unmerged failure", async () => {
    const rig = makeRig([UNKNOWN_PROVIDER_ERROR]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);
    // An unrelated commit lands on main from someone else's work -- must not be mistaken for
    // this agent's branch landing.
    execFileSync("git", ["-C", rig.dir, "commit", "-q", "--allow-empty", "-m", "unrelated main commit"]);

    rig.sup.send(agentId!, { from: "op", kind: "user", text: "go" });
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(true);

    await waitUntil(() => rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!.state === "failed", 20_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).not.toContain("already merged to main");
  });

  it("merge attempt failed (conflict) -- branch never actually landed, task fails not falsely marked done", async () => {
    const rig = makeRig([UNKNOWN_PROVIDER_ERROR]);
    initRepo(rig.dir);
    // A conflicting change on main so the merge attempt below fails.
    execFileSync("bash", ["-c", `echo "main" > ${JSON.stringify(join(rig.dir, "f.txt"))}`]);
    execFileSync("git", ["-C", rig.dir, "add", "f.txt"]);
    execFileSync("git", ["-C", rig.dir, "commit", "-q", "-m", "main writes f.txt"]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("bash", ["-c", `echo "branch" > ${JSON.stringify(join(wt, "f.txt"))}`]);
    execFileSync("git", ["-C", wt, "add", "f.txt"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "-m", "branch writes f.txt (conflicts)"]);
    // main diverges on the SAME line after the branch point, so the merge below actually conflicts.
    execFileSync("bash", ["-c", `echo "main-diverged" > ${JSON.stringify(join(rig.dir, "f.txt"))}`]);
    execFileSync("git", ["-C", rig.dir, "add", "f.txt"]);
    execFileSync("git", ["-C", rig.dir, "commit", "-q", "-m", "main diverges on f.txt"]);

    // Merge attempt fails -- must not be mistaken for a successful landing.
    let mergeFailed = false;
    try {
      execFileSync("git", ["-C", rig.dir, "merge", "--no-ff", "-q", "-m", "merge", `chimera/${agentId}`], { stdio: "pipe" });
    } catch {
      mergeFailed = true;
      execFileSync("git", ["-C", rig.dir, "merge", "--abort"], { stdio: "pipe" });
    }
    expect(mergeFailed).toBe(true);

    rig.sup.send(agentId!, { from: "op", kind: "user", text: "go" });
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(true);

    await waitUntil(() => rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!.state === "failed", 20_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).not.toContain("already merged to main");
  });

  it("dirty worktree with an uncommitted, unmerged diff at failure time is auto-snapshotted but still reported unlanded", async () => {
    const rig = makeRig([UNKNOWN_PROVIDER_ERROR]);
    initRepo(rig.dir);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: rig.dir, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");

    const wt = join(rig.dir, ".chimera", "worktrees", agentId!);
    execFileSync("git", ["-C", rig.dir, "worktree", "add", "-b", `chimera/${agentId}`, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    // Uncommitted diff, never merged -- autoCommitDirtyWorktree snapshots it onto the branch, but
    // that snapshot commit is never reachable from main, so this must still read as unlanded.
    execFileSync("bash", ["-c", `echo "wip" > ${JSON.stringify(join(wt, "wip.txt"))}`]);

    rig.sup.send(agentId!, { from: "op", kind: "user", text: "go" });
    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 20_000);
    expect(rig.sup.status(agentId!).worktreeUnlanded).toBe(true);
    // The snapshot ran (autoCommitDirtyWorktree), so the diff is preserved on the branch...
    const branchLog = execFileSync("git", ["-C", rig.dir, "log", "-1", "--format=%s", `chimera/${agentId}`]).toString();
    expect(branchLog).toContain("chimera-autosave");

    await waitUntil(() => rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!.state === "failed", 20_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");
    expect(task.error).not.toContain("already merged to main");
  });
});
