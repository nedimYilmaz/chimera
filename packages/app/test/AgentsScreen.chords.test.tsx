// Harness FIRST: sets window.__CHIMERA_MOCK__ + the keydown-capturing window
// stub before any src/ module (and the mocked bridge) evaluates.
import { keydownHandlers, rpcCalls, fireKeydown } from "./agents-window-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// The bridge's real exports are preserved (children import many of them) — only
// rpcCall is overridden to RECORD calls, so we can assert the persist-then-respond
// pair AgentsScreen's chords drive through agentCommands.answerPermissionPersist.
// (pushes to globalThis.__rpcCalls; the hoisted factory can't close over a module binding.)
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
import { systemLocal } from "../src/state/commands.system";

const flush = () => new Promise((r) => setTimeout(r, 0));

// Seed a pending permission straight into the singleton appStore via the reducer's
// normalized-event path (same projection the live bridge feeds). The appStore is a
// module singleton whose `lastSeq` watermark persists across tests, so every seed
// MUST advance seq (the reducer drops `e.seq <= state.lastSeq` as a replay dup).
let seq = 1;
function seedPermission(requestId: string, toolName: string): void {
  seq += 1;
  act(() => {
    appStore.dispatch({
      type: "event",
      event: { seq, ts: seq, agentId: "agent-1", kind: "permission_request", data: { requestId, toolName, input: {} } },
    } as never);
  });
}

function clearPending(): void {
  act(() => {
    for (const p of appStore.getState().pendingPermissions) {
      appStore.dispatch({ type: "permissionAnswered", requestId: p.requestId } as never);
    }
  });
}

let tree: ReturnType<typeof create> | undefined;
function mount(): void {
  act(() => { tree = create(<AgentsScreen />); });
}

beforeEach(() => { rpcCalls.length = 0; });
afterEach(() => {
  if (tree) act(() => { tree!.unmount(); });
  tree = undefined;
  clearPending();
  systemLocal.set({ replay: { ...systemLocal.getState().replay, active: false } });
  keydownHandlers.length = 0;
});

describe("AgentsScreen: registers the capture-phase permission chord handler", () => {
  it("adds a window keydown listener on mount", () => {
    mount();
    expect(keydownHandlers.length).toBeGreaterThan(0);
  });
});

// KEYMAP-REDESIGN: the ALWAYS-ALLOW-UI persist-then-allow chords (ctrl+t /
// ctrl+s) are RETIRED as keyboard bindings — both letters are OS-reserved,
// and the agents-scope mod+letter budget has no room left for them (see
// keymap.ts's KEYBINDING STANDARD comment). The underlying actions
// (perm.allowTool/perm.allowServer) still work — PermissionCard's persist
// chips call runAction directly (mouse-click path), independent of any
// KEYMAP row or keyboard capture handler.
describe("AgentsScreen: ctrl+t / ctrl+s no longer persist anything (retired)", () => {
  it("ctrl+t/ctrl+s on an MCP ask write no persist rule via keyboard", async () => {
    mount();
    seedPermission("rP", "mcp__ekb__search");
    await act(async () => { fireKeydown({ key: "t", ctrlKey: true }); await flush(); });
    await act(async () => { fireKeydown({ key: "s", ctrlKey: true }); await flush(); });
    expect(rpcCalls.some((c) => c.method === "host.setPolicy")).toBe(false);
  });

  it("cmd+t/cmd+s (metaKey) are inert too — no platform variant survives", async () => {
    mount();
    seedPermission("rP", "mcp__ekb__search");
    await act(async () => { fireKeydown({ key: "t", metaKey: true }); await flush(); });
    await act(async () => { fireKeydown({ key: "s", metaKey: true }); await flush(); });
    expect(rpcCalls.some((c) => c.method === "host.setPolicy")).toBe(false);
  });
});

describe("AgentsScreen: perm.allowTool/perm.allowServer still work via runAction (PermissionCard's mouse-click path)", () => {
  it("perm.allowTool persists the EXACT tool rule then responds", async () => {
    mount();
    seedPermission("rP", "mcp__ekb__search");
    await act(async () => { runAction("perm.allowTool", appStore); await flush(); });
    const persist = rpcCalls.filter((c) => c.method === "host.setPolicy" || c.method === "agent.permissionRespond");
    expect(persist).toEqual([
      { method: "host.setPolicy", params: { tool: "mcp__ekb__search", profile: "*", mode: "allow" } },
      { method: "agent.permissionRespond", params: { requestId: "rP", allow: true } },
    ]);
  });

  it("perm.allowServer persists the SERVER key (not the exact tool)", async () => {
    mount();
    seedPermission("rP", "mcp__ekb__search");
    await act(async () => { runAction("perm.allowServer", appStore); await flush(); });
    const setPolicy = rpcCalls.find((c) => c.method === "host.setPolicy");
    expect(setPolicy?.params).toEqual({ tool: "mcp__ekb", profile: "*", mode: "allow" });
  });

  it("perm.allowTool on a NON-MCP (Bash) ask writes no persist rule", async () => {
    mount();
    seedPermission("rB", "Bash");
    await act(async () => { runAction("perm.allowTool", appStore); await flush(); });
    expect(rpcCalls.some((c) => c.method === "host.setPolicy")).toBe(false);
  });

  it("perm.allowTool during an active REPLAY writes no persist rule (B7 world-mutating guard)", async () => {
    mount();
    seedPermission("rP", "mcp__ekb__search");
    systemLocal.set({ replay: { ...systemLocal.getState().replay, active: true } });
    await act(async () => { runAction("perm.allowTool", appStore); await flush(); });
    expect(rpcCalls.some((c) => c.method === "host.setPolicy")).toBe(false);
  });

  it("perm.allowTool with NO pending permission writes no persist rule", async () => {
    mount();
    await act(async () => { runAction("perm.allowTool", appStore); await flush(); });
    expect(rpcCalls.some((c) => c.method === "host.setPolicy")).toBe(false);
  });
});
