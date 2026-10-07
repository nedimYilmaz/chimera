import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "../src/mcp-server-factory.js";
import { MCP_TOOL_TABLE, type ChimeraMcpCtx } from "../src/mcp-tools.js";
import { CHIMERA_READ_TOOLS, CHIMERA_COMMUNICATION_TOOLS } from "../src/chimera-capabilities.js";

async function fixture(allowlist?: string[], context: Partial<ChimeraMcpCtx> = {}, childOverrides: Record<string, unknown> = {}) {
  const peers: Record<string, unknown> = {
    child: { agentId: "child", parentId: "parent", depth: 1, treeId: "parent", principal: "local", projectId: "p", membership: { team: "t" }, ...childOverrides },
    parent: { agentId: "parent", treeId: "parent", principal: "local", projectId: "p", membership: { team: "t" } },
    teammate: { agentId: "teammate", treeId: "other-tree", principal: "local", projectId: "p", membership: { team: "t" } },
    stranger: { agentId: "stranger", treeId: "other-tree", principal: "local", projectId: "p" },
    foreignPrincipal: { agentId: "foreignPrincipal", treeId: "parent", principal: "other", projectId: "p" },
    otherProject: { agentId: "otherProject", treeId: "other-tree", principal: "local", projectId: "q", membership: { team: "t" } },
  };
  const dispatch = vi.fn(async (method: string, params: unknown) => method === "agent.status" ? peers[(params as { agentId: string }).agentId] : method === "team.mine" ? { team: null } : { ok: true });
  const server = await createChimeraMcpServer(dispatch, { depth: 2, agentId: "child", treeId: "parent", team: "t", access: "coordination", toolAllowlist: allowlist, ...context });
  const client = new Client({ name: "offline-child", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { dispatch, client, peers, close: async () => { await client.close(); await server.close(); } };
}

describe("bounded child Chimera grant", () => {
  it("annotates only actual reads and hides admin/delegation/foreign store tools", async () => {
    for (const name of [...CHIMERA_READ_TOOLS, ...CHIMERA_COMMUNICATION_TOOLS]) expect(MCP_TOOL_TABLE.some(t => t.name === name), name).toBe(true);
    const f = await fixture();
    try {
      const { tools } = await f.client.listTools();
      expect(tools.find(t => t.name === "chimera_tools")?.annotations?.readOnlyHint).toBe(true);
      for (const name of ["agent_send", "chimera_call"]) expect(tools.find(t => t.name === name)?.annotations?.readOnlyHint).not.toBe(true);
      for (const name of ["agent_spawn", "memory_add", "terminal_write", "mcp_store_call", "mcp_store_tools", "secret_get"]) expect(tools.some(t => t.name === name), name).toBe(false);
      expect(f.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true); // No foreign discovery/connection.
      const result = await f.client.callTool({ name: "chimera_tools", arguments: { tag: "agent", limit: 50 } });
      const rows = JSON.parse((result.content as { text: string }[])[0]!.text).tools;
      expect(rows.some((t: { name: string }) => t.name === "agent_send_many")).toBe(true);
      expect(rows.some((t: { name: string }) => t.name === "agent_kill")).toBe(false);
      const help = await f.client.callTool({ name: "engine_help", arguments: {} });
      expect(JSON.stringify(help)).not.toContain("child gets no chimera MCP");
    } finally { await f.close(); }
  });

  it.each(["parent", "teammate"])("sends to %s with caller identity preserved", async agentId => {
    const f = await fixture();
    try {
      expect((await f.client.callTool({ name: "agent_send", arguments: { agentId, text: "ready" } })).isError).not.toBe(true);
      expect(f.dispatch).toHaveBeenLastCalledWith("agent.send", { agentId, text: "ready", from: "child" });
    } finally { await f.close(); }
  });

  it.each(["stranger", "foreignPrincipal", "otherProject", "remote/parent"])("refuses %s before mailbox dispatch", async agentId => {
    const f = await fixture();
    try {
      expect((await f.client.callTool({ name: "agent_send", arguments: { agentId, text: "ready" } })).isError).toBe(true);
      expect(f.dispatch.mock.calls.some(([m]) => m === "agent.send")).toBe(false);
    } finally { await f.close(); }
  });

  it("checks every wrapped batch recipient and rejects controls/mutations/unknown tools", async () => {
    const f = await fixture();
    try {
      expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "parent", text: "ready", force: true } })).isError).toBe(true);
      for (const tool of ["agent_send", "agent_send_many"]) expect((await f.client.callTool({ name: "chimera_call", arguments: { tool, args: { agentId: "parent", agentIds: ["parent"], text: "ready", force: true } } })).isError).toBe(true);
      expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "agent_send_many", args: { agentIds: ["parent", "stranger"], text: "ready" } } })).isError).toBe(true);
      expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "parent", text: "/compact", slash: true } })).isError).toBe(true);
      for (const tool of ["agent_kill", "secret_get", "host_set_policy", "mcp_store_call", "made_up"]) {
        expect((await f.client.callTool({ name: "chimera_call", arguments: { tool, args: {} } })).isError, tool).toBe(true);
      }
      expect(f.dispatch.mock.calls.some(([m]) => m !== "agent.status")).toBe(false);
      expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "agent_send_many", args: { agentIds: ["parent", "teammate"], text: "ready" } } })).isError).not.toBe(true);
      expect(f.dispatch).toHaveBeenLastCalledWith("agent.sendMany", { agentIds: ["parent", "teammate"], text: "ready", from: "child" });
    } finally { await f.close(); }
  });

  it("preserves an explicit empty or limited MCP grant", async () => {
    for (const grant of [[], ["chimera_tools"]]) {
      const f = await fixture(grant);
      try {
        if (grant.length === 0) {
          await expect(f.client.listTools()).rejects.toThrow("Method not found");
          await expect(f.client.callTool({ name: "agent_send", arguments: { agentId: "parent", text: "ready" } })).rejects.toThrow("Method not found");
        } else {
          expect((await f.client.listTools()).tools.map(t => t.name)).toEqual(grant);
          expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "parent", text: "ready" } })).isError).toBe(true);
        }
        expect(f.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true);
      } finally { await f.close(); }
    }
  });
});

it.each([{ agentId: undefined }, { agentId: "missing" }, { treeId: "forged" }, { depth: 9 }, { team: "foreign" }])("rejects absent/forged child context: %j", async context => {
  const f = await fixture(undefined, context);
  try { await expect(f.client.listTools()).rejects.toThrow("Method not found"); }
  finally { await f.close(); }
});

it("scopes direct/wrapped reads and refuses memory/history widening", async () => {
  const f = await fixture();
  try {
    for (const agentId of ["stranger", "foreignPrincipal", "otherProject", "remote/parent"]) {
      for (const name of ["agent_status", "agent_result", "agent_wait"]) expect((await f.client.callTool({ name, arguments: { agentId } })).isError, name).toBe(true);
      expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "agent_tail", args: { agentId } } })).isError).toBe(true);
    }
    for (const args of [{ scope: "*" }, { scope: "foreign" }, { scopeMode: "all" }]) expect((await f.client.callTool({ name: "memory_search", arguments: args })).isError).toBe(true);
    for (const args of [{ allTrees: true }, { agentIds: ["stranger"] }]) expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "chronicle_search", args: { query: "past", ...args } } })).isError).toBe(true);
    expect(f.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true);
    expect((await f.client.callTool({ name: "memory_search", arguments: {} })).isError).not.toBe(true);
    expect(f.dispatch).toHaveBeenLastCalledWith("memory.search", { agentId: "child", excerpt: true });
    expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "chronicle_search", args: { query: "past" } } })).isError).not.toBe(true);
    expect(f.dispatch).toHaveBeenLastCalledWith("chronicle.search", { query: "past", scope: { treeIds: ["parent"] } });
  } finally { await f.close(); }
});

it("deny overrides both direct registration and wrapped allowed target", async () => {
  const f = await fixture(["chimera_tools", "chimera_call", "agent_tail"], { toolDenylist: ["agent_tail"] });
  try {
    expect((await f.client.callTool({ name: "chimera_call", arguments: { tool: "agent_tail", args: { agentId: "parent" } } })).isError).toBe(true);
    const result = await f.client.callTool({ name: "chimera_tools", arguments: { tag: "agent" } });
    expect(JSON.stringify(result)).not.toContain('"name":"agent_tail"');
    expect(f.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true);
  } finally { await f.close(); }
});

it("full orchestration preserves wrapped grants and catalog accurately marks promoted tools", async () => {
  const dispatch = vi.fn(async () => ({ ok: true }));
  const ctx = { depth: 0, autonomy: "full" as const, conductor: true, toolAllowlist: ["chimera_tools", "chimera_call"] };
  const server = await createChimeraMcpServer(dispatch, ctx);
  const client = new Client({ name: "full-grant", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    expect((await client.callTool({ name: "chimera_call", arguments: { tool: "project_list", args: {} } })).isError).not.toBe(true);
    const res = await client.callTool({ name: "chimera_tools", arguments: { tag: "project", limit: 50 } });
    const rows = JSON.parse((res.content as { text: string }[])[0]!.text).tools;
    expect(rows.find((t: { name: string }) => t.name === "project_list")).toMatchObject({ direct: false });
    const ask = await client.callTool({ name: "chimera_tools", arguments: { tag: "ask", limit: 50 } });
    const asks = JSON.parse((ask.content as { text: string }[])[0]!.text).tools;
    expect(asks.some((t: { name: string }) => ["ask_human", "ask_agent", "ask_team"].includes(t.name))).toBe(false);
  } finally { await client.close(); await server.close(); }
});

it("a default child can message its established parent's team without inheriting role or team-wide reads", async () => {
  const f = await fixture(undefined, { team: undefined }, { membership: undefined });
  try {
    expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "teammate", text: "ready" } })).isError).not.toBe(true);
    expect(f.dispatch).toHaveBeenLastCalledWith("agent.send", { agentId: "teammate", text: "ready", from: "child" });
    expect((f.peers.child as { membership?: unknown }).membership).toBeUndefined();
    expect((await f.client.callTool({ name: "agent_status", arguments: { agentId: "teammate" } })).isError).toBe(true);
    for (const agentId of ["otherProject", "foreignPrincipal", "stranger"]) expect((await f.client.callTool({ name: "agent_send", arguments: { agentId, text: "ready" } })).isError).toBe(true);
  } finally { await f.close(); }
});

it.each([{ agentId: "forged" }, { treeId: "foreign" }, { principal: "foreign" }, { projectId: "foreign" }, { membership: undefined }])("does not inherit messaging scope from a mismatched parent: %j", async patch => {
  const f = await fixture(undefined, { team: undefined }, { membership: undefined });
  try {
    Object.assign(f.peers.parent as object, patch);
    f.dispatch.mockClear();
    expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "teammate", text: "ready" } })).isError).toBe(true);
    expect(f.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true);
  } finally { await f.close(); }
});

it("rechecks parent membership on every call, without overriding the child's actual membership", async () => {
  const f = await fixture(undefined, { team: undefined }, { membership: undefined });
  try {
    expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "teammate", text: "ready" } })).isError).not.toBe(true);
    Object.assign(f.peers.parent as object, { membership: { team: "changed" } });
    expect((await f.client.callTool({ name: "agent_send", arguments: { agentId: "teammate", text: "ready" } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "my_team", arguments: {} })).isError).not.toBe(true);
    expect(f.dispatch).toHaveBeenLastCalledWith("team.mine", { agentId: "child" });
  } finally { await f.close(); }
  const member = await fixture(undefined, { team: "own" }, { membership: { team: "own" } });
  try {
    expect((await member.client.callTool({ name: "agent_send", arguments: { agentId: "teammate", text: "ready" } })).isError).toBe(true);
    expect(member.dispatch.mock.calls.every(([m]) => m === "agent.status")).toBe(true);
  } finally { await member.close(); }
});
