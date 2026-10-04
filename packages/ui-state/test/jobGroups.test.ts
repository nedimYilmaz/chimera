import { describe, expect, it } from "vitest";
import { bucketAgentsByJob, emptyAgent, type AgentView } from "../src/index.js";

function agent(overrides: Partial<AgentView>): AgentView {
  return { ...emptyAgent(overrides.agentId ?? "x"), ...overrides };
}

describe("bucketAgentsByJob", () => {
  it("buckets job-spawned agents by jobName, newest createdAt first", () => {
    const agents: Record<string, AgentView> = {
      a: agent({ agentId: "a", jobName: "slack-watch", createdAt: 1_000 }),
      b: agent({ agentId: "b", jobName: "slack-watch", createdAt: 3_000 }),
      c: agent({ agentId: "c", jobName: "slack-watch", createdAt: 2_000 }),
      d: agent({ agentId: "d" }), // no jobName — not a scheduled-job spawn
    };
    const buckets = bucketAgentsByJob(agents, ["a", "b", "c", "d"]);
    expect([...buckets.keys()]).toEqual(["slack-watch"]);
    expect(buckets.get("slack-watch")).toEqual(["b", "c", "a"]);
  });

  it("falls back to lastEventTs when createdAt hasn't landed yet", () => {
    const agents: Record<string, AgentView> = {
      a: agent({ agentId: "a", jobName: "j", lastEventTs: 5 }),
      b: agent({ agentId: "b", jobName: "j", lastEventTs: 9 }),
    };
    expect(bucketAgentsByJob(agents, ["a", "b"]).get("j")).toEqual(["b", "a"]);
  });

  it("omits agents with no jobName and jobs with no members", () => {
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a" }) };
    expect(bucketAgentsByJob(agents, ["a", "unknown-id"]).size).toBe(0);
  });
});
