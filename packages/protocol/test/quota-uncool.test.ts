import { describe, it, expect } from "vitest";
import {
  AgentReleaseParamsSchema, AccountUncoolParamsSchema, AccountUncoolResultSchema, EventKindSchema,
} from "../src/index.js";
import { MCP_TOOL_TABLE, MCP_TOOL_NAMES } from "../src/mcp-tools.js";

// QUOTA-UNCOOL: the contract half. accounts_uncool has to reach the daemon through the same tool
// table every other tool does, and agent_release's new `force` has to survive schema parsing —
// AgentBulkParamsSchema is `.strict()` and shared with agent.hold, which is why release got its
// own schema instead of an extra field on the shared one.

describe("AgentReleaseParamsSchema", () => {
  it("defaults force to false so every existing caller keeps today's behavior", () => {
    expect(AgentReleaseParamsSchema.parse({ agentIds: ["a"] })).toEqual({ agentIds: ["a"], force: false });
  });

  it("accepts an explicit force", () => {
    expect(AgentReleaseParamsSchema.parse({ agentIds: ["a"], force: true }).force).toBe(true);
  });

  it("still rejects unknown keys", () => {
    expect(() => AgentReleaseParamsSchema.parse({ agentIds: ["a"], forec: true })).toThrow();
  });
});

describe("accounts.uncool contract", () => {
  it("requires a non-empty account name", () => {
    expect(AccountUncoolParamsSchema.parse({ name: "claude" })).toEqual({ name: "claude" });
    expect(() => AccountUncoolParamsSchema.parse({ name: "" })).toThrow();
  });

  it("reports what was cleared and who was resumed", () => {
    const parsed = AccountUncoolResultSchema.parse({
      account: "claude", wasCooling: true, clearedUntil: 1_800_000, resumed: ["a1", "a2"],
    });
    expect(parsed.resumed).toEqual(["a1", "a2"]);
    // A cleared-nothing result is still valid: the desired end state already held.
    expect(AccountUncoolResultSchema.parse({ account: "c", wasCooling: false, clearedUntil: null, resumed: [] }).clearedUntil).toBeNull();
  });

  it("is reachable as an MCP tool that resolves to the RPC", () => {
    expect(MCP_TOOL_NAMES).toContain("accounts_uncool");
    const tool = MCP_TOOL_TABLE.find((t) => t.name === "accounts_uncool")!;
    expect(tool.tags).toContain("accounts");
    expect(tool.resolve({ name: "claude" })).toMatchObject({ method: "accounts.uncool", params: { name: "claude" } });
  });

  it("agent_release forwards force only when the caller set it", () => {
    const tool = MCP_TOOL_TABLE.find((t) => t.name === "agent_release")!;
    expect(tool.resolve({ agentIds: ["a"] })).toMatchObject({ params: { agentIds: ["a"] } });
    expect(tool.resolve({ agentIds: ["a"], force: true })).toMatchObject({ params: { agentIds: ["a"], force: true } });
  });
});

describe("account_cooldown_cleared event kind", () => {
  it("is a registered event kind", () => {
    expect(EventKindSchema.parse("account_cooldown_cleared")).toBe("account_cooldown_cleared");
  });
});
