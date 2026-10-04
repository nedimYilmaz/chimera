import { describe, it, expect } from "vitest";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";
import { RPC_CONTRACT } from "../src/contract.js";
import { MemoryGraphParams, MemoryIndexParams, SliRollupParamsSchema, McpStoreMonitorParams } from "../src/index.js";

const meta = MCP_TOOL_TABLE.find(t => t.name === "chimera_call")!;
const call = (tool: string, args = {}) => meta.resolve({ tool, args }, { depth: 0, agentId: "diagnosing-agent" });

describe("diagnostic MCP contract boundaries", () => {
  it.each([
    ["health_status", {}, RPC_CONTRACT["health.status"].request],
    ["events_search", { query: "capacity", scope: { kinds: ["error"], fromTs: 10 }, limit: 1 }, RPC_CONTRACT["events.search"].request],
    ["events_search_export", { query: "capacity", maxResults: 500 }, RPC_CONTRACT["events.searchExport"].request],
    ["evidence_get", { taskId: "task" }, RPC_CONTRACT["evidence.get"].request],
    ["audit_verify", {}, RPC_CONTRACT["audit.verify"].request],
    ["replay_agents_as_of", { toSeq: 1 }, RPC_CONTRACT["replay.agentsAsOf"].request],
    ["chronicle_status", {}, RPC_CONTRACT["chronicle.status"].request],
    ["sli_rollup", { from: 1, bucketMs: 1000, groupBy: "team" }, SliRollupParamsSchema],
    ["memory_graph", { folder: "incidents", kind: "fact", tags: ["bug"], semanticEdges: true }, MemoryGraphParams],
    ["mcp_store_monitor", {}, McpStoreMonitorParams],
  ] as const)("%s sends parameters accepted by the authoritative RPC schema", (name, args, schema) => {
    const resolved = call(name, args);
    expect(resolved.kind).toBe("rpc");
    if (resolved.kind === "rpc") expect(schema.safeParse(resolved.params).success).toBe(true);
  });

  it("does not expose snapshot prompts, environment or result text", async () => {
    const resolved = call("replay_agents_as_of");
    expect(resolved.kind).toBe("rpc");
    if (resolved.kind !== "rpc" || !resolved.postDispatch) throw new Error("missing diagnostic projection");
    const output = await resolved.postDispatch([{ agentId: "a", state: "paused", crashCount: 3, spec: { prompt: "private", env: { TOKEN: "private" } }, resultText: "private" }], async () => undefined);
    expect(output).toEqual([{ agentId: "a", state: "paused", crashCount: 3 }]);
  });

  it.each(["events_search", "events_search_export"])("%s binds the search to the calling agent, ignoring a forged caller", (name) => {
    const resolved = call(name, { query: "x", callerAgentId: "someone-else" });
    expect(resolved).toMatchObject({ kind: "rpc", params: { callerAgentId: "diagnosing-agent" } });
    const external = meta.resolve({ tool: name, args: { query: "x" } }, { depth: 0 });
    if (external.kind === "rpc") expect(external.params).not.toHaveProperty("callerAgentId");
  });

  it("cannot turn an index status query into a rebuild", () => {
    const resolved = call("memory_index_status", { action: "rebuild" });
    expect(resolved).toEqual({ kind: "rpc", method: "memory.index", params: { action: "status" } });
    if (resolved.kind === "rpc") expect(MemoryIndexParams.parse(resolved.params).action).toBe("status");
  });

  it.each([
    ["events_search", { query: " " }],
    ["events_search", { query: "x", limit: 101 }],
    ["events_search", { query: "x", scope: { fromSeq: -1 } }],
    ["events_search_export", { query: "x", maxResults: 501 }],
    ["sli_rollup", { bucketMs: 0 }],
    ["replay_agents_as_of", { toSeq: 0 }],
  ])("rejects invalid diagnostic request for %s before dispatch", (name, args) => {
    expect(call(name as string, args)).toMatchObject({ kind: "error" });
  });
});
