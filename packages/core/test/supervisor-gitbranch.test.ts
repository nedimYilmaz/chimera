import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { CFG, fakeExec, makeEngineHome } from "./helpers.js";

// WD Stage 1 (coverage B12, sessions-table branch): AgentRecord.gitBranch — stamped
// ASYNCHRONOUSLY at spawn from the spec's cwd and refreshed fire-and-forget on
// agent.status. The probe is an injected dep (mirrors the `now` seam) so the unit
// layer is deterministic; one integration test runs the REAL
// `git -C <cwd> rev-parse --abbrev-ref HEAD` default against a temp repo.

const settle = () => new Promise((r) => setTimeout(r, 20));

// CORE-SUITE-BASELINE: the real-git integration test below polls a genuine async `git`
// subprocess probe (fire-and-forget rev-parse) rather than a mocked one — under this
// machine's concurrent-agent load a subprocess spawn can take well over 1s to schedule,
// so the test timeout needs real headroom, not just vitest's 5000ms default. Sized to
// cover both of that test's poll loops (50 x 300ms = 15s each) plus overhead.
vi.setConfig({ testTimeout: 40_000 });

function makeSup(gitBranch?: (cwd: string) => Promise<string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-gitbr-"));
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(gitBranch ? { gitBranch } : {}),
  });
  return sup;
}

const spec = (cwd = "/tmp/proj") => ({ prompt: "job", cwd, isolation: "none" });

describe("AgentSupervisor gitBranch (WD Stage 1)", () => {
  it("stamps the probed branch onto the record after spawn (async — never on the spawn return itself)", async () => {
    const sup = makeSup(async (cwd) => (cwd === "/tmp/proj" ? "feature-x" : undefined));
    const rec = await sup.spawn(spec());
    // spawn returns BEFORE the probe lands (fire-and-forget contract)…
    await settle();
    // …but the live record (the same object status()/agent.list serve) is stamped soon after.
    expect(sup.status(rec.agentId).gitBranch).toBe("feature-x");
  });

  it("a failed probe (undefined) leaves gitBranch absent — and never rejects the spawn", async () => {
    const sup = makeSup(async () => undefined);
    const rec = await sup.spawn(spec("/tmp/not-a-repo"));
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBeUndefined();
  });

  it("a probe that never resolves still lets the spawn complete (the stamp must not gate spawn)", async () => {
    const sup = makeSup(() => new Promise<string | undefined>(() => {}));
    const rec = await sup.spawn(spec());
    expect(rec.agentId).toBeTruthy();
    expect(rec.gitBranch).toBeUndefined();
  });

  it("stampGitBranch refreshes to the probe's CURRENT answer, and a later failure keeps the last-known branch", async () => {
    let branch: string | undefined = "main";
    const sup = makeSup(async () => branch);
    const rec = await sup.spawn(spec());
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBe("main");

    branch = "release-1";                          // the operator switched branches
    sup.stampGitBranch(rec.agentId);
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBe("release-1");

    branch = undefined;                            // transient git failure on refresh
    sup.stampGitBranch(rec.agentId);
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBe("release-1");   // never blanked by a failed probe
  });

  it("stampGitBranch is a silent no-op for an unknown id (agent.status still throws through status())", () => {
    const sup = makeSup(async () => "x");
    expect(() => sup.stampGitBranch("ghost")).not.toThrow();
  });
});

describe("engine agent.status branch refresh — real git integration (WD Stage 1)", () => {
  it("stamps the actual branch of a real repo cwd at spawn, and agent.status refreshes it after a branch switch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-gitrepo-"));
    execFileSync("git", ["-C", repo, "init", "-b", "wd-main"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed"], { stdio: "ignore" });

    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[
        { emit: { kind: "agent_started", data: {} } },
        { awaitSend: true },                       // park the agent running so status() polls a live record
      ]])]]),
    });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "job", cwd: repo, isolation: "none" } })) as { agentId: string };

    // spawn-time stamp: poll until the async default probe lands (bounded wait). Each poll
    // triggers a FRESH real `git` subprocess (engine.ts's agent.status re-stamps on every
    // call), so the interval here is deliberately coarser than the file's shared 20ms
    // `settle()` — under concurrent-agent load, hammering real subprocess spawns every 20ms
    // adds to the very contention we're waiting out. 50 polls x 300ms keeps the same
    // subprocess-spawn budget as the original 50-iteration design while giving 15s of real
    // wall-clock headroom instead of 1s.
    const pollGitProbe = () => new Promise((r) => setTimeout(r, 300));
    let st = { gitBranch: undefined as string | undefined };
    for (let i = 0; i < 50 && st.gitBranch === undefined; i++) {
      await pollGitProbe();
      st = (await e.handle("agent.status", { agentId: rec.agentId })) as { gitBranch?: string };
    }
    expect(st.gitBranch).toBe("wd-main");

    // refresh-on-status: switch the branch, then agent.status fire-and-forget re-probes
    execFileSync("git", ["-C", repo, "checkout", "-b", "wd-feature"], { stdio: "ignore" });
    st = (await e.handle("agent.status", { agentId: rec.agentId })) as { gitBranch?: string };   // triggers the refresh
    for (let i = 0; i < 50 && st.gitBranch !== "wd-feature"; i++) {
      await pollGitProbe();
      st = (await e.handle("agent.status", { agentId: rec.agentId })) as { gitBranch?: string };
    }
    expect(st.gitBranch).toBe("wd-feature");

    // the field also rides the agent.list snapshot (the sessions table's actual source)
    const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; gitBranch?: string }>;
    expect(list.find((a) => a.agentId === rec.agentId)?.gitBranch).toBe("wd-feature");

    await e.handle("agent.kill", { agentId: rec.agentId });
  }, 20_000);
});

// AGENT-RECORD-GITBRANCH-LIES: an isolation:"worktree" agent was reported as gitBranch:"main"
// (the MAIN repo's own branch) instead of its own worktree's branch, because stampGitBranch
// probed spec.cwd (the mainRepo path a worktree agent is spawned FROM) rather than where the
// agent actually runs. A confidently wrong field is worse than an absent one: it persuades a
// caller (e.g. a janitor sweep) it already has the answer instead of forcing it to check
// further. An injected probe (mirrors the deterministic-unit style of the first describe block
// above) records which cwd it was actually called with — proving the fix's routing (spec.cwd
// vs. the resolved worktree dir) directly, without racing two real `git` subprocesses against
// each other under shared-machine load the way a real-git two-probe test would.
describe("AgentSupervisor gitBranch — isolation:worktree never lies as main's own branch (AGENT-RECORD-GITBRANCH-LIES)", () => {
  it("probes the worktree dir (not the main repo's spec.cwd) once the worktree exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-gitbr-wt-"));
    const probedCwds: string[] = [];
    const sup = makeSup(async (cwd) => {
      probedCwds.push(cwd);
      return cwd === repo ? "main" : "chimera/feature-branch";
    });
    const rec = await sup.spawn({ prompt: "job", cwd: repo, isolation: "worktree" });
    // spawn-time probe: the worktree isn't materialized yet, so resolveWorkdirPath's documented
    // fallback (mirrors WF-3's gate-execution callers) correctly probes spec.cwd itself here —
    // this is the ONE legitimate case where "main" is a truthful answer, not a lie.
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBe("main");

    // the worktree materializes (as ensureWorkdir would mid-launch for a real backend — see
    // supervisor-worktree-landing.test.ts's identical FakeAgentBackend-never-calls-ensureWorkdir
    // precedent for why this test creates it by hand instead)
    mkdirSync(join(repo, ".chimera", "worktrees", rec.agentId), { recursive: true });
    sup.stampGitBranch(rec.agentId);
    await settle();
    expect(sup.status(rec.agentId).gitBranch).toBe("chimera/feature-branch");
    expect(sup.status(rec.agentId).gitBranch).not.toBe("main");
    expect(probedCwds).toContain(join(repo, ".chimera", "worktrees", rec.agentId));
  });
});
