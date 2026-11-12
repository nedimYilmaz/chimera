import { expect, it } from "vitest";
import { reduce, initialState } from "../src/index.js";

it("new workflow shadows receive activity from live events without reconnecting", () => {
  const agentId = "shadow:parent:gate";
  const event = (seq: number, data: Record<string, unknown>) => ({ type: "event" as const, event: { agentId, seq, ts: seq, kind: "agent_task" as const, data } });
  let state = reduce(initialState, event(1, { status: "running", workflowName: "ai-review-staged", description: "Review staged changes", parentId: "parent", treeId: "parent", depth: 1 }));
  state = reduce(state, event(2, { status: "running", lastToolName: "Read", summary: "Checking authentication", usage: { totalTokens: 55600, toolUses: 4, durationMs: 16000 } }));
  expect(state.agents[agentId]?.shadowInfo).toEqual({ workflowName: "ai-review-staged", description: "Review staged changes", lastToolName: "Read", summary: "Checking authentication", totalTokens: 55600, toolUses: 4, durationMs: 16000 });
  state = reduce(state, event(3, { status: "completed", usage: { totalTokens: -1 }, summary: undefined }));
  expect(state.agents[agentId]?.state).toBe("done");
  expect(state.agents[agentId]?.shadowInfo?.totalTokens).toBe(55600);
  expect(state.agents[agentId]?.shadowInfo?.summary).toBe("Checking authentication");
});
