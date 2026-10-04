// ALWAYS-ALLOW-UI — shared helpers both UIs use to turn a pending
// permission_request into a persistable toolPolicy key. Foreign MCP tool calls
// surface as permission cards named "mcp__<server>__<tool>" (MCP-TOOL-POLICY,
// merge 873752f); the card's "always allow" affordance writes host.setPolicy
// with EITHER the exact tool name OR the server key, mode on the "*" row (MCP
// calls carry no CLI profile). Kept here — not in a UI package — so the TUI and
// the Tauri app derive the SAME key from the SAME name.

const MCP_PREFIX = "mcp__";

// A permission ask is a foreign MCP tool when its name carries the "mcp__"
// prefix. chimera's own tools (mcp__chimera__*) auto-allow and never raise a
// card, so any name that reaches a permission card and starts with "mcp__" is a
// foreign/host MCP tool the server-scope affordance can govern.
export function isMcpTool(tool: string): boolean {
  return tool.startsWith(MCP_PREFIX);
}

// Server-level policy key for a foreign MCP tool. MIRRORS core's mcpServerKey
// (packages/core/src/broker.ts) EXACTLY so a rule written from the card lands on
// the same key decidePermission reads: everything up to (excluding) the "__"
// that separates <server> from <tool> — e.g.
// "mcp__plugin_atlassian_atlassian__getJiraIssue" → "mcp__plugin_atlassian_atlassian".
// A malformed name with no second "__" yields itself (server === exact tool),
// so the lookup still resolves.
export function mcpServerKey(tool: string): string {
  const sep = tool.indexOf("__", MCP_PREFIX.length);
  return sep === -1 ? tool : tool.slice(0, sep);
}
