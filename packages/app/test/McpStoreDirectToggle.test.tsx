import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// MCP-STORE-DIRECT-TOGGLE: a per-server "direct" on/off toggle in the Settings MCP
// section (default off — proxy-only, identical to today). Toggling calls
// mcpstore.setDirect and reflects the persisted flag: a "direct" badge appears and the
// toggle button's label flips.
let direct = false;
vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") {
        return Promise.resolve([
          { name: "chrome-devtools", type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp"], env: {}, direct },
        ]);
      }
      if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
      if (method === "mcpstore.setDirect") {
        direct = (params as { direct: boolean }).direct;
        return Promise.resolve({ name: (params as { name: string }).name, direct });
      }
      return Promise.resolve(undefined);
    }),
    onDaemonEvent: vi.fn(() => () => {}),
    onDaemonState: vi.fn(() => () => {}),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
  };
});

function find(root: ReactTestInstance, key: string, value?: string): ReactTestInstance {
  return root.find((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}
function findAll(root: ReactTestInstance, key: string): ReactTestInstance[] {
  return root.findAll((node) => node.props[key] !== undefined);
}

describe("Settings MCP section — per-server direct toggle (MCP-STORE-DIRECT-TOGGLE)", () => {
  it("defaults to proxy-only (no badge), toggling calls mcpstore.setDirect and persists across a reload", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(findAll(view.root, "data-mcp-store-direct-badge")).toHaveLength(0);
    expect(find(view.root, "data-mcp-store-direct-toggle", "chrome-devtools").children.join("")).toBe("make direct");

    await act(async () => { find(view.root, "data-mcp-store-direct-toggle", "chrome-devtools").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("mcpstore.setDirect", { name: "chrome-devtools", direct: true });
    expect(find(view.root, "data-mcp-store-direct-badge", "chrome-devtools").children.join("")).toBe("direct");
    expect(find(view.root, "data-mcp-store-direct-toggle", "chrome-devtools").children.join("")).toBe("make proxy-only");

    // a fresh section mount (simulating a reload) reflects the persisted flag, not a component-local toggle.
    let reloaded!: ReactTestRenderer;
    await act(async () => { reloaded = create(<McpStoreSection />); });
    expect(find(reloaded.root, "data-mcp-store-direct-badge", "chrome-devtools").children.join("")).toBe("direct");
  });
});
