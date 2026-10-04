// Local CLI integration fixture; no daemon, credentials, or microphone.
import { createInterface } from "node:readline";
let pending;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.id === "approval" && pending !== undefined) {
    const accepted = request.result?.action === "accept";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: pending, result: { content: [{ type: "text", text: accepted ? "local-mcp-ok" : "user cancelled MCP tool call" }], isError: !accepted } }) + "\n");
    pending = undefined;
    return;
  }
  if (request.method === "tools/call") {
    pending = request.id;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "approval", method: "elicitation/create", params: { mode: "form", message: "Approve local tool", requestedSchema: { type: "object", properties: {} } } }) + "\n");
    return;
  }
  const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "chimera", version: "test" } }
    : request.method === "tools/list" ? { tools: [{ name: "chimera_tools", description: "Local test tool", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
