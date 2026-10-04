import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { McpStoreSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

// MCPSTORE-LIFECYCLE-UI: disable/enable (a temporary off switch — credentials survive it)
// and uninstall (relabeled `remove`, still purges credentials daemon-side — see
// packages/core/test/mcpstore-auth.test.ts for the keychain-purge coverage). Exercises an
// IMPORTED entry specifically (the case the user called out — "these have to work even for
// the MCPs I imported"), not just a manually-added one.
let enabled = true;
let removedCalls: Array<Record<string, unknown> | undefined> = [];
vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "mcpstore.list") {
        return Promise.resolve([
          // an IMPORTED entry — same installed-row code path as a manual add, per the brief.
          { name: "imported-gw", type: "http", url: "https://imported.example.com/mcp", headers: {}, direct: false, enabled, auth: { kind: "bearer", keychainRef: "chimera:mcp:imported-gw" } },
        ]);
      }
      if (method === "mcpstore.importables") return Promise.resolve({ importables: [] });
      if (method === "mcpstore.setEnabled") {
        enabled = (params as { enabled: boolean }).enabled;
        return Promise.resolve({ name: (params as { name: string }).name, enabled });
      }
      if (method === "mcpstore.remove") {
        removedCalls.push(params);
        return Promise.resolve({ name: (params as { name: string }).name, removed: true });
      }
      return Promise.resolve(undefined);
    }),
    openArtifactUrl: vi.fn(() => Promise.resolve()),
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

describe("Settings MCP section — disable/enable + uninstall lifecycle (MCPSTORE-LIFECYCLE-UI)", () => {
  it("an imported http row shows an unconditional auth control alongside disable/uninstall actions", async () => {
    enabled = true;
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    expect(find(view.root, "data-mcp-store-authorize", "imported-gw").children.join("")).toBe("Authorize");
    expect(find(view.root, "data-mcp-store-enable-toggle", "imported-gw").children.join("")).toBe("disable");
    expect(find(view.root, "data-mcp-store-uninstall", "imported-gw").children.join("")).toBe("uninstall");
    expect(findAll(view.root, "data-mcp-store-disabled-badge", "imported-gw")).toHaveLength(0);
  });

  it("disabling calls mcpstore.setEnabled, flips the row to a disabled badge, and the toggle relabels to enable", async () => {
    enabled = true;
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    await act(async () => { await find(view.root, "data-mcp-store-enable-toggle", "imported-gw").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("mcpstore.setEnabled", { name: "imported-gw", enabled: false });
    expect(find(view.root, "data-mcp-store-disabled-badge", "imported-gw").children.join("")).toBe("disabled");
    expect(find(view.root, "data-mcp-store-enable-toggle", "imported-gw").children.join("")).toBe("enable");
  });

  it("a disabled row's expand panel does not attempt to connect — shows a static hint instead", async () => {
    enabled = false;
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    (rpcCall as unknown as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => { find(view.root, "data-mcp-store-expand", "imported-gw").props.onClick(); });

    expect(rpcCall).not.toHaveBeenCalledWith("mcpstore.tools", expect.anything());
    expect(find(view.root, "data-mcp-store-disabled-hint", "imported-gw").children.join(""))
      .toContain("disabled");
  });

  it("re-enabling restores the auth control's normal state and clears the disabled badge", async () => {
    enabled = false;
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });
    expect(find(view.root, "data-mcp-store-enable-toggle", "imported-gw").children.join("")).toBe("enable");

    await act(async () => { await find(view.root, "data-mcp-store-enable-toggle", "imported-gw").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("mcpstore.setEnabled", { name: "imported-gw", enabled: true });
    expect(findAll(view.root, "data-mcp-store-disabled-badge", "imported-gw")).toHaveLength(0);
    expect(find(view.root, "data-mcp-store-enable-toggle", "imported-gw").children.join("")).toBe("disable");
  });

  it("uninstall (relabeled remove) still calls mcpstore.remove after confirmation", async () => {
    enabled = true;
    removedCalls = [];
    const cmds = getSettingsCommands(appStore, rpcCall);
    await act(async () => { await cmds.loadMcpStore(); });

    let view!: ReactTestRenderer;
    await act(async () => { view = create(<McpStoreSection />); });

    await act(async () => { find(view.root, "data-mcp-store-uninstall", "imported-gw").props.onClick(); });

    // the confirm row (data-remove-confirm) renders its own "uninstall" button — find the
    // one INSIDE it, distinct from the row action button already found above.
    const confirmRow = find(view.root, "data-remove-confirm");
    const confirmBtn = confirmRow.findAll((n) => n.type === "button" && n.props.children === "uninstall")[0]!;
    await act(async () => { confirmBtn.props.onClick(); });

    expect(removedCalls).toEqual([{ name: "imported-gw" }]);
  });
});
