import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { AuditLedger } from "@chimera/core/audit-ledger";
import { ChimeraConfigSchema, type WorktreeSetupHook, type AuditLedgerRecord } from "@chimera/protocol";
import { setupMarkerPath } from "@chimera/core/worktree-setup";
import { makeSupervisor } from "./helpers.js";

// Same shell-out-heavy precedent as supervisor-worktree-landing.test.ts: runWorktreeSetupHook
// now calls the REAL ensureWorkdir() (git worktree add) whenever a project + enabled hook are
// configured, so these tests don't need to hand-materialize the worktree first.
vi.setConfig({ testTimeout: 45_000 });

function initRepo(dir: string) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
}

function newAuditLedger(): { ledger: AuditLedger; records: () => AuditLedgerRecord[] } {
  const home = mkdtempSync(join(tmpdir(), "chimera-audit-"));
  const ledger = new AuditLedger(home);
  const path = join(home, "audit", "ledger.jsonl");
  const records = () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as AuditLedgerRecord)
      : [];
  return { ledger, records };
}

const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];

const HOOK: WorktreeSetupHook = { command: "true", enabled: true, timeoutSec: 30 };
// A hook that PRINTS, so a run emits start + >=1 chunk + ok (AC8 counts three phases; "true"
// alone would only ever produce two and silently under-prove the event contract).
const NOISY_HOOK: WorktreeSetupHook = { command: `node -e "process.stdout.write('bootstrap-ran')"`, enabled: true, timeoutSec: 30 };
// The default CFG caps perAccount.main at 1, which admission-rejects the SECOND of any two
// concurrent spawns before the hook gate is ever reached — a dedup test written against CFG
// passes with the runner never invoked at all. Anything concurrent here must use this config.
const CFG_CONCURRENT = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  caps: { maxAgentsTotal: 4, perAccount: { main: 4 } },
});
const FAILING_HOOK: WorktreeSetupHook = { command: "false", enabled: true, timeoutSec: 30 };

describe("F26: fail-closed worktree setup hook wired into spawn", () => {
  it("a failing hook refuses the spawn: guardrail code, backend never spawned, watch released, no marker", async () => {
    const { ledger: auditLedger, records } = newAuditLedger();
    const unwatched: string[] = [];
    const { sup, dir, fake } = makeSupervisor([RUNNING], undefined, {
      auditLedger,
      projectSetupHook: () => FAILING_HOOK,
      repoWatcher: { watch: () => {}, unwatch: (refId) => unwatched.push(refId) },
    });
    initRepo(dir);

    const err = await sup
      .spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "setup-fail", projectId: "proj-a" })
      .then(() => null, (e: unknown) => e as { code?: string; message: string });

    // AC4 is the whole fail-closed contract, not just "it threw": the classified code is what
    // callers branch on, and each of the three side-effect clauses below is a distinct way a
    // refused spawn could still leave the daemon half-committed to a broken worktree.
    expect(err?.code).toBe("guardrail");
    expect(err?.message).toContain("exited with code 1");
    expect(fake.spawns.length).toBe(0);
    expect(() => sup.status("setup-fail")).toThrow();
    expect(unwatched).toContain("setup-fail");
    const marker = setupMarkerPath(join(dir, ".chimera", "worktrees", "setup-fail"));
    expect(marker === null || !existsSync(marker)).toBe(true);
    const rec = records().find((r) => r.action === "worktree_setup_ran");
    expect(rec?.decision).toBe("deny");
  });

  it("a successful hook: backend spawns once, >=3 worktree_setup events under the agent's own id, exactly one recorded audit record", async () => {
    const { ledger: auditLedger, records } = newAuditLedger();
    const { sup, dir, fake, events } = makeSupervisor([RUNNING], undefined, {
      auditLedger,
      projectSetupHook: () => NOISY_HOOK,
    });
    initRepo(dir);

    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "setup-ok", projectId: "proj-a" });

    expect(sup.status("setup-ok")).toBeDefined();
    expect(fake.spawns.length).toBe(1);
    // Events must land under the AGENT's id, not a synthetic setup id — the transcript the
    // operator watches is keyed by agentId, so a mis-stamped event is an invisible one.
    const phases = events.tail("setup-ok", 100).filter((e) => e.kind === "worktree_setup").map((e) => e.data["phase"]);
    expect(phases.length).toBeGreaterThanOrEqual(3);
    expect(phases[0]).toBe("start");
    expect(phases).toContain("chunk");
    expect(phases[phases.length - 1]).toBe("ok");
    const all = records().filter((r) => r.action === "worktree_setup_ran");
    expect(all.length).toBe(1);
    const rec = all[0];
    expect(rec?.decision).toBe("recorded");
    expect(rec?.detail?.timeoutSec).toBe(30);
    // The audit detail carries the (redacted) command, but the raw command string still
    // appears here since "true"/"false" contain no secrets to redact — this only proves the
    // record shape, not redaction itself (that's covered at the credentials.ts unit level).
    expect(rec?.detail?.project).toBe("proj-a");
  });

  it("never invokes the hook for isolation:none, no project, or no configured hook", async () => {
    const calls: string[] = [];
    const { ledger: auditLedger, records } = newAuditLedger();
    const { sup, dir } = makeSupervisor([RUNNING, RUNNING, RUNNING], undefined, {
      auditLedger,
      projectSetupHook: (projectId) => {
        calls.push(projectId);
        return HOOK;
      },
    });
    initRepo(dir);

    // isolation: none — no worktree at all, gate short-circuits on isolation.
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none" }, { agentId: "no-iso", projectId: "proj-a" });
    // Free the "main" account's cap slot (default CFG: perAccount.main = 1) before the next
    // spawn — RUNNING never completes on its own, so it'd otherwise hold the slot forever.
    await sup.kill("no-iso");
    // isolation: worktree but no projectId — gate short-circuits on projectId.
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "no-proj" });

    expect(calls).toEqual([]);
    expect(records().find((r) => r.action === "worktree_setup_ran")).toBeUndefined();
  });

  it("is a no-op when the project has no hook (or a disabled one) configured", async () => {
    const { ledger: auditLedger, records } = newAuditLedger();
    const { sup, dir } = makeSupervisor([RUNNING], undefined, {
      auditLedger,
      projectSetupHook: () => null,
    });
    initRepo(dir);

    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "no-hook", projectId: "proj-a" });

    expect(sup.status("no-hook")).toBeDefined();
    expect(records().find((r) => r.action === "worktree_setup_ran")).toBeUndefined();
  });

  it("dedupes two concurrent spawns sharing one workdirKey: the hook runs once and BOTH spawns succeed", async () => {
    let runs = 0;
    let gate: () => void = () => {};
    let seen = 0;
    const secondArrived = new Promise<void>((r) => { gate = r; });
    const { ledger: auditLedger } = newAuditLedger();
    const { sup, dir } = makeSupervisor([RUNNING, RUNNING], CFG_CONCURRENT, {
      auditLedger,
      // Releasing the runner only once BOTH spawns have passed the hook lookup makes the race
      // deterministic: a sleep-based runner would let a slow machine finish spawn A's hook
      // before B ever reaches setupInFlight, and the test would pass without proving dedup.
      projectSetupHook: () => { if (++seen === 2) gate(); return HOOK; },
      runSetupHook: async () => { runs++; await secondArrived; return { ran: true, durationMs: 0 }; },
    });
    initRepo(dir);

    // Two DIFFERENT agentIds sharing one workdirKey is the real shape workdir.ts keys on
    // (worktreeKey = spec.workdirKey ?? spec.agentId) — a shared-worktree workflow step.
    await Promise.all([
      sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "shared-wt" }, { agentId: "dedupe-a", projectId: "proj-a" }),
      sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "shared-wt" }, { agentId: "dedupe-b", projectId: "proj-a" }),
    ]);

    expect(runs).toBe(1);
    expect(sup.status("dedupe-a")).toBeDefined();
    expect(sup.status("dedupe-b")).toBeDefined();
  });

  it("a relaunch into an already-bootstrapped worktree does not re-run the hook", async () => {
    const { ledger: auditLedger, records } = newAuditLedger();
    const dirForCount = mkdtempSync(join(tmpdir(), "chimera-hookcount-"));
    const countFile = join(dirForCount, "runs.txt");
    // Counts REAL child executions (no runSetupHook seam) so this exercises the on-disk marker
    // gate, which is what actually survives a failover relaunch — setupInFlight is cleared by
    // then, so nothing else would stop a second run.
    const counting: WorktreeSetupHook = {
      command: `node -e "require('fs').appendFileSync(process.argv[1],'x')" ${countFile}`,
      enabled: true, timeoutSec: 30,
    };
    const { sup, dir } = makeSupervisor([RUNNING, RUNNING], CFG_CONCURRENT, {
      auditLedger, projectSetupHook: () => counting,
    });
    initRepo(dir);

    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "relaunch-wt" }, { agentId: "relaunch-1", projectId: "proj-a" });
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "relaunch-wt" }, { agentId: "relaunch-2", projectId: "proj-a" });

    expect(readFileSync(countFile, "utf8")).toBe("x");
    // The no-op path still records an audit line (the gate ran, it just didn't execute) — what
    // must not happen twice is the child process, asserted above.
    expect(records().filter((r) => r.action === "worktree_setup_ran").length).toBe(2);
  });
  it("a hook failure removes the worktree it created — no orphan dir, no orphan branch", async () => {
    const { ledger: auditLedger } = newAuditLedger();
    const { sup, dir } = makeSupervisor([RUNNING], undefined, {
      auditLedger,
      projectSetupHook: () => FAILING_HOOK,
    });
    initRepo(dir);

    // `git worktree add` runs BEFORE the hook, so fail-closed used to orphan a worktree and a
    // branch on every refused attempt — a bad operator command leaked one per spawn, forever.
    await sup
      .spawn({ prompt: "x", cwd: dir, isolation: "worktree" }, { agentId: "leak-check", projectId: "proj-a" })
      .then(() => null, () => null);

    expect(existsSync(join(dir, ".chimera", "worktrees", "leak-check"))).toBe(false);
    // The dir being gone is not enough: a `rm -rf`-style cleanup would leave git's own
    // administrative entry AND the branch behind, and the next spawn would fail to re-add it.
    expect(execFileSync("git", ["-C", dir, "worktree", "list"]).toString()).not.toContain("leak-check");
    expect(execFileSync("git", ["-C", dir, "branch", "--list", "chimera/leak-check"]).toString().trim()).toBe("");
  });

  it("a deduped spawn is visible: the joiner emits its own joined events and audit record", async () => {
    let gate: () => void = () => {};
    let seen = 0;
    const secondArrived = new Promise<void>((r) => { gate = r; });
    const { ledger: auditLedger, records } = newAuditLedger();
    const { sup, dir, events } = makeSupervisor([RUNNING, RUNNING], CFG_CONCURRENT, {
      auditLedger,
      projectSetupHook: () => { if (++seen === 2) gate(); return HOOK; },
      // The seam emits nothing, so the LEADER's transcript stays empty here — every
      // worktree_setup event below therefore provably came from the joiner's own narration.
      runSetupHook: async () => { await secondArrived; return { ran: true, durationMs: 7 }; },
    });
    initRepo(dir);

    await Promise.all([
      sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "join-wt" }, { agentId: "join-a", projectId: "proj-a" }),
      sup.spawn({ prompt: "x", cwd: dir, isolation: "worktree", workdirKey: "join-wt" }, { agentId: "join-b", projectId: "proj-a" }),
    ]);

    // Which spawn wins the race is not deterministic; exactly one must be the joiner.
    const setupEvents = (id: string) => events.tail(id, 100).filter((e) => e.kind === "worktree_setup");
    const joiners = ["join-a", "join-b"].filter((id) => setupEvents(id).length > 0);
    expect(joiners.length).toBe(1);
    const joined = setupEvents(joiners[0]!);
    expect(joined.map((e) => e.data["phase"])).toEqual(["start", "ok"]);
    expect(joined.every((e) => e.data["joined"] === true)).toBe(true);
    // The joiner mirrors the LEADER's real outcome, not a fabricated one.
    expect(joined[1]?.data["durationMs"]).toBe(7);
    expect(joined[1]?.data["ran"]).toBe(true);

    const all = records().filter((r) => r.action === "worktree_setup_ran");
    expect(all.length).toBe(2);
    expect(all.filter((r) => r.detail?.joined === true).length).toBe(1);
  });
});
