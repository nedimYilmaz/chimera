import { describe, expect, it } from "vitest";
import { initialState, pendingDeepLink, reduce, selectedTaskId, taskQueueForDeepLink, type UiState } from "../src/index.js";

describe("deep-link reducer state", () => {
  it("selects known entities and parks a monotonic navigation intent", () => {
    const seed: UiState = {
      ...initialState,
      teams: { available: true, items: [{ name: "ui" }] },
      queues: { available: true, items: [{ name: "features" }] },
      tasks: { t1: { taskId: "t1", queue: "features", state: "blocked", agentId: null, attempts: 0, priority: 1, subject: "ship", updatedAt: 1 } },
    };
    const team = reduce(seed, { type: "navigate", target: { kind: "team", name: "ui" } });
    expect(team.activeTab).toBe("teams");
    expect(team.teamCursor).toBe(0);
    expect(team.navigation).toEqual({ requestId: 1, target: { kind: "team", name: "ui" } });

    const task = reduce(team, { type: "navigate", target: { kind: "task", taskId: "t1" } });
    expect(task.activeTab).toBe("queues");
    expect(task.queueCursor).toBe(0);
    expect(task.navigation.requestId).toBe(2);
  });

  it("applies agent/event navigation and ignores stale consumption", () => {
    const withUnseen: UiState = { ...initialState, unseen: { permissions: 1, questions: 2, errors: 3 } };
    const agent = reduce(withUnseen, { type: "navigate", target: { kind: "agent", agentId: "a1" } });
    expect(agent.selectedAgentId).toBe("a1");
    expect(agent.activeTab).toBe("agents");
    const event = reduce(agent, { type: "navigate", target: { kind: "event", seq: 42 } });
    expect(event.unseen).toEqual({ permissions: 0, questions: 0, errors: 0 });
    expect(reduce(event, { type: "navigationConsumed", requestId: 1 })).toBe(event);
    expect(reduce(event, { type: "navigationConsumed", requestId: 2 }).navigation.target).toBeNull();
  });

  it("exposes stable navigation selectors", () => {
    const state: UiState = { ...initialState, tasks: { t1: { taskId: "t1", queue: "q", state: "pending", agentId: null, attempts: 0, priority: 0, subject: "one", updatedAt: 1 } }, queueDetail: { spec: { name: "q" }, counts: {}, tasks: [{ taskId: "t1" }] } };
    expect(taskQueueForDeepLink(state, { kind: "task", taskId: "t1" })).toBe("q");
    expect(selectedTaskId(state)).toBe("t1");
    expect(pendingDeepLink(reduce(state, { type: "navigate", target: { kind: "settings", section: "mcp" } }))).toEqual({ kind: "settings", section: "mcp" });
  });
});
