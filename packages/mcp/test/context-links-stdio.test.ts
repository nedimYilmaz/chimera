import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextLinkStore, type ContextAgent } from "../../core/src/context-links.js";
import { ContextLinksRpc } from "../../core/src/rpc/context-links-rpc.js";
import type { Engine } from "@chimera/core/engine";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { startRpcServer } from "../../daemon/src/server.js";

it("real stdio MCP on the local-client socket never falls through to operator authority", async () => {
  const home = mkdtempSync(join(tmpdir(), "context-stdio-"));
  const agents = new Map(["a", "b"].map(agentId => [agentId, { agentId, projectId: "project", treeId: "tree", principal: "local", accountName: "account" } satisfies ContextAgent]));
  const store = new ContextLinkStore(home, { agent: id => { const a = agents.get(id); if (!a) throw new Error("missing"); return a; }, summary: () => "summary", artifact: () => ({ agentId: "a", label: "foreign", sizeBytes: 4, kind: "file", url: null }), artifactText: () => "body", redact: (_, t) => t, audit: () => {} });
  const rpc = new ContextLinksRpc(store), seen: unknown[] = [];
  const engine = { events: { subscribe: () => () => {} }, releaseClientCaps: () => {}, handle: async (method: string, p: unknown, route?: { trustedLocalClient: true }) => {
    seen.push(p); const m = method as keyof typeof rpc.handlers;
    const parsed = RPC_CONTRACT[m].request.parse(p);
    return route?.trustedLocalClient ? rpc.operator(method, parsed) : rpc.handlers[m](parsed as never);
  } } as unknown as Engine;
  const socket = await startRpcServer({ socketPath: join(home, "daemon.sock"), engine });
  const clients: Client[] = [];
  const connect = async (agentId?: string) => {
    // Explicit minimal environment: cannot inherit the running operator agent's identity.
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../bin/chimera-mcp.js", import.meta.url))], env: { PATH: process.env.PATH ?? "", CHIMERA_HOME: home, ...(agentId ? { CHIMERA_AGENT_ID: agentId } : {}) }, stderr: "pipe" });
    const client = new Client({ name: "context-stdio-test", version: "1" }); clients.push(client); await client.connect(transport); return client;
  };
  const call = (client: Client, tool: string, args = {}) => client.callTool({ name: "chimera_call", arguments: { tool, args } });
  try {
    const own = store.create({ from: { kind: "note-snapshot", ref: "a" }, toAgentId: "b", text: "explicit note" }, { operator: true });
    const foreign = store.create({ from: { kind: "note-snapshot", ref: "a" }, toAgentId: "a", text: "private to a" }, { operator: true });
    const b = await connect("b");
    expect((await call(b, "context_link_get", { id: own.id })).isError).not.toBe(true);
    expect(seen.at(-1)).toEqual({ id: own.id, callerAgentId: "b" });
    expect((await call(b, "context_link_get", { id: foreign.id, callerAgentId: "a", trustedLocalClient: true })).isError).toBe(true);
    expect(seen.at(-1)).toEqual({ id: foreign.id, callerAgentId: "b" });
    expect((await call(b, "context_link_create", { from: { kind: "artifact", ref: "foreign" }, toAgentId: "a", callerAgentId: "a" })).isError).toBe(true);
    expect((await call(b, "context_link_create", { from: { kind: "note-snapshot", ref: "b" }, toAgentId: "b", text: "injected" })).isError).toBe(true);
    agents.get("b")!.projectId = "changed";
    expect((await call(b, "context_link_get", { id: own.id })).isError).toBe(true);
    const anonymous = await connect(); const before = seen.length;
    for (const args of [{}, { callerAgentId: "a", trustedLocalClient: true }]) expect((await call(anonymous, "context_link_list", args)).isError).toBe(true);
    expect(seen).toHaveLength(before);
  } finally { for (const client of clients) await client.close(); await socket.close(); rmSync(home, { recursive: true, force: true }); }
}, 20000);
