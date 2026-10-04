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
import { MCP_TOOL_TABLE, grantedChimeraToolNames, type ChimeraMcpCtx } from "./mcp-tools.js";

export type ChimeraMcpDispatch = (method: string, params: unknown) => Promise<unknown>;

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
  const granted = new Set(grantedChimeraToolNames({ autonomy: ctx.autonomy, conductor: ctx.conductor, toolTags: ctx.toolTags }));
  for (const tool of MCP_TOOL_TABLE) {
    if (!granted.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}) },
      async (a: Record<string, unknown>) => {
        const r = tool.resolve(a, ctx);
        if (r.kind === "local") return json(r.value);
        if (r.kind === "error") return jsonErr(r.error);
        try {
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
  await registerDirectStoreTools(server, dispatch, ctx);
  return server;
}
