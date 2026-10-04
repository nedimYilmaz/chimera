import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// MCP-STORE-IMPORT-UI: the importable list's "import" button. Clicking a local
// stdio row calls mcpstore.import({source,name}) and the server moves to
// installed on success; a claude.ai-managed remote connector (notImportableReason,
// no command) can never be imported, so its button stays disabled and the reason
// is shown inline; a failed import (e.g. a rescan mismatch) surfaces inline too —
// a click must never be a silent no-op.
let installed: Array<{ name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> }> = [];
vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") return Promise.resolve(installed);
      if (method === "mcpstore.importables") {
        return Promise.resolve({
          importables: [
            { source: "claude", name: "gateway", command: "npx", args: ["-y", "gateway-mcp"], env: {} },
            { source: "claude", name: "acme-remote", notImportableReason: "claude.ai-managed remote connector — auth lives server-side, cannot be imported" },
            { source: "codex", name: "boom", command: "npx", args: ["-y", "boom-mcp"], env: {} },
          ],
        });
      }
      if (method === "mcpstore.import") {
        const p = params as { source: string; name: string };
        if (p.name === "boom") return Promise.reject(new Error('no importable mcp server "boom" found from source "codex" (re-scan with mcpstore.importables)'));
        installed = [...installed, { name: p.name, type: "stdio", command: "npx", args: [], env: {} }];
        return Promise.resolve({ name: p.name, type: "stdio", command: "npx", args: [], env: {} });
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

describe("Settings MCP section — importable list's import button", () => {
  it("clicking a local stdio row's import button dispatches mcpstore.import with that row's {source,name}, and the row moves to installed", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    const btn = find(view.root, "data-mcp-store-import", "gateway");
    expect(btn.props.disabled).toBe(false);

    await act(async () => { btn.props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("mcpstore.import", { source: "claude", name: "gateway" });
    // reconciled: gateway now shows in the installed table, and its importable row disables (already installed).
    expect(find(view.root, "data-mcp-store-row", "gateway")).toBeTruthy();
    expect(find(view.root, "data-mcp-store-import", "gateway").props.disabled).toBe(true);
  });

  it("a notImportable row (claude.ai-managed remote connector) has its import button disabled and shows the reason inline", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    const btn = find(view.root, "data-mcp-store-import", "acme-remote");
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.title).toMatch(/claude.ai-managed remote connector/);
    expect(find(view.root, "data-mcp-store-not-importable", "acme-remote").children.join("")).toMatch(/claude.ai-managed remote connector/);
  });

  it("a failed import (rescan mismatch) surfaces inline on the row, not silently", async () => {
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(findAll(view.root, "data-mcp-store-import-error")).toHaveLength(0);

    await act(async () => { find(view.root, "data-mcp-store-import", "boom").props.onClick(); });

    expect(find(view.root, "data-mcp-store-import-error", "boom").children.join("")).toMatch(/re-scan with mcpstore.importables/);
  });
});
