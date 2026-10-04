// KILL-CONFIRM: agent.kill is irreversible (terminates the live process, loses
// in-flight work) — it must route through the same ConfirmCard gate every other
// destructive action uses (dissolveTeam/deleteQueue/...), not fire on a bare
// click/chord. Harness/mocking mirrors AgentsScreen.chords.test.tsx.
import { keydownHandlers, rpcCalls } from "./agents-window-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

vi.mock("../src/rpc/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rpc/bridge")>();
  return {
    ...actual,
    rpcCall: (method: string, params?: unknown) => {
      (globalThis as unknown as { __rpcCalls: Array<{ method: string; params: unknown }> }).__rpcCalls.push({ method, params });
      return Promise.resolve({});
    },
    subscribeEvents: async () => {},
    onDaemonEvent: () => () => {},
    onDaemonState: () => () => {},
  };
});

import { AgentsScreen } from "../src/screens/AgentsScreen";
import { appStore } from "../src/state/store";
import { runAction } from "../src/keymap";
import { findBuiltin } from "../src/state/commands.agents";

const flush = () => new Promise((r) => setTimeout(r, 0));

let tree: ReturnType<typeof create> | undefined;
function mount(): void {
  act(() => { tree = create(<AgentsScreen />); });
}

function seedSelectedAgent(agentId: string): void {
  act(() => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    } as never);
    appStore.dispatch({ type: "selectAgent", agentId } as never);
  });
}

beforeEach(() => { rpcCalls.length = 0; });
afterEach(() => {
  if (tree) act(() => { tree!.unmount(); });
  tree = undefined;
  act(() => { appStore.dispatch({ type: "confirm", confirm: null }); });
  keydownHandlers.length = 0;
});

describe("AgentsScreen: kill-agent is gated behind a confirm dialog", () => {
  it("agents.kill (row button / mod+shift+k) opens a confirm instead of killing directly", async () => {
    seedSelectedAgent("kc-1");
    mount();
    await act(async () => { runAction("agents.kill", appStore); await flush(); });

    expect(rpcCalls.some((c) => c.method === "agent.kill")).toBe(false);
    expect(appStore.getState().confirm).toEqual({ kind: "killAgent", agentId: "kc-1", label: expect.any(String) });
  });

  it("confirming the dialog fires agent.kill for the pending agentId and clears the confirm", async () => {
    seedSelectedAgent("kc-2");
    mount();
    await act(async () => { runAction("agents.kill", appStore); await flush(); });

    const confirmChip = tree!.root.findByProps({ "data-confirm": true });
    await act(async () => { confirmChip.props["onClick"](); await flush(); });

    expect(rpcCalls).toEqual(expect.arrayContaining([{ method: "agent.kill", params: { agentId: "kc-2" } }]));
    expect(appStore.getState().confirm).toBeNull();
  });

  it("closing the dialog (esc/back) never calls agent.kill", async () => {
    seedSelectedAgent("kc-3");
    mount();
    await act(async () => { runAction("agents.kill", appStore); await flush(); });

    expect(appStore.getState().confirm).not.toBeNull();
    act(() => { appStore.dispatch({ type: "confirm", confirm: null }); });

    expect(rpcCalls.some((c) => c.method === "agent.kill")).toBe(false);
  });

  it("the command-palette/slash \"kill\" builtin also opens the confirm, not a direct kill", async () => {
    seedSelectedAgent("kc-4");
    const cmd = findBuiltin("kill");
    expect(cmd).toBeDefined();
    await act(async () => {
      cmd!.run({ store: appStore, commands: { killSelected: async () => { throw new Error("should not be called directly"); } } as never, openSpawn: () => {} });
      await flush();
    });

    expect(rpcCalls.some((c) => c.method === "agent.kill")).toBe(false);
    expect(appStore.getState().confirm).toEqual({ kind: "killAgent", agentId: "kc-4", label: expect.any(String) });
  });
});
