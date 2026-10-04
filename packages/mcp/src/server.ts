#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChimeraClient } from "@chimera/client";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { createDispatch } from "./daemon-skew.js";

// This entrypoint is used two ways: (1) spawned as a subprocess of an ALREADY-running
// chimerad by claude.ts/codex.ts for an orchestration-enabled agent; (2) launched
// standalone by an external MCP client (e.g. `claude mcp add chimera -- node
// bin/chimera-mcp.js`). Both go through ChimeraClient.connect()'s default
// autostart:true, same as every other chimera CLI entrypoint (cli.ts) -- a standalone
// launch with no chimerad yet running transparently boots one under CHIMERA_HOME rather
// than erroring, so a fresh `claude mcp add chimera` "just works". The try/catch below
// only matters for the failure tail of that autostart (spawn failed, or chimerad didn't
// come up within its 5s deadline) or a CHIMERA_HOME with no write access -- ChimeraClient
// already produces a readable Error for those; this turns it into ONE clear stderr line
// instead of an unhandled top-level-await stack trace the MCP client would otherwise show
// as an opaque "server failed to start".
let client: ChimeraClient;
try {
  client = await ChimeraClient.connect();
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(
    `chimera-mcp: could not connect to (or start) chimerad: ${detail}\n` +
    `If chimerad uses a non-default home, set CHIMERA_HOME to match before retrying.`,
  );
  process.exit(1);
}
const depth = Number(process.env.CHIMERA_DEPTH ?? -1) + 1;
// set by the chimera-MCP grant injected into orchestrating agents (Task 17):
// the daemon enforces the GRANTING parent's depth limit, not the child spec's
const maxDepthCap = process.env.CHIMERA_MAX_DEPTH ? Number(process.env.CHIMERA_MAX_DEPTH) : undefined;
const treeId = process.env.CHIMERA_TREE_ID || undefined;
const team = process.env.CHIMERA_TEAM || undefined;
const agentId = process.env.CHIMERA_AGENT_ID || undefined;
// AGENT-AUTONOMY: set by claude.ts/codex.ts's chimera-mcp grant when the spawning agent's own
// spec has autonomy:"full" — see createChimeraMcpServer for what this suppresses.
const autonomy = process.env.CHIMERA_AUTONOMY === "full" ? "full" as const : undefined;

const isDisconnected = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "disconnected";

// P1 reliability fix: a long-lived MCP server holds ONE persistent daemon socket
// (`client`) for its whole process lifetime. If chimerad restarts or the socket
// drops (idle timeout, EPIPE/ECONNRESET), every call used to fail forever with
// {code:"disconnected"} -- surfaced to the SDK as "Stream closed" -- with no
// retry. `reconnect()` re-dials on demand and shares one in-flight promise so
// concurrent callers don't each open their own duplicate connection.
let reconnecting: Promise<void> | null = null;
const reconnect = (): Promise<void> => {
  if (!reconnecting) {
    reconnecting = ChimeraClient.connect()
      .then((c) => { client = c; })
      .finally(() => { reconnecting = null; });
  }
  return reconnecting;
};

// INPROC-CHIMERA-BRIDGE: dispatch is the ONLY socket-specific piece left in this file -- the
// tool-name -> RPC mapping (method + param shaping) and the McpServer construction now live in
// @chimera/protocol's MCP_TOOL_TABLE/createChimeraMcpServer, shared verbatim with core's
// in-process bridge (packages/core/src/backends/generic-mcp.ts). The daemon-version-skew
// strip-and-retry logic lives in ./daemon-skew.ts so it can be unit-tested with a fake daemon.
const dispatch = createDispatch({
  request: (method, params) => client.request(method, params),
  isClosed: () => client.closed,
  reconnect,
  isDisconnected,
  warn: (message) => console.error(message),
});

// CONDUCTOR-TOOLS-MATCH-THE-PLAYBOOK: stamped by every backend from spec.conductor — see
// CONDUCTOR_TOOL_NAMES for what it unlocks and why.
const conductor = process.env.CHIMERA_CONDUCTOR === "1";
const server = await createChimeraMcpServer(dispatch, { agentId, depth, maxDepthCap, treeId, team, autonomy, conductor });

await server.connect(new StdioServerTransport());
