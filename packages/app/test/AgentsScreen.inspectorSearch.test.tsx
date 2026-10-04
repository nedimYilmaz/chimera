import { keydownHandlers, rpcCalls } from "./agents-window-harness";
import { afterEach, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

vi.mock("../src/rpc/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rpc/bridge")>();
  return { ...actual, rpcCall: async (method: string, params?: unknown) => {
    rpcCalls.push({ method, params });
    return method === "agent.status" ? { spec: {} } : [];
  }, subscribeEvents: async () => {}, onDaemonEvent: () => () => {}, onDaemonState: () => () => {} };
});

import { AgentsScreen } from "../src/screens/AgentsScreen";
import { appStore } from "../src/state/store";

let tree: ReturnType<typeof create> | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  vi.restoreAllMocks();
  keydownHandlers.length = 0;
  rpcCalls.length = 0;
});

it("keeps inspector search bounded during roster changes and chooses only visible initial agents", async () => {
  const records = [
    { agentId: "dead-first", state: "killed", displayLabel: "old" },
    { agentId: "alpha", state: "running", displayLabel: "alpha" },
    { agentId: "beta", state: "running", displayLabel: "beta" },
  ].map((r) => ({ ...r, accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }));
  appStore.dispatch({ type: "agentRecords", records });
  appStore.dispatch({ type: "selectAgent", agentId: null });
  const dispatch = appStore.dispatch.bind(appStore);
  let selections = 0;
  vi.spyOn(appStore, "dispatch").mockImplementation((action) => {
    // Bound a regression instead of hanging the test runner.
    if (action.type === "selectAgent" && ++selections > 30) return;
    dispatch(action);
  });
  await act(async () => { tree = create(<AgentsScreen />); });
  expect(appStore.getState().selectedAgentId).toBe("alpha");
  const search = () => tree!.root.findAllByType("input").find((n) => "data-agents-search" in n.props)!;
  for (const value of ["b", "be", "bet", "beta"]) {
    await act(async () => { search().props.onChange({ target: { value } }); });
  }
  expect(appStore.getState().selectedAgentId).toBe("beta");
  await act(async () => {
    appStore.dispatch({ type: "agentRecords", records: records.filter((r) => r.agentId !== "beta") });
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  // Snapshots retain event-derived agents as extras; choose the other matching
  // agent explicitly, then clearing the filter must not undo that selection.
  await act(async () => { search().props.onChange({ target: { value: "alpha" } }); });
  await act(async () => { search().props.onChange({ target: { value: "" } }); });
  expect(appStore.getState().selectedAgentId).toBe("alpha");
  expect(selections).toBeLessThan(10);
  expect(rpcCalls.filter((c) => c.method === "agent.status").length).toBeLessThan(15);
});
