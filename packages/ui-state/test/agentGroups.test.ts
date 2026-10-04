import { describe, expect, it } from "vitest";
import { bucketAgentsByGroup, effectiveGroupOf, groupColor, emptyAgent, type AgentView } from "../src/index.js";

function agent(overrides: Partial<AgentView>): AgentView {
  return { ...emptyAgent(overrides.agentId ?? "x"), ...overrides };
}

describe("effectiveGroupOf", () => {
  it("resolves an agent's own explicit group", () => {
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a", groups: ["sprint"] }) };
    expect(effectiveGroupOf(agents, "a")).toBe("sprint");
  });

  it("a grouped agent's whole subtree resolves to the SAME group via parentId inheritance — the 'moves with its subtree' invariant", () => {
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root", groups: ["sprint"] }),
      child: agent({ agentId: "child", parentId: "root" }),
      grandchild: agent({ agentId: "grandchild", parentId: "child" }),
    };
    expect(effectiveGroupOf(agents, "child")).toBe("sprint");
    expect(effectiveGroupOf(agents, "grandchild")).toBe("sprint");
  });

  it("an ungrouped agent with no grouped ancestor resolves to undefined", () => {
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root" }),
      child: agent({ agentId: "child", parentId: "root" }),
    };
    expect(effectiveGroupOf(agents, "child")).toBeUndefined();
  });

  it("a deeper explicit group wins over an outer ancestor's (nearest-ancestor-or-self, not outermost)", () => {
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root", groups: ["sprint"] }),
      child: agent({ agentId: "child", parentId: "root", groups: ["daily"] }),
    };
    expect(effectiveGroupOf(agents, "child")).toBe("daily");
  });

  it("never guesses across an unresolvable/missing parent — degrades to undefined, not a crash", () => {
    const agents: Record<string, AgentView> = {
      orphan: agent({ agentId: "orphan", parentId: "does-not-exist" }),
    };
    expect(effectiveGroupOf(agents, "orphan")).toBeUndefined();
  });

  it("a cyclic parentId chain (malformed data) degrades cleanly instead of hanging", () => {
    const agents: Record<string, AgentView> = {
      a: agent({ agentId: "a", parentId: "b" }),
      b: agent({ agentId: "b", parentId: "a" }),
    };
    expect(effectiveGroupOf(agents, "a")).toBeUndefined();
  });

  it("resolves for an unknown agentId to undefined", () => {
    expect(effectiveGroupOf({}, "nope")).toBeUndefined();
  });
});

describe("bucketAgentsByGroup", () => {
  it("buckets by effective group, preserving the caller's own order (not recency-sorted)", () => {
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root", groups: ["sprint"] }),
      child: agent({ agentId: "child", parentId: "root" }),
      other: agent({ agentId: "other", groups: ["daily"] }),
      ungrouped: agent({ agentId: "ungrouped" }),
    };
    const buckets = bucketAgentsByGroup(agents, ["root", "child", "other", "ungrouped"]);
    expect([...buckets.keys()]).toEqual(["sprint", "daily"]);
    expect(buckets.get("sprint")).toEqual(["root", "child"]);
    expect(buckets.get("daily")).toEqual(["other"]);
  });

  it("omits agents with no resolvable group entirely", () => {
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a" }) };
    expect(bucketAgentsByGroup(agents, ["a", "unknown-id"]).size).toBe(0);
  });
});

describe("groupColor", () => {
  it("returns the explicit color when given", () => {
    expect(groupColor("sprint", "amber")).toBe("amber");
  });

  it("falls back to a deterministic hash-derived color when unset", () => {
    const a = groupColor("sprint", undefined);
    const b = groupColor("sprint", undefined);
    expect(a).toBe(b); // stable across calls
  });

  it("two different group ids are not guaranteed distinct, but resolution never throws for empty ids", () => {
    expect(() => groupColor("", undefined)).not.toThrow();
  });
});


it("explicit removal stops inherited membership for an agent and its descendants", () => {
  const agents = {
    root: agent({ agentId: "root", groups: ["sprint"] }),
    child: agent({ agentId: "child", parentId: "root", groups: [] }),
    leaf: agent({ agentId: "leaf", parentId: "child" }),
  };
  expect(effectiveGroupOf(agents, "root")).toBe("sprint");
  expect(effectiveGroupOf(agents, "child")).toBeUndefined();
  expect(effectiveGroupOf(agents, "leaf")).toBeUndefined();
});
