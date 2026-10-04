import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorktreeSetup, setupMarkerPath, scrubHookEnv, BoundedCapture, WorktreeSetupError } from "@chimera/core/worktree-setup";
import { ensureWorkdir } from "@chimera/core/workdir";
import type { WorktreeSetupHook } from "@chimera/protocol";

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function makeWorktree(prefix: string): { repo: string; wt: string } {
  const repo = initRepo(prefix);
  const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-setup" });
  return { repo, wt: info.workdir };
}

function hook(command: string, overrides: Partial<WorktreeSetupHook> = {}): WorktreeSetupHook {
  return { command, timeoutSec: 300, enabled: true, ...overrides };
}

describe("runWorktreeSetup", () => {
  it("runs the hook in the worktree and writes the marker on exit 0", async () => {
    const { wt } = makeWorktree("chimera-ws-ok-");
    const events: Record<string, unknown>[] = [];
    const result = await runWorktreeSetup({
      hook: hook("node -e \"process.exit(0)\""), workdir: wt, mainRepo: wt, branch: "chimera/x",
      project: "p1", emit: (e) => events.push(e),
    });
    expect(result.ran).toBe(true);
    const marker = setupMarkerPath(wt);
    expect(marker).not.toBeNull();
    expect(existsSync(marker!)).toBe(true);
    expect(events.some((e) => e.phase === "start")).toBe(true);
    expect(events.some((e) => e.phase === "ok")).toBe(true);
  });

  it("a second call with the same command is a no-op, a changed command re-runs once", async () => {
    const { wt } = makeWorktree("chimera-ws-idempotent-");
    const events: Record<string, unknown>[] = [];
    const emit = (e: Record<string, unknown>) => events.push(e);
    const first = await runWorktreeSetup({ hook: hook("node -e \"process.exit(0)\""), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit });
    expect(first.ran).toBe(true);

    const second = await runWorktreeSetup({ hook: hook("node -e \"process.exit(0)\""), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit });
    expect(second.ran).toBe(false);

    const third = await runWorktreeSetup({ hook: hook("node -e \"0;process.exit(0)\""), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit });
    expect(third.ran).toBe(true);

    // The marker was rewritten to the new command by the third call — a fourth call with that
    // SAME (changed) command must now be the no-op, not just "the diff triggered a run".
    const fourth = await runWorktreeSetup({ hook: hook("node -e \"0;process.exit(0)\""), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit });
    expect(fourth.ran).toBe(false);
  });

  it("non-zero exit throws WorktreeSetupError whose message carries stdout AND stderr", async () => {
    const { wt } = makeWorktree("chimera-ws-fail-");
    const script = "node -e \"process.stdout.write('out-marker'); process.stderr.write('err-marker'); process.exit(1)\"";
    await expect(
      runWorktreeSetup({ hook: hook(script), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: () => {} }),
    ).rejects.toThrow(WorktreeSetupError);
    const script2 = "node -e \"0;process.stdout.write('out-marker'); process.stderr.write('err-marker'); process.exit(1)\"";
    try {
      await runWorktreeSetup({ hook: hook(script2), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: () => {} });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WorktreeSetupError);
      expect((e as Error).message).toContain("out-marker");
      expect((e as Error).message).toContain("err-marker");
    }
  });

  it("a hook that never exits is SIGTERM'd then SIGKILL'd, rejects naming the timeout, and leaves no child", async () => {
    const { wt } = makeWorktree("chimera-ws-hang-");
    const pidFile = join(wt, "..", "hang-pid.txt");
    // The child writes its own pid so AC5's "the child is killed (its pid no longer exists)"
    // clause is checkable — without it a passing `rejects` only proves the PROMISE settled and
    // an ignored-SIGTERM process could still be alive after the ladder gave up.
    const body = `require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const script = process.platform === "win32"
      ? `node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)" ${pidFile}`
      : `node -e "${body}" ${pidFile}`;
    const events: Record<string, unknown>[] = [];
    let message = "";
    try {
      await runWorktreeSetup({ hook: hook(script, { timeoutSec: 1 }), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: (e) => events.push(e) });
      throw new Error("expected the hang to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(WorktreeSetupError);
      message = (e as Error).message;
    }
    // AC5: the message must NAME the timeout. The SIGTERM path lands in child.on("close") with
    // code null, which without the timedOut flag reads "exited with code null" — an operator
    // cannot tell a deadline kill from a crash.
    expect(message).toMatch(/timed out after 1000ms/);
    const failEvent = events.find((e) => e.phase === "fail");
    expect(failEvent?.timedOut).toBe(true);

    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(pid)).toBe(true);
    // signal 0 only probes existence; it throws ESRCH once the process is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  }, 45_000);

  it("scrubHookEnv drops every CHIMERA_* key and keeps only the four injected, end-to-end via an env-dumping hook", async () => {
    const base = { CHIMERA_AGENT_ID: "leak", CHIMERA_TEAM: "leak", PATH: process.env.PATH, HOME: process.env.HOME };
    const scrubbed = scrubHookEnv(base as NodeJS.ProcessEnv, { CHIMERA_WORKTREE: "/wt", CHIMERA_MAIN_REPO: "/main", CHIMERA_BRANCH: "b", CHIMERA_SETUP_HOOK: "1" });
    expect(Object.keys(scrubbed).filter((k) => k.startsWith("CHIMERA_")).sort())
      .toEqual(["CHIMERA_BRANCH", "CHIMERA_MAIN_REPO", "CHIMERA_SETUP_HOOK", "CHIMERA_WORKTREE"]);
    expect(scrubbed.PATH).toBe(base.PATH);

    const { wt } = makeWorktree("chimera-ws-env-");
    const outFile = join(wt, "..", "env-dump.json");
    const script = `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))" ${outFile}`;
    await runWorktreeSetup({ hook: hook(script), workdir: wt, mainRepo: wt, branch: "chimera/x", project: "p1", emit: () => {} });
    const dumped = JSON.parse(readFileSync(outFile, "utf8"));
    expect(Object.keys(dumped).filter((k) => k.startsWith("CHIMERA_")).sort())
      .toEqual(["CHIMERA_BRANCH", "CHIMERA_MAIN_REPO", "CHIMERA_SETUP_HOOK", "CHIMERA_WORKTREE"]);
    expect(dumped.CHIMERA_WORKTREE).toBe(wt);
    expect(dumped.CHIMERA_BRANCH).toBe("chimera/x");
  });

  it("setupMarkerPath returns null for a main checkout (.git is a directory)", () => {
    const repo = initRepo("chimera-ws-mainrepo-");
    expect(setupMarkerPath(repo)).toBeNull();
  });

  it("no shell: a command containing && is passed as literal argv, not executed as two commands", async () => {
    const { wt } = makeWorktree("chimera-ws-noshell-");
    const marker = join(wt, "..", "should-not-exist.txt");
    // Without a shell, `node` receives "-e" and the whole "..." string (including the literal
    // "&&") as a single argv entry — a real shell would split on && and run touch separately.
    const script = `node -e "process.exit(0)" && touch ${marker}`;
    const result = await runWorktreeSetup({ hook: hook(script), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: () => {} });
    // Proves node actually consumed the literal "&& touch <path>" text as positional argv to
    // -e and exited 0 — not that the whole thing merely failed to run (which would also leave
    // the marker file absent and falsely pass this assertion).
    expect(result.ran).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("nothing is written to the working tree — git status --porcelain stays empty after a run", async () => {
    const { wt } = makeWorktree("chimera-ws-clean-");
    await runWorktreeSetup({ hook: hook("node -e \"process.exit(0)\""), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: () => {} });
    expect(execFileSync("git", ["-C", wt, "status", "--porcelain"]).toString().trim()).toBe("");
  });

  it("disabled hook is a no-op and does not touch the marker", async () => {
    const { wt } = makeWorktree("chimera-ws-disabled-");
    const result = await runWorktreeSetup({ hook: hook("node -e \"process.exit(1)\"", { enabled: false }), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: () => {} });
    expect(result.ran).toBe(false);
    expect(existsSync(setupMarkerPath(wt)!)).toBe(false);
  });
  it("BoundedCapture bounds a megabyte of hook output to the documented cap and reports what it dropped", () => {
    const cap = new BoundedCapture();
    // Under the cap the capture must be byte-identical to plain concatenation — the failure
    // message format for ordinary hooks must not change just because the buffer became bounded.
    cap.push("hello ");
    cap.push("world");
    expect(cap.render()).toBe("hello world");
    expect(cap.omittedChars).toBe(0);

    const chatty = new BoundedCapture();
    const line = "x".repeat(1000) + "\n";
    for (let i = 0; i < 1000; i++) chatty.push(line);
    // The point of the class: a verbose hook streaming for up to timeoutSec never grows the
    // daemon's heap past the cap, so the assertion is on RETAINED size, not on the message text.
    expect(chatty.render().length).toBeLessThan(1200);
    expect(chatty.omittedChars).toBe(1000 * line.length - 1000);
    expect(chatty.render()).toContain("chars truncated");
    expect(chatty.render().startsWith("x")).toBe(true);
    expect(chatty.render().endsWith("\n")).toBe(true);
  });

  it("the fail event carries the captured tail, including for a command that never starts", async () => {
    const { wt } = makeWorktree("chimera-ws-tail-");
    const events: Record<string, unknown>[] = [];
    const script = "node -e \"process.stderr.write('boom-detail'); process.exit(3)\"";
    let caught: WorktreeSetupError | null = null;
    try {
      await runWorktreeSetup({ hook: hook(script), workdir: wt, mainRepo: wt, branch: null, project: "p1", emit: (e) => events.push(e) });
    } catch (e) {
      caught = e as WorktreeSetupError;
    }
    const failEvent = events.find((e) => e.phase === "fail");
    expect(String(failEvent?.stderrTail ?? "")).toContain("boom-detail");
    expect(failEvent?.exitCode).toBe(3);
    // The same facts ride on the error object, which is how a spawn that JOINED this run
    // reconstructs the leader's outcome for its own transcript.
    expect(caught?.exitCode).toBe(3);
    expect(caught?.timedOut).toBe(false);
    expect(caught?.stderrTail).toContain("boom-detail");

    // ENOENT emits ZERO chunk events, so before the tail was attached the reason for the most
    // common operator mistake (a typo'd command) appeared in no UI at all.
    const { wt: wt2 } = makeWorktree("chimera-ws-tail-enoent-");
    const events2: Record<string, unknown>[] = [];
    await expect(
      runWorktreeSetup({ hook: hook("chimera-no-such-binary-xyz"), workdir: wt2, mainRepo: wt2, branch: null, project: "p1", emit: (e) => events2.push(e) }),
    ).rejects.toThrow(WorktreeSetupError);
    const failEvent2 = events2.find((e) => e.phase === "fail");
    expect(String(failEvent2?.stderrTail ?? "")).not.toBe("");
  });
});
