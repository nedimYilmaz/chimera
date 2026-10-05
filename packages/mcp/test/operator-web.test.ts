import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { Engine } from "../../core/src/engine.js";
import { daemonEndpoint } from "../../core/src/paths.js";
import { startRpcServer } from "../../daemon/src/server.js";
import { ChimeraClient } from "../../client/src/client.js";
import { makeEngineHome } from "../../core/test/helpers.js";
import { rmSync } from "node:fs";

it.each([undefined, "forged-agent"])("denies anonymous/forged MCP management on the real local socket (%s)", async agentId => {
  const home = makeEngineHome(); const engine = new Engine({ home, backends: new Map() });
  const rpc = await startRpcServer({ socketPath: daemonEndpoint(home), engine });
  const socket = await ChimeraClient.connect({ home, autostart: false });
  const server = await createChimeraMcpServer((method, params) => socket.request(method, params), { agentId, depth: 0 });
  const client = new Client({ name: "operator-boundary-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    for (const method of ["status", "enable", "disable", "pairStart", "sessionList", "sessionRevoke", "settingsSet"]) {
      await expect(socket.request(`operatorweb.${method}`, { callerAgentId: agentId ?? "" })).rejects.toMatchObject({ code: "forbidden" });
      // operator_web_status is deliberately the redacted status tool, not full status.
      for (const tool of method === "status" ? [`operatorweb.${method}`] : [`operatorweb.${method}`, `operator_web_${method}`]) {
        const result = await client.callTool({ name: "chimera_call", arguments: { tool, args: { callerAgentId: "forged" } } });
        expect(result.isError).toBe(true);
      }
    }
    expect(engine.operatorWeb.status().enabled).toBe(false);
    const result = await client.callTool({ name: "chimera_call", arguments: { tool: "operator_web_status", args: {} } });
    expect(result.isError).not.toBe(true);
    const status = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(Object.keys(status).sort()).toEqual(["bundleAvailable", "enabled", "limitation"]);
    expect(await socket.call("operatorweb.status", {})).toMatchObject({ enabled: false });
  } finally {
    await client.close(); await server.close(); socket.close(); await rpc.close();
    await engine.operatorWeb.close(); engine.jobs.detach(); rmSync(home, { recursive: true, force: true });
  }
});
