import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
it("discovers canvas read, injects identity, refuses anonymous access and excludes private layout writes", async () => {
  for (const agentId of ["caller", undefined]) {
    const seen: unknown[] = [];
    const server = await createChimeraMcpServer(async (method, params) => { if (method === "canvas.get") seen.push(params); return { nodes: [] }; }, { depth: 0, agentId });
    const client = new Client({ name: "canvas", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    try {
      const found = await client.callTool({ name: "chimera_tools", arguments: { query: "canvas" } }); expect(JSON.stringify(found)).toContain("canvas_get");
      const result = await client.callTool({ name: "chimera_call", arguments: { tool: "canvas_get", args: { projectId: "p", callerAgentId: "forged" } } });
      if (agentId) expect(seen).toEqual([{ projectId: "p", callerAgentId: "caller" }]); else { expect(result.isError).toBe(true); expect(seen).toEqual([]); }
      expect((await client.callTool({ name: "chimera_call", arguments: { tool: "canvas_save_layout", args: {} } })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  }
});
