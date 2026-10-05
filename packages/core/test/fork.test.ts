import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ConversationForks } from "../src/fork.js";
import { reattachConductors } from "../src/reattach.js";
import { ForkRpc } from "../src/rpc/fork-rpc.js";
import { EventLog } from "../src/events.js";
import type { AgentBackend } from "../src/backend.js";
import { resolveAgentSpec } from "../src/supervisor.js";
import { ensureWorkdir } from "../src/workdir.js";
import type { AgentRecord, AgentSupervisor } from "../src/supervisor.js";

const dirs: string[] = [], logs: EventLog[] = [];
afterEach(() => { for (const log of logs.splice(0)) log.flushDurable(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString().trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-fork-"))); dirs.push(root);
  git(root, "init"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Fork test"); git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "tracked.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
  const source = { agentId: "source", accountName: "test", provider: "claude", state: "running", depth: 0, treeId: "source", principal: "local", projectId: "project", parentId: null, costUsd: 0, attempts: [], createdAt: 1, membership: { team: "test-team", role: "backend" }, sessionId: "source-session",
    spec: resolveAgentSpec({ cwd: root, prompt: "Original task: publish once", account: "test", model: "test-model", permissionProfile: "readOnly", isolation: "worktree", orchestration: { allow: true, maxDepth: 2 }, content: [{ type: "text", text: "Transcribed original attachment" }] }),
  } as AgentRecord;
  const wt = ensureWorkdir({ ...source.spec, agentId: source.agentId }).workdir;
  writeFileSync(join(wt, "tracked.txt"), "source committed\n"); git(wt, "add", "."); git(wt, "commit", "-m", "source unique commit");
  writeFileSync(join(wt, "tracked.txt"), "source dirty\n"); writeFileSync(join(wt, "private-untracked.txt"), "do not copy");
  const events = new EventLog(join(root, "events")); logs.push(events);
  events.append({ agentId: "source", kind: "status", data: { delivered: true, text: "fallback", content: [{ type: "text", text: "Transcribed next attachment" }, { type: "image", data: "private-image-bytes" }] } });
  const boundary = events.append({ agentId: "source", kind: "message_complete", data: { text: "Already published. Boundary context.", nativeForkBoundaryId: "provider-boundary" } });
  events.append({ agentId: "source", kind: "message_complete", data: { text: "Future context MUST NOT transfer" } });
  events.append({ agentId: "source", kind: "tool_call", data: { toolName: "publish", input: { command: "DANGEROUS_TOOL_REPLAY" } } });
  source.resultText = "FUTURE_FINAL_RESULT";
  const agents = new Map([[source.agentId, source]]);
  const spawn = vi.fn(async (spec: unknown, opts: { agentId?: string } = {}) => ({ ...source, agentId: opts.agentId!, spec: resolveAgentSpec(spec), parentId: null, sessionId: "child-session" }));
  let backend: AgentBackend = { provider: "claude", capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true }, spawn: vi.fn() };
  let accountProvider = "claude";
  const changed = vi.fn();
  const forks = new ConversationForks({ agent: id => { const a = agents.get(id); if (!a) throw new Error("no agent"); return a; }, backend: () => backend, accountProvider: () => accountProvider, events, spawn: spawn as AgentSupervisor["spawn"], redact: s => s, changed });
  return { root, wt, source, agents, forks, spawn, boundary, changed, backend: (value: AgentBackend) => { backend = value; }, mismatch: () => { accountProvider = "codex"; } };
}
const operator = { operator: true } as const;
describe("conversation branching", () => {
  it("snapshots only selected completed context into one fresh task/session/worktree; source is unchanged", async () => {
    const f = fixture(), before = structuredClone(f.source), head = git(f.wt, "rev-parse", "HEAD");
    const result = await f.forks.create({ agentId: "source", mode: "auto", upToSeq: f.boundary.seq, task: "Inspect the alternative; do not publish", includeUncommitted: true }, operator);
    expect(result.mode).toBe("snapshot"); expect(result.label).toContain("no tool history");
    expect(result.lineage).toEqual({ forkedFrom: "source", atSeq: f.boundary.seq, mode: "snapshot" });
    expect(result.worktree.path).not.toBe(f.wt); expect(result.worktree.baseSha).toBe(head);
    expect(readFileSync(join(result.worktree.path, "tracked.txt"), "utf8")).toBe("source dirty\n");
    expect(() => readFileSync(join(result.worktree.path, "private-untracked.txt"))).toThrow();
    expect(f.source).toEqual(before); expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const spec = f.spawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec.resume).toBeNull(); expect(spec.content).toBeUndefined(); expect(spec.mcpServers).toEqual({});
    expect(spec.prompt).toContain("Inspect the alternative"); expect(spec.prompt).toContain("Boundary context");
    expect(spec.prompt).toContain("Transcribed original attachment"); expect(spec.prompt).toContain("Transcribed next attachment");
    for (const excluded of ["Future context MUST NOT transfer", "DANGEROUS_TOOL_REPLAY", "private-image-bytes", "FUTURE_FINAL_RESULT"]) expect(spec.prompt).not.toContain(excluded);
  });
  it("rollback removes its unmerged branch and worktree when spawn fails", async () => {
    const f = fixture(); f.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    const branches = git(f.root, "branch", "--list");
    await expect(f.forks.create({ agentId: "source", mode: "snapshot", task: "inspect" }, operator)).rejects.toThrow("spawn failed");
    expect(git(f.root, "branch", "--list")).toBe(branches); expect(readdirSync(join(f.root, ".chimera/worktrees"))).toEqual(["source"]);
  });
  it("native is explicit and denied without verified capability; an advertised hook returns a distinct child session", async () => {
    const f = fixture(); await expect(f.forks.create({ agentId: "source", mode: "native", task: "inspect" }, operator)).rejects.toMatchObject({ code: "fork_unsupported" });
    expect(f.spawn).not.toHaveBeenCalled();
    const discard = vi.fn(async () => {}), fork = vi.fn(async () => ({ sessionId: "new-session", discard }));
    f.backend({ provider: "claude", capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true, supportsConversationFork: true }, forkConversation: fork, spawn: vi.fn() });
    const result = await f.forks.create({ agentId: "source", mode: "native", upToSeq: f.boundary.seq, task: "inspect" }, operator);
    expect(result.mode).toBe("native"); expect(fork).toHaveBeenCalledWith({ sessionId: "source-session", boundaryId: "provider-boundary", cwd: result.worktree.path });
    expect(f.spawn.mock.calls[0]![0]).toMatchObject({ resume: "new-session", prompt: "inspect" }); expect(discard).not.toHaveBeenCalled();
  });
  it("native session is discarded on spawn failure and source session is never discarded", async () => {
    const f = fixture(), discard = vi.fn(async () => {});
    f.backend({ provider: "claude", capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true, supportsConversationFork: true }, forkConversation: async () => ({ sessionId: "new-session", discard }), spawn: vi.fn() });
    f.spawn.mockRejectedValueOnce(new Error("fail"));
    await expect(f.forks.create({ agentId: "source", mode: "native", upToSeq: f.boundary.seq, task: "inspect" }, operator)).rejects.toThrow("fail"); expect(discard).toHaveBeenCalledOnce();
    f.backend({ provider: "claude", capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true, supportsConversationFork: true }, forkConversation: async () => ({ sessionId: "source-session", discard }), spawn: vi.fn() });
    await expect(f.forks.create({ agentId: "source", mode: "native", upToSeq: f.boundary.seq, task: "inspect" }, operator)).rejects.toMatchObject({ code: "fork_unsupported" }); expect(discard).toHaveBeenCalledOnce();
  });
  it("rejects provider mismatch, missing/streaming boundaries and blank tasks before creating anything", async () => {
    const f = fixture(); f.mismatch(); expect(f.forks.capabilities({ agentId: "source" }, operator).snapshot.reason).toContain("provider");
    await expect(f.forks.create({ agentId: "source", mode: "auto", task: "inspect" }, operator)).rejects.toMatchObject({ code: "fork_unsupported" });
    await expect(f.forks.create({ agentId: "source", mode: "snapshot", task: " " }, operator)).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
    const g = fixture(); expect(g.forks.capabilities({ agentId: "source", upToSeq: 999999 }, operator).snapshot.available).toBe(false);
  });
  it("agent forks carry real caller depth/tree/parent for supervisor budget governance and deny cross-team/escalation", async () => {
    const f = fixture();
    await f.forks.create({ agentId: "source", mode: "snapshot", task: "inspect" }, { agentId: "source" });
    expect(f.spawn.mock.calls[0]![1]).toMatchObject({ depth: 1, treeId: "source", parentId: "source", principal: "local", maxDepthCap: 2 });
    f.agents.set("other", { ...f.source, agentId: "other", membership: { team: "other-team", role: "backend" }, parentId: "source" });
    expect(() => f.forks.capabilities({ agentId: "other" }, { agentId: "source" })).toThrowError(expect.objectContaining({ code: "forbidden" }));
    f.source.spec.orchestration.allow = false;
    expect(() => f.forks.capabilities({ agentId: "source" }, { agentId: "source" })).toThrowError(expect.objectContaining({ code: "forbidden" }));
  });
  it("RPC requires a caller or trusted operator invocation; forged authority cannot be an input", () => {
    const f = fixture(), rpc = new ForkRpc(f.forks);
    expect(() => rpc.handlers["agent.forkCapabilities"]({ agentId: "source" })).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(rpc.operator("agent.forkCapabilities", { agentId: "source" })).toMatchObject({ snapshot: { available: true } });
  });
});

it("branch lineage and team session survive eager/lazy reattachment without replaying the new or original task", async () => {
  const f = fixture(); const lineage = { forkedFrom: "parent", atSeq: 1, mode: "snapshot" as const };
  const source = { ...f.source, forkLineage: lineage, spec: { ...f.source.spec, session: true } };
  const spawn = vi.fn(async () => source), dormant = vi.fn(), paused = vi.fn();
  const engine = { supervisor: { spawn, reattachDormant: dormant, reattachPaused: paused }, events: { append: vi.fn() } };
  reattachConductors(engine as never, [source], "eager");
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ resume: "source-session", resumeOnly: true }), expect.objectContaining({ forkLineage: lineage, membership: source.membership, principal: "local" }));
  reattachConductors(engine as never, [source], "lazy"); expect(dormant).toHaveBeenCalledWith(source, "daemon-restart");
  reattachConductors(engine as never, [{ ...source, state: "paused" }], "lazy"); expect(paused).toHaveBeenCalledOnce();
});

it("a failed lineage notification after successful spawn never removes the running child's files", async () => {
  const f = fixture(); f.changed.mockImplementationOnce(() => { throw new Error("event failed"); });
  const result = await f.forks.create({ agentId: "source", mode: "snapshot", task: "inspect" }, operator);
  expect(readFileSync(join(result.worktree.path, "tracked.txt"), "utf8")).toBe("source committed\n");
  expect(result.warnings.join(" ")).toContain("Child started; lineage event delivery failed");
});
