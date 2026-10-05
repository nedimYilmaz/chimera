import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { ContextLinkStore, type ContextAgent } from "../../core/src/context-links.js";
import { ContextLinksRpc } from "../../core/src/rpc/context-links-rpc.js";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const value = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
describe("context links through real MCP server", () => {
  it("discovers, pulls an operator note snapshot, preserves it after source edits and refuses immediately after revoke", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-context-"));
    const agent = (id: string): ContextAgent => ({ agentId: id, treeId: "tree", projectId: "project", principal: "local", accountName: "account" });
    const store = new ContextLinkStore(home, { agent, summary: () => "summary", artifact: () => { throw new Error("none"); }, artifactText: () => "", redact: (_, t) => t, audit: () => {} });
    const rpc = new ContextLinksRpc(store), seen: unknown[] = [];
    const server = await createChimeraMcpServer(async (method, params) => {
      seen.push(params); const m = method as keyof typeof rpc.handlers;
      const parsed = RPC_CONTRACT[m].request.parse(params); return rpc.handlers[m](parsed as never);
    }, { agentId: "b", depth: 0 });
    const client = new Client({ name: "context-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    const call = (tool: string, args = {}) => client.callTool({ name: "chimera_call", arguments: { tool, args } });
    try {
      const discovered = value(await client.callTool({ name: "chimera_tools", arguments: { query: "context_link" } }));
      expect(discovered.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["context_link_list", "context_link_get", "context_link_create", "context_link_revoke"]));
      const link = store.create({ from: { kind: "note-snapshot", ref: "a" }, toAgentId: "b", text: "exact note preview" }, { operator: true });
      expect(value(await call("context_link_list" )).links[0].snapshot.text).toBeUndefined();
      expect(value(await call("context_link_get", { id: link.id })).snapshot.text).toBe("exact note preview");
      expect(seen).toContainEqual({ id: link.id, callerAgentId: "b" });
      const denied = await call("context_link_create", { from: { kind: "note-snapshot", ref: "a" }, toAgentId: "b", text: "private" }); expect(denied.isError).toBe(true);
      const forged = await call("context_link_get", { id: link.id, callerAgentId: "a" }); expect(forged.isError).not.toBe(true); expect(seen.at(-1)).toEqual({ id: link.id, callerAgentId: "b" });
      store.revoke(link.id, { operator: true }); expect((await call("context_link_get", { id: link.id })).isError).toBe(true);
      expect(value(await call("context_link_list")).links[0].status).toBe("revoked");
    } finally { await client.close(); await server.close(); rmSync(home, { recursive: true, force: true }); }
  });
  it("identity-free MCP sessions cannot impersonate the operator", async () => {
    let dispatched = false;
    const server = await createChimeraMcpServer(async (method) => { if (method.startsWith("contextlink.")) dispatched = true; return {}; }, { depth: 0 });
    const client = new Client({ name: "anonymous", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    try { expect((await client.callTool({ name: "chimera_call", arguments: { tool: "context_link_list", args: {} } })).isError).toBe(true); expect(dispatched).toBe(false); }
    finally { await client.close(); await server.close(); }
  });
});
