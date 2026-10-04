// MCP-STORE live acceptance: drives the REAL bin/chimera-mcp.js-equivalent server.ts over
// stdio (same "node --import tsx SERVER" pattern mcp-coordination.test.ts uses) through the
// mcp_store_add/mcp_store_tools/mcp_store_call meta-tools end to end, against a REAL
// daemon-hosted McpStoreConnectionManager connection to a REAL fixture MCP server
// (fixtures/mcp-echo-server.mjs) -- no MCP-layer mock anywhere in this test. Two SEPARATE
// stdio Client connections (simulating two independent agents) share the same CHIMERA_HOME,
// so server.ts's own ChimeraClient.connect() autostart contract (same one
// mcp-coordination.test.ts / mcp-host-generic-live.test.ts rely on) makes agent 2's
// server.ts subprocess talk to the SAME already-running chimerad agent 1 started --
// proving the store connection is genuinely shared across callers, not per-agent.
import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { ChimeraClient } from "@chimera/client";
import { makeEngineHome } from "../../core/test/helpers.js";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" } as Record<string, string>;

const parse = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

async function connectAgent(): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", SERVER], env }));
  return client;
}

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("MCP-STORE live: mcp_store_add/tools/call over a real stdio chimera-mcp + a real fixture server", () => {
  it("installs a fixture, discovers its tool, and round-trips a call through ONE shared daemon connection across two agents", async () => {
    const agent1 = await connectAgent();

    // TOKEN-OPT-P2: mcp_store_add/mcp_store_remove are "extended" tier (admin CRUD) --
    // not registered directly, routed via chimera_call. mcp_store_tools/mcp_store_call
    // stay core (the always-available discovery pair this store's own design mirrors).
    const added = parse(await agent1.callTool({
      name: "chimera_call",
      arguments: { tool: "mcp_store_add", args: { name: "echo-fixture", command: process.execPath, args: [FIXTURE] } },
    }));
    // REMOTE-MCP (stdio/http schema union) stamps every stored spec's `type` explicitly;
    // MCP-STORE-DIRECT-TOGGLE added `direct` (default false) -- this expectation predates both.
    expect(added).toEqual({ name: "echo-fixture", type: "stdio", command: process.execPath, args: [FIXTURE], env: {}, direct: false, enabled: false, trust: "untrusted" });
    expect(parse(await agent1.callTool({ name: "mcp_store_tools", arguments: {} })).servers).toEqual([]);
    // The operator reviews/enables the fixture through the same RPCs as Settings;
    // neither of these administrative methods is exposed to agent MCP callers.
    const operator = await ChimeraClient.connect({ home, env, autostart: false });
    try {
      await operator.request("mcpstore.setTrust", { name: "echo-fixture", trust: "full" });
      await operator.request("mcpstore.setEnabled", { name: "echo-fixture", enabled: true });
    } finally { operator.close(); }

    const discovered = parse(await agent1.callTool({ name: "mcp_store_tools", arguments: {} }));
    expect(discovered.servers).toHaveLength(1);
    expect(discovered.servers[0]).toMatchObject({ server: "echo-fixture", connected: true });
    expect(discovered.servers[0].tools).toEqual([
      { server: "echo-fixture", name: "echo", description: expect.stringContaining("Echoes"), inputSchema: expect.any(Object) },
    ]);

    const first = parse(await agent1.callTool({ name: "mcp_store_call", arguments: { server: "echo-fixture", tool: "echo", args: { text: "hi" } } }));
    expect(JSON.parse(first.text)).toEqual({ echoed: "hi", calls: 1 });

    await agent1.close();

    // A wholly separate chimera-mcp subprocess/client, simulating a second agent. If the
    // daemon spawned a FRESH fixture child process instead of reusing its cached
    // connection, the fixture's in-process counter would reset and this would see calls:1
    // again instead of continuing to 2.
    const agent2 = await connectAgent();
    const second = parse(await agent2.callTool({ name: "mcp_store_call", arguments: { server: "echo-fixture", tool: "echo", args: { text: "again" } } }));
    expect(JSON.parse(second.text)).toEqual({ echoed: "again", calls: 2 });

    const removed = parse(await agent2.callTool({ name: "chimera_call", arguments: { tool: "mcp_store_remove", args: { name: "echo-fixture" } } }));
    expect(removed).toEqual({ name: "echo-fixture", removed: true });

    await agent2.close();
  }, 30_000);
});
