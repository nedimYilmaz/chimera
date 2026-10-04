#!/usr/bin/env node
// F49: a minimal ACP-speaking stand-in for the kimi CLI. kimi-hang-cli.mjs never answers the
// handshake, so it can never reach the grant-minting code -- the http grant is only decided AFTER
// initialize() resolves. This fixture answers just enough of the wire to get there, and records
// the `session/new` params it received so a test can assert what chimera actually put on the wire
// (the mcpServers array is otherwise invisible from outside the backend).
//
// Env knobs (never argv: the backend owns argv and would drop anything extra):
//   KIMI_FAKE_LOG               path to append one JSON line per inbound request
//   KIMI_FAKE_MCP_CAPS          JSON for agentCapabilities.mcpCapabilities (default {"http":true,"sse":true})
//   KIMI_FAKE_EXIT_AFTER_NEW=1  exit(0) right after answering session/new -- the "child died on its
//                               own, terminate() never ran" path
// session/prompt is never answered (see below), so a spawned agent stays alive until killed.
import { appendFileSync } from "node:fs";

const logPath = process.env["KIMI_FAKE_LOG"];
const caps = JSON.parse(process.env["KIMI_FAKE_MCP_CAPS"] ?? '{"http":true,"sse":true}');

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;   // a notification: nothing to answer
    if (logPath) appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params }) + "\n");
    // session/prompt is deliberately NEVER answered: the turn stays in flight, so the agent (and
    // therefore its grant) is still alive when the test kills it. An answered turn would let the
    // run loop end the agent on its own and revoke the grant for a reason the test is not testing.
    if (msg.method === "session/prompt") continue;
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: caps } };
    else if (msg.method === "session/new") result = { sessionId: "sess-acp-fake" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    // Exit 0, not a crash code: connectKimiAcp only rejects the handshake on a NON-zero exit, so a
    // clean self-exit is exactly the "nothing failed, the child is simply gone" case under test.
    if (msg.method === "session/new" && process.env["KIMI_FAKE_EXIT_AFTER_NEW"] === "1") {
      setTimeout(() => process.exit(0), 30);
    }
  }
});
setInterval(() => {}, 60_000);
