import { describe, it, expect } from "vitest";
import { isMcpTool, mcpServerKey } from "../src/mcpPolicy.js";

// ALWAYS-ALLOW-UI: the persist affordance turns a pending permission_request's
// toolName into a host.setPolicy key. mcpServerKey MUST mirror core's own
// mcpServerKey (broker.ts) exactly, or a rule written from the card would land
// on a key decidePermission never reads.
describe("isMcpTool", () => {
  it("recognizes foreign MCP tool names by the mcp__ prefix", () => {
    expect(isMcpTool("mcp__ekb__search")).toBe(true);
    expect(isMcpTool("mcp__plugin_atlassian_atlassian__getJiraIssue")).toBe(true);
  });
  it("rejects Bash/native host-tool asks (no server key applies)", () => {
    expect(isMcpTool("Bash")).toBe(false);
    expect(isMcpTool("Write")).toBe(false);
    expect(isMcpTool("kubectl")).toBe(false);
  });
});

describe("mcpServerKey", () => {
  it("strips the tool, keeping mcp__<server> (server names may hold single underscores)", () => {
    expect(mcpServerKey("mcp__ekb__search")).toBe("mcp__ekb");
    expect(mcpServerKey("mcp__plugin_atlassian_atlassian__getJiraIssue")).toBe("mcp__plugin_atlassian_atlassian");
    expect(mcpServerKey("mcp__claude_ai_Slack__slack_send_message")).toBe("mcp__claude_ai_Slack");
  });
  it("splits at the FIRST '__' after the prefix (a tool name with '__' doesn't move the boundary)", () => {
    expect(mcpServerKey("mcp__srv__a__b")).toBe("mcp__srv");
  });
  it("a malformed name with no second '__' yields itself (server === exact tool)", () => {
    expect(mcpServerKey("mcp__weird")).toBe("mcp__weird");
  });
});
