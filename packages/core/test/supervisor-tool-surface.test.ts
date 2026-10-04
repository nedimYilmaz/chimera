import { describe, it, expect } from "vitest";
import { makeSupervisor } from "./helpers.js";

// TOOL-SURFACE-MEASURE: mirrors supervisor-turnbudget.test.ts's contract shape — a backend
// `status` event carrying a `toolSurface` estimate, and a `usage` event carrying a real
// cache-write figure, must both flag the AgentRecord (surfaced on agent.list/agent.status)
// without touching state/lifecycle. See core/src/supervisor.ts onEvent and
// packages/protocol/src/mcp-tools.ts's estimateChimeraMcpToolSurface doc comments.

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("AgentSupervisor tool-surface measurement (TOOL-SURFACE-MEASURE)", () => {
  it("a status event carrying toolSurface flags the record and rides agent.list", async () => {
    const estimate = { source: "chimera-mcp-core-tier", toolCount: 22, approxChars: 14836, approxTokens: 3709, settingSources: [], note: "estimate" };
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "status", data: { toolSurface: estimate } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    const st = sup.status(rec.agentId);
    expect(st.state).toBe("running");
    expect(st.toolSurfaceEstimate).toEqual(estimate);
    expect(sup.list().find((a) => a.agentId === rec.agentId)?.toolSurfaceEstimate).toEqual(estimate);
  });

  it("the first usage event's cache-creation figure is captured as toolSurfaceCacheWriteTokens, later ones do not overwrite it", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "usage", data: { usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 46_558 } } } },
      { emit: { kind: "usage", data: { usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 500 } } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    expect(sup.status(rec.agentId).toolSurfaceCacheWriteTokens).toBe(46_558);
  });

  it("never sets either field absent an explicit status/usage event carrying them", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    const st = sup.status(rec.agentId);
    expect(st.toolSurfaceEstimate).toBeUndefined();
    expect(st.toolSurfaceCacheWriteTokens).toBeUndefined();
  });

  it("agent_started's mcpServers become toolSurfaceServers, names only, sorted and deduped, and ride agent.list (A9)", async () => {
    const { sup } = makeSupervisor([[
      {
        emit: {
          kind: "agent_started",
          data: {
            mcpServers: [
              { name: "chimera", status: "connected" },
              { name: "", status: "connected" },
              { name: "chimera", status: "connected" },
              { name: "beta", status: "connected" },
            ],
          },
        },
      },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    const st = sup.status(rec.agentId);
    expect(st.toolSurfaceServers).toEqual(["beta", "chimera"]);
    expect(sup.list().find((a) => a.agentId === rec.agentId)?.toolSurfaceServers).toEqual(["beta", "chimera"]);
  });

  it("a second agent_started does not overwrite the first toolSurfaceServers (first-write-wins) (A9)", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { mcpServers: [{ name: "alpha", status: "connected" }] } } },
      { emit: { kind: "agent_started", data: { mcpServers: [{ name: "zeta", status: "connected" }] } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "job", cwd: "/tmp/proj", isolation: "none" });
    await settle();
    expect(sup.status(rec.agentId).toolSurfaceServers).toEqual(["alpha"]);
  });
});
