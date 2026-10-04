import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
// From errors.js, NOT supervisor.js: supervisor.ts pulls in @chimera/protocol (zod) and a large
// transitive graph. setupWorktreeNodeModules/repairMainChimeraLinks below are called by
// scripts/setup-worktree-modules.mjs BEFORE a fresh worktree has any node_modules at all — that
// bootstrap must not depend on anything that itself needs node_modules to already be resolvable.
import { GuardrailError } from "./errors.js";
import type { ResolvedAgentSpec } from "./backend.js";

export type WorkdirInfo = {
  workdir: string;
  branch: string | null;
  baseSha: string | null;
  mainRepo: string | null;
  // True only on the "fresh worktree add" path below; a reused worktree (rate-limit failover
  // retry) or isolation:"none" reports false. NOTE it is NOT what gates the F26 setup hook —
  // runWorktreeSetupHook gates the RUN on the on-disk marker instead, because a worktree can
  // survive a daemon restart (or a refused spawn) with the hook never having run. What it does
  // gate there is the failure TEARDOWN (removeWorktree below): only a worktree this attempt
  // created may be force-removed.
  created: boolean;
};

function currentHead(cwd: string, onFailure: (e: Error) => never): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    return onFailure(e as Error);
  }
}

// FEATURE-2: non-throwing HEAD read for checkpoint capture (contrast currentHead above, which
// throws via its onFailure callback — ensureWorkdir needs a hard failure on a missing repo,
// checkpoint capture must not; a null here just means "couldn't read it this time," not a
// workflow error).
export function currentWorkdirHeadSha(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

// GATE-CANNOT-TELL-LANDED-FROM-EMPTY: a `command` gate that shells out to `git log
// main..HEAD` (or similar) can't tell "nothing was committed" apart from "it WAS committed and
// then already merged to main" — CLAUDE.md's own land-on-main doctrine has the implement step
// merge mid-task, before the gate that's supposed to verify its work ever runs. Mirrors
// checkWorktreeUnlanded's identical merge-base check, but keyed off an explicit (mainRepo, sha)
// pair — the checkpoint's, not a live AgentRecord's — so a gate evaluation (which has no
// AgentRecord assumptions to lean on) can call it directly. Returns false on any git failure
// (unreadable repo, unknown sha) — "not confirmed landed" is always the safe default.
export function isShaAncestorOfMain(mainRepo: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", mainRepo, "merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// WF-7: workdirKey lets multiple (sequential) agentIds share one worktree/branch — e.g. a
// workflow's step-role switches, where each step spawns a DIFFERENT agentId but all must see
// the same shared task workspace. Absent → keyed on agentId exactly as before.
function worktreeKey(spec: Pick<ResolvedAgentSpec, "agentId" | "workdirKey">): string {
  return spec.workdirKey ?? spec.agentId;
}

// Exported so recovery paths (AGENT-RESUME-TOOLS: supervisor.resume) can compute a dead
// worktree agent's DETERMINISTIC worktree dir without re-deriving the `.chimera/worktrees/<key>`
// layout by hand — and, unlike resolveWorkdirPath below, WITHOUT the silent fall-back to
// spec.cwd, so the caller can existsSync the returned path and refuse a landed/removed worktree.
export function worktreePath(spec: Pick<ResolvedAgentSpec, "cwd" | "agentId" | "workdirKey">): string {
  return join(spec.cwd, ".chimera", "worktrees", worktreeKey(spec));
}

// FEATURE-2: pure branch-name derivation, extracted out of ensureWorkdir so scheduler.ts's
// checkpoint capture can compute the SAME name without re-deriving/guessing it.
//
// BUG FIX: this used to slice(0, 8), which for scheduler.ts's sharedWorkdirKey(taskId) =
// `task-${taskId}` kept only the "task-" prefix plus the FIRST 3 hex chars of the uuid —
// collapsing the entire branch namespace to 16^3 = 4096 possible names. Two concurrent tasks
// whose taskId shared that 3-char prefix would derive the SAME branch, and the second task's
// ensureWorkdir would hit a GuardrailError (branch already checked out elsewhere) that
// spawnForTask treats as starvation — livelocking that task forever. workdirKey is already a
// unique identifier (an agentId uuid, or `task-<uuid>`) so using it whole is both simpler and
// collision-free; no truncation needed.
export function branchNameFor(workdirKey: string): string {
  return `chimera/${workdirKey}`;
}

// WF-3 (G1): pure, side-effect-free path resolution reused by gate execution — the
// worktree dir if isolation:"worktree" and it already exists, else spec.cwd. Unlike
// ensureWorkdir, this never creates a worktree or shells out to git, so it's safe to
// call on every gate evaluation (a live agent's worktree should already exist by then;
// isolation:"none" or a not-yet-materialized worktree both fall back to spec.cwd).
export function resolveWorkdirPath(spec: Pick<ResolvedAgentSpec, "isolation" | "cwd" | "agentId" | "workdirKey">): string {
  if (spec.isolation !== "worktree") return spec.cwd;
  const wt = worktreePath(spec);
  return existsSync(wt) ? wt : spec.cwd;
}

// REAP-SAFETY: makes "the agent got killed (or reaped by the liveness monitor after
// backgrounding a long run and never coming back) and its uncommitted worktree diff just
// vanished" structurally impossible instead of merely forbidden by doctrine — the same
// instruction, in the same role template, has been observed ignored by real agents. Called by
// supervisor.kill()/reportUnresponsive() the moment a live worktree-isolated agent transitions
// to killed: snapshots whatever is on disk to the agent's own branch before anyone even asks
// whether the no-backgrounding rule was followed. No-ops (cheap: one `git status`) for
// isolation:"none", a not-yet-materialized/already-removed worktree, or an already-clean one —
// so a normal, already-committed teardown never grows a spurious empty commit.
//
// --no-verify is deliberate: this is a crash-recovery snapshot, not a reviewed commit. A
// pre-commit hook rejecting it would silently defeat the entire safety net, which is worse than
// an unformatted snapshot landing on a throwaway agent branch that only a human recovering lost
// work will ever read. Best-effort throughout — a failing snapshot must never block the
// kill/recovery path it guards.
export function autoCommitDirtyWorktree(
  spec: Pick<ResolvedAgentSpec, "isolation" | "cwd" | "agentId" | "workdirKey">,
  reason: string,
): void {
  if (spec.isolation !== "worktree") return;
  const wt = worktreePath(spec);
  if (!existsSync(wt)) return;
  let status: string;
  try {
    status = execFileSync("git", ["-C", wt, "status", "--porcelain"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch {
    return;
  }
  if (!status.trim()) return;
  try {
    execFileSync("git", ["-C", wt, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", wt, "commit", "--no-verify", "-m", `chimera-autosave: ${reason}`], { stdio: "pipe" });
  } catch {
    // best-effort — see doc comment above.
  }
}

// STALE-WORKTREE-RECORD: seed backlog item 3 — "no cheap way to know a worktree is stale."
// Cleanup used to have to re-derive a reaped agent's git state from scratch on every sweep
// (walk the worktree, diff it against main). Called right after autoCommitDirtyWorktree at the
// exact moment a live worktree-isolated agent is reaped (kill()/reportUnresponsive()), this
// takes ONE cheap git snapshot — is the branch tip an ancestor of main's HEAD? — and its caller
// stamps the result onto the record so a future janitor can read AgentRecord.worktreeUnlanded
// directly instead of shelling to git again. Returns null (no fact to record) for
// isolation:"none" — the record simply keeps no stale opinion rather than a wrong one. Any
// ambiguous outcome (unreadable HEAD, main unresolvable, no common history) reports unlanded:
// true — a landing check this function can't positively confirm must never read as "safe to
// throw away."
//
// STALE-WORKTREE-RECORD-GAP (this run): the original version returned null whenever the
// worktree DIRECTORY was already gone, on the theory that a gone worktree means "landed and
// cleaned up, or never materialized" — but a concurrent land (a different process merging and
// running `git worktree remove`) can remove the directory while THIS agent is still "running"
// and gets reaped moments later, e.g. a separate merge process racing supervisor.kill()'s reap.
// `git worktree remove` does not delete the branch by itself, so the branch a reap needs to
// check is very often still sitting in the main repo even once the directory is gone. Its name
// is not a guess: ensureWorkdir (below) always names it `branchNameFor(worktreeKey(spec))` —
// deterministic from spec alone, no probe, no race with a live gitBranch stamp that may not
// have run yet or may have (per AGENT-RECORD-GITBRANCH-LIES) been stamped before the worktree
// even existed. Falls through to the original null only if the branch is ALSO gone (deleted as
// part of the same land, or never created) — a narrower version of the same "no fact" gap, not
// a new false-positive risk.
export function checkWorktreeUnlanded(
  spec: Pick<ResolvedAgentSpec, "isolation" | "cwd" | "agentId" | "workdirKey">,
): boolean | null {
  if (spec.isolation !== "worktree") return null;
  const wt = worktreePath(spec);
  let tip: string;
  if (existsSync(wt)) {
    try {
      tip = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    } catch {
      return null;
    }
  } else {
    try {
      tip = execFileSync(
        "git", ["-C", spec.cwd, "rev-parse", branchNameFor(worktreeKey(spec))],
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString().trim();
    } catch {
      return null;   // branch also gone (or never created) -- no fact to report, same as before
    }
  }
  try {
    execFileSync("git", ["-C", spec.cwd, "merge-base", "--is-ancestor", tip, "HEAD"], { stdio: "pipe" });
    return false;   // branch tip already reachable from main's HEAD -> landed
  } catch {
    return true;    // not an ancestor, or the check itself failed -> report unlanded, never a false "safe"
  }
}

// NODE-MODULES-CORRUPTION-ROOTCAUSE: the corrupting sequence, reproduced and confirmed live
// four times, was always: `ln -s <mainRepo>/node_modules <worktreeDir>/node_modules` (a
// WHOLE-DIRECTORY symlink, done because a worktree has no node_modules and `pnpm install`
// there hangs on an interactive prompt), repeated at EVERY level that has one — pnpm gives each
// package its own node_modules (packages/core/node_modules/{zod,@chimera/protocol,...}), not
// just the root — followed by "reinstall packages/*/node_modules/@chimera/* to point at the
// worktree's own sibling packages." Because each node_modules dir is ITSELF a symlink into
// main, every path under it resolves through to main's real directory — the agent believes it
// is repointing its own tree but is actually rewriting the one shared directory that every
// other worktree (and main's own `tsc -b`) reads through. setupWorktreeNodeModules is the single
// correct implementation of this step for every node_modules dir in the tree (root + each
// package): it gives the worktree a REAL directory at each level (so no future write under it
// can ever reach main), while still sharing ordinary (non-@chimera) dependencies from main
// read-only, cheaply, via per-entry symlinks. It is the only thing agents/scripts should call —
// see scripts/setup-worktree-modules.mjs.
function linkOneNodeModulesDir(worktreeDir: string, mainModules: string, wtModules: string): void {
  if (!existsSync(mainModules)) return;
  // GUARD: compare against THIS level's main node_modules dir specifically — not "is this path
  // anywhere under the main checkout," which is trivially true for every worktree, since
  // worktrees live at <mainRepo>/.chimera/worktrees/<id>, itself nested inside the main
  // checkout's own directory tree.
  const mainModulesReal = realpathSync(mainModules);
  if (existsSync(wtModules)) {
    // Refuse to proceed if this node_modules dir IS (or resolves through) the exact corrupting
    // shape — a whole-directory symlink to the SAME dir main uses at this level — instead of
    // silently repointing @chimera through it. Idempotent no-op if it's already its own real
    // directory (prior successful setup at this level).
    const wtModulesReal = realpathSync(wtModules);
    if (wtModulesReal === mainModulesReal) {
      throw new GuardrailError(
        `${wtModules} resolves to the SAME directory main uses (${mainModulesReal}) — this is ` +
        `the known corrupting shape (whole-directory symlink into main); remove it and re-run ` +
        `instead of repointing @chimera/* through it`,
      );
    }
    return;
  }
  mkdirSync(wtModules);
  for (const entry of readdirSync(mainModules)) {
    if (entry === "@chimera") continue;
    symlinkSync(join(mainModules, entry), join(wtModules, entry));
  }
  const mainChimera = join(mainModules, "@chimera");
  if (!existsSync(mainChimera)) return;
  const wtChimera = join(wtModules, "@chimera");
  mkdirSync(wtChimera);
  for (const pkg of readdirSync(mainChimera)) {
    const pkgDirInWorktree = join(worktreeDir, "packages", pkg);
    if (!existsSync(join(pkgDirInWorktree, "package.json"))) continue;
    symlinkSync(pkgDirInWorktree, join(wtChimera, pkg));
  }
}

export function setupWorktreeNodeModules(mainRepo: string, worktreeDir: string): void {
  if (realpathSync(worktreeDir) === realpathSync(mainRepo)) {
    throw new GuardrailError(`refusing to run worktree node_modules setup against the main checkout itself (${mainRepo})`);
  }
  if (!existsSync(join(mainRepo, "node_modules"))) {
    throw new GuardrailError(`main checkout has no node_modules at ${join(mainRepo, "node_modules")} — run pnpm install there first`);
  }
  linkOneNodeModulesDir(worktreeDir, join(mainRepo, "node_modules"), join(worktreeDir, "node_modules"));
  for (const pkg of readdirSync(join(mainRepo, "packages"))) {
    const wtPkgDir = join(worktreeDir, "packages", pkg);
    if (!existsSync(join(wtPkgDir, "package.json"))) continue;
    linkOneNodeModulesDir(worktreeDir, join(mainRepo, "packages", pkg, "node_modules"), join(wtPkgDir, "node_modules"));
  }
}

// NODE-MODULES-CORRUPTION-ROOTCAUSE (containment half): bounds the damage from any OTHER path
// that still manages to rewrite main's own @chimera links (a stale worktree that set up before
// this fix existed, a hand-rolled shell step ignoring setupWorktreeNodeModules) to "until the
// next spawn," instead of "until a human notices tsc lying." Repairs any @chimera/<name> link
// under mainRepo/node_modules OR mainRepo/packages/*/node_modules that does not resolve inside
// mainRepo/packages — best-effort and silent on anything it can't safely fix (missing target,
// broken link) so it never turns a spawn into a hard failure.
function repairOneChimeraDir(chimeraDir: string, mainRepo: string, mainPackagesReal: string): string[] {
  if (!existsSync(chimeraDir)) return [];
  const repaired: string[] = [];
  for (const entry of readdirSync(chimeraDir)) {
    const linkPath = join(chimeraDir, entry);
    const correctTarget = join(mainRepo, "packages", entry);
    if (!existsSync(correctTarget)) continue;
    let target: string;
    try {
      target = realpathSync(linkPath);
    } catch {
      continue;
    }
    if (target === mainPackagesReal || target.startsWith(mainPackagesReal + sep)) continue;
    try {
      rmSync(linkPath, { force: true });
      symlinkSync(correctTarget, linkPath);
      repaired.push(entry);
    } catch {
      // best-effort — see doc comment above.
    }
  }
  return repaired;
}

export function repairMainChimeraLinks(mainRepo: string): string[] {
  if (!existsSync(join(mainRepo, "node_modules"))) return [];
  const mainPackagesReal = join(realpathSync(mainRepo), "packages");
  const repaired = repairOneChimeraDir(join(mainRepo, "node_modules", "@chimera"), mainRepo, mainPackagesReal);
  const mainPackagesDir = join(mainRepo, "packages");
  if (existsSync(mainPackagesDir)) {
    for (const pkg of readdirSync(mainPackagesDir)) {
      const chimeraDir = join(mainPackagesDir, pkg, "node_modules", "@chimera");
      repaired.push(...repairOneChimeraDir(chimeraDir, mainRepo, mainPackagesReal).map((e) => `${pkg}/node_modules/@chimera/${e}`));
    }
  }
  return repaired;
}

const INDEX_LOCK_RETRY_MAX = 5;
const INDEX_LOCK_RETRY_BASE_MS = 100;

// Blocking sleep for a synchronous retry loop — ensureWorkdir is called from launch() as a plain
// sync call (see supervisor.ts:1798), so an async backoff would mean threading a Promise through
// every caller just for this one rare-contention path. Atomics.wait is the standard Node idiom for
// "block this thread for N ms" without spinning the CPU.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// F08.QA-FIX item 4 (N4): under fleet load, concurrent `git worktree add` calls against the SAME
// main repo race for .git's index.lock — one of the two most common failures QA found invisible to
// every classifier. It is NOT a `classifyFailure`/failover.ts case: the lock is a turn-internal
// git-process contention that clears itself within milliseconds, never a backend `kind:"error"`
// event, so there is no FailureCause to record. QA's own recommendation (F08.md N4) is a bounded
// retry in the git helper instead of a classifier row — this is that retry.
function execGitWorktreeAdd(args: string[]): void {
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("git", args, { stdio: "pipe" });
      return;
    } catch (e) {
      const stderr = (e as { stderr?: Buffer | string }).stderr;
      const message = `${stderr ?? ""}${(e as Error).message ?? ""}`;
      if (!/index\.lock/i.test(message) || attempt >= INDEX_LOCK_RETRY_MAX) throw e;
      sleepSync(INDEX_LOCK_RETRY_BASE_MS * attempt);
    }
  }
}

// Best-effort teardown of a worktree this attempt just created — F26's fail-closed hook made a
// pre-existing leak routine: `git worktree add` runs before the hook, so one bad operator command
// used to orphan a worktree AND a branch on every spawn attempt. NEVER throws: a teardown failure
// must not mask the error that triggered it. Callers MUST gate on WorkdirInfo.created — a reused
// worktree can hold real uncommitted work that `--force` would destroy. `branch -d` (not -D) so a
// branch that somehow carries unmerged commits is kept rather than silently discarded.
export function removeWorktree(mainRepo: string, workdir: string, branch: string | null): void {
  try {
    execFileSync("git", ["-C", mainRepo, "worktree", "remove", "--force", workdir], { stdio: "pipe" });
  } catch {
    return; // the worktree survived — leave its branch checked out rather than half-cleaning.
  }
  if (!branch) return;
  try {
    execFileSync("git", ["-C", mainRepo, "branch", "-d", branch], { stdio: "pipe" });
  } catch { /* unmerged commits: keep the branch, the work in it is not ours to destroy */ }
}

export function ensureWorkdir(spec: Pick<ResolvedAgentSpec, "isolation" | "cwd" | "agentId" | "workdirKey">): WorkdirInfo {
  if (spec.isolation !== "worktree") return { workdir: spec.cwd, branch: null, baseSha: null, mainRepo: null, created: false };
  const wt = worktreePath(spec);
  const branch = branchNameFor(worktreeKey(spec));
  const fail = (e: Error): never => {
    throw new GuardrailError(`isolation "worktree" needs a git repo at ${spec.cwd}: ${e.message}`);
  };
  try { repairMainChimeraLinks(spec.cwd); } catch { /* best-effort containment, see doc comment above */ }
  // Reuse an existing worktree instead of re-adding it. A rate-limit failover retry
  // re-invokes spawn() with the SAME agentId (supervisor.launch(record, next)); a
  // second `git worktree add` on the same path would fail and turn the failover into
  // a hard "failed" state. The worktree from the prior attempt is ours — resume in it.
  if (existsSync(wt)) return { workdir: wt, branch, baseSha: currentHead(spec.cwd, fail), mainRepo: spec.cwd, created: false };
  const baseSha = currentHead(spec.cwd, fail);
  try {
    execGitWorktreeAdd(["-C", spec.cwd, "worktree", "add", "-b", branch, wt]);
  } catch (e) {
    // The branch may already exist from a prior attempt whose worktree was removed
    // (e.g. cleaned up after a merge) — reuse it instead of failing the retry.
    try {
      execGitWorktreeAdd(["-C", spec.cwd, "worktree", "add", wt, branch]);
    } catch {
      return fail(e as Error);
    }
  }
  return { workdir: wt, branch, baseSha, mainRepo: spec.cwd, created: true };
}
