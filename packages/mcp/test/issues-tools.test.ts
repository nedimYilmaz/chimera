import { describe, it, expect } from "vitest";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";
describe("issues tools", () => {
  it("queue_push exposes no internal import taskId in its public schema or parsed RPC", async () => {
    const { RPC_CONTRACT } = await import("@chimera/protocol/contract");
    const tool = MCP_TOOL_TABLE.find(t => t.name === "queue_push")!;
    expect(tool.inputSchema).not.toHaveProperty("taskId");
    const resolved = tool.resolve({ queue: "work", prompt: "ordinary", taskId: `gh-${"a".repeat(64)}` }, { agentId: "real" } as Parameters<typeof tool.resolve>[1]);
    expect(resolved.kind).toBe("rpc");
    if (resolved.kind === "rpc") expect(RPC_CONTRACT["queue.push"].request.parse(resolved.params)).not.toHaveProperty("taskId");
  });
  it("has parity for all operations and stamps the real caller after forged input", () => {
    const tools = MCP_TOOL_TABLE.filter(t => t.name.startsWith("issues_")); expect(tools).toHaveLength(6);
    for (const tool of tools) {
      const r = tool.resolve({ callerAgentId: "forged", sourceId: "source", repo: "demo/repo", projectId: "p", queue: "mine", taskId: "task", body: "result", phase: "confirm", previewId: "forged" }, { agentId: "real" } as Parameters<typeof tool.resolve>[1]);
      expect(r).toMatchObject({ kind: "rpc", params: { callerAgentId: "real" } });
      expect(tool.inputSchema).not.toHaveProperty("callerAgentId");
      if (tool.name === "issues_post_comment") { expect(r).toMatchObject({ params: { phase: "preview" } }); expect(tool.inputSchema).not.toHaveProperty("previewId"); }
      if (tool.name === "issues_source_upsert") expect(r).toMatchObject({ params: { allowRunningQueue: false } });
    }
  });
});
