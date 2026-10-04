// MCP-HOST-GENERIC: gives GenericAgentBackend (providers with no agentic SDK of their own,
// e.g. kimi/nvidia/openai-compat) the same MCP access claude.ts/codex.ts get for free from
// their runtimes — chimera's own coordination tools (queue_push, memory_add, ask_human, ...)
// plus any spec.mcpServers the caller configured. Since this backend has no host runtime to
// lean on, IT is the MCP client: connect each server as a stdio child, list its tools, and
// route model tool-calls to the right server.
//
// INPROC-CHIMERA-BRIDGE: chimera's OWN server is the one exception — GenericAgentBackend runs
// INSIDE the daemon process, so shelling out to bin/chimera-mcp.js just to loop a socket call
// back into the SAME daemon is a wasted child process + round-trip. That one entry connects via
// an in-process McpServer (chimera-mcp-server.ts, built from the SAME tool table
// packages/mcp/src/server.ts uses) over InMemoryTransport instead of a stdio subprocess.
// Every OTHER (external) spec.mcpServers entry is a genuinely separate process and keeps the
// stdio path below untouched.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import type { ChimeraEngineAccessor, ResolvedAgentSpec } from "../backend.js";
import { toolResultText, wrapUntrustedToolResult } from "./tool-result.js";
import type { GenericToolResult } from "./generic-tools.js";

export type ChatToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type McpServerSpec = { command: string; args?: string[]; env: Record<string, string> };

// The chimera server's in-process target: no subprocess, no env — just the engine accessor and
// the identity/scoping ctx chimera-mcp-server.ts's tool table needs (mirrors the CHIMERA_* env
// stamping buildMcpServerSpecs used to inject into the (now retired) subprocess spec).
export type InProcessChimeraTarget = {
  inProcess: true;
  engine: ChimeraEngineAccessor;
  ctx: { agentId?: string; depth: number; maxDepthCap?: number; treeId?: string; team?: string; autonomy?: "ask" | "full" };
};

// v1 scope (matches codex.ts's mcp_servers restriction, see buildCodexOptions): stdio only.
// A url/sse/http entry in spec.mcpServers has no `command` and is silently skipped.
const MCP_LIST_TIMEOUT_MS = 10_000;
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 120_000;   // matches generic-tools.ts's BASH_TIMEOUT_MS

function fullEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, extra);
  return env;
}

// Builds the SAME server set claude.ts's spawn() would get: chimera's own MCP (only when
// spec.orchestration.allow, in-process — identity-scoped ctx so ask_human attribution / memory
// author / queue pushedBy resolve correctly) + spec.mcpServers's stdio entries.
export function buildMcpServerSpecs(
  spec: ResolvedAgentSpec,
  engine: ChimeraEngineAccessor,
): Record<string, McpServerSpec | InProcessChimeraTarget> {
  const specs: Record<string, McpServerSpec | InProcessChimeraTarget> = {};
  if (spec.orchestration.allow) {
    specs["chimera"] = {
      inProcess: true,
      engine,
      ctx: {
        agentId: spec.agentId,
        // the depth of the CHILD this grant lets the agent spawn, not this agent's own depth —
        // mirrors the (now retired) subprocess's CHIMERA_DEPTH env, which server.ts read back
        // as `Number(process.env.CHIMERA_DEPTH ?? -1) + 1`.
        depth: spec.depth + 1,
        maxDepthCap: spec.orchestration.maxDepth,
        treeId: spec.env["CHIMERA_TREE_ID"] || undefined,
        team: spec.env["CHIMERA_TEAM"] || undefined,
        // AGENT-AUTONOMY: mirrors claude.ts's identical grant — see its comment for why.
        autonomy: spec.autonomy === "full" ? "full" : undefined,
      },
    };
  }
  for (const [name, s] of Object.entries(spec.mcpServers)) {
    const srv = s as { command?: string; args?: string[]; env?: Record<string, string> };
    if (!srv.command) continue;
    specs[name] = { command: srv.command, args: srv.args, env: fullEnv(srv.env) };
  }
  return specs;
}

export const MCP_TOOL_PREFIX = "mcp__";

function parseToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// Hosts one MCP Client per configured server for the lifetime of one agent spawn. Every
// method degrades gracefully — a broken/slow server never wedges the agent turn or takes
// down the other connected servers: connect/list failures drop just that server (logged via
// the returned skipped list), and call() timeouts/errors become a normal tool-error result
// fed back to the model instead of throwing out of the tool loop.
export class McpHost {
  private clients = new Map<string, Client>();
  private toolDefs: ChatToolDef[] = [];

  async connect(specs: Record<string, McpServerSpec | InProcessChimeraTarget>): Promise<{ connected: string[]; skipped: Array<{ name: string; error: string }> }> {
    const connected: string[] = [];
    const skipped: Array<{ name: string; error: string }> = [];
    for (const [name, s] of Object.entries(specs)) {
      const client = new Client({ name: "chimera-generic-agent", version: "1.0.0" });
      try {
        if ("inProcess" in s) {
          // No subprocess, no daemon socket: the chimera tool table runs as a real McpServer
          // inside THIS process, wired straight to engine.handle() — InMemoryTransport is a
          // plain in-memory queue pair, not a wire protocol, so this is just a function call
          // dressed in the MCP envelope both sides already speak.
          const server = await createChimeraMcpServer((method, params) => s.engine.get().handle(method, params), s.ctx);
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          await client.connect(clientTransport, { timeout: MCP_CONNECT_TIMEOUT_MS });
        } else {
          const transport = new StdioClientTransport({ command: s.command, args: s.args, env: s.env });
          await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
        }
        const { tools } = await client.listTools(undefined, { timeout: MCP_LIST_TIMEOUT_MS });
        this.clients.set(name, client);
        for (const t of tools) {
          this.toolDefs.push({
            name: `${MCP_TOOL_PREFIX}${name}__${t.name}`,
            description: t.description ?? "",
            parameters: t.inputSchema as Record<string, unknown>,
          });
        }
        connected.push(name);
      } catch (err) {
        skipped.push({ name, error: (err as Error).message });
        await client.close().catch(() => {});
      }
    }
    return { connected, skipped };
  }

  get tools(): ChatToolDef[] {
    return this.toolDefs;
  }

  isMcpTool(name: string): boolean {
    return name.startsWith(MCP_TOOL_PREFIX);
  }

  async call(name: string, args: Record<string, unknown>): Promise<GenericToolResult> {
    const parsed = parseToolName(name);
    const client = parsed ? this.clients.get(parsed.server) : undefined;
    if (!parsed || !client) return { text: `unknown mcp tool "${name}"`, isError: true };
    try {
      const result = await client.callTool({ name: parsed.tool, arguments: args }, undefined, { timeout: MCP_CALL_TIMEOUT_MS });
      const text = toolResultText(result["content"]);
      // PROMPT-INJECTION-FRAMING (see tool-result.ts): GenericAgentBackend owns this MCP client
      // itself (McpHost), so this text becomes the model-facing tool result directly — the same
      // attacker-controllable-foreign-content case mcpstore.ts wraps.
      return { text: wrapUntrustedToolResult(text !== "" ? text : "(no output)"), ...(result["isError"] === true ? { isError: true } : {}) };
    } catch (err) {
      return { text: `mcp tool "${name}" failed: ${(err as Error).message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
    this.toolDefs = [];
  }
}
