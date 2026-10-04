import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { CheckpointRecord, CheckpointStatus } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// F20 D16 (coverage §C18): the checkpoint.* RPC family end-to-end through Engine.handle,
// including the busy-repo revert guard wired against the REAL supervisor (kill unblocks
// it) and the manual RPC path (the ctrl+s trigger W22 binds).

// CORE-SUITE-BASELINE: real `git` checkpoint plumbing under this machine's concurrent-agent
// load can exceed vitest's 5000ms default; widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 45_000 });

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "chimera-eckpt-repo-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed"], { stdio: "ignore" });
  return repo;
}

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("Engine checkpoint.* RPC family (D16)", () => {
  it("checkpoint.status is dark for a non-git cwd", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const dir = mkdtempSync(join(tmpdir(), "chimera-eckpt-plain-"));
    expect(await e.handle("checkpoint.status", { cwd: dir })).toEqual({ supported: false, cwd: dir });
  });

  it("checkpoint.create/list/status roundtrip (manual trigger — the ctrl+s path)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const repo = initRepo();
    const created = await e.handle("checkpoint.create", { cwd: repo }) as CheckpointRecord;   // trigger defaults to "manual"
    expect(created).toMatchObject({ id: "1", trigger: "manual", agentId: null, taskId: null });

    const listed = await e.handle("checkpoint.list", { cwd: repo }) as CheckpointRecord[];
    expect(listed).toEqual([created]);

    const status = await e.handle("checkpoint.status", { cwd: repo }) as CheckpointStatus;
    expect(status).toMatchObject({ supported: true, count: 1, latest: created });
  });

  it("checkpoint.create auto-resolves taskId from the caller's CURRENT binding, mirroring artifact.add", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const repo = initRepo();
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: repo, account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as { taskId: string };
    let agentId: string | null = null;
    for (let i = 0; i < 50 && agentId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      agentId = e.queues.getTask(task.taskId).agentId;
    }
    expect(agentId).not.toBeNull();

    const created = await e.handle("checkpoint.create", { cwd: repo, agentId: agentId! }) as CheckpointRecord;
    expect(created.agentId).toBe(agentId);
    expect(created.taskId).toBe(task.taskId);
    await e.handle("agent.kill", { agentId: agentId! });
  });

  it("checkpoint.revert restores the working tree", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "v1");
    const created = await e.handle("checkpoint.create", { cwd: repo }) as CheckpointRecord;
    writeFileSync(join(repo, "a.txt"), "v2-mutated");

    const result = await e.handle("checkpoint.revert", { cwd: repo, id: created.id }) as { id: string };
    expect(result.id).toBe(created.id);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1");
  });

  it("checkpoint.revert on an unknown id rejects (protocol error)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const repo = initRepo();
    await expect(e.handle("checkpoint.revert", { cwd: repo, id: "999" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("busy-repo guard: revert is refused while a REAL agent is running in that repo, and killing it unblocks the revert", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "v1");
    const created = await e.handle("checkpoint.create", { cwd: repo }) as CheckpointRecord;
    writeFileSync(join(repo, "a.txt"), "v2-mutated");

    const rec = await e.handle("agent.spawn", { spec: { prompt: "job", cwd: repo, isolation: "none" } }) as { agentId: string };

    await expect(e.handle("checkpoint.revert", { cwd: repo, id: created.id })).rejects.toMatchObject({ code: "guardrail" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v2-mutated");   // refused — nothing changed

    await e.handle("agent.kill", { agentId: rec.agentId });
    const result = await e.handle("checkpoint.revert", { cwd: repo, id: created.id }) as { id: string };
    expect(result.id).toBe(created.id);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1");
  });

  it("task-start auto-checkpoint: spawning an agent into a git cwd creates a checkpoint (fire-and-forget)", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "done" } },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const repo = initRepo();
    const rec = await e.handle("agent.spawn", { spec: { prompt: "job", cwd: repo, isolation: "none" } }) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId });

    let status = await e.handle("checkpoint.status", { cwd: repo }) as CheckpointStatus;
    for (let i = 0; i < 50 && (status.count ?? 0) === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = await e.handle("checkpoint.status", { cwd: repo }) as CheckpointStatus;
    }
    expect(status.count).toBe(1);
    expect(status.latest?.trigger).toBe("task_start");
    expect(status.latest?.agentId).toBe(rec.agentId);
  });

  it("a non-git cwd never blocks a spawn (auto-trigger swallows the error)", async () => {
    const fake = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done" } }]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const dir = mkdtempSync(join(tmpdir(), "chimera-eckpt-plain2-"));
    const rec = await e.handle("agent.spawn", { spec: { prompt: "job", cwd: dir, isolation: "none" } }) as { agentId: string };
    expect(rec.agentId).toBeTruthy();
    await e.handle("agent.wait", { agentId: rec.agentId });
    expect(existsSync(dir)).toBe(true);   // sanity: no crash, dir untouched
  });

  // D16 fix (checkpoint auto-trigger scoping): a non-git cwd must never even ATTEMPT the
  // auto-trigger — gated FROM THE SOURCE (supervisor's isGitRepo pre-check), not
  // attempt-then-swallow. Proven two ways: (1) no checkpoint ever materializes for that
  // cwd, and (2) the "checkpoint auto-trigger failed" warning never fires — that log line
  // is reserved for a REAL git error against a confirmed git cwd.
  it("a non-git cwd never attempts a checkpoint at all — no warning, no checkpoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done" } }]]);
      const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
      const dir = mkdtempSync(join(tmpdir(), "chimera-eckpt-plain3-"));
      const rec = await e.handle("agent.spawn", { spec: { prompt: "job", cwd: dir, isolation: "none" } }) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId });
      await new Promise((r) => setTimeout(r, 50));   // let the fire-and-forget trigger settle
      expect(await e.handle("checkpoint.status", { cwd: dir })).toEqual({ supported: false, cwd: dir });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("explicit checkpoint.create RPC on a non-git cwd still rejects with NotAGitRepoError (unchanged, conscious call)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const dir = mkdtempSync(join(tmpdir(), "chimera-eckpt-plain4-"));
    await expect(e.handle("checkpoint.create", { cwd: dir })).rejects.toMatchObject({ code: "protocol" });
  });
});
