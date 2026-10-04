import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { defaultGateExec, type GateExecFn } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

// CORE-SUITE-BASELINE: command gates spawn real subprocesses (defaultGateExec) — under
// this machine's concurrent-agent load that can exceed vitest's 5000ms default; widened
// per existing precedent (supervisor-crash-loop.test.ts), and the waitUntil deadlines
// above were widened alongside it.
vi.setConfig({ testTimeout: 25_000 });

// Two-step workflow: s0 carries the command gate under test (non-final, so the
// scheduler's `send()` of s1's text — which only fires once s0's gate resolves —
// is what unblocks the scenario's second `awaitSend`, exactly like
// engine-workflows.test.ts's FIVE_STEP_SCENARIO). s1 is a trivial "none" gate that
// closes the conductor session. The FIRST `awaitSend` parks immediately after spawn
// (step0's scope rides in spawn-time instructions, not a `send()`) so the test can
// finish setting up preconditions (e.g. materializing a worktree dir) before kicking
// the scenario off with an explicit `sup.send(agentId, "go")` — see scheduler-retry
// .test.ts's "holder" task for the same externally-unblocked-awaitSend pattern.
const TWO_STEP_SCENARIO: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { end: { resultText: "done" } },
];

const WF_STEPS = (gate: { kind: "command"; spec: { command: string; args: string[]; timeoutMs?: number } }) => [
  { id: "s0", title: "test", gate },
  { id: "s1", title: "ship", gate: { kind: "none" as const } },
];

describe("QueueScheduler command gate execution (WF-3: G1 cwd, G2 env, G3 timeout)", () => {
  it("G1: execs in the agent's worktree dir when it already exists, not the main-repo cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-gate-cwd-"));
    const seenCwd: string[] = [];
    const gateExec: GateExecFn = async (_c, _a, execCwd) => { seenCwd.push(execCwd); return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    // FakeAgentBackend never calls ensureWorkdir (only the real claude/codex backends do) —
    // materialize the worktree dir by hand at the exact path ensureWorkdir would have used,
    // BEFORE unblocking the scenario's step0 turn. FEATURE-2: every workflow-bound task now
    // shares its task-stable workdirKey from step 0 (previously only step-role/critic-gate
    // workflows did) — this test's expected path is keyed on the TASK, not the agentId.
    const worktreeDir = join(cwd, ".chimera", "worktrees", `task-${t.taskId}`);
    mkdirSync(worktreeDir, { recursive: true });
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenCwd).toEqual([worktreeDir]);
  });

  it("G1: falls back to spec.cwd when the worktree dir doesn't exist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-gate-cwd-"));
    const seenCwd: string[] = [];
    const gateExec: GateExecFn = async (_c, _a, execCwd) => { seenCwd.push(execCwd); return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    // no worktree dir created this time
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenCwd).toEqual([cwd]);
  });

  it("G1: isolation:\"none\" always execs in spec.cwd (unchanged behavior)", async () => {
    const seenCwd: string[] = [];
    const gateExec: GateExecFn = async (_c, _a, execCwd) => { seenCwd.push(execCwd); return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenCwd).toEqual(["/tmp"]);
  });

  it("G2: passes per-task CHIMERA_* env vars visible to the gate command", async () => {
    let seenEnv: Record<string, string> | undefined;
    const gateExec: GateExecFn = async (_c, _a, _cwd, env) => { seenEnv = env; return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenEnv).toEqual({
      CHIMERA_TASK_ID: t.taskId,
      CHIMERA_STEP_ID: "s0",
      CHIMERA_STEP_INDEX: "0",
      CHIMERA_AGENT_ID: agentId,
      CHIMERA_WORKFLOW: "wf",
      CHIMERA_WORKFLOW_VERSION: "1",
      // FEATURE-2: idempotency key available to gate scripts, threaded through every dispatch
      // surface — deterministic per (taskId, stepIndex).
      CHIMERA_IDEMPOTENCY_KEY: `${t.taskId}:step-0`,
    });
  });

  it("G3: an injected gateExec seam receives a per-gate timeoutMs override", async () => {
    let seenTimeout: number | undefined;
    const gateExec: GateExecFn = async (_c, _a, _cwd, _env, timeoutMs) => { seenTimeout = timeoutMs; return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [], timeoutMs: 5000 } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenTimeout).toBe(5000);
  });

  it("G3: an absent timeoutMs reaches the exec seam as undefined (defaultGateExec's 120s default applies)", async () => {
    let seenTimeout: number | undefined = -1 as unknown as number;
    const gateExec: GateExecFn = async (_c, _a, _cwd, _env, timeoutMs) => { seenTimeout = timeoutMs; return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(seenTimeout).toBeUndefined();
  });

  it("defaultGateExec merges the given env over process.env", async () => {
    const res = await defaultGateExec(
      process.execPath, ["-e", "process.exit(process.env.CHIMERA_PROBE === 'yes' ? 0 : 1)"],
      "/tmp", { CHIMERA_PROBE: "yes" },
    );
    expect(res.ok).toBe(true);
  });

  it("defaultGateExec honors an overridden timeoutMs and kills a command that exceeds it", async () => {
    const res = await defaultGateExec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], "/tmp", {}, 100);
    expect(res.ok).toBe(false);
  }, 10_000);

  // GATE-FAILURE-DISCARDS-ITS-OWN-DIAGNOSTICS: gate scripts (and tsc/vitest) diagnose on
  // stdout, not stderr — the old fallback chain (`stderr || err.message`) silently dropped
  // stdout on every one of these real failures. This is the regression that matters.
  it("defaultGateExec: a command that fails writing ONLY to stdout surfaces that stdout in the message", async () => {
    const res = await defaultGateExec(
      process.execPath, ["-e", "console.log('GATE FAIL: branch has NO commits ahead of main'); process.exit(1);"],
      "/tmp", {},
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("GATE FAIL: branch has NO commits ahead of main");
  });

  it("defaultGateExec: a populated stderr does not hide stdout", async () => {
    const res = await defaultGateExec(
      process.execPath,
      ["-e", "console.log('stdout diagnosis'); console.error('stderr noise'); process.exit(1);"],
      "/tmp", {},
    );
    expect(res.ok).toBe(false);
    expect(res.message).toContain("stdout diagnosis");
    expect(res.message).toContain("stderr noise");
  });

  it("defaultGateExec: truncation is announced, not silent", async () => {
    const res = await defaultGateExec(
      process.execPath, ["-e", "console.log('x'.repeat(5000)); process.exit(1);"],
      "/tmp", {},
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/chars truncated/);
  });
});

// GATE-CANNOT-TELL-LANDED-FROM-EMPTY: a `command` gate script that greps `git log
// main..HEAD` can't tell "nothing committed" from "committed AND already merged to main"
// (CLAUDE.md's land-on-main doctrine merges mid-step). These prove the checkpoint-driven
// preempt in evaluateGate distinguishes the three cases correctly, using REAL git (like
// supervisor-worktree-landing.test.ts) rather than the FakeAgentBackend/exec-spy alone —
// the whole point is a real merge-base check against real commits.
describe("GATE-CANNOT-TELL-LANDED-FROM-EMPTY: command gate distinguishes empty/landed/unlanded branches", () => {
  vi.setConfig({ testTimeout: 45_000 });

  it("branch with NO commits at all still fails the gate (must NOT be preempted as landed)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-gate-landed-"));
    initRepo(cwd);
    let execCalls = 0;
    const gateExec: GateExecFn = async () => { execCalls++; return { ok: false, message: "GATE FAIL: branch has NO commits ahead of main" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    const workdirKey = `task-${t.taskId}`;
    const wt = join(cwd, ".chimera", "worktrees", workdirKey);
    // Materialize the worktree branch but commit NOTHING new on it — its tip is exactly
    // the checkpoint's captured commitSha (the mainRepo HEAD at spawn time).
    execFileSync("git", ["-C", cwd, "worktree", "add", "-b", `chimera/${workdirKey}`, wt]);
    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 20_000);
    expect(execCalls).toBe(1);   // preempt did NOT bypass the real command
    expect(rig.queues.getTask(t.taskId).stepHistory[0]?.reason).toContain("GATE FAIL: branch has NO commits ahead of main");
  });

  it("branch with commits, already merged into main before the gate runs: passes WITHOUT running the command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-gate-landed-"));
    initRepo(cwd);
    let execCalls = 0;
    const gateExec: GateExecFn = async () => { execCalls++; return { ok: false, message: "should never run" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    const workdirKey = `task-${t.taskId}`;
    const wt = join(cwd, ".chimera", "worktrees", workdirKey);
    const branch = `chimera/${workdirKey}`;
    execFileSync("git", ["-C", cwd, "worktree", "add", "-b", branch, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "real work"]);
    execFileSync("git", ["-C", cwd, "merge", "--no-ff", "-q", "-m", "landed", branch]);

    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(execCalls).toBe(0);   // preempt bypassed the (stale-diff) command entirely
    expect(rig.queues.getTask(t.taskId).stepHistory[0]?.reason).toContain("already merged to main");
  });

  it("branch with unmerged commits: normal case, runs the command as before", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-gate-landed-"));
    initRepo(cwd);
    let execCalls = 0;
    const gateExec: GateExecFn = async () => { execCalls++; return { ok: true, message: "" }; };
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "worktree" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    const workdirKey = `task-${t.taskId}`;
    const wt = join(cwd, ".chimera", "worktrees", workdirKey);
    const branch = `chimera/${workdirKey}`;
    execFileSync("git", ["-C", cwd, "worktree", "add", "-b", branch, wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);
    // deliberately NOT merged into main

    await rig.sup.send(agentId, "go");

    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);
    expect(execCalls).toBe(1);
  });
});
