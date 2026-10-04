import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { AgentList } from "../src/components/AgentList";
import { registerActionHandler } from "../src/keymap";
import { appStore } from "../src/state/store";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("AgentList mouse affordances", () => {
  it.each(["agents.spawn", "agents.spawnDefault", "agents.kill", "system.pinSelected"])("%s dispatches the existing action id", (actionId) => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "afford-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      appStore.dispatch({ type: "selectAgent", agentId: "afford-1" });
      mounted = create(React.createElement(AgentList));
    });
    const handler = vi.fn();
    const dispose = registerActionHandler(actionId, handler);
    const button = mounted!.root.findByProps({ "data-agent-action": actionId });

    act(() => button.props["onClick"]({ stopPropagation: vi.fn() }));

    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });
});

// AGENT-MARK visibility. Reported as: "I tick it, then move to another agent and it does not look
// marked at all — I cannot tell which agents I marked." The mark control had been placed inside
// the SELECTED-row action cluster, so the set existed but nothing on screen said what was in it,
// which is the one thing a batch action has to show before it runs.
describe("a marked agent stays visibly marked when it is not the selected row", () => {
  const twoAgents = () => appStore.dispatch({
    type: "agentRecords",
    records: [
      { agentId: "mark-a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
      { agentId: "mark-b", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2 },
    ],
  });

  it("shows the mark on an UNSELECTED row once it is ticked", () => {
    act(() => {
      twoAgents();
      appStore.dispatch({ type: "clearAgentMarks" });
      appStore.dispatch({ type: "toggleAgentMark", agentId: "mark-a" });
      appStore.dispatch({ type: "selectAgent", agentId: "mark-b" });   // look elsewhere
      mounted = create(React.createElement(AgentList));
    });
    const marks = mounted!.root.findAllByProps({ "data-agent-marked": "1" });
    expect(marks.length).toBeGreaterThan(0);   // the tick survived moving away from the row
  });

  it("does not put a checkbox on every unselected, unmarked row", () => {
    // The other half of the trade: always rendering it would give an untouched list a column of
    // empty boxes. Marked rows always show; unmarked ones only when selected.
    act(() => {
      twoAgents();
      appStore.dispatch({ type: "clearAgentMarks" });
      appStore.dispatch({ type: "selectAgent", agentId: "mark-b" });
      mounted = create(React.createElement(AgentList));
    });
    const boxes = mounted!.root.findAllByProps({ "data-agent-action": "agents.mark" });
    expect(boxes.length).toBe(1);   // only the selected row offers one
  });
});

