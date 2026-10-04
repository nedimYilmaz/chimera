import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "disconnect-probe", version: "1.0.0" });
server.registerTool("snapshot", {}, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
server.registerTool("disconnect", {}, async () => { process.exit(0); });
await server.connect(new StdioServerTransport());
