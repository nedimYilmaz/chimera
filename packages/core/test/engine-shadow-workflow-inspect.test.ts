import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { ShadowWorkflowInspectResponse } from "@chimera/protocol/contract";
import { makeEngineHome } from "./helpers.js";

// SHADOW-WORKFLOW-VISIBILITY: end-to-end for shadow.workflowInspect. A parent agent runs a
// Workflow tool: the SDK emits an agent_task (workflowName + toolUseId) that creates the shadow,
// then a tool_result whose toolId matches and whose text prints the on-disk transcript dir. The
// supervisor stashes that dir on the shadow; the RPC then parses it on demand.

const tick = () => new Promise((r) => setTimeout(r, 20));

function engineWith(scenario: FakeStep[]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([scenario])]]),
  });
}

describe("shadow.workflowInspect (end-to-end)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-e2e-"));
    await writeFile(join(dir, "journal.jsonl"), [
      JSON.stringify({ type: "started", key: "v2:a", agentId: "inner1" }),
      JSON.stringify({ type: "result", key: "v2:a", agentId: "inner1", result: "inner1 finding" }),
    ].join("\n"));
    await writeFile(join(dir, "agent-inner1.meta.json"), JSON.stringify({ agentType: "general-purpose", spawnDepth: 1 }));
    await writeFile(join(dir, "agent-inner1.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:00.000Z", message: { role: "user", content: "Investigate X" } }) + "\n" +
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T15:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "X is fine" }] } }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runWorkflowParent(resultText: string) {
    const e = engineWith([
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", toolUseId: "wf-tool-1", workflowName: "review-changes", description: "review the branch" } },
      { emit: { kind: "tool_result", data: { toolId: "wf-tool-1", result: resultText } } },
      { end: { resultText: "ok" } },
    ]);
    const parent = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await tick();
    return { e, shadowId: `shadow:${parent.agentId}:T1` };
  }

  it("happy path: parses the reported transcript dir into inner-agent rows and a drill-down tail", async () => {
    const { e, shadowId } = await runWorkflowParent(
      `Workflow complete.\nTranscript dir: ${dir}\nRun ID: wf_e2e-123`,
    );

    const snap = (await e.handle("shadow.workflowInspect", { agentId: shadowId })) as ShadowWorkflowInspectResponse;
    expect(snap.available).toBe(true);
    expect(snap.runId).toBe("wf_e2e-123");
    expect(snap.transcriptDir).toBe(dir);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0]).toMatchObject({
      agentId: "inner1", agentType: "general-purpose", state: "done",
      resultPreview: "inner1 finding", label: "Investigate X", phase: null,
    });

    // Drill into the inner agent's transcript tail.
    const drill = (await e.handle("shadow.workflowInspect", { agentId: shadowId, innerAgentId: "inner1" })) as ShadowWorkflowInspectResponse;
    expect(drill.transcript).toEqual([
      { role: "user", text: "Investigate X", ts: Date.parse("2026-07-01T15:00:00.000Z") },
      { role: "assistant", text: "X is fine", ts: Date.parse("2026-07-01T15:00:02.000Z") },
    ]);
  });

  it("degrades to available:false + a reason when the reported dir is gone", async () => {
    const { e, shadowId } = await runWorkflowParent(`Transcript dir: ${dir}\nRun ID: wf_gone`);
    await rm(dir, { recursive: true, force: true });   // workflow cleaned up between report and inspect
    const snap = (await e.handle("shadow.workflowInspect", { agentId: shadowId })) as ShadowWorkflowInspectResponse;
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/unavailable/i);
    expect(snap.runId).toBe("wf_gone");                // still surfaces what it knew
    expect(snap.agents).toEqual([]);
  });

  it("degrades when the workflow never reported a transcript dir yet", async () => {
    // tool_result carries no markers -> nothing captured on the shadow.
    const { e, shadowId } = await runWorkflowParent("Workflow finished but printed no dir line");
    const snap = (await e.handle("shadow.workflowInspect", { agentId: shadowId })) as ShadowWorkflowInspectResponse;
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/not been reported yet/i);
  });

  it("reports missing session logs for a native sub-agent instead of rejecting its type", async () => {
    const e = engineWith([
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T2", toolUseId: "sub-1", subagentType: "code-reviewer" } },
      { emit: { kind: "tool_result", data: { toolId: "sub-1", result: `Transcript dir: ${dir}` } } },
      { end: { resultText: "ok" } },
    ]);
    const parent = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await tick();
    const snap = (await e.handle("shadow.workflowInspect", { agentId: `shadow:${parent.agentId}:T2` })) as ShadowWorkflowInspectResponse;
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/spawning Claude session/i);
  });

  it("returns not-a-known-shadow for an unknown agentId", async () => {
    const { e } = await runWorkflowParent(`Transcript dir: ${dir}`);
    const snap = (await e.handle("shadow.workflowInspect", { agentId: "shadow:nope:X" })) as ShadowWorkflowInspectResponse;
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/not a known shadow/i);
  });
});

it("serves CLI phases from live task_progress before any Workflow tool result or transcript file", async () => {
  const e = engineWith([
    { emit: { kind: "agent_started", data: { sessionId: "s-live" } } },
    { task: { taskId: "gate", subagentType: "ai-review-staged" } },
    { emit: { kind: "agent_task", data: { taskId: "gate", status: "running", workflowProgress: [
      { type: "workflow_phase", index: 1, title: "code-review:ai-review-context" },
      { type: "workflow_agent", index: 1, agentId: "pre", label: "pre-gather", phaseIndex: 1, phaseTitle: "code-review:ai-review-context", state: "done", tokens: 55600 },
      { type: "workflow_agent", index: 2, agentId: "judge", label: "context (judgment)", phaseIndex: 1, state: "progress", model: "opus", tokens: 91700 },
    ] } } },
    { awaitSend: true },
  ]);
  const parent = await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
  await tick();
  try {
    const result = await e.handle("shadow.workflowInspect", { agentId: `shadow:${parent.agentId}:gate` }) as ShadowWorkflowInspectResponse;
    expect(result.available).toBe(true); expect(result.source).toBe("workflow");
    expect(result.workflow?.phases[0]?.title).toBe("code-review:ai-review-context");
    expect(result.agents.map(a => [a.label, a.state, a.tokens])).toEqual([["pre-gather", "done", 55600], ["context (judgment)", "running", 91700]]);
  } finally { await e.handle("agent.kill", { agentId: parent.agentId }); }
});
