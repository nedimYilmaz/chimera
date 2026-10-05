import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// PROVENANCE: the "built-in" badge is the UI's claim that a server ships with Chimera. It must come
// only from the daemon-stamped `builtIn` marker -- never from a name -- so a user's own server called
// "laya" stays an ordinary, removable external server.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn((method: string) => {
    if (method === "mcpstore.list") {
      return Promise.resolve([
        { name: "chimera-browser", type: "stdio", command: "/Apps/Chimera/runtime/node/bin/node", args: ["cli.js"], env: {}, direct: false, enabled: true, trust: "full", sessionMode: "agent", builtIn: { id: "chimera-browser", version: "0.0.83" } },
        { name: "laya", type: "stdio", command: "/opt/my-own-laya/bin/python", args: ["-m", "my_laya"], env: {}, direct: false, enabled: true, trust: "full" },
        { name: "npm-tool", type: "stdio", command: "npx", args: ["x"], env: {}, direct: false, enabled: true, trust: "full", managed: { packageName: "x", version: "1.0.0" } },
      ]);
    }
    if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
    return Promise.resolve(undefined);
  }),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  subscribeEvents: vi.fn().mockResolvedValue(undefined),
}));

const all = (root: ReactTestInstance, key: string, value?: string) =>
  root.findAll((n) => n.props[key] !== undefined && (value === undefined || n.props[key] === value));

describe("Settings MCP section — built-in vs external servers", () => {
  it("badges only the daemon-marked built-in, offers it no uninstall, and leaves same-named custom servers external", async () => {
    await act(async () => { await getSettingsCommands(appStore, rpcCall).loadMcpStore(); });
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    const badge = all(view.root, "data-mcp-store-builtin-badge", "chimera-browser")[0]!;
    expect(badge.children.join("")).toBe("built-in · 0.0.83");
    expect(badge.props.title).toContain("Not an external MCP server");
    expect(all(view.root, "data-mcp-store-uninstall", "chimera-browser")).toHaveLength(0);
    // still manageable: a built-in can be disabled, trusted/untrusted and made direct like any server.
    expect(all(view.root, "data-mcp-store-enable-toggle", "chimera-browser").length).toBeGreaterThan(0);

    expect(all(view.root, "data-mcp-store-builtin-badge", "laya")).toHaveLength(0);
    expect(all(view.root, "data-mcp-store-uninstall", "laya").length).toBeGreaterThan(0);
    expect(all(view.root, "data-mcp-store-builtin-badge", "npm-tool")).toHaveLength(0);
    expect(all(view.root, "data-mcp-store-uninstall", "npm-tool").length).toBeGreaterThan(0);
  });
});
