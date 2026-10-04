import { expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpStoreConnectionManager, McpStoreRegistry } from "../src/mcpstore.js";
import { InMemoryKeychain } from "../src/keychain.js";

it("reconnects a real stdio server after EOF and cleans up only its disconnected agent session", async () => {
  const home = mkdtempSync(join(tmpdir(), "chimera-mcp-disconnect-"));
  const registry = new McpStoreRegistry(home);
  registry.add({ name: "probe", type: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-disconnect.mjs", import.meta.url))], env: {}, sessionMode: "agent" });
  const manager = new McpStoreConnectionManager(registry, new InMemoryKeychain());
  try {
    const first = await manager.call("probe", "snapshot", {}, undefined, "a");
    const other = await manager.call("probe", "snapshot", {}, undefined, "b");
    expect(first.isError).toBeUndefined();
    expect(other.isError).toBeUndefined();
    expect(readdirSync(join(home, "mcp-sessions"))).toHaveLength(2);
    const disconnected = await manager.call("probe", "disconnect", {}, undefined, "a");
    expect(disconnected.isError).toBe(true);
    expect(readdirSync(join(home, "mcp-sessions"))).toHaveLength(1);
    const next = await manager.call("probe", "snapshot", {}, undefined, "a");
    expect(next.isError).toBeUndefined();
    expect(next.text).not.toBe(first.text);
    expect((await manager.call("probe", "snapshot", {}, undefined, "b")).text).toBe(other.text);
  } finally {
    await manager.closeAll();
    expect(readdirSync(join(home, "mcp-sessions"))).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
