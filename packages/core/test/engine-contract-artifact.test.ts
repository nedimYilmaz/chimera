import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord, ArtifactRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";
import { ensureWorkdir, resolveWorkdirPath } from "@chimera/core/workdir";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };
const LONG_RUNNING_SCENARIO: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { end: { resultText: "done" } },
];

// FEATURE-11: exercises all 3 artifact.* methods through Engine.handle()'s RpcContract
// dispatch (see engine.ts's isContractMethod check) now that their handler bodies live in
// packages/core/src/rpc/artifact-rpc.ts's ArtifactRpc, not engine.ts's switch. core/test/
// engine-artifacts.test.ts already covers this family in more depth (oversize refusal, file
// snapshotting) and is left completely unmodified — it staying green is the strongest evidence
// the extraction changed nothing observable. This file's job is narrower: prove the reroute
// itself works for every migrated method in one place, including the agentId -> taskId ->
// stepIndex auto-resolution chain (F16.1 Phase 2) that spans scheduler.taskFor and
// queues.getTask, both re-injected into ArtifactRpc's constructor.
describe("Engine artifact.* RpcContract dispatch (FEATURE-11)", () => {
  it.each(["none", "worktree"] as const)("resolves relative reports inside the caller's %s checkout", async isolation => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chimera-report-cwd-")));
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([LONG_RUNNING_SCENARIO])) });
    const agent = await e.supervisor.spawn({ prompt: "write report", cwd, isolation });
    try {
      // FakeBackend doesn't prepare a checkout; native backends do this at launch.
      ensureWorkdir({ ...agent.spec, agentId: agent.agentId });
      const workdir = resolveWorkdirPath({ ...agent.spec, agentId: agent.agentId });
      if (isolation === "worktree") expect(workdir).not.toBe(cwd);
      mkdirSync(join(workdir, "reports"));
      writeFileSync(join(workdir, "reports/result.json"), '{"ok":true}');
      const artifact = await e.handle("artifact.add", { kind: "report", path: "reports/result.json", label: "result", agentId: agent.agentId }) as ArtifactRecord;
      expect(artifact.path).toBe(join(workdir, "reports/result.json"));
      expect(artifact.sizeBytes).toBe(11);
    } finally { await e.supervisor.kill(agent.agentId); }
  });

  it("add -> list -> get lifecycle for a link artifact", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const added = await e.handle("artifact.add", { kind: "link", url: "https://example.com/report", label: "external report" }) as ArtifactRecord;
    expect(added).toMatchObject({ kind: "link", url: "https://example.com/report", label: "external report", agentId: null, taskId: null });

    expect(await e.handle("artifact.get", { id: added.id })).toEqual(added);

    const listed = await e.handle("artifact.list", {}) as ArtifactRecord[];
    expect(listed.map((r) => r.id)).toEqual([added.id]);
  });

  it("artifact.get on an unknown id rejects with a typed error", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("artifact.get", { id: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("auto-resolves agentId -> taskId -> stepIndex from the calling agent's live binding (F16.1 Phase 2 guard carried over verbatim)", async () => {
    const fake = new FakeAgentBackend([LONG_RUNNING_SCENARIO]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: TEAM_SPEC });
    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.getTask(task.taskId).agentId !== null, 5000);
    const agentId = e.queues.getTask(task.taskId).agentId!;

    const srcDir = mkdtempSync(join(tmpdir(), "chimera-contract-art-"));
    const src = join(srcDir, "report.md");
    writeFileSync(src, "# report\n");

    const rec = await e.handle("artifact.add", { kind: "report", path: src, label: "review", agentId }) as ArtifactRecord;
    expect(rec.agentId).toBe(agentId);
    expect(rec.taskId).toBe(task.taskId);
    expect(rec.stepIndex).toBe(0);
  });

  it("artifact.add with no agentId leaves taskId/stepIndex unset", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = await e.handle("artifact.add", { kind: "link", url: "https://x", label: "l" }) as ArtifactRecord;
    expect(rec.agentId).toBeNull();
    expect(rec.taskId).toBeNull();
    expect(rec.stepIndex).toBeUndefined();
  });
});
