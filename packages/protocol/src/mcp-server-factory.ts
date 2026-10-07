// INPROC-CHIMERA-BRIDGE: builds a real McpServer from MCP_TOOL_TABLE (mcp-tools.ts) against an
// injected `dispatch`. packages/mcp/src/server.ts uses this to build the stdio-exposed server
// it always has (dispatch = a ChimeraClient socket call, ctx from process.env);
// packages/core/src/backends/generic-mcp.ts's McpHost uses it to build an IN-PROCESS server for
// a generic agent's own MCP grant (dispatch = engine.handle() directly, ctx from the
// ResolvedAgentSpec) — no daemon socket, no chimera-mcp child process. One factory, two
// transports, zero drift between them. Lives beside MCP_TOOL_TABLE (not in @chimera/core)
// because core cannot import @chimera/mcp without a cycle, but mcp CAN cheaply depend on THIS
// package (protocol) without pulling in core's much heavier agentic-SDK surface.
import { z } from "zod";
import { McpStoreCallResultSchema } from "./index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_TABLE, directChimeraToolNames, type ChimeraMcpCtx } from "./mcp-tools.js";
import { CHIMERA_READ_TOOLS } from "./chimera-capabilities.js";

export type ChimeraMcpDispatch = (method: string, params: unknown) => Promise<unknown>;

type CoordinationCaller = { agentId: string; parentId: string | null; depth: number; principal: string; treeId: string; projectId?: string | null; membership?: { team: string }; communicationTeam?: string };

async function coordinationCaller(dispatch: ChimeraMcpDispatch, ctx: ChimeraMcpCtx): Promise<CoordinationCaller | null> {
  if (!ctx.agentId || !ctx.treeId || ctx.depth < 2) return null;
  try {
    const caller = await dispatch("agent.status", { agentId: ctx.agentId }) as CoordinationCaller;
    if (caller?.agentId !== ctx.agentId || !caller.parentId || caller.depth !== ctx.depth - 1 || caller.treeId !== ctx.treeId || !caller.principal) return null;
    if (ctx.team && caller.membership?.team !== ctx.team) return null;
    // Plain agent_spawn deliberately does not assign its parent's role to the
    // child. An established parent edge can grant ordinary team messaging
    // without changing the child's membership or granting team-wide read access.
    if (caller.membership?.team) return { ...caller, communicationTeam: caller.membership.team };
    const parent = await dispatch("agent.status", { agentId: caller.parentId }) as CoordinationCaller;
    if (parent?.agentId === caller.parentId && parent.principal === caller.principal && parent.treeId === caller.treeId
      && typeof caller.projectId === "string" && caller.projectId.length > 0 && parent.projectId === caller.projectId) return { ...caller, communicationTeam: parent.membership?.team };
    return caller;
  } catch { return null; }
}

async function coordinationOperationAllowed(dispatch: ChimeraMcpDispatch, caller: CoordinationCaller, method: string, params: unknown): Promise<boolean> {
  const p = params as { agentId?: string; agentIds?: string[]; slash?: boolean; force?: boolean; scope?: unknown; scopeMode?: string };
  if (method === "memory.search") return p.agentId === caller.agentId
    && (p.scope === undefined || p.scope === caller.projectId) && p.scopeMode !== "all"
    && (caller.projectId != null || p.scopeMode === "global");
  if (method === "chronicle.search") {
    const scope = p.scope as { treeIds?: string[]; agentIds?: string[] } | undefined;
    return scope?.treeIds?.length === 1 && scope.treeIds[0] === caller.treeId && !scope.agentIds;
  }
  if (!["agent.send", "agent.sendMany", "agent.status", "agent.result", "agent.wait", "agent.tail"].includes(method)) return true;
  // Provider slash commands are controls, not ordinary mailbox communication.
  if (p.slash || p.force) return false;
  const ids = method === "agent.sendMany" ? p.agentIds : [p.agentId];
  if (!ids?.length || ids.some(id => typeof id !== "string" || id.includes("/"))) return false;
  for (const id of ids) {
    const peer = await dispatch("agent.status", { agentId: id }) as CoordinationCaller;
    if (peer?.agentId !== id || peer.principal !== caller.principal) return false;
    const sameTree = peer.treeId === caller.treeId;
    const team = method === "agent.send" || method === "agent.sendMany" ? caller.communicationTeam : caller.membership?.team;
    const sameTeam = team && peer.membership?.team === team
      && caller.projectId != null && peer.projectId === caller.projectId;
    if (!sameTree && !sameTeam) return false;
  }
  return true;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const jsonErr = (e: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(e) }], isError: true });

// Only the store RPC can return native images. Arbitrary RPC objects must never be
// interpreted as MCP content (or silently get a different result/error contract).
function storeResult(value: unknown) {
  const parsed = McpStoreCallResultSchema.safeParse(value);
  if (!parsed.success) return json(value);
  const result = parsed.data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ text: result.text, ...(result.isError ? { isError: true } : {}) }) }, ...(result.images ?? [])],
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

// MCP-STORE-DIRECT-TOGGLE: best-effort JSON-Schema -> zod shape for a store tool's
// (arbitrary, third-party) inputSchema. Only the top-level `properties`/`required` are
// mapped to typed fields -- nested/unknown shapes fall back to z.unknown() -- and the
// WHOLE object is wrapped in .passthrough() so any property this shallow mapping didn't
// anticipate is still forwarded to mcpstore.call verbatim rather than stripped by zod
// parsing. Good enough to give the model real field names/types for the common flat-object
// case without pulling in a full json-schema-to-zod dependency.
function jsonSchemaToZodShape(schema: Record<string, unknown> | undefined): z.ZodTypeAny {
  const properties = (schema?.["properties"] as Record<string, unknown> | undefined) ?? {};
  const required = new Set((schema?.["required"] as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const prop = (raw ?? {}) as { type?: string; description?: string };
    let zt: z.ZodTypeAny;
    switch (prop.type) {
      case "string": zt = z.string(); break;
      case "number": zt = z.number(); break;
      case "integer": zt = z.number().int(); break;
      case "boolean": zt = z.boolean(); break;
      case "array": zt = z.array(z.unknown()); break;
      case "object": zt = z.record(z.string(), z.unknown()); break;
      default: zt = z.unknown();
    }
    if (prop.description) zt = zt.describe(prop.description);
    shape[key] = required.has(key) ? zt : zt.optional();
  }
  return z.object(shape).passthrough();
}

// MCP-STORE-DIRECT-TOGGLE: registers every `direct:true` store server's live tools as
// NATIVE, server-prefixed tools (`<server>__<tool>`) on this SAME chimera MCP server,
// routed through dispatch("mcpstore.call", ...) -- the identical shared daemon connection
// mcp_store_call already uses, including its operator-selected session isolation.
// This is presentation-only: no new server process/connection is spawned here. `servers` is passed to mcpstore.tools so a NON-direct server is never
// connected just to check. A lookup/connect failure degrades gracefully -- the direct
// server simply contributes no native tools (still reachable via mcp_store_call) and the
// rest of the chimera MCP grant (core tools, other direct servers) is unaffected.
async function registerDirectStoreTools(server: McpServer, dispatch: ChimeraMcpDispatch, ctx: ChimeraMcpCtx): Promise<void> {
  let directNames: string[];
  try {
    const list = (await dispatch("mcpstore.list", {})) as Array<{ name: string; direct?: boolean; enabled?: boolean }>;
    // MCPSTORE-LIFECYCLE-UI: a disabled server's direct tool injection is suppressed even
    // when `direct:true` -- disabling is a full "inert to agents" switch, not just a
    // proxy-vs-native presentation choice.
    directNames = list.filter((s) => s.direct === true && s.enabled !== false).map((s) => s.name);
  } catch {
    return;
  }
  if (directNames.length === 0) return;
  let rows: Array<{ server: string; connected: boolean; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>;
  try {
    const res = (await dispatch("mcpstore.tools", { servers: directNames })) as { servers: typeof rows };
    rows = res.servers;
  } catch {
    return;
  }
  for (const row of rows) {
    if (!row.connected) continue;   // unreachable direct MCP: no native tools, proxy path unaffected
    for (const t of row.tools) {
      server.registerTool(
        `${row.server}__${t.name}`,
        { description: t.description, inputSchema: jsonSchemaToZodShape(t.inputSchema) },
        async (a: unknown) => {
          try {
            // FEATURE-6: thread ctx.agentId through (mirrors mcp_store_call's own resolve
            // in mcp-tools.ts) so CapabilityBroker's audit event can attribute a principal.
            return storeResult(await dispatch("mcpstore.call", { server: row.server, tool: t.name, args: a as Record<string, unknown>, ...(ctx.agentId ? { agentId: ctx.agentId } : {}) }));
          } catch (e) {
            return jsonErr(e);
          }
        },
      );
    }
  }
}

// TOKEN-OPT-P2: register only "core" tools directly -- the ~2/3 rarely-called admin/CRUD
// surface ("extended") is NOT registered here at all; it's reachable only through the
// chimera_tools/chimera_call meta-pair (itself tier:"core", so always present). This shrinks
// the schema every orchestration-enabled agent gets injected with (~5K tok -> ~2K tok) without
// removing any capability -- every extended tool still runs, just via chimera_call instead of
// its own top-level MCP tool name. Applies uniformly to BOTH consumers of this factory: the
// stdio server (packages/mcp/src/server.ts) and core's in-process bridge (generic-mcp.ts).
export async function createChimeraMcpServer(dispatch: ChimeraMcpDispatch, ctx: ChimeraMcpCtx): Promise<McpServer> {
  const server = new McpServer({ name: "chimera", version: "0.1.0" });
  // Depth/env identify a candidate grant, not authority. Resolve the child edge
  // against the daemon before even publishing its baseline tools.
  if (ctx.access === "coordination" && !await coordinationCaller(dispatch, ctx)) return server;
  // TOOL-TAGS: what an agent is given is now a set of SUBJECTS, not a hand-kept list of names.
  // "core" is what everyone gets; a conductor adds "conductor" (the orchestration verbs its own
  // playbook instructs it to use — see CONDUCTOR_TOOL_NAMES for why a prompt that names tools an
  // agent cannot see does not fail safely); a spec can name more.
  //
  // Same tools as before for both cases, by construction — the tags are derived from the very sets
  // this used to test against. What changes is that widening an agent's surface is now naming a
  // subject rather than editing a list, and the vocabulary is the one chimera_tools already
  // searches, so what an agent CAN be given and what it can FIND are the same words.
  // AGENT-AUTONOMY: grantedChimeraToolNames also omits ask_human/ask_agent/ask_team entirely
  // for a "full" autonomy agent (no human to ask) -- not registered-but-refusing, so the
  // model's own tool list never advertises a capability it doesn't have. engine_help's catalog
  // is filtered the same way.
  const granted = new Set(directChimeraToolNames(ctx));
  for (const tool of MCP_TOOL_TABLE) {
    if (!granted.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      { description: ctx.access === "coordination" && tool.name === "memory_search" ? "Search shared-memory excerpts in your project and global scope." : ctx.access === "coordination" && tool.name === "chronicle_search" ? "Search recorded snippets from your own agent tree." : tool.description, ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        // Wrappers and mailbox operations are not pure reads, even when bounded.
        ...(CHIMERA_READ_TOOLS.has(tool.name) ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}),
      },
      async (a: Record<string, unknown>) => {
        if (ctx.access === "coordination" && (a["force"] === true || a["slash"] === true || (a["args"] && typeof a["args"] === "object" && ((a["args"] as Record<string, unknown>)["force"] === true || (a["args"] as Record<string, unknown>)["slash"] === true)))) return jsonErr({ code: "forbidden", message: "bounded coordination does not grant force or provider controls" });
        const r = tool.resolve(a, ctx);
        if (r.kind === "local") return json(r.value);
        if (r.kind === "error") return jsonErr(r.error);
        try {
          if (ctx.access === "coordination") {
            const caller = await coordinationCaller(dispatch, ctx);
            if (r.method === "memory.search" && caller?.projectId == null && (r.params as { scopeMode?: string }).scopeMode === undefined) r.params = { ...r.params as object, scopeMode: "global" };
            if (r.method === "agent.tail" && !(r.params as { agentId?: string }).agentId) r.params = { ...r.params as object, agentId: ctx.agentId };
            if (!caller || !await coordinationOperationAllowed(dispatch, caller, r.method, r.params)) {
              return jsonErr({ code: "forbidden", message: "operation is outside this child's tree/project/principal coordination grant" });
            }
          }
          const result = await dispatch(r.method, r.params);
          // F34.FIX: postDispatch reshapes what the AGENT sees, never what the RPC itself
          // returned — dispatch() above already resolved/settled against the protocol-declared
          // success type before this runs.
          if (r.method === "mcpstore.call" && !r.postDispatch) return storeResult(result);
          return json(r.postDispatch ? await r.postDispatch(result, dispatch) : result);
        } catch (e) {
          return jsonErr(e);
        }
      },
    );
  }
  if (ctx.access !== "coordination") await registerDirectStoreTools(server, dispatch, ctx);
  return server;
}
