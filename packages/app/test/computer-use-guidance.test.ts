import { describe, expect, it } from "vitest";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";
import { MCP_TOOLS } from "../src/state/commands.system";

describe("computer-use guidance across agent discovery and command presentation", () => {
  it.each(["mcp_store_tools", "mcp_store_session"])("keeps %s guidance consistent without adding task authority", name => {
    const agentTool = MCP_TOOL_TABLE.find(tool => tool.name === name)!;
    const presentation = MCP_TOOLS.find(tool => tool.name === name)!;
    expect(presentation.description).toBe(agentTool.description);
    expect(agentTool.description).toContain("app-directed typing");
    expect(agentTool.description).toContain("fresh");
    expect(agentTool.description).toContain("exact window target");
    expect(agentTool.description).toContain("Laya confidence never authorizes");
    expect(agentTool.description).toMatch(/[Dd]eliberate desktop task/);
    expect(agentTool.description).toMatch(/not an enforced target-identity guarantee|proxy does not enforce task intent/);
    expect(Object.keys(agentTool.inputSchema!)).toEqual(name === "mcp_store_tools" ? ["query"] : ["server", "action"]);
  });
});
