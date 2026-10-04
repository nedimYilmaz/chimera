import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall, openArtifactUrl } from "../src/rpc/bridge";

// MCP-OAUTH-DISCOVERABILITY: a remote store row imported BEFORE oauth existed (or via the
// import button, which defaults to bearer) never gets a `kind:"oauth"` entry on its own — the
// real motivating case is the `gateway` server (auth.kind:"bearer", but its endpoint is
// genuinely OAuth 2.1). loadMcpStore's per-row detect probe (mcpstore.detectAuth) is the ONLY
// way that server's Authorize button ever appears; clicking it must CONVERT the entry to
// oauth-kind (mcpstore.setAuthKind) before running the existing start->open->poll flow.
let detectCalls: Array<Record<string, unknown> | undefined> = [];
let setAuthKindCalls: Array<Record<string, unknown> | undefined> = [];
let convertedKind: "bearer" | "oauth" = "bearer";
// MCPSTORE-LIFECYCLE-UI: when set, oauth.start rejects for this server name — simulates
// McpStoreOAuthNotConfiguredError's "mcp store server ... is not configured for oauth"
// (thrown when the endpoint genuinely doesn't advertise an OAuth 2.1 authorization server).
let oauthStartFailFor: string | null = null;

vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") {
        return Promise.resolve([
          {
            name: "gateway", type: "http", url: "https://platform.acmecorp.dev/mcp", headers: {}, direct: false,
            auth: { kind: convertedKind, keychainRef: "chimera:mcp:gateway", ...(convertedKind === "oauth" ? { scopes: ["docs"] } : {}) },
          },
          { name: "plain", type: "http", url: "https://plain.example.com/mcp", headers: {}, direct: false, auth: { kind: "bearer", keychainRef: "chimera:mcp:plain" } },
        ]);
      }
      if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
      if (method === "mcpstore.detectAuth") {
        detectCalls.push(params);
        const name = params?.["name"];
        return Promise.resolve({ oauth: name === "gateway" });
      }
      if (method === "mcpstore.setAuthKind") {
        setAuthKindCalls.push(params);
        convertedKind = "oauth";
        return Promise.resolve({ name: "gateway", type: "http", url: "https://platform.acmecorp.dev/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway", scopes: ["docs"] } });
      }
      if (method === "mcpstore.oauth.start") {
        const name = params?.["name"];
        if (name === oauthStartFailFor) {
          return Promise.reject({ code: "protocol", message: `mcp store server "${String(name)}" is not configured for oauth` });
        }
        return Promise.resolve({ pendingId: "p1", authorizeUrl: "https://platform.acmecorp.dev/oauth/authorize?x=1" });
      }
      if (method === "mcpstore.oauth.finish") return Promise.resolve({ status: "connected" });
      if (method === "mcpstore.tools") return Promise.resolve({ servers: [{ server: "gateway", connected: true, tools: [] }] });
      return Promise.resolve(undefined);
    }),
    openArtifactUrl: vi.fn((url: string) => { openedUrls.push(url); return Promise.resolve(); }),
    onDaemonEvent: vi.fn(() => () => {}),
    onDaemonState: vi.fn(() => () => {}),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
  };
});

const openedUrls: string[] = [];

function find(root: ReactTestInstance, key: string, value?: string): ReactTestInstance {
  return root.find((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}
function findAll(root: ReactTestInstance, key: string, value?: string): ReactTestInstance[] {
  return root.findAll((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}

describe("Settings MCP section — Authorize on a detected-OAuth bearer entry (MCP-OAUTH-DISCOVERABILITY)", () => {
  beforeEach(() => {
    detectCalls = [];
    setAuthKindCalls = [];
    convertedKind = "bearer";
    oauthStartFailFor = null;
    openedUrls.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("probes every non-oauth remote row on load, but Authorize itself is unconditional — only the detected hint is probe-gated (MCPSTORE-LIFECYCLE-UI)", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    expect(detectCalls).toEqual(expect.arrayContaining([{ name: "gateway" }, { name: "plain" }]));

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(find(view.root, "data-mcp-store-authorize", "gateway").children.join("")).toBe("Authorize");
    expect(find(view.root, "data-mcp-store-oauth-detected", "gateway").children.join("")).toBe("oauth detected");
    // "plain" — the probe did NOT flag it as oauth, but the Authorize control still renders
    // (the old behavior hid it entirely here, which was the reported bug: a real gateway
    // whose probe fails/doesn't resolve had NO recovery path at all).
    expect(find(view.root, "data-mcp-store-authorize", "plain").children.join("")).toBe("Authorize");
    expect(findAll(view.root, "data-mcp-store-oauth-detected", "plain")).toHaveLength(0);
  });

  it("clicking Authorize on the detected-but-still-bearer row converts it (setAuthKind) BEFORE starting the oauth flow", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    await act(async () => { await find(view.root, "data-mcp-store-authorize", "gateway").props.onClick(); });

    expect(setAuthKindCalls).toEqual([{ name: "gateway", kind: "oauth" }]);
    // setAuthKind ran BEFORE oauth.start — the mock only accepts the reconciled kind.
    const methods = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(methods.indexOf("mcpstore.setAuthKind")).toBeLessThan(methods.indexOf("mcpstore.oauth.start"));
    expect(openedUrls).toEqual(["https://platform.acmecorp.dev/oauth/authorize?x=1"]);

    // after the reload the entry is oauth-kind — the "oauth detected" hint (a bearer-only
    // affordance) is gone; only the ordinary oauth-kind Authorize path applies now.
    expect(findAll(view.root, "data-mcp-store-oauth-detected", "gateway")).toHaveLength(0);
  });

  // MCPSTORE-LIFECYCLE-UI acceptance criterion 4: a server that genuinely can't do OAuth
  // must fail LOUDLY in the row, not just have a silently-missing button.
  it("a server that isn't OAuth-configured surfaces a visible, specific error in its row", async () => {
    oauthStartFailFor = "plain";
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    await act(async () => { await find(view.root, "data-mcp-store-authorize", "plain").props.onClick(); });

    expect(find(view.root, "data-mcp-store-oauth-error", "plain").children.join(""))
      .toContain("not configured for oauth");
    // the button itself survives the failure — the row stays recoverable, not dead-ended.
    expect(find(view.root, "data-mcp-store-authorize", "plain").children.join("")).toBe("Authorize");
  });
});
