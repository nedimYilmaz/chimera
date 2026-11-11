import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "../src/mcp-server-factory.js";

describe("Chimera MCP tool input budget", () => {
  it("bounds nested SDK validation before dispatch and preserves the boundary and long strings", async () => {
    const dispatch = vi.fn(async (method: string) => method === "mcpstore.list" ? [] : { ok: true });
    const server = await createChimeraMcpServer(dispatch, { depth: 0, agentId: "input-budget-test" });
    const client = new Client({ name: "input-budget-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    try {
      await client.connect(b);
      dispatch.mockClear();
      const call = (args: Record<string, unknown>) => client.callTool({
        name: "mcp_store_call", arguments: { server: "fixture", tool: "probe", args },
      });
      const boundary = { nested: Array.from({ length: 4998 }, () => ({ value: null })) };
      // Three envelope keys, one nested key, and two elements per item = exactly 10,000.
      expect((await call(boundary)).isError).not.toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenLastCalledWith("mcpstore.call", expect.objectContaining({ args: boundary }));
      dispatch.mockClear();
      const oversized = { nested: [...boundary.nested, { value: null }] };
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(1_048_576);
      const rejected = await call(oversized);
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toMatch(/maximum of 10000 elements/);
      expect(dispatch).not.toHaveBeenCalled();
      const document = "a".repeat(200_000);
      expect((await call({ document })).isError).not.toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
