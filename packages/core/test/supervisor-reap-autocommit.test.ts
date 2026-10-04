import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// REAP-SAFETY: real failure observed twice in one night — an agent backgrounds a long run,
// ends its turn to wait for it, gets reaped (killed outright, or by the liveness-monitor's
// unresponsive-probe), and every uncommitted change in its worktree is gone. The doctrine
// forbidding this is in every role template; it was ignored anyway. This proves the fix makes
// losing that work structurally impossible: supervisor.kill()/reportUnresponsive() now snapshot
// a live worktree-isolated agent's dirty tree to its own branch the instant it dies, regardless
// of whether the agent itself ever got around to committing.
//
// The fake backend never calls ensureWorkdir (see supervisor-resume.test.ts's precedent), so
// each test materializes the worktree by hand exactly the way a real backend would have.

// CORE-SUITE-BASELINE: every test here shells out to real `git worktree`/`git commit` —
// under this machine's concurrent-agent load that can exceed vitest's 5000ms default;
// widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 45_000 });

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];

describe("REAP-SAFETY: auto-commit a worktree-isolated agent's uncommitted work on reap", () => {
  it("kill() snapshots uncommitted worktree changes instead of losing them", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "reap-1" });
    const wt = join(dir, ".chimera", "worktrees", "reap-1");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/reap-1", wt]);
    writeFileSync(join(wt, "wip.txt"), "uncommitted work in progress");

    await sup.kill("reap-1");

    const status = execFileSync("git", ["-C", wt, "status", "--porcelain"]).toString();
    expect(status.trim()).toBe("");   // nothing left uncommitted — the snapshot captured it
    const log = execFileSync("git", ["-C", wt, "log", "--oneline"]).toString();
    expect(log).toContain("chimera-autosave");
    const committed = execFileSync("git", ["-C", wt, "show", "HEAD:wip.txt"]).toString();
    expect(committed).toBe("uncommitted work in progress");
  });

  it("reportUnresponsive() (the liveness-monitor reap path) snapshots too, not just explicit kill", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "reap-2" });
    const wt = join(dir, ".chimera", "worktrees", "reap-2");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/reap-2", wt]);
    writeFileSync(join(wt, "wip.txt"), "backgrounded work nobody ever committed");

    sup.reportUnresponsive("reap-2", 999_999, 500_000);

    const status = execFileSync("git", ["-C", wt, "status", "--porcelain"]).toString();
    expect(status.trim()).toBe("");
    const committed = execFileSync("git", ["-C", wt, "show", "HEAD:wip.txt"]).toString();
    expect(committed).toBe("backgrounded work nobody ever committed");
  });

  it("is a no-op on an already-clean worktree (no spurious empty auto-commit)", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "reap-3" });
    const wt = join(dir, ".chimera", "worktrees", "reap-3");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/reap-3", wt]);
    const before = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"]).toString();

    await sup.kill("reap-3");

    const after = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"]).toString();
    expect(after).toBe(before);
  });

  it("is a no-op for isolation:none (nothing to snapshot, byte-identical to before this fix)", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none" }, { agentId: "reap-4" });
    // KILL-REPORTS-TRUTHFULLY: kill() answers whether it actually killed a LIVE agent. The
    // point here is still "does not throw"; the boolean is incidental to this test.
    await expect(sup.kill("reap-4")).resolves.toBeTypeOf("boolean");
  });
});
