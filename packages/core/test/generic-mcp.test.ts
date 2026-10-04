import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import { McpHost, buildMcpServerSpecs } from "@chimera/core/backends/generic-mcp";

// Fakes the MCP SDK's transport-level pieces (stdio child process + wire protocol) so McpHost
// can be exercised without ever spawning a real subprocess. Each MockClient pulls its behavior
// off `queue` in construction order — tests call enqueueClientConfig() once per server, in the
// same order McpHost.connect() will iterate Object.entries(specs).
const queue: Array<{
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  connectError?: string;
  listError?: string;
  callError?: string;
  callToolResult?: unknown | ((params: unknown) => unknown);
}> = [];
const mockClients: Array<{ cfg: (typeof queue)[number]; closeCalls: number; calls: unknown[] }> = [];

function enqueueClientConfig(cfg: (typeof queue)[number]): void {
  queue.push(cfg);
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    cfg: (typeof queue)[number];
    closeCalls = 0;
    calls: unknown[] = [];
    constructor() {
      this.cfg = queue.shift() ?? {};
      mockClients.push(this as unknown as (typeof mockClients)[number]);
    }
    async connect() {
      if (this.cfg.connectError) throw new Error(this.cfg.connectError);
    }
    async listTools() {
      if (this.cfg.listError) throw new Error(this.cfg.listError);
      return { tools: this.cfg.tools ?? [] };
    }
    async callTool(params: unknown) {
      this.calls.push(params);
      if (this.cfg.callError) throw new Error(this.cfg.callError);
      if (typeof this.cfg.callToolResult === "function") return (this.cfg.callToolResult as (p: unknown) => unknown)(params);
      return this.cfg.callToolResult ?? { content: [{ type: "text", text: "ok" }] };
    }
    async close() {
      this.closeCalls++;
    }
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  class MockStdioClientTransport {
    constructor(public params: unknown) {}
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

function specStub(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none", ...over }),
    agentId: "gen-mcp-1", accountName: "gen-main", resolvedProvider: "test-provider",
    env: {}, depth: 0,
  } as ResolvedAgentSpec;
}

const fakeEngine = { get: () => ({ handle: async () => ({}) }) };

beforeEach(() => {
  queue.length = 0;
  mockClients.length = 0;
});

describe("buildMcpServerSpecs", () => {
  it("omits the chimera server when orchestration.allow is false (the default)", () => {
    expect(buildMcpServerSpecs(specStub(), fakeEngine)).toEqual({});
  });

  it("builds an in-process chimera target with identity ctx when orchestration.allow is true", () => {
    const spec = specStub({ orchestration: { allow: true, maxDepth: 3 } });
    const specs = buildMcpServerSpecs(spec, fakeEngine);
    expect(Object.keys(specs)).toEqual(["chimera"]);
    const chimera = specs["chimera"] as { inProcess: true; ctx: Record<string, unknown> };
    expect(chimera.inProcess).toBe(true);
    expect(chimera.ctx).toEqual({
      agentId: "gen-mcp-1", depth: 1, maxDepthCap: 3, treeId: undefined, team: undefined,
    });
  });

  it("includes a spec.mcpServers stdio entry and skips a url/sse entry (v1 scope, mirrors codex.ts)", () => {
    const spec = specStub({ mcpServers: { good: { command: "some-cmd", args: ["--x"] }, bad: { url: "https://example.com" } } });
    const specs = buildMcpServerSpecs(spec, fakeEngine);
    expect(Object.keys(specs)).toEqual(["good"]);
    expect((specs["good"] as { command: string }).command).toBe("some-cmd");
  });
});

describe("McpHost", () => {
  it("connects, namespaces tools as mcp__<server>__<tool>, and forwards the JSON-Schema verbatim", async () => {
    enqueueClientConfig({ tools: [{ name: "memory_add", description: "add a memory", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    const host = new McpHost();
    const result = await host.connect({ chimera: { command: "node", args: [], env: {} } });
    expect(result).toEqual({ connected: ["chimera"], skipped: [] });
    expect(host.tools).toEqual([
      { name: "mcp__chimera__memory_add", description: "add a memory", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    ]);
  });

  it("call() routes to the right server/tool and returns the flattened text result", async () => {
    enqueueClientConfig({ tools: [{ name: "memory_add", inputSchema: { type: "object" } }], callToolResult: { content: [{ type: "text", text: "stored" }] } });
    const host = new McpHost();
    await host.connect({ chimera: { command: "node", args: [], env: {} } });
    const res = await host.call("mcp__chimera__memory_add", { text: "hi" });
    expect(res).toEqual({ text: "stored" });
    expect(mockClients[0]!.calls).toEqual([{ name: "memory_add", arguments: { text: "hi" } }]);
  });

  it("call() to an unknown/unconnected tool returns a clean tool-error instead of throwing", async () => {
    const host = new McpHost();
    const res = await host.call("mcp__nope__x", {});
    expect(res).toEqual({ text: 'unknown mcp tool "mcp__nope__x"', isError: true });
  });

  it("a rejecting callTool (timeout or otherwise) becomes a clean tool-error result, not a throw", async () => {
    enqueueClientConfig({ tools: [{ name: "slow", inputSchema: { type: "object" } }], callError: "MCP error -32001: Request timed out" });
    const host = new McpHost();
    await host.connect({ chimera: { command: "node", args: [], env: {} } });
    const res = await host.call("mcp__chimera__slow", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Request timed out");
  });

  it("a server that fails to connect is skipped (and closed) without blocking the others", async () => {
    enqueueClientConfig({ connectError: "spawn ENOENT" });
    enqueueClientConfig({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
    const host = new McpHost();
    const result = await host.connect({
      bad: { command: "does-not-exist", args: [], env: {} },
      good: { command: "node", args: [], env: {} },
    });
    expect(result.connected).toEqual(["good"]);
    expect(result.skipped).toEqual([{ name: "bad", error: "spawn ENOENT" }]);
    expect(host.tools).toEqual([{ name: "mcp__good__ping", description: "", parameters: { type: "object" } }]);
    expect(mockClients[0]!.closeCalls).toBe(1);   // the failed server's client is still cleaned up
  });

  it("close() closes every connected client and clears the tool list", async () => {
    enqueueClientConfig({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
    const host = new McpHost();
    await host.connect({ chimera: { command: "node", args: [], env: {} } });
    await host.close();
    expect(mockClients[0]!.closeCalls).toBe(1);
    expect(host.tools).toEqual([]);
  });
});
