import { MCP_TOOL_NAMES, type McpToolName } from "./mcp-tools.js";
// spec §17.6: the engine's self-description (engine_help / ENGINE_HELP), lifted
// out of server.ts into this PURE, side-effect-free module so every consumer can
// import the canonical tool catalog WITHOUT dragging in the server wiring.
//
// CAPABILITY-BLOCK-DRIFT: this module lives in @chimera/protocol (not @chimera/mcp,
// where it started) because @chimera/core needed it too, and core -> mcp is a real
// dependency cycle (mcp -> client -> core). protocol has no dependency on core or
// client, and both core and mcp already depend on protocol, so this is the one
// location every consumer can reach without a cycle. @chimera/mcp/engine-help
// re-exports this module verbatim so its existing subpath (and the app imports
// of it) stay unchanged.
//
// server.ts connects a ChimeraClient at module top-level (it IS the stdio server
// entrypoint), so importing "@chimera/mcp" would try to open a second client. This
// file imports nothing (zero deps, no side effects), so @chimera/app
// and @chimera/core can all pull the source of truth for "which tools exist" without
// the client ever connecting. server.ts consumes it too, so there is exactly ONE
// hand-maintained list; the palettes (and now the supervisor's spawn-time capability
// block) are generated from it (F07: "generate from engine_help — hand-written lists
// forbidden").
//
// This list is the TRUTH for the FULL set of tool names (browse/discovery catalog for the
// UIs and for engine_help), not the provider's eager/deferred-name surface. TOKEN-OPT-P2:
// only @chimera/protocol's small CORE_MCP_TOOL_NAMES subset is registered on the wire;
// every "extended"-tier name here is found with chimera_tools and reached via chimera_call.
// The stdio completeness guard in test/mcp.test.ts checks registered tools ===
// CORE_MCP_TOOL_NAMES (not this full list).
// Its parity with each UI palette is still enforced by a per-package drift test that maps its
// presentation metadata over these names (a name with no metadata, or a phantom metadata
// entry, fails the suite).
//
// A THIRD guard, test/mcp-parity.test.ts, checks parity against the actual DAEMON rather
// than against this catalog: every case in Engine.handle()'s RPC table (packages/core/src/
// engine.ts) must resolve through some entry in @chimera/protocol's mcp-tools.ts, or be named
// in that test's INTENTIONALLY_EXCLUDED_RPCS with a reason (currently: the ten fed.* federation
// network/credential-administration RPCs -- human/CLI territory, never agent-facing;
// mailbox.forward doesn't need listing there at all since it lives only in the separate
// peer-authenticated handlePeer() entrypoint, never in handle()'s own table).

/** Every chimera MCP tool name, in the engine_help advertisement order. */
// TOOL-CATALOG-IS-DERIVED: this WAS a hand-maintained array parallel to MCP_TOOL_TABLE, and it
// rotted exactly the way a restated list does. Measured at the moment it was replaced, THREE
// tools existed in the table and were absent here — main_conductor_status, main_conductor_ensure
// and agent_set_turn_limit — so engine_help's own catalog, ENGINE_HELP.tools and both UI
// palettes had been silently omitting real, callable tools. Nothing failed: adding a tool to the
// table alone produced no error anywhere, it just made the tool invisible to everything that
// reads this list.
//
// Now it is read off the table that implements the tools, so a tool cannot exist without being
// listed. What still needs a human is PRESENTATION — the app palette is a
// Record<EngineToolName, ...>, so a new tool makes them fail to compile until someone writes its
// label and description. That is the right place for the remaining friction: a name is derivable,
// a good description is not.
export const ENGINE_TOOL_NAMES = MCP_TOOL_NAMES;

export type EngineToolName = McpToolName;

export const ENGINE_DEPTH_RULE =
  "Every spawn increments depth by 1. A spawn is rejected once depth exceeds the granting parent's maxDepth cap (CHIMERA_MAX_DEPTH). orchestrationAllow=false (default) means a child gets no chimera MCP of its own.";

export const ENGINE_PERMISSION_RULE =
  "Gated tool calls route per the spawn's on.permissionRequest policy: 'auto' decides instantly from permissionProfile; 'poke:caller'/'tui' (legacy name for asking the attached operator) emit a permission_request event and wait for agent_permission_respond, falling back to the profile decision on timeout.";

export const ENGINE_ASK_RULE =
  "Call ask_human to ask your human/orchestrator a question and block until they answer; call ask_agent to ask a SPECIFIC peer agent (to:{agentId}); call ask_team to ask a whole team or role, collecting ALL members' answers. Each emits an agent_question event, is answered via answer_question, and returns the structured answer(s). On timeout the question's default applies.";

/** The machine-readable engine_help payload (static — no daemon round-trip). */
export type EngineHelp = {
  tools: readonly string[];
  depthRule: string;
  permissionRule: string;
  askRule: string;
};

export const ENGINE_HELP: EngineHelp = {
  tools: ENGINE_TOOL_NAMES,
  depthRule: ENGINE_DEPTH_RULE,
  permissionRule: ENGINE_PERMISSION_RULE,
  askRule: ENGINE_ASK_RULE,
};
