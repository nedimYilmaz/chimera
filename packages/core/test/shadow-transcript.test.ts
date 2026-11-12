import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateShadowTranscript, inspectSubagentFile, readBoundedTail } from "../src/rpc/shadow-transcript.js";
import { parseWorkflowSnapshot } from "../src/rpc/workflow-snapshot.js";

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), "shadow-inspect-"))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const context = () => ({ configDir: dir, cwd: "/repo", sessionId: "session-a", taskId: "task-a" });
const row = (content: unknown[]) => JSON.stringify({ message: { role: "assistant", content }, timestamp: "2026-11-12T10:00:00Z" });
async function sessionRoot(id = "session-a") {
  const path = join(dir, "projects", "-repo", id, "subagents");
  await mkdir(path, { recursive: true }); return path;
}

describe("session-scoped shadow inspection", () => {
  it("reads native activity without a spawning tool id, tolerates a partially written line", async () => {
    const root = await sessionRoot(); const path = join(root, "agent-task-a.jsonl");
    await writeFile(path, [row([{ type: "text", text: "Reviewing changes" }]), row([{ type: "tool_use", name: "TodoWrite", input: { todos: [
      { content: "Gather context", status: "completed" }, { content: "Review auth", status: "in_progress" },
    ] } }]), row([{ type: "tool_use", name: "Bash", input: { command: "git diff --cached" } }]), '{"message":'].join("\n"));
    expect(await locateShadowTranscript(context())).toEqual({ source: "subagent", path });
    const result = await inspectSubagentFile(path, 2);
    expect(result.activity).toMatchObject({ lastTool: "Bash", truncated: true, steps: [
      { title: "Gather context", status: "completed" }, { title: "Review auth", status: "in_progress" },
    ] });
    expect(result.transcript.at(-1)?.text).toContain("git diff --cached");
  });
  it("never reads a sibling session, path traversal, disabled transcript, or escaping symlink", async () => {
    const other = await sessionRoot("session-b");
    await writeFile(join(other, "agent-task-a.jsonl"), row([{ type: "text", text: "private sibling" }]));
    expect(await locateShadowTranscript(context())).toBeNull();
    const root = await sessionRoot();
    await symlink(join(other, "agent-task-a.jsonl"), join(root, "agent-task-a.jsonl"));
    expect(await locateShadowTranscript(context())).toBeNull();
    expect(await locateShadowTranscript({ ...context(), taskId: "../../secret" })).toBeNull();
    expect(await locateShadowTranscript({ ...context(), skipTranscript: true })).toBeNull();
  });
  it("correlates different task and agent ids by the exact tool id, never by agent type", async () => {
    const root = await sessionRoot();
    await writeFile(join(root, "agent-real.meta.json"), JSON.stringify({ toolUseId: "tool-1", agentType: "reviewer" }));
    await writeFile(join(root, "agent-real.jsonl"), "");
    expect(await locateShadowTranscript(context())).toBeNull();
    expect((await locateShadowTranscript({ ...context(), toolUseId: "tool-1" }))?.path).toBe(join(root, "agent-real.jsonl"));
  });
  it("finds live workflow transcript directories using only ids reported by that task", async () => {
    const root = await sessionRoot(); const workflow = join(root, "workflows", "wf_live");
    await mkdir(workflow, { recursive: true }); await writeFile(join(workflow, "agent-inner.jsonl"), "");
    expect(await locateShadowTranscript(context(), ["different"])).toBeNull();
    expect(await locateShadowTranscript(context(), ["inner"])).toEqual({ source: "workflow", path: workflow });
  });
  it("binds a completed snapshot by taskId even if workflowName was absent from SDK events", async () => {
    const root = await sessionRoot(); const snapshots = join(root, "..", "workflows");
    await mkdir(snapshots, { recursive: true });
    await writeFile(join(snapshots, "wf_completed.json"), JSON.stringify({ taskId: "task-a", runId: "wf_completed", workflowName: "ai-review-staged", workflowProgress: [] }));
    const found = await locateShadowTranscript(context());
    expect(found?.source).toBe("workflow");
    expect(found?.snapshot?.workflow.name).toBe("ai-review-staged");
    expect(await locateShadowTranscript({ ...context(), taskId: "different-task" })).toBeNull();
    expect(await locateShadowTranscript(context(), ["fresh-run-agent"])).toBeNull();
  });
  it("bounds large transcript reads and drops the incomplete first line", async () => {
    const path = join(dir, "large.jsonl"); await writeFile(path, "x".repeat(500) + "\n" + row([{ type: "text", text: "recent" }]) + "\n");
    const tail = await readBoundedTail(path, 200);
    expect(tail.truncated).toBe(true); expect(tail.text).not.toContain("xxx"); expect(tail.text).toContain("recent");
  });
});

it("normalizes actual Claude phase/progress states and metrics without executing script", () => {
  const snapshot = parseWorkflowSnapshot({ taskId: "t", runId: "wf_t", script: "throw new Error('must never run')", phases: [{ title: "Context", detail: "gather" }], workflowProgress: [
    { type: "workflow_agent", index: 1, label: "pre-gather", phaseIndex: 1, phaseTitle: "Context", agentId: "a", state: "done", tokens: 55600, durationMs: 16000 },
    { type: "workflow_agent", index: 2, label: "context (judgment)", phaseIndex: 1, phaseTitle: "Context", agentId: "b", state: "progress", model: "opus", lastToolName: "Read", toolCalls: 5 },
    { type: "workflow_agent", index: 3, label: "queued", state: "start", queuedAt: 1 },
    { type: "workflow_agent", index: 4, agentId: "error", state: "error" },
  ] });
  expect(snapshot?.agents.map(a => a.state)).toEqual(["done", "running", "pending", "failed"]);
  expect(snapshot?.agents[0]).toMatchObject({ label: "pre-gather", phase: "Context", tokens: 55600 });
  expect(snapshot?.workflow.phases).toEqual([{ index: 1, title: "Context", detail: "gather" }]);
});

it("does not show orphaned inner agents as running after their workflow stops", () => {
  for (const status of ["killed", "failed", "paused"]) {
    const result = parseWorkflowSnapshot({ taskId: "t", runId: "wf_t", status, workflowProgress: [
      { type: "workflow_agent", index: 1, agentId: "done", state: "done" },
      { type: "workflow_agent", index: 2, agentId: "orphan", state: "progress" },
    ] });
    expect(result?.agents.map(a => a.state)).toEqual(["done", status]);
  }
});
