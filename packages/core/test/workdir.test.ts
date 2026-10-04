import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  ensureWorkdir,
  branchNameFor,
  currentWorkdirHeadSha,
  autoCommitDirtyWorktree,
  setupWorktreeNodeModules,
  repairMainChimeraLinks,
} from "@chimera/core/workdir";
import { GuardrailError } from "@chimera/core/supervisor";

// CORE-SUITE-BASELINE: every test here shells out to real `git worktree`/`git commit` —
// under this machine's concurrent-agent load that can exceed vitest's 5000ms default;
// widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 60_000 });

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function headSha(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
}

// Simulates a pnpm-installed monorepo checkout: committed packages/<name>/package.json for
// each name, plus a node_modules/@chimera/<name> -> packages/<name> symlink and one ordinary
// (non-@chimera) dependency directory, matching the real repo's node_modules shape closely
// enough to reproduce the corruption mechanism under test.
function initRepoWithPackages(prefix: string, pkgNames: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  for (const pkg of pkgNames) {
    mkdirSync(join(repo, "packages", pkg), { recursive: true });
    writeFileSync(join(repo, "packages", pkg, "package.json"), JSON.stringify({ name: `@chimera/${pkg}` }));
  }
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  mkdirSync(join(repo, "node_modules", "@chimera"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "some-dep", "index.js"), "module.exports = 1;");
  for (const pkg of pkgNames) {
    symlinkSync(join(repo, "packages", pkg), join(repo, "node_modules", "@chimera", pkg));
  }
  return repo;
}

describe("ensureWorkdir", () => {
  it("returns cwd unchanged for isolation none", () => {
    expect(ensureWorkdir({ isolation: "none", cwd: "/tmp/x", agentId: "a1" }))
      .toEqual({ workdir: "/tmp/x", branch: null, baseSha: null, mainRepo: null, created: false });
  });

  it("creates a named-branch git worktree for isolation worktree", () => {
    const repo = initRepo("chimera-wt-");
    const sha = headSha(repo);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-9" });
    expect(info.workdir).toBe(join(repo, ".chimera", "worktrees", "ag-9"));
    expect(existsSync(join(info.workdir, ".git"))).toBe(true);
    expect(info.branch).toBe("chimera/ag-9");
    expect(info.baseSha).toBe(sha);
    expect(info.mainRepo).toBe(repo);
    expect(info.created).toBe(true);
    expect(execFileSync("git", ["-C", info.workdir, "branch", "--show-current"]).toString().trim())
      .toBe("chimera/ag-9");
  });

  it("throws GuardrailError outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-nowt-"));
    expect(() => ensureWorkdir({ isolation: "worktree", cwd: dir, agentId: "ag-9" }))
      .toThrow(GuardrailError);
  });

  it("throws a GuardrailError with code \"guardrail\" (not a generic Error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-nowt-code-"));
    expect.assertions(2);
    try {
      ensureWorkdir({ isolation: "worktree", cwd: dir, agentId: "ag-9" });
    } catch (e) {
      expect(e).toBeInstanceOf(GuardrailError);
      expect((e as InstanceType<typeof GuardrailError>).code).toBe("guardrail");
    }
  });

  it("reuses an existing worktree on a second call with the same agentId instead of re-adding it", () => {
    // A second `git worktree add` at a path that already exists throws — so a second
    // call only succeeds (returning the same path, without throwing) if the
    // existsSync(wt) guard short-circuits before shelling out again. This is the
    // Phase-1-Task-17 failover-retry guard; losing it turns a retried spawn into a
    // GuardrailError instead of resuming the prior worktree.
    const repo = initRepo("chimera-wt-reuse-");
    const spec = { isolation: "worktree" as const, cwd: repo, agentId: "ag-retry" };
    const first = ensureWorkdir(spec);
    const second = ensureWorkdir(spec);
    expect(second.workdir).toBe(first.workdir);
    expect(second.branch).toBe(first.branch);
    expect(existsSync(join(second.workdir, ".git"))).toBe(true);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("falls back to the existing branch when it survives a removed worktree (retry after cleanup)", () => {
    const repo = initRepo("chimera-wt-branchonly-");
    const spec = { isolation: "worktree" as const, cwd: repo, agentId: "ag-again" };
    const first = ensureWorkdir(spec);
    // Simulate a prior attempt's worktree having been landed + removed, leaving its
    // branch behind (as the LAND-ON-MAIN flow does: merge, then `worktree remove`,
    // then `branch -D` — but a retry can race in before the branch is deleted).
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", first.workdir]);
    const second = ensureWorkdir(spec);
    expect(second.workdir).toBe(first.workdir);
    expect(second.branch).toBe(first.branch);
    expect(existsSync(join(second.workdir, ".git"))).toBe(true);
    // The worktree directory was removed, so this re-add takes the "fresh worktree add" path
    // (existsSync(wt) is false) even though the branch survived — created is keyed on the
    // worktree dir, not the branch.
    expect(second.created).toBe(true);
    expect(execFileSync("git", ["-C", second.workdir, "branch", "--show-current"]).toString().trim())
      .toBe(first.branch);
  });

  it("WF-7: keys the worktree/branch on workdirKey instead of agentId when set", () => {
    const repo = initRepo("chimera-wt-key-");
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-9", workdirKey: "task-abc" });
    expect(info.workdir).toBe(join(repo, ".chimera", "worktrees", "task-abc"));
    expect(info.branch).toBe("chimera/task-abc");
    expect(execFileSync("git", ["-C", info.workdir, "branch", "--show-current"]).toString().trim())
      .toBe("chimera/task-abc");
    expect(info.created).toBe(true);
  });

  it("WF-7: two sequential agents with different agentIds but the same workdirKey share one worktree/branch", () => {
    const repo = initRepo("chimera-wt-shared-");
    const first = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-one", workdirKey: "task-shared" });
    const second = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-two", workdirKey: "task-shared" });
    expect(second.workdir).toBe(first.workdir);
    expect(second.branch).toBe(first.branch);
    expect(second.workdir).toBe(join(repo, ".chimera", "worktrees", "task-shared"));
    expect(existsSync(join(second.workdir, ".git"))).toBe(true);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("WF-7: is byte-identical to the pre-workdirKey behavior when workdirKey is absent", () => {
    const repo = initRepo("chimera-wt-nokey-");
    const sha = headSha(repo);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-plain" });
    expect(info.workdir).toBe(join(repo, ".chimera", "worktrees", "ag-plain"));
    expect(info.branch).toBe("chimera/ag-plain");
    expect(info.baseSha).toBe(sha);
    expect(info.mainRepo).toBe(repo);
    expect(info.created).toBe(true);
  });

  // Regression: two workflow tasks whose sharedWorkdirKey(taskId) = `task-${taskId}` share
  // the first 8 characters used to derive the SAME branch (branchNameFor sliced to 8 chars).
  // The second call's `git worktree add -b <branch>` failed (branch taken by the first
  // worktree), and the fallback `git worktree add <wt> <branch>` also failed (branch already
  // checked out elsewhere) — surfacing as a GuardrailError that livelocks the second task.
  // Distinct full keys must produce distinct worktrees/branches even with a shared prefix.
  it("does not collide when two distinct workdirKeys share their first 8 characters", () => {
    const repo = initRepo("chimera-wt-collision-");
    const keyA = "task-abcdef12-1111-1111-1111-111111111111";
    const keyB = "task-abcdef12-2222-2222-2222-222222222222";
    expect(keyA.slice(0, 8)).toBe(keyB.slice(0, 8));

    const first = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-a", workdirKey: keyA });
    const second = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-b", workdirKey: keyB });

    expect(second.workdir).not.toBe(first.workdir);
    expect(second.branch).not.toBe(first.branch);
    expect(existsSync(join(first.workdir, ".git"))).toBe(true);
    expect(existsSync(join(second.workdir, ".git"))).toBe(true);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
  });
});

// REAP-SAFETY: direct unit coverage of the snapshot primitive itself (supervisor.test.ts
// covers the kill()/reportUnresponsive() wiring end-to-end).
describe("autoCommitDirtyWorktree", () => {
  it("commits an uncommitted change to the agent's own branch", () => {
    const repo = initRepo("chimera-wt-autocommit-");
    const spec = { isolation: "worktree" as const, cwd: repo, agentId: "ag-dirty" };
    const info = ensureWorkdir(spec);
    writeFileSync(join(info.workdir, "wip.txt"), "in progress");

    autoCommitDirtyWorktree(spec, "test reap");

    expect(execFileSync("git", ["-C", info.workdir, "status", "--porcelain"]).toString().trim()).toBe("");
    expect(execFileSync("git", ["-C", info.workdir, "log", "--oneline"]).toString()).toContain("chimera-autosave: test reap");
  });

  it("is a no-op on a clean worktree", () => {
    const repo = initRepo("chimera-wt-autocommit-clean-");
    const spec = { isolation: "worktree" as const, cwd: repo, agentId: "ag-clean" };
    const info = ensureWorkdir(spec);
    const before = headSha(info.workdir);

    autoCommitDirtyWorktree(spec, "test reap");

    expect(headSha(info.workdir)).toBe(before);
  });

  it("is a no-op for isolation none", () => {
    expect(() => autoCommitDirtyWorktree({ isolation: "none", cwd: "/tmp/does-not-matter", agentId: "a1" }, "x"))
      .not.toThrow();
  });

  it("is a no-op when the worktree was never materialized (or was already landed+removed)", () => {
    const repo = initRepo("chimera-wt-autocommit-gone-");
    expect(() => autoCommitDirtyWorktree({ isolation: "worktree", cwd: repo, agentId: "never-spawned" }, "x"))
      .not.toThrow();
  });
});

// FEATURE-2 (durable checkpoint-resume)
describe("branchNameFor", () => {
  it("matches ensureWorkdir's own branch derivation for the same key — single source of truth", () => {
    const repo = initRepo("chimera-wt-branchname-");
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-x", workdirKey: "task-abcdef123" });
    expect(branchNameFor("task-abcdef123")).toBe(info.branch);
    expect(branchNameFor("task-abcdef123")).toBe("chimera/task-abcdef123");
  });

  // Regression for the workdir branch-name collision bug: scheduler.ts's
  // sharedWorkdirKey(taskId) = `task-${taskId}` used to get sliced to 8 chars by
  // branchNameFor, which kept only "task-" plus the first 3 hex chars of the uuid —
  // collapsing the branch namespace to 4096 possibilities. Two distinct task uuids sharing
  // that 3-char prefix would collide, and the second task's ensureWorkdir would hit a
  // GuardrailError (branch already checked out for the first task's worktree), which
  // spawnForTask treats as starvation — livelocking the second task forever.
  it("gives distinct branches to distinct keys even when they share an 8-char prefix", () => {
    const keyA = "task-abcdef12-1111-1111-1111-111111111111";
    const keyB = "task-abcdef12-2222-2222-2222-222222222222";
    expect(keyA.slice(0, 8)).toBe(keyB.slice(0, 8)); // same prefix, would have collided under the old formula
    expect(branchNameFor(keyA)).not.toBe(branchNameFor(keyB));
  });
});

describe("currentWorkdirHeadSha", () => {
  it("returns the real HEAD sha for a valid git worktree", () => {
    const repo = initRepo("chimera-wt-headsha-");
    expect(currentWorkdirHeadSha(repo)).toBe(headSha(repo));
  });

  it("returns null (does not throw) for a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-nogit-"));
    expect(currentWorkdirHeadSha(dir)).toBeNull();
  });

  it("RESUME PROOF: a second ensureWorkdir call with a DIFFERENT agentId but the SAME " +
     "workdirKey (simulating a crash-recovered fresh respawn) returns the SAME worktree with " +
     "the prior commit still intact — not a fresh branch", () => {
    const repo = initRepo("chimera-wt-resume-");
    const key = "task-resume-x";
    const first = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-A", workdirKey: key });
    // simulate in-progress agent work inside the worktree, then a crash before the step's gate
    // ever evaluated.
    execFileSync("git", ["-C", first.workdir, "commit", "-q", "--allow-empty", "-m", "partial work"]);
    const workSha = headSha(first.workdir);
    expect(workSha).not.toBe(first.baseSha);

    // scheduler re-dispatches after "restart" — a fresh agentId, same stable workdirKey.
    const second = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "agent-B", workdirKey: key });
    expect(second.workdir).toBe(first.workdir);
    expect(second.branch).toBe(first.branch);
    expect(currentWorkdirHeadSha(second.workdir)).toBe(workSha);   // the commit survived
  });
});

// NODE-MODULES-CORRUPTION-ROOTCAUSE: root cause confirmed live (see workdir.ts doc comments on
// setupWorktreeNodeModules / repairMainChimeraLinks) — a hand-rolled worktree setup does
// `ln -s <mainRepo>/node_modules <worktreeDir>/node_modules` (a WHOLE-DIRECTORY symlink), then
// "repoints @chimera/* to the worktree's own packages" believing that only affects the
// worktree. Because node_modules itself is a symlink into main, that repoint actually rewrites
// main's real @chimera links. These tests reproduce that exact sequence.
describe("node_modules corruption (root cause + fix)", () => {
  it("REGRESSION: reproduces the whole-directory-symlink corrupting sequence and proves " +
     "repairMainChimeraLinks — wired into every ensureWorkdir call — heals main afterwards", () => {
    const repo = initRepoWithPackages("chimera-corrupt-", ["foo", "bar"]);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-corrupt" });
    const wt = info.workdir;

    // The OLD (bad) hand-rolled step: symlink the ENTIRE node_modules dir from main.
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
    // "Reinstall @chimera/* to point at the worktree's own sibling packages" — believed to be
    // scoped to the worktree.
    rmSync(join(wt, "node_modules", "@chimera", "foo"));
    symlinkSync(join(wt, "packages", "foo"), join(wt, "node_modules", "@chimera", "foo"));

    // Sanity check: prove the bug actually reproduced — main's OWN link now resolves into the
    // worktree instead of its own packages/foo. Without this assertion the test below could
    // pass vacuously (nothing to repair).
    expect(realpathSync(join(repo, "node_modules", "@chimera", "foo")))
      .toBe(realpathSync(join(wt, "packages", "foo")));
    expect(realpathSync(join(repo, "node_modules", "@chimera", "foo")))
      .not.toBe(realpathSync(join(repo, "packages", "foo")));

    // The next spawn's ensureWorkdir call self-heals main — bounding the damage to "until the
    // next spawn" instead of "until a human notices tsc lying."
    ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-corrupt-2" });

    expect(realpathSync(join(repo, "node_modules", "@chimera", "foo")))
      .toBe(realpathSync(join(repo, "packages", "foo")));
    // bar was never touched — repair must not disturb links that were already correct.
    expect(realpathSync(join(repo, "node_modules", "@chimera", "bar")))
      .toBe(realpathSync(join(repo, "packages", "bar")));
  });

  it("setupWorktreeNodeModules gives the worktree a REAL node_modules directory, so a later " +
     "@chimera repoint inside the worktree can never reach main", () => {
    const repo = initRepoWithPackages("chimera-setup-", ["foo", "bar"]);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-setup" });
    const wt = info.workdir;

    setupWorktreeNodeModules(repo, wt);

    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, "node_modules", "@chimera")).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(wt, "node_modules", "@chimera", "foo")))
      .toBe(realpathSync(join(wt, "packages", "foo")));
    // ordinary (non-@chimera) deps are shared via symlink — cheap, and safe since nothing ever
    // writes back into them.
    expect(realpathSync(join(wt, "node_modules", "some-dep")))
      .toBe(realpathSync(join(repo, "node_modules", "some-dep")));

    const mainFooBefore = realpathSync(join(repo, "node_modules", "@chimera", "foo"));
    // Simulate the exact mistaken re-repoint this whole fix exists to neutralize.
    rmSync(join(wt, "node_modules", "@chimera", "foo"));
    symlinkSync(join(wt, "packages", "bar"), join(wt, "node_modules", "@chimera", "foo"));

    // Main's link is untouched: the write physically could not reach it, because the
    // worktree's node_modules is now a real directory, not a symlink into main.
    expect(realpathSync(join(repo, "node_modules", "@chimera", "foo"))).toBe(mainFooBefore);
  });

  it("setupWorktreeNodeModules refuses (GuardrailError) instead of proceeding when node_modules " +
     "already resolves into the main checkout", () => {
    const repo = initRepoWithPackages("chimera-guard-", ["foo"]);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-guard" });
    const wt = info.workdir;
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));

    expect(() => setupWorktreeNodeModules(repo, wt)).toThrow(GuardrailError);
  });

  it("setupWorktreeNodeModules refuses to run against the main checkout itself", () => {
    const repo = initRepoWithPackages("chimera-mainrefuse-", ["foo"]);
    expect(() => setupWorktreeNodeModules(repo, repo)).toThrow(GuardrailError);
  });

  it("setupWorktreeNodeModules is idempotent — a second call on an already-set-up worktree is a no-op", () => {
    const repo = initRepoWithPackages("chimera-idempotent-", ["foo"]);
    const info = ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: "ag-idempotent" });
    const wt = info.workdir;
    setupWorktreeNodeModules(repo, wt);
    expect(() => setupWorktreeNodeModules(repo, wt)).not.toThrow();
    expect(realpathSync(join(wt, "node_modules", "@chimera", "foo")))
      .toBe(realpathSync(join(wt, "packages", "foo")));
  });

  it("repairMainChimeraLinks is a silent no-op when main has no node_modules yet", () => {
    const repo = initRepo("chimera-norepair-");
    expect(repairMainChimeraLinks(repo)).toEqual([]);
  });
});
