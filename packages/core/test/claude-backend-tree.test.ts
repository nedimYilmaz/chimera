import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";

function fakeQuery() {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return { async *[Symbol.asyncIterator]() {}, interrupt: vi.fn(async () => {}) };
  }) as never;
  return { fn, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("ClaudeAgentBackend tree env", () => {
  it("forwards CHIMERA_TREE_ID into the chimera MCP grant", async () => {
    const { fn, calls } = fakeQuery();
    const spec = {
      ...AgentSpecSchema.parse({ prompt: "t", cwd: "/tmp/repo", isolation: "none", orchestration: { allow: true, maxDepth: 2 } }),
      agentId: "ag-9", accountName: "main", resolvedProvider: "claude",
      env: { CHIMERA_AGENT_ID: "ag-9", CHIMERA_DEPTH: "1", CHIMERA_TREE_ID: "tree-root" }, depth: 1,
    } as ResolvedAgentSpec;
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec, () => {}, async () => true);
    await settle();
    const servers = calls[0]!.options.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(servers["chimera"]).toBeDefined();
    expect(servers["chimera"]!.env?.["CHIMERA_TREE_ID"]).toBe("tree-root");
    expect(servers["chimera"]!.env?.["CHIMERA_DEPTH"]).toBe("1");
    expect(servers["chimera"]!.env?.["CHIMERA_MAX_DEPTH"]).toBe("2");   // Phase 1 grant contract stays intact
    expect(servers["chimera"]!.env?.["CHIMERA_HOME"]).toBeTruthy();     // NEVER "" (Phase 1 chimeraHome() fallback)
  });
});
