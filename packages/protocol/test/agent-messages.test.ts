import { expect, it } from "vitest";
import { AssignParams, DispatchParams, AgentMessageMetadataSchema } from "../src/index.js";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";

it.each(["assign", "dispatch"])("%s derives provenance from the MCP connection, not arguments", (name) => {
  const tool = MCP_TOOL_TABLE.find(tool => tool.name === name)!;
  expect(tool.inputSchema).not.toHaveProperty("callerAgentId");
  const args = { agentId: "target", prompt: "task", callerAgentId: "forged" };
  const result = tool.resolve(args, { agentId: "real-sender", depth: 0 });
  expect(result).toMatchObject({ kind: "rpc", params: { callerAgentId: "real-sender", prompt: "task" } });
  const external = tool.resolve(args, { depth: 0 });
  if (external.kind === "rpc") expect(external.params).not.toHaveProperty("callerAgentId");
});

it("round-trips daemon provenance independently of message text", () => {
  const metadata = { from: "agent-id", source: "agent", kind: "child_failed", engineId: "local", team: "crew", role: "reviewer" };
  expect(AgentMessageMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
  expect(AssignParams.parse({ target: { agentId: "target" }, prompt: "task", callerAgentId: "source" }).callerAgentId).toBe("source");
  expect(DispatchParams.parse({ prompt: "task", callerAgentId: "source" }).callerAgentId).toBe("source");
});

it("bulk send cannot impersonate the operator or another agent", () => {
  const tool = MCP_TOOL_TABLE.find(tool => tool.name === "agent_send_many")!;
  expect(tool.inputSchema).not.toHaveProperty("from");
  expect(tool.resolve({ agentIds: ["target"], text: "task", from: "operator" }, { agentId: "real-agent", depth: 0 }))
    .toMatchObject({ params: { from: "real-agent" } });
});

it.each(["agent_resume", "agent_resume_many"])("%s carries the actual continuation author", name => {
  const tool = MCP_TOOL_TABLE.find(tool => tool.name === name)!;
  expect(tool.resolve({ agentId: "target", agentIds: ["target"], prompt: "task", callerAgentId: "forged" }, { agentId: "real-agent", depth: 0 }))
    .toMatchObject({ params: { callerAgentId: "real-agent" } });
});
