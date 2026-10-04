import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// MCP-STORE-TOOLS-UI: the Settings MCP section renders per-server CONNECTION
// STATUS + TOOLS (name/description), not just command/args — fetched lazily on
// row expand (mcpstore.tools) rather than eagerly for every installed server on
// section load. McpStoreSection is rendered standalone (not the full
// SettingsScreen) because SettingsScreen's own effects touch `window`, which
// the node vitest env (no jsdom) doesn't provide — same reasoning as
// ProviderCatalogCard's extraction (see its test for precedent).
vi.mock("../src/rpc/bridge", () => {
  const responses: Record<string, unknown> = {
    "mcpstore.list": [
      { name: "chrome-devtools", type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp"], env: {} },
      { name: "telegram", type: "stdio", command: "npx", args: ["-y", "telegram-mcp"], env: {} },
    ],
    "mcpstore.importables": { importables: [] },
  };
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.tools") {
        const query = params?.["query"] as string | undefined;
        if (query === "chrome-devtools") {
          return Promise.resolve({
            servers: [{
              server: "chrome-devtools",
              connected: true,
              tools: [{ server: "chrome-devtools", name: "navigate_page", description: "Navigate the current page to a URL", inputSchema: {} }],
            }],
          });
        }
        if (query === "telegram") {
          return Promise.resolve({ servers: [{ server: "telegram", connected: false, error: "Connection closed", tools: [] }] });
        }
      }
      return Promise.resolve(responses[method] ?? undefined);
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
function text(node: ReactTestInstance): string {
  return node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
}

describe("Settings MCP section — per-server tool list (MCP-STORE-TOOLS-UI)", () => {
  it("does not fetch any server's tools until its row is expanded, then renders tools + status distinctly for a connected vs. an erroring server", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(findAll(view.root, "data-mcp-store-row")).toHaveLength(2);
    expect((rpcCall as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => c[0] === "mcpstore.tools")).toBe(false);

    // expand the connected server
    await act(async () => { find(view.root, "data-mcp-store-expand", "chrome-devtools").props.onClick(); });
    expect(find(view.root, "data-mcp-store-status", "chrome-devtools").children.join("")).toBe("● connected · 1 tools");
    const tool = find(view.root, "data-mcp-store-tool", "navigate_page");
    expect(text(tool)).toContain("Navigate the current page to a URL");
    expect((rpcCall as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[0] === "mcpstore.tools")).toHaveLength(1);

    // expand the erroring server — distinct status, zero tools, no crash
    await act(async () => { find(view.root, "data-mcp-store-expand", "telegram").props.onClick(); });
    expect(find(view.root, "data-mcp-store-status", "telegram").children.join("")).toBe("✗ Connection closed");
    expect(findAll(view.root, "data-mcp-store-tool")).toHaveLength(1); // still only chrome-devtools' tool — telegram has none

    // collapsing hides the panel
    await act(async () => { find(view.root, "data-mcp-store-expand", "chrome-devtools").props.onClick(); });
    expect(findAll(view.root, "data-mcp-store-tools").map((n) => n.props["data-mcp-store-tools"])).toEqual(["telegram"]);
  });
});
