import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F49.2 plan test 38 — the network section's read-only mcp-listener block.
// Never renders a grant's bearer token: McpListenerStatus carries no token
// field at all, so this test also stands as a negative check on that.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let statusResponse: unknown = { agents: {}, accounts: [], peers: [] };

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string) => {
    if (method === "daemon.status") return statusResponse;
    if (method === "config.get") return {};
    return [];
  }),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { SettingsScreen } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { mcpListenerView } from "../src/state/selectors.settings";
import { rpcCall } from "../src/rpc/bridge";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  statusResponse = { agents: {}, accounts: [], peers: [] };
});

async function mountNetwork(): Promise<void> {
  getSettingsCommands(appStore, rpcCall).setSection("network");
  await act(async () => {
    mounted = create(React.createElement(SettingsScreen));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SettingsScreen network section — mcp listener", () => {
  // pre-load is a selector-level state: the mocked rpc resolves before the first render can
  // be observed, so assert the view directly rather than racing the mount.
  it("says loading, not em-dash, before the first daemon.status lands", () => {
    expect(mcpListenerView(null, false).headline).toContain("loading");
    expect(mcpListenerView(null, true).headline).toBe("local MCP listener: —");
  });


  it("renders the off headline when disabled", async () => {
    statusResponse = {
      agents: {},
      accounts: [],
      peers: [],
      mcpListener: { enabled: false, listening: false, address: null, grants: [] },
    };
    await mountNetwork();

    const headline = mounted!.root.findByProps({ "data-mcp-listener-state": true });
    expect(headline.children.join("")).toContain("local MCP listener: off");
    expect(mounted!.root.findAllByProps({ "data-mcp-listener-grant": true })).toHaveLength(0);
  });

  it("renders address and grant rows without ever exposing a token", async () => {
    statusResponse = {
      agents: {},
      accounts: [],
      peers: [],
      mcpListener: {
        enabled: true,
        listening: true,
        address: "127.0.0.1:54321",
        // the extra `token` is deliberate: the type has no such field, and the block must not
        // render it even if a future daemon started sending one.
        grants: [{ agentId: "a1b2c3d4e5", provider: "kimi", since: 0, token: "tok_deadbeef" }],
      },
    };
    await mountNetwork();

    const headline = mounted!.root.findByProps({ "data-mcp-listener-state": true });
    expect(headline.children.join("")).toContain("127.0.0.1:54321");
    const rows = mounted!.root.findAllByProps({ "data-mcp-listener-grant": true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.children.join("")).toContain("kimi");

    const block = mounted!.root.findByProps({ "data-mcp-listener": true });
    const text = block.findAll((n) => typeof n.type === "string").flatMap((n) =>
      n.children.filter((c): c is string => typeof c === "string"),
    ).join(" ");
    expect(text).not.toContain("tok_deadbeef");
    // the footnote must SAY it is token-authenticated while showing no token
    expect(text).toContain("never shown here");
    expect(text).toContain("127.0.0.1 by construction");
  });
});
