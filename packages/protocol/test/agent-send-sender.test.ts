import { describe, it, expect } from "vitest";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";

// SENDER-OUT-OF-THE-TEXT: the receiving agent's "from:" line comes from the mailbox `from`, so an
// agent's agent_send must carry the caller's own id. It used to carry none, and 160 of the last
// few thousand delivered messages read "[from caller]": the receiver could not tell who wrote.
describe("agent_send names its caller", () => {
  const tool = MCP_TOOL_TABLE.find((t) => t.name === "agent_send")!;

  it("stamps the calling agent's own id as the sender", () => {
    const resolved = tool.resolve({ agentId: "b", text: "hi" }, { depth: 1, agentId: "agent-a" });
    expect(resolved).toMatchObject({ kind: "rpc", method: "agent.send", params: { agentId: "b", text: "hi", from: "agent-a" } });
  });

  it("cannot be told to send as someone else", () => {
    const resolved = tool.resolve({ agentId: "b", text: "hi", from: "operator" } as never, { depth: 1, agentId: "agent-a" });
    if (resolved.kind === "rpc") expect(resolved.params).toMatchObject({ from: "agent-a" });
  });

  it("an external MCP client with no agent id stays the operator (no from)", () => {
    const resolved = tool.resolve({ agentId: "b", text: "hi" }, { depth: 0 });
    if (resolved.kind === "rpc") expect(resolved.params).not.toHaveProperty("from");
  });
});
