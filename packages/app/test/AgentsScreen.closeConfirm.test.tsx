// CLOSE-CONFIRM: agent.close ends a session irreversibly (the next enter
// lazily respawns fresh, with no memory of the closed session) — it must
// route through the same ConfirmCard gate killAgent uses (KILL-CONFIRM),
// not fire on a bare chord/palette entry. Mirrors AgentsScreen.killConfirm.test.tsx.
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

function seedMainConductor(agentId: string): void {
  act(() => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    } as never);
    appStore.dispatch({ type: "mainConductorId", agentId } as never);
  });
}

beforeEach(() => { rpcCalls.length = 0; });
afterEach(() => {
  if (tree) act(() => { tree!.unmount(); });
  tree = undefined;
  act(() => { appStore.dispatch({ type: "confirm", confirm: null }); appStore.dispatch({ type: "mainConductorId", agentId: null } as never); });
  keydownHandlers.length = 0;
});

describe("AgentsScreen: close-conductor is gated behind a confirm dialog", () => {
  it("agents.closeMain (mod+shift+w) opens a confirm instead of closing directly", async () => {
    seedMainConductor("cc-1");
    mount();
    await act(async () => { runAction("agents.closeMain", appStore); await flush(); });

    expect(rpcCalls.some((c) => c.method === "agent.close")).toBe(false);
    expect(appStore.getState().confirm).toEqual({ kind: "closeAgent", agentId: "cc-1", label: expect.any(String) });
  });

  it("confirming the dialog fires agent.close for the main conductor and clears the confirm", async () => {
    seedMainConductor("cc-2");
    mount();
    await act(async () => { runAction("agents.closeMain", appStore); await flush(); });

    const confirmChip = tree!.root.findByProps({ "data-confirm": true });
    await act(async () => { confirmChip.props["onClick"](); await flush(); });

    expect(rpcCalls).toEqual(expect.arrayContaining([{ method: "agent.close", params: { agentId: "cc-2" } }]));
    expect(appStore.getState().confirm).toBeNull();
  });

  it("closing the dialog (esc/back) never calls agent.close", async () => {
    seedMainConductor("cc-3");
    mount();
    await act(async () => { runAction("agents.closeMain", appStore); await flush(); });

    expect(appStore.getState().confirm).not.toBeNull();
    act(() => { appStore.dispatch({ type: "confirm", confirm: null }); });

    expect(rpcCalls.some((c) => c.method === "agent.close")).toBe(false);
  });

  it("the command-palette/slash \"close\" builtin also opens the confirm, not a direct close", async () => {
    seedMainConductor("cc-4");
    const cmd = findBuiltin("close");
    expect(cmd).toBeDefined();
    await act(async () => {
      cmd!.run({ store: appStore, commands: { closeMain: async () => { throw new Error("should not be called directly"); } } as never, openSpawn: () => {} });
      await flush();
    });

    expect(rpcCalls.some((c) => c.method === "agent.close")).toBe(false);
    expect(appStore.getState().confirm).toEqual({ kind: "closeAgent", agentId: "cc-4", label: expect.any(String) });
  });
});
