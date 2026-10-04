import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { ensureWorkdir, worktreePath } from "@chimera/core/workdir";
import { makeEngineHome } from "./helpers.js";
import { makeFedHome } from "./fed-helpers.js";

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

// TOKEN-OPT-P1: agent.listSummary / queue.statusSummary must stay small (<~10KB) even
// against a large tree/queue where the FULL records would be 600KB+ (huge spec.instructions,
// base64-shaped content, and — for tasks — big resultText/stepHistory[].handoffSummary).

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const BIG = "x".repeat(20_000);   // stands in for a large instructions blob / base64 image / handoffSummary

describe("TOKEN-OPT-P1 — agent.listSummary", () => {
  it("projects a large agent tree down to id/name/role/status/model/depth/parentId/costUsd/gitBranch, staying tiny vs. the full record", async () => {
    // guardrails.maxAgentsTotal defaults to 12 — 10 is enough to demonstrate a "large tree".
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await Promise.all(Array.from({ length: 10 }, (_, i) => e.handle("agent.spawn", {
      spec: {
        prompt: `task ${i}`, cwd: "/tmp", isolation: "none", permissionProfile: "readOnly",
        instructions: BIG, model: "claude-sonnet-5",
      },
    })));

    const full = (await e.handle("agent.list", {})) as unknown[];
    const summary = (await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>;

    expect(summary.length).toBe(full.length);
    expect(summary.length).toBe(10);
    for (const a of summary) {
      expect(Object.keys(a).sort()).toEqual(
        ["costUsd", "depth", "gitBranch", "id", "model", "name", "parentId", "role", "status", "workdir"].sort(),
      );
      expect(a["model"]).toBe("claude-sonnet-5");
    }

    const fullSize = JSON.stringify(full).length;
    const summarySize = JSON.stringify(summary).length;
    expect(fullSize).toBeGreaterThan(20_000 * 10);   // the big instructions blob rides every full record
    expect(summarySize).toBeLessThan(10_000);         // stays small regardless of spec bloat
    expect(summarySize).toBeLessThan(fullSize / 100);
  });
});

describe("TOKEN-OPT-P1 — queue.statusSummary", () => {
  // DONE_COUNT/LIMIT are chosen only to reproduce the original test's page shape (two full
  // pages + a remainder) at a fraction of the record count — each task below carries 3 BIG
  // (20KB) blobs (prompt/handoffSummary/resultText), so save()'s full-file rewrite cost scales
  // with count² and the original 60-task version was flaky under concurrent-agent load even
  // standalone (~4.5-5.1s against the 5000ms default timeout). The pagination/projection
  // property under test doesn't depend on the specific counts, only on there being >2 pages.
  const DONE_COUNT = 28;
  const LIMIT = 10;

  it("projects tasks to id/state/subject, paginates the terminal slice, and stays tiny vs. queue.status", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "big", retryLimit: 0 } });

    for (let i = 0; i < DONE_COUNT; i++) {
      const t = e.queues.push("big", { prompt: `${BIG} task-${i}` });
      e.queues.startStep(t.taskId, 0, "step-0", null);
      e.queues.closeStep(t.taskId, "passed");
      e.queues.setStepHandoffSummary(t.taskId, 0, BIG);
      e.queues.markDone(t.taskId, BIG);
    }
    for (let i = 0; i < 3; i++) e.queues.push("big", { prompt: `${BIG} pending-${i}` });

    const full = (await e.handle("queue.status", { queue: "big" })) as { tasks: unknown[]; counts: Record<string, number> };
    expect(full.tasks.length).toBe(DONE_COUNT + 3);
    expect(full.counts.done).toBe(DONE_COUNT);
    expect(full.counts.pending).toBe(3);

    const page1 = (await e.handle("queue.statusSummary", { queue: "big", limit: LIMIT })) as {
      spec: unknown; counts: Record<string, number>; tasks: Array<Record<string, unknown>>; nextCursor: string | null;
    };
    // every non-terminal task (3 pending) + one page (LIMIT) of the DONE_COUNT terminal ones
    expect(page1.tasks.length).toBe(3 + LIMIT);
    expect(page1.counts).toEqual(full.counts);
    expect(page1.nextCursor).toBe(String(LIMIT));
    for (const t of page1.tasks) {
      expect(Object.keys(t).sort()).toEqual(["id", "state", "subject"]);
      expect((t["subject"] as string).length).toBeLessThanOrEqual(81);   // 80 chars + "…"
    }

    const page2 = (await e.handle("queue.statusSummary", { queue: "big", limit: LIMIT, cursor: page1.nextCursor! })) as {
      tasks: unknown[]; nextCursor: string | null;
    };
    expect(page2.tasks.length).toBe(3 + LIMIT);
    expect(page2.nextCursor).toBe(String(2 * LIMIT));

    const page3 = (await e.handle("queue.statusSummary", { queue: "big", limit: LIMIT, cursor: page2.nextCursor! })) as {
      tasks: unknown[]; nextCursor: string | null;
    };
    expect(page3.tasks.length).toBe(3 + (DONE_COUNT - 2 * LIMIT));   // remainder of the terminal tasks
    expect(page3.nextCursor).toBeNull();

    const fullSize = JSON.stringify(full).length;
    const summarySize = JSON.stringify(page1).length;
    expect(fullSize).toBeGreaterThan(20_000 * DONE_COUNT * 2);   // resultText + handoffSummary both ride every full task
    expect(summarySize).toBeLessThan(10_000);
    expect(summarySize).toBeLessThan(fullSize / 100);
  });

  it("default limit is 25 when omitted", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "q", retryLimit: 0 } });
    for (let i = 0; i < 30; i++) {
      const t = e.queues.push("q", { prompt: `task-${i}` });
      e.queues.markDone(t.taskId, "ok");
    }
    const res = (await e.handle("queue.statusSummary", { queue: "q" })) as { tasks: unknown[]; nextCursor: string | null };
    expect(res.tasks.length).toBe(25);
    expect(res.nextCursor).toBe("25");
  });
});

// WORKDIR-FEDERATION-GUARD: agent.listSummary's `workdir` field must be computed against THIS
// host's filesystem only — a federated record's spec carries a PEER's own cwd/isolation, which
// resolveWorkdirPath must never be run against locally.
describe("WORKDIR-FEDERATION-GUARD — agent.listSummary workdir", () => {
  // shells out to real `git worktree` — mirrors workdir.test.ts's precedent for that cost.
  vi.setConfig({ testTimeout: 40_000 });

  it("a local worktree-isolated agent whose worktree exists resolves workdir to that worktree path", async () => {
    const repo = initRepo("chimera-wf-summary-exists-");
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "job", cwd: repo, isolation: "worktree", permissionProfile: "readOnly" },
    })) as { agentId: string };
    // FakeAgentBackend never runs a real backend process, so it never calls ensureWorkdir
    // (that's a real-backend-only side effect, see backends/claude.ts) — materialize the
    // worktree directly to exercise resolveWorkdirPath's "exists" branch.
    ensureWorkdir({ isolation: "worktree", cwd: repo, agentId: rec.agentId });

    const summary = (await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>;
    const row = summary.find((a) => a["id"] === rec.agentId)!;
    expect(row["workdir"]).toBe(worktreePath({ cwd: repo, agentId: rec.agentId }));
  });

  it("a local worktree-isolated agent whose worktree was removed falls back to spec.cwd", async () => {
    const repo = initRepo("chimera-wf-summary-missing-");
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "job", cwd: repo, isolation: "worktree", permissionProfile: "readOnly" },
    })) as { agentId: string };
    rmSync(worktreePath({ cwd: repo, agentId: rec.agentId }), { recursive: true, force: true });

    const summary = (await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>;
    const row = summary.find((a) => a["id"] === rec.agentId)!;
    expect(row["workdir"]).toBe(repo);
  });

  it("a federated record omits workdir entirely, even though it carries a spec", async () => {
    // engine.id + a (unconnected) peer entry are enough to construct a real FederationManager —
    // no live peer link is needed since the test seeds the record cache directly, exactly the
    // shape cacheRecord() gets from a genuine agent.status reply relayed through a peer.
    const home = makeFedHome({ id: "local-engine", peers: [{ engineId: "peer-1", publicKey: "fake-key", socketPath: "/tmp/does-not-exist.sock" }] });
    const e = new Engine({ home, backends: backends(new FakeAgentBackend([])) });
    // Simulate what a peer's agent.status reply looks like once cached: a fully qualified
    // agentId plus the PEER's own spec (its cwd/isolation, meaningless on this host).
    e.federation!.cacheRecord("peer-1/remote-agent-1", {
      agentId: "peer-1/remote-agent-1",
      accountName: "peer-account",
      state: "running",
      depth: 0,
      parentId: null,
      costUsd: 0,
      spec: { isolation: "worktree", cwd: "/peer/only/path", model: "claude-sonnet-5" },
    });

    const summary = (await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>;
    const row = summary.find((a) => a["id"] === "peer-1/remote-agent-1")!;
    expect(row).toBeDefined();
    expect("workdir" in row).toBe(false);
  });
});
