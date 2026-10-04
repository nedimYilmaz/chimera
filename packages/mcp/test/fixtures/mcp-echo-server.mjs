#!/usr/bin/env node
// MCP-STORE live acceptance fixture: a trivial real stdio MCP server with one `echo`
// tool. Tracks an in-process call counter so a test can prove TWO mcp_store_call
// invocations were served by the SAME daemon-hosted connection/child process -- a
// fresh spawn (a connection-reuse regression) would always report calls:1.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

let calls = 0;

const server = new McpServer({ name: "chimera-mcp-store-fixture", version: "0.1.0" });
server.registerTool("echo", {
  description: "Echoes the given text back, with a call counter proving connection reuse",
  inputSchema: { text: z.string() },
}, ({ text }) => {
  calls += 1;
  return { content: [{ type: "text", text: JSON.stringify({ echoed: text, calls }) }] };
});

await server.connect(new StdioServerTransport());
