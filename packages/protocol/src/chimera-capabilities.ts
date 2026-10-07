// Delegation is opt-in; a child still needs discovery and a way to report to its
// parent. Keep that grant separate from host permissions and provider autonomy.
export type ChimeraAccess = "none" | "coordination" | "orchestration";
export function chimeraAccess(spec: { depth: number; orchestration: { allow: boolean } }): ChimeraAccess {
  return spec.orchestration.allow ? "orchestration" : spec.depth > 0 ? "coordination" : "none";
}

// Explicit names fail closed when the catalog grows. Never classify secrets,
// foreign MCP proxies or admin operations by a verb such as get/list.
export const CHIMERA_READ_TOOLS: ReadonlySet<string> = new Set([
  "chimera_tools", "engine_help",
  "agent_status", "agent_result", "agent_wait", "agent_tail",
  "my_team", "memory_search", "chronicle_search",
]);
export const CHIMERA_COMMUNICATION_TOOLS: ReadonlySet<string> = new Set(["agent_send", "agent_send_many"]);
export function coordinationTool(name: string): boolean {
  return name === "chimera_call" || CHIMERA_READ_TOOLS.has(name) || CHIMERA_COMMUNICATION_TOOLS.has(name);
}

export function coordinationPermission(toolName: string, input: unknown): boolean {
  const prefix = "mcp__chimera__";
  if (!toolName.startsWith(prefix)) return false;
  const name = toolName.slice(prefix.length);
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const target = name === "chimera_call" ? args["tool"] : name;
  const body = name === "chimera_call" && args["args"] && typeof args["args"] === "object" ? args["args"] as Record<string, unknown> : args;
  if (body["force"] === true || body["slash"] === true) return false;
  return typeof target === "string" && target !== "chimera_call" && coordinationTool(target);
}

export function chimeraToolRestrictions(spec: { mcpToolAllowlist?: Record<string, string[]>; mcpServers: Record<string, unknown> }): { toolAllowlist?: string[]; toolDenylist?: string[] } {
  const configured = spec.mcpServers["chimera"] as { enabled_tools?: string[]; disabled_tools?: string[]; enabled?: boolean } | undefined;
  const requested = spec.mcpToolAllowlist === undefined ? undefined : spec.mcpToolAllowlist["chimera"] ?? [];
  const allowed = configured?.enabled === false ? [] : requested === undefined ? configured?.enabled_tools
    : configured?.enabled_tools === undefined ? requested : requested.filter(name => configured.enabled_tools!.includes(name));
  return { ...(allowed !== undefined ? { toolAllowlist: allowed } : {}), ...(configured?.disabled_tools !== undefined ? { toolDenylist: configured.disabled_tools } : {}) };
}
