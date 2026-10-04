import { describe, expect, it } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { buildAgentRows, fleetSummary, hiddenTerminalAgentCount, spawnLineageMap, visibleAgentIds } from "../src/state/selectors";

function fixture() {
  let state = reduce(initialState, { type: "agentRecords", records: [
    { agentId: "owner", state: "running", treeId: "owner", depth: 0, createdAt: 1 },
    ...["old", "new"].map((task, i) => ({ agentId: `shadow:owner:${task}`, state: i ? "running" : "done", treeId: "owner", parentId: "owner", depth: 1, createdAt: i + 2,
      shadow: true, label: "ai-review", shadowInfo: { workflowName: "ai-review" } })),
    { agentId: "worker", state: "running", treeId: "owner", parentId: "owner", depth: 1, createdAt: 4 },
  ] });
  let seq = 1;
  const event = (kind: NormalizedEvent["kind"], data: Record<string, unknown>) => {
    state = reduce(state, { type: "event", event: { agentId: "owner", seq: seq++, ts: seq, kind, data } });
  };
  for (const taskId of ["old", "new"]) {
    event("tool_call", { toolName: "Workflow", toolId: `call-${taskId}`, input: { name: "ai-review" } });
    event("agent_task", { taskId, toolUseId: `call-${taskId}`, workflowName: "ai-review", status: taskId === "old" ? "completed" : "running" });
    event("tool_result", { toolId: `call-${taskId}`, result: "Workflow launched in background" });
  }
  event("tool_call", { toolName: "mcp__chimera__agent_spawn", input: { spec: { prompt: "work" } } });
  return state;
}

describe("native workflows live in the owner's transcript", () => {
  it("omits running and completed workflows from fleet rows, keyboard navigation, search and counts", () => {
    const state = fixture();
    expect(buildAgentRows(state).map(r => r.agentId)).toEqual(["owner", "worker"]);
    expect(visibleAgentIds(state)).toEqual(["owner", "worker"]);
    expect(buildAgentRows(state, "ai-review")).toEqual([]);
    expect(fleetSummary(state)).toMatchObject({ total: 2, running: 2, done: 0 });
    expect(hiddenTerminalAgentCount(state)).toBe(0);
    expect(state.agents["shadow:owner:old"]?.state).toBe("done");
  });

  it("maps repeated workflow names to their own run IDs and leaves real agent spawn links intact", () => {
    const state = fixture();
    const transcript = state.agents.owner!.transcript;
    const links = spawnLineageMap(transcript, state, "owner");
    expect([...links.values()].map(l => l.childId)).toEqual(["shadow:owner:old", "shadow:owner:new", "worker"]);
  });

  it("allows explicitly opening a hidden completed workflow", () => {
    const state = reduce(fixture(), { type: "selectAgent", agentId: "shadow:owner:old" });
    expect(state.selectedAgentId).toBe("shadow:owner:old");
    expect(state.agents[state.selectedAgentId!]?.shadowInfo?.workflowName).toBe("ai-review");
  });
});
