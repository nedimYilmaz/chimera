import { describe, expect, it } from "vitest";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";
describe("resource MCP discovery", () => {
  it("forces caller scope from authenticated context and includes host admission", () => {
    const resources = MCP_TOOL_TABLE.find(t => t.name === "agent_resources")!;
    const result = resources.resolve({ agentId: "target", callerAgentId: "forged" }, { agentId: "self" } as never);
    expect(result).toMatchObject({ kind: "rpc", method: "agent.resources", params: { agentId: "target", callerAgentId: "self" } });
    expect(MCP_TOOL_TABLE.find(t => t.name === "host_admission")!.resolve({}, {} as never)).toMatchObject({ kind: "rpc", method: "host.admission", params: {} });
  });
});
