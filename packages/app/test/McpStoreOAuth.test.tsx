import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall, openArtifactUrl } from "../src/rpc/bridge";

// MCP-OAUTH slice 3: the Authorize button on an oauth-kind remote store row —
// click -> mcpstore.oauth.start -> open the returned authorizeUrl in the system
// browser (the existing Tauri opener plugin seam, openArtifactUrl) -> poll
// mcpstore.oauth.finish until connected (badge flips, button disappears) or error
// (inline message). The app never sees a token: only pendingId/authorizeUrl/status
// ever cross this boundary.
let finishStatus: "pending" | "connected" | "error" = "pending";
let finishCalls = 0;
let cancelCalls: Array<Record<string, unknown> | undefined> = [];
// MCPSTORE-OAUTH-CANCEL race test hook: lets a test hold the cancel RPC open (simulating a
// cancel that's still in flight against the daemon) and release it on demand.
let cancelGate: Promise<unknown> = Promise.resolve({});
const openedUrls: string[] = [];

vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") {
        return Promise.resolve([
          { name: "gateway", type: "http", url: "https://gw.example.com/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway", scopes: ["docs"] } },
          { name: "gateway-err", type: "http", url: "https://gw2.example.com/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway-err", scopes: ["docs"] } },
          // its own row, never touched by the other describe block above — that block
          // connects "gateway" (tools load + oauth status), and the singleton cmds/appStore
          // this file shares across tests would otherwise leak that "Re-authorize" state in.
          { name: "gateway-cancel", type: "http", url: "https://gw3.example.com/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway-cancel", scopes: ["docs"] } },
        ]);
      }
      if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
      if (method === "mcpstore.oauth.start") return Promise.resolve({ pendingId: "p1", authorizeUrl: "https://gw.example.com/oauth/authorize?x=1" });
      if (method === "mcpstore.oauth.finish") {
        finishCalls += 1;
        return Promise.resolve(finishStatus === "error" ? { status: "error", error: "state mismatch" } : { status: finishStatus });
      }
      if (method === "mcpstore.oauth.cancel") {
        cancelCalls.push(params);
        return cancelGate;
      }
      if (method === "mcpstore.tools") return Promise.resolve({ servers: [{ server: "gateway", connected: true, tools: [] }] });
      return Promise.resolve(undefined);
    }),
    openArtifactUrl: vi.fn((url: string) => { openedUrls.push(url); return Promise.resolve(); }),
    onDaemonEvent: vi.fn(() => () => {}),
    onDaemonState: vi.fn(() => () => {}),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
  };
});

function find(root: ReactTestInstance, key: string, value?: string): ReactTestInstance {
  return root.find((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}
function findAll(root: ReactTestInstance, key: string, value?: string): ReactTestInstance[] {
  return root.findAll((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}

describe("Settings MCP section — Authorize button (MCP-OAUTH slice 3)", () => {
  beforeEach(() => {
    finishStatus = "pending";
    finishCalls = 0;
    cancelCalls = [];
    cancelGate = Promise.resolve({});
    openedUrls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("shows Authorize for a disconnected oauth-kind server, opens the browser, polls, and flips to connected", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    const authorizeBtn = find(view.root, "data-mcp-store-authorize", "gateway");
    expect(authorizeBtn.children.join("")).toBe("Authorize");

    finishStatus = "pending";
    await act(async () => { await authorizeBtn.props.onClick(); });

    // start ran, browser opened with the RETURNED url, no token anywhere
    expect((rpcCall as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("mcpstore.oauth.start", { name: "gateway" });
    expect(openedUrls).toEqual(["https://gw.example.com/oauth/authorize?x=1"]);
    expect(JSON.stringify(cmds.getState())).not.toMatch(/access.?token|stored-in-keychain/i);

    // still polling / not yet connected — button stays
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(findAll(view.root, "data-mcp-store-authorize", "gateway")).toHaveLength(1);

    // flip the daemon to "connected" and let the next poll tick land
    finishStatus = "connected";
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    // MCPSTORE-LIFECYCLE-UI: a connected server still offers Re-authorize (an expired/
    // revoked/rotated grant needs a recovery path) — the button relabels, it never
    // disappears the way it used to.
    const reauthBtn = find(view.root, "data-mcp-store-authorize", "gateway");
    expect(reauthBtn.children.join("")).toBe("Re-authorize");
    expect(find(view.root, "data-mcp-store-badge", "gateway").children.join("")).toContain("tools");
  });

  it("shows an inline error and keeps the Authorize button when oauth.finish reports an error", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    finishStatus = "error";
    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway-err").props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(find(view.root, "data-mcp-store-oauth-error", "gateway-err").children.join("")).toContain("state mismatch");
    // the button stays (the error didn't connect it) — find() throws if it's gone.
    expect(find(view.root, "data-mcp-store-authorize", "gateway-err").children.join("")).toBe("Authorize");
  });
});

// MCPSTORE-OAUTH-CANCEL: the Authorize button's "authorizing…" state was previously a dead
// end — no control could get the row unstuck short of the daemon's 10-minute flow timeout.
describe("Settings MCP section — cancel control (MCPSTORE-OAUTH-CANCEL)", () => {
  beforeEach(() => {
    finishStatus = "pending";
    finishCalls = 0;
    cancelCalls = [];
    cancelGate = Promise.resolve({});
    openedUrls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("appears once authorizing, and clicking it stops polling, restores Authorize, and tells the daemon to abandon the flow", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    // idle: no cancel control yet
    expect(findAll(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel")).toHaveLength(0);

    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway-cancel").props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // busy: Authorize is disabled ("authorizing…") and a cancel control is now present
    const authorizeBtn = find(view.root, "data-mcp-store-authorize", "gateway-cancel");
    expect(authorizeBtn.props.disabled).toBe(true);
    expect(authorizeBtn.children.join("")).toBe("authorizing…");
    const cancelBtn = find(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel");

    await act(async () => { await cancelBtn.props.onClick(); });

    expect(cancelCalls).toEqual([{ pendingId: "p1" }]);
    const restoredBtn = find(view.root, "data-mcp-store-authorize", "gateway-cancel");
    expect(restoredBtn.props.disabled).toBe(false);
    expect(restoredBtn.children.join("")).toBe("Authorize");
    expect(findAll(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel")).toHaveLength(0);

    // the poll really stopped -- no further finish calls after cancel
    const callsAtCancel = finishCalls;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(finishCalls).toBe(callsAtCancel);
  });

  it("cancel-then-authorize-again works", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway-cancel").props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await find(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel").props.onClick(); });

    // a fresh Authorize click works exactly as if nothing had happened before
    finishStatus = "connected";
    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway-cancel").props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(find(view.root, "data-mcp-store-authorize", "gateway-cancel").children.join("")).toBe("Re-authorize");
  });

  // The genuine daemon-side race (cancel landing while the browser's callback is mid
  // token-exchange) is covered end-to-end in packages/core/test/mcpstore-oauth-flow.test.ts
  // (real loopback listener + real HTTP), where it matters: the exchange must complete and
  // the token must land in the keychain regardless of the race. What matters HERE, at the
  // UI layer, is the other half of that race: the row must recover immediately and never
  // block on the daemon RPC settling.
  it("resets the row immediately even while the daemon-side cancel RPC is still in flight (never blocks the UI on the network)", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    let releaseCancel: (v: unknown) => void = () => {};
    cancelGate = new Promise((resolve) => { releaseCancel = resolve; });   // held open deliberately

    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway-cancel").props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(find(view.root, "data-mcp-store-authorize", "gateway-cancel").props.disabled).toBe(true);

    await act(async () => { find(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel").props.onClick(); });

    // the row is already back to a clickable Authorize -- this did NOT wait on cancelGate.
    expect(cancelCalls).toEqual([{ pendingId: "p1" }]);
    const restored = find(view.root, "data-mcp-store-authorize", "gateway-cancel");
    expect(restored.props.disabled).toBe(false);
    expect(restored.children.join("")).toBe("Authorize");
    expect(findAll(view.root, "data-mcp-store-oauth-cancel", "gateway-cancel")).toHaveLength(0);

    // a stray poll tick (as if one had still been in flight when cancel was clicked) never
    // lands -- the poll timer is already gone, so a would-be "connected" result is moot.
    finishStatus = "connected";
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(find(view.root, "data-mcp-store-authorize", "gateway-cancel").children.join("")).toBe("Authorize");

    releaseCancel({});   // let the still-pending daemon RPC settle so it doesn't leak into other tests
    await act(async () => { await Promise.resolve(); });
  });
});
