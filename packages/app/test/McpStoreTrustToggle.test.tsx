import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// TRUST-TIER: a per-server "trust" on/off toggle in the Settings MCP section (default "full" —
// identical to today). Toggling calls mcpstore.setTrust and reflects the persisted tier: an
// "untrusted" badge appears and the toggle button's label flips. Mirrors
// McpStoreDirectToggle.test.tsx's pattern for setDirect.
let trust: "full" | "untrusted" = "full";
vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") {
        return Promise.resolve([
          { name: "chrome-devtools", type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp"], env: {}, direct: false, enabled: true, trust },
        ]);
      }
      if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
      if (method === "mcpstore.setTrust") {
        trust = (params as { trust: "full" | "untrusted" }).trust;
        return Promise.resolve({ name: (params as { name: string }).name, trust });
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

describe("Settings MCP section — per-server trust toggle (TRUST-TIER)", () => {
  it("defaults to full (no badge), toggling calls mcpstore.setTrust and persists across a reload", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(findAll(view.root, "data-mcp-store-trust-badge")).toHaveLength(0);
    expect(find(view.root, "data-mcp-store-trust-toggle", "chrome-devtools").children.join("")).toBe("mark untrusted");

    await act(async () => { find(view.root, "data-mcp-store-trust-toggle", "chrome-devtools").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("mcpstore.setTrust", { name: "chrome-devtools", trust: "untrusted" });
    expect(find(view.root, "data-mcp-store-trust-badge", "chrome-devtools").children.join("")).toBe("untrusted");
    expect(find(view.root, "data-mcp-store-trust-toggle", "chrome-devtools").children.join("")).toBe("mark trusted");

    // a fresh section mount (simulating a reload) reflects the persisted tier, not a component-local toggle.
    let reloaded!: ReactTestRenderer;
    await act(async () => { reloaded = create(<McpStoreSection />); });
    expect(find(reloaded.root, "data-mcp-store-trust-badge", "chrome-devtools").children.join("")).toBe("untrusted");
  });
});
