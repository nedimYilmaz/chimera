import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";
import { reconstructAgentsFromLog } from "@chimera/core/replay";

// CORE-SUITE-RESIDUAL: this file landed after the CORE-SUITE-BASELINE sweep (a845788,
// STALE-WORKTREE-RECORD) and was never widened — every test here shells out to real `git
// worktree add`/`commit`/`merge` (kill()'s own worktreeUnlanded check adds another git
// shell-out on top), which can exceed vitest's bare 5000ms default under this machine's
// concurrent-agent load; widened per existing precedent (supervisor-reap-autocommit.test.ts).
vi.setConfig({ testTimeout: 45_000 });

// STALE-WORKTREE-RECORD (seed backlog item 3): "There is no cheap way to know a worktree is
// stale." A janitor used to have no durable fact to read — it would have to re-shell to git and
// re-derive branch-vs-main liveness on every sweep, for every worktree, forever. This proves
// kill()/reportUnresponsive() (the two real reap paths fixed by REAP-SAFETY) now also stamp
// AgentRecord.worktreeUnlanded the instant a worktree-isolated agent dies, so that fact is a
// cheap field read from then on instead of a git shell-out.
//
// The fake backend never calls ensureWorkdir (see supervisor-resume.test.ts's precedent), so
// each test materializes the worktree by hand exactly the way a real backend would have.

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];

describe("STALE-WORKTREE-RECORD: durably record whether a reaped worktree's work landed", () => {
  it("kill() on a branch with unmerged commits stamps worktreeUnlanded: true", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-1" });
    const wt = join(dir, ".chimera", "worktrees", "land-1");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-1", wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);

    await sup.kill("land-1");

    const record = sup.status("land-1");
    expect(record.worktreeUnlanded).toBe(true);
    expect(typeof record.worktreeLandingCheckedAt).toBe("number");
  });

  it("kill() on a branch already merged (--no-ff) into main stamps worktreeUnlanded: false", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-2" });
    const wt = join(dir, ".chimera", "worktrees", "land-2");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-2", wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "landed work"]);
    execFileSync("git", ["-C", dir, "merge", "--no-ff", "-q", "-m", "merge", "chimera/land-2"]);

    await sup.kill("land-2");

    expect(sup.status("land-2").worktreeUnlanded).toBe(false);
  });

  it("reportUnresponsive() (the liveness-monitor reap path) stamps it too, not just explicit kill", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-3" });
    const wt = join(dir, ".chimera", "worktrees", "land-3");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-3", wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "backgrounded work"]);

    sup.reportUnresponsive("land-3", 999_999, 500_000);

    expect(sup.status("land-3").worktreeUnlanded).toBe(true);
  });

  it("is a no-op for isolation:none (byte-identical to before this fix)", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none" }, { agentId: "land-4" });

    await sup.kill("land-4");

    expect(sup.status("land-4").worktreeUnlanded).toBeUndefined();
    expect(sup.status("land-4").worktreeLandingCheckedAt).toBeUndefined();
  });

  // STALE-WORKTREE-RECORD-GAP (this run): the worktree directory is gone by reap time, but
  // `git worktree remove` never deletes the branch -- and checkWorktreeUnlanded now falls back
  // to reading it directly (its name is deterministic: branchNameFor(worktreeKey(spec)), the
  // exact one ensureWorkdir gave it, no probe/race involved). land-5's branch never diverged
  // from main (no commit made before the directory was removed), so its tip trivially IS main's
  // HEAD -- correctly "landed" (nothing was ever at risk), no longer a blind "no fact" no-op.
  it("worktree directory already gone at reap time, but its never-diverged branch survives: stamps worktreeUnlanded: false (not a no-op)", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-5" });
    const wt = join(dir, ".chimera", "worktrees", "land-5");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-5", wt]);
    execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });

    await sup.kill("land-5");

    expect(sup.status("land-5").worktreeUnlanded).toBe(false);
  });

  // Same "directory already gone" shape as above, but the branch DID diverge and was never
  // merged -- the fallback must still report true, never a false "safe."
  it("worktree directory already gone at reap time, with unmerged commits on the surviving branch: stamps worktreeUnlanded: true", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-5b" });
    const wt = join(dir, ".chimera", "worktrees", "land-5b");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-5b", wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);
    execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });

    await sup.kill("land-5b");

    expect(sup.status("land-5b").worktreeUnlanded).toBe(true);
  });

  // The residual gap this run's fix narrows but doesn't close: if the BRANCH is also gone (e.g.
  // deleted as the last step of a land, same as the directory), there is genuinely no fact left
  // to read -- still a no-op, same as before this run.
  it("is still a no-op when BOTH the worktree directory and its branch are already gone by reap time", async () => {
    const { sup, dir } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-5c" });
    const wt = join(dir, ".chimera", "worktrees", "land-5c");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-5c", wt]);
    execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt]);
    execFileSync("git", ["-C", dir, "branch", "-D", "chimera/land-5c"]);
    rmSync(wt, { recursive: true, force: true });

    await sup.kill("land-5c");

    expect(sup.status("land-5c").worktreeUnlanded).toBeUndefined();
  });

  it("the fact survives a boot-replay fold, riding its own status event like crashCount/circuitOpen do", async () => {
    const { sup, dir, events } = makeSupervisor([RUNNING]);
    initRepo(dir);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "land-6" });
    const wt = join(dir, ".chimera", "worktrees", "land-6");
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", "chimera/land-6", wt]);
    execFileSync("git", ["-C", wt, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", wt, "config", "user.name", "test"]);
    execFileSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", "unlanded work"]);

    await sup.kill("land-6");
    const live = sup.status("land-6");
    expect(live.worktreeUnlanded).toBe(true);

    // Reconstruct a bare record purely from the durable event log, exactly as reattach.ts's
    // boot recovery does after a daemon restart — no in-memory record survives that.
    const bare = { ...live, worktreeUnlanded: undefined, worktreeLandingCheckedAt: undefined };
    const [replayed] = reconstructAgentsFromLog([bare], events.replay({ fromSeq: 0, limit: Number.MAX_SAFE_INTEGER }));
    expect(replayed!.worktreeUnlanded).toBe(true);
    expect(replayed!.worktreeLandingCheckedAt).toBe(live.worktreeLandingCheckedAt);
  });
});
