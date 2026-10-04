import { describe, expect, it } from "vitest";
import { EXTENDED_MCP_TOOL_NAMES, CORE_MCP_TOOL_NAMES, MCP_TOOL_TABLE } from "../src/mcp-tools.js";
import { ReviewFindingSchema } from "../src/index.js";

// F25: review_get/review_finding_add/review_finding_resolve resolver-level ctx stamping + tier.
// These pin the resolver seam directly (the engine-side forwarding is proven in core's own
// tests); ctx.agentId presence/absence is the whole contract.
const tool = (name: string) => MCP_TOOL_TABLE.find((t) => t.name === name)!;

describe("review MCP tools (F25)", () => {
  it("all three are extended tier, not core", () => {
    for (const name of ["review_get", "review_finding_add", "review_finding_resolve"]) {
      expect(EXTENDED_MCP_TOOL_NAMES).toContain(name);
      expect(CORE_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it("review_get with a taskId forwards taskId + agentId when ctx carries one", () => {
    const result = tool("review_get").resolve({ taskId: "t1" }, { agentId: "a1", depth: 0 }) as
      { kind: "rpc"; method: string; params: Record<string, unknown> };
    expect(result.method).toBe("review.get");
    expect(result.params).toEqual({ taskId: "t1", agentId: "a1" });
  });

  it("review_get with no taskId forwards only agentId (engine resolves the binding)", () => {
    const result = tool("review_get").resolve({}, { agentId: "a1", depth: 0 }) as
      { kind: "rpc"; params: Record<string, unknown> };
    expect(result.params).toEqual({ agentId: "a1" });
  });

  it("review_get omits both keys when ctx carries no agentId and no taskId is given", () => {
    const result = tool("review_get").resolve({}, { depth: 0 }) as { kind: "rpc"; params: Record<string, unknown> };
    expect(result.params).toEqual({});
  });

  it("review_finding_add stamps authorAgentId from ctx.agentId", () => {
    const result = tool("review_finding_add").resolve(
      { taskId: "t1", path: "src/x.ts", severity: "blocking", body: "fix this" },
      { agentId: "a1", depth: 0 },
    ) as { kind: "rpc"; method: string; params: Record<string, unknown> };
    expect(result.method).toBe("review.finding.add");
    expect(result.params).toEqual({
      taskId: "t1", path: "src/x.ts", severity: "blocking", body: "fix this", authorAgentId: "a1",
    });
  });

  it("review_finding_add omits authorAgentId when ctx carries no agentId", () => {
    const result = tool("review_finding_add").resolve(
      { taskId: "t1", path: "src/x.ts", severity: "note", body: "nit" },
      { depth: 0 },
    ) as { kind: "rpc"; params: Record<string, unknown> };
    expect("authorAgentId" in result.params).toBe(false);
  });

  it("review_finding_resolve stamps actorAgentId from ctx.agentId", () => {
    const result = tool("review_finding_resolve").resolve(
      { taskId: "t1", findingId: "f1" },
      { agentId: "a1", depth: 0 },
    ) as { kind: "rpc"; method: string; params: Record<string, unknown> };
    expect(result.method).toBe("review.finding.resolve");
    expect(result.params).toEqual({ taskId: "t1", findingId: "f1", actorAgentId: "a1" });
  });

  it("review_finding_resolve omits actorAgentId when ctx carries no agentId (operator call)", () => {
    const result = tool("review_finding_resolve").resolve(
      { taskId: "t1", findingId: "f1" },
      { depth: 0 },
    ) as { kind: "rpc"; params: Record<string, unknown> };
    expect("actorAgentId" in result.params).toBe(false);
  });
});

// F25.QA: the plan (§3) lists this case and it was never written — chimera_call validates
// entry.inputSchema BEFORE resolving, which is the only thing standing between a hallucinated
// severity and a zod error from the daemon.
describe("review tools through chimera_call's schema gate (F25.QA)", () => {
  const call = (args: Record<string, unknown>) =>
    tool("chimera_call").resolve({ tool: "review_finding_add", args }, { agentId: "a1", depth: 0 }) as
      { kind: string; error?: { code: string; message: string } };

  it("rejects a severity outside the enum", () => {
    const result = call({ taskId: "t1", path: "a.ts", severity: "critical", body: "b" });
    expect(result.kind).toBe("error");
    expect(result.error?.code).toBe("protocol");
  });

  it("strips a caller-supplied authorAgentId so identity cannot be spoofed", () => {
    const result = tool("chimera_call").resolve(
      { tool: "review_finding_add", args: { taskId: "t1", path: "a.ts", severity: "note", body: "b", authorAgentId: "someone-else" } },
      { agentId: "a1", depth: 0 },
    ) as { kind: string; params: Record<string, unknown> };
    expect(result.kind).toBe("rpc");
    expect(result.params["authorAgentId"]).toBe("a1");
  });
});

// F25.QA F4: resolvedBy was added after reviews.json could already hold findings on disk —
// the zod default must keep a pre-change record (no `resolvedBy` key at all) parseable.
describe("ReviewFindingSchema resolvedBy backward compatibility (F25.QA)", () => {
  const base = {
    id: "f1", taskId: "t1", path: "a.ts", hunkId: null, parentId: null,
    authorAgentId: "a1", severity: "note" as const, body: "fix", status: "resolved" as const,
    createdAt: 0, updatedAt: 0,
  };

  it("a pre-change record with no resolvedBy key defaults to null", () => {
    const parsed = ReviewFindingSchema.parse(base);
    expect(parsed.resolvedBy).toBeNull();
  });

  it("a post-change record round-trips its resolvedBy value", () => {
    const parsed = ReviewFindingSchema.parse({ ...base, resolvedBy: "a2" });
    expect(parsed.resolvedBy).toBe("a2");
  });
});
