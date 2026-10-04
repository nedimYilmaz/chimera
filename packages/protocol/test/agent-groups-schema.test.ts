import { describe, it, expect } from "vitest";
import {
  AgentSpecSchema, AgentSummarySchema, AgentGroupSchema, AgentGroupIdSchema, AgentGroupColorSchema,
  GroupCreateParamsSchema, GroupUpdateParamsSchema, GroupDeleteParamsSchema, GroupListResultSchema,
  AgentSetGroupsParamsSchema, AGENT_GROUP_COLORS,
} from "@chimera/protocol";

describe("AGENT-GROUPS Phase 1: AgentSpecSchema.groups", () => {
  it("defaults to [] — a spec without `groups` parses and round-trips byte-identically to every pre-existing spec", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp" });
    expect(spec.groups).toEqual([]);
  });

  it("accepts an explicit groups array", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", groups: ["sprint"] });
    expect(spec.groups).toEqual(["sprint"]);
  });

  it("caps at 8 groups per spec", () => {
    const groups = Array.from({ length: 9 }, (_, i) => `g${i}`);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", groups })).toThrow();
  });

  it("rejects a malformed group id (uppercase, leading dash, too long)", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", groups: ["Sprint"] })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", groups: ["-sprint"] })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", groups: ["x".repeat(33)] })).toThrow();
  });
});

describe("AGENT-GROUPS Phase 1: AgentSummarySchema.groups", () => {
  const base = {
    id: "a1", name: "claude", role: null, status: "running", model: null, depth: 0,
    parentId: null, costUsd: 0, gitBranch: null,
  };

  it("omitted entirely when absent — byte-identical to a pre-AGENT-GROUPS summary", () => {
    const parsed = AgentSummarySchema.parse(base);
    expect(parsed.groups).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("groups");
  });

  it("carries groups when present", () => {
    const parsed = AgentSummarySchema.parse({ ...base, groups: ["sprint", "daily"] });
    expect(parsed.groups).toEqual(["sprint", "daily"]);
  });
});

describe("AGENT-GROUPS Phase 1: registry/RPC schemas", () => {
  it("AgentGroupIdSchema: slug rules", () => {
    expect(AgentGroupIdSchema.safeParse("sprint").success).toBe(true);
    expect(AgentGroupIdSchema.safeParse("sprint-42").success).toBe(true);
    expect(AgentGroupIdSchema.safeParse("Sprint").success).toBe(false);
    expect(AgentGroupIdSchema.safeParse("-sprint").success).toBe(false);
    expect(AgentGroupIdSchema.safeParse("").success).toBe(false);
  });

  it("AgentGroupColorSchema: exactly the 8 TEAM_COLORS-equivalent literals", () => {
    expect(AGENT_GROUP_COLORS).toHaveLength(8);
    for (const c of AGENT_GROUP_COLORS) expect(AgentGroupColorSchema.safeParse(c).success).toBe(true);
    expect(AgentGroupColorSchema.safeParse("chartreuse").success).toBe(false);
  });

  it("AgentGroupSchema: color is optional (defaults resolved client-side, never persisted as a default)", () => {
    const g = AgentGroupSchema.parse({ id: "sprint", name: "Sprint", createdAt: 1, order: 0 });
    expect(g.color).toBeUndefined();
  });

  it("GroupCreateParamsSchema / GroupUpdateParamsSchema / GroupDeleteParamsSchema / GroupListResultSchema round-trip", () => {
    expect(GroupCreateParamsSchema.parse({ name: "Sprint" })).toEqual({ name: "Sprint" });
    expect(GroupUpdateParamsSchema.parse({ id: "sprint", name: "Renamed" })).toEqual({ id: "sprint", name: "Renamed" });
    expect(GroupDeleteParamsSchema.parse({ id: "sprint" })).toEqual({ id: "sprint" });
    expect(GroupListResultSchema.parse({ groups: [] })).toEqual({ groups: [] });
  });

  it("AgentSetGroupsParamsSchema: caps at 8, rejects a malformed id", () => {
    expect(AgentSetGroupsParamsSchema.parse({ agentId: "a1", groups: ["sprint"] })).toEqual({ agentId: "a1", groups: ["sprint"] });
    expect(() => AgentSetGroupsParamsSchema.parse({ agentId: "a1", groups: Array.from({ length: 9 }, (_, i) => `g${i}`) })).toThrow();
    expect(() => AgentSetGroupsParamsSchema.parse({ agentId: "a1", groups: ["Bad Id"] })).toThrow();
  });
});
