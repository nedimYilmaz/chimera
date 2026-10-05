import { expect, it } from "vitest";
import { ForkRequestSchema, ProviderCapabilitiesSchema } from "../src/index.js";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";
it("defaults native provider capability false and rejects blank task, overrides and authority forgery", () => {
  expect(ProviderCapabilitiesSchema.parse({ tools: true, vision: true, streaming: true }).conversationFork).toBe(false);
  const input = { agentId: "a", mode: "snapshot", task: "inspect" };
  for (const value of [{ ...input, task: " " }, { ...input, provider: "codex" }, { ...input, operator: true }, { ...input, account: "private" }, { ...input, agentId: "peer:a" }]) expect(ForkRequestSchema.safeParse(value).success).toBe(false);
});
it("MCP resolves authenticated caller internally without user-supplied depth/account/identity", () => {
  for (const name of ["agent_fork", "agent_fork_capabilities"]) {
    const tool = MCP_TOOL_TABLE.find(t => t.name === name)!;
    expect(Object.keys(tool.inputSchema!)).not.toContain("callerAgentId");
    expect(() => tool.resolve!({ agentId: "a", mode: "snapshot", task: "inspect" }, { depth: 0 })).toThrow("Authenticated");
    expect(tool.resolve!({ agentId: "a", mode: "snapshot", task: "inspect" }, { agentId: "caller", depth: 1 })).toMatchObject({ params: { callerAgentId: "caller" } });
  }
});
