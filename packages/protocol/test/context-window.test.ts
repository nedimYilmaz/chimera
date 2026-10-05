import { expect, it } from "vitest";
import { z } from "zod";
import { AgentSpecSchema, RoleSpecSchema } from "../src/index.js";
import { RPC_CONTRACT } from "../src/contract.js";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";

it("preserves the optional window through agent, role update and MCP spawn surfaces", () => {
  expect(AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp", contextWindow: 500000 }).contextWindow).toBe(500000);
  expect(RoleSpecSchema.parse({ name: "worker", contextWindow: 500000 }).contextWindow).toBe(500000);
  expect(RPC_CONTRACT["role.update"].request.parse({ name: "worker", patch: { contextWindow: null } })).toMatchObject({ patch: { contextWindow: null } });
  const tool = MCP_TOOL_TABLE.find(t => t.name === "agent_spawn")!;
  const input = z.object(tool.inputSchema).parse({ prompt: "p", cwd: "/tmp", contextWindow: 500000 });
  expect(tool.resolve(input, { depth: 0 })).toMatchObject({ params: { spec: { contextWindow: 500000 } } });
  for (const value of [0, -1, 0.5, Infinity]) expect(AgentSpecSchema.safeParse({ prompt: "p", cwd: "/tmp", contextWindow: value }).success).toBe(false);
  expect(AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp" })).not.toHaveProperty("contextWindow");
});
