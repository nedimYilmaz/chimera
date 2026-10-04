import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor, UnknownAgentError } from "@chimera/core/supervisor";
import type { AgentBackend } from "@chimera/core/backend";
import { CFG, fakeExec } from "./helpers.js";

// HOOK-5 (supervisor.ts, coverage gap): a worktree-isolated spawn registers its mainRepo
// (spec.cwd) with the repoWatcher seam at spawn time; an isolation:"none" spawn never does;
// and a launch that THROWS unwatches (the record never reached a real terminal event, so
// RepoWatcher's own EventLog subscription would otherwise leak the watch). The repoWatcher
// itself is a recording fake here — RepoWatcher's real behavior is covered in repo-watch*.test.ts.

const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok", costUsd: 0.01 } }];

function makeRepoWatcherSpy() {
  const watched: Array<{ repo: string; refId: string }> = [];
  const unwatched: string[] = [];
  const repoWatcher = {
    watch: (repo: string, refId: string) => { watched.push({ repo, refId }); },
    unwatch: (refId: string) => { unwatched.push(refId); },
  };
  return { repoWatcher, watched, unwatched };
}

// `backends` is injectable so the launch-failure case can hand in an EMPTY map — launch()
// throws UnknownAgentError before touching credentials when no backend is registered for
// the routed account's provider.
function makeSup(
  scenarios: FakeStep[][],
  repoWatcher: { watch(repo: string, refId: string): void; unwatch(refId: string): void } | undefined,
  backends?: Map<string, AgentBackend>,
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-repowatch-"));
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: backends ?? new Map([["claude", new FakeAgentBackend(scenarios)]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    ...(repoWatcher ? { repoWatcher } : {}),
  });
  return { sup, events };
}

describe("AgentSupervisor: repoWatcher seam (HOOK-5)", () => {
  it("a worktree-isolated spawn registers a watch on its cwd keyed by the record's agentId", async () => {
    const { repoWatcher, watched, unwatched } = makeRepoWatcherSpy();
    const { sup } = makeSup([HAPPY], repoWatcher);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp/wt", account: "main", isolation: "worktree" });
    expect(watched).toEqual([{ repo: "/tmp/wt", refId: rec.agentId }]);
    expect(unwatched).toEqual([]);   // a successful launch never unwatches — that's driven by the terminal event
  });

  it("an isolation:none spawn registers NO watch", async () => {
    const { repoWatcher, watched } = makeRepoWatcherSpy();
    const { sup } = makeSup([HAPPY], repoWatcher);
    await sup.spawn({ prompt: "x", cwd: "/tmp/nonwt", account: "main", isolation: "none" });
    expect(watched).toEqual([]);
  });

  it("a launch that throws unwatches the just-registered worktree watch (no leaked watch)", async () => {
    const { repoWatcher, watched, unwatched } = makeRepoWatcherSpy();
    // Empty backends map ⇒ launch() throws UnknownAgentError for the routed "claude" provider,
    // AFTER spawn() has already registered the worktree watch.
    const { sup } = makeSup([], repoWatcher, new Map<string, AgentBackend>());
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp/wt-fail", account: "main", isolation: "worktree" }))
      .rejects.toBeInstanceOf(UnknownAgentError);
    expect(watched).toHaveLength(1);
    expect(watched[0]!.repo).toBe("/tmp/wt-fail");
    // the SAME agentId that was watched is unwatched — the failed record is fully cleaned up
    expect(unwatched).toEqual([watched[0]!.refId]);
  });

  it("no repoWatcher wired ⇒ a worktree spawn is byte-identical (no throw)", async () => {
    const { sup } = makeSup([HAPPY], undefined);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp/wt-none", account: "main", isolation: "worktree" });
    expect(rec.state).toBe("running");
  });
});
