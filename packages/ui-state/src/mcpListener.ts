import type { McpListenerGrantStatus, McpListenerStatus } from "@chimera/protocol";

/** F49.UI — the one sentence both surfaces print under the listener block. The
 * transport guarantee and the auth model are the two things an operator has to
 * be told, and the token is deliberately not among them: McpListenerStatus
 * carries no token field, so there is nothing here that could leak one. */
export const MCP_LISTENER_FOOTNOTE =
  "local-only transport — 127.0.0.1 by construction, never reachable from another machine · each agent authenticates with its own token (never shown here)";

/** F49.UI — a grant appearing/disappearing between two daemon.status polls is the
 * only operator-visible trace of a client connecting; the daemon emits no event for
 * it. Rendered into the owning agent's transcript as a system line. */
export function mcpListenerConnectLine(g: McpListenerGrantStatus, address: string | null): string {
  const where = address ? ` · ${address}` : "";
  return `local MCP listener: ${g.provider} client connected${where} (token-authenticated, loopback-only)`;
}

export function mcpListenerDisconnectLine(): string {
  return "local MCP listener: client disconnected — its token is revoked";
}

export type McpListenerTransition =
  | { kind: "connected"; agentId: string; text: string }
  | { kind: "disconnected"; agentId: string; text: string };

/** Diff of two consecutive polls. `prev === null` means "never observed" and yields
 * NOTHING — the first poll after a UI start must not announce grants that were
 * already live as if they had just connected. */
export function mcpListenerTransitions(
  prev: readonly string[] | null,
  next: McpListenerStatus | undefined,
): { transitions: McpListenerTransition[]; agentIds: readonly string[] | null } {
  if (next === undefined) return { transitions: [], agentIds: prev };
  const grants = next.enabled ? next.grants : [];
  const agentIds = grants.map((g) => g.agentId);
  if (prev === null) return { transitions: [], agentIds };
  const before = new Set(prev);
  const after = new Set(agentIds);
  const transitions: McpListenerTransition[] = [];
  for (const g of grants) {
    if (!before.has(g.agentId)) {
      transitions.push({ kind: "connected", agentId: g.agentId, text: mcpListenerConnectLine(g, next.address) });
    }
  }
  for (const agentId of prev) {
    if (!after.has(agentId)) {
      transitions.push({ kind: "disconnected", agentId, text: mcpListenerDisconnectLine() });
    }
  }
  return { transitions, agentIds };
}
