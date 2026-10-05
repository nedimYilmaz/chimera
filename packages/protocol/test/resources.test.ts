import { describe, expect, it } from "vitest";
import { AgentResourceSampleSchema } from "../src/resources.js";
import { RPC_CONTRACT } from "../src/contract.js";
describe("resource wire contract", () => {
  it("keeps unknown metrics null and bounds process snapshots", () => {
    const sample = { agentId: "a", sampledAt: 1, state: "unavailable", reason: "platform", rootPid: null, procs: [], totals: { cpuPct: null, rssBytes: null, procCount: 0 }, truncated: false };
    expect(AgentResourceSampleSchema.parse(sample).totals.rssBytes).toBeNull();
    expect(AgentResourceSampleSchema.safeParse({ ...sample, argv: "secret" }).success).toBe(false);
    expect(RPC_CONTRACT["agent.resources"].request.safeParse({ agentId: "a" }).success).toBe(true);
    expect(RPC_CONTRACT["host.admission"].request.safeParse({ kill: 123 }).success).toBe(false);
  });
});
