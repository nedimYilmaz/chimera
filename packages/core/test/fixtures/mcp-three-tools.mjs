import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "three-tools", version: "1.0.0" });
for (const name of ["alpha", "beta", "gamma"]) {
  server.registerTool(
    name,
    { description: `${name} capture probe` },
    async () => ({ content: [{ type: "text", text: name }] }),
  );
}

await server.connect(new StdioServerTransport());
