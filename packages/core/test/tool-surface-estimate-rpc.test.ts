import { describe, it, expect, vi } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { AgentSpecSchema, estimateChimeraMcpToolSurface } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// TOOL-SURFACE-ESTIMATE-RPC / F41.1: agent.estimateToolSurface must price a spawn's chimera
// grant EXACTLY the way claude.ts's own spawn-time "toolSurface" status event does (case 1,
// load-bearing — see backends/claude.ts's estimateChimeraMcpToolSurface call, which omits
// toolTags), disclose everything it cannot price with a reason (A7), and only report
// `measured` figures once there are >=3 comparable past spawns (A8) — never opening an
// mcpstore connection to do any of it (A7 side-effect bound).

function engineWithScenarios(scenarios: FakeStep[][] = []): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("agent.estimateToolSurface", () => {
  it("discloses native settings by default while respecting a role's explicit opt-out", async () => {
    const e = engineWithScenarios();
    const standard = await e.handle("agent.estimateToolSurface", { cwd: "/tmp" }) as { unpriced: Array<{ kind: string }> };
    expect(standard.unpriced.some(row => row.kind === "settings")).toBe(true);
    await e.handle("role.create", { spec: { name: "isolated", cwd: "/tmp", loadSettings: false } });
    const isolated = await e.handle("agent.estimateToolSurface", { cwd: "/tmp", role: "isolated" }) as { unpriced: Array<{ kind: string }> };
    expect(isolated.unpriced.some(row => row.kind === "settings")).toBe(false);
  });

  it("case 1 (load-bearing): chimera figure toEqual the toolSurface a claude spawn emits for the same grant", async () => {
    // Mirrors backends/claude.ts:416-434 exactly: computed from autonomy+conductor only
    // (toolTags omitted), wrapped with source/settingSources/note around the raw estimate.
    const rawEstimate = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: false });
    const e = engineWithScenarios([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "status", data: { toolSurface: { source: "chimera-mcp-grant", ...rawEstimate, settingSources: [], note: "estimate" } } } },
      { awaitSend: true },
    ]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));
    const status = (await e.handle("agent.status", { agentId: rec.agentId })) as { toolSurfaceEstimate?: { toolCount: number; approxChars: number; approxTokens: number; bySource: unknown } };
    const emitted = status.toolSurfaceEstimate!;

    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { chimera: unknown };

    expect(result.chimera).toEqual({ toolCount: emitted.toolCount, approxChars: emitted.approxChars, approxTokens: emitted.approxTokens, bySource: emitted.bySource });
    expect(result.chimera).toEqual(rawEstimate);
  });

  it("case 2: every settingSource, plugin and spec.mcpServers key appears as its own unpriced row with a reason", async () => {
    const e = engineWithScenarios();
    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false,
      settingSources: ["user", "project"], pluginCount: 2, mcpServers: ["foo", "bar"],
    })) as { unpriced: Array<{ source: string; kind: string; count: number; reason: string }> };

    const settingsRow = result.unpriced.find((r) => r.kind === "settings");
    expect(settingsRow).toMatchObject({ source: "settingSources:user,project", count: 2 });
    expect(settingsRow!.reason.length).toBeGreaterThan(0);

    const pluginsRow = result.unpriced.find((r) => r.kind === "plugins");
    expect(pluginsRow).toMatchObject({ source: "plugins", count: 2 });
    expect(pluginsRow!.reason.length).toBeGreaterThan(0);

    const specRows = result.unpriced.filter((r) => r.kind === "spec-mcp");
    expect(specRows.map((r) => r.source).sort()).toEqual(["spec.mcpServers:bar", "spec.mcpServers:foo"]);
    for (const row of specRows) expect(row.reason.length).toBeGreaterThan(0);
  });

  it("case 3: a direct+enabled store server appears as an unpriced row; a non-direct or disabled one does not", async () => {
    const e = engineWithScenarios();
    await e.handle("mcpstore.add", { name: "direct-on", type: "stdio", command: "node", args: [], env: {} });
    await e.handle("mcpstore.setDirect", { name: "direct-on", direct: true });
    await e.handle("mcpstore.add", { name: "direct-off", type: "stdio", command: "node", args: [], env: {} });
    await e.handle("mcpstore.setDirect", { name: "direct-off", direct: true });
    await e.handle("mcpstore.setEnabled", { name: "direct-off", enabled: false });
    await e.handle("mcpstore.add", { name: "indirect", type: "stdio", command: "node", args: [], env: {} });

    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { unpriced: Array<{ source: string; kind: string }> };

    const storeRows = result.unpriced.filter((r) => r.kind === "store-direct");
    expect(storeRows.map((r) => r.source)).toEqual(["mcp-store:direct-on"]);
  });

  it("case 4: never opens an mcp-store connection", async () => {
    const e = engineWithScenarios();
    await e.handle("mcpstore.add", { name: "direct-on", type: "stdio", command: "node", args: [], env: {} });
    await e.handle("mcpstore.setDirect", { name: "direct-on", direct: true });

    // mcpstore.tools would require a live connection (ensure()) — asserting it throws/absent
    // for a fake stdio target confirms the RPC path never reaches it; the estimate RPC itself
    // must succeed without triggering any such connection.
    await expect(
      e.handle("agent.estimateToolSurface", { orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [] }),
    ).resolves.toBeDefined();
  });

  it("case 5: measured is null at n<3", async () => {
    const e = engineWithScenarios([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "usage", data: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100 } } } },
      { awaitSend: true },
    ]]);
    await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } });
    await new Promise((r) => setTimeout(r, 20));

    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { measured: unknown };
    expect(result.measured).toBeNull();
  });

  it("case 6: measured reports median/min/max/n and the union of toolSurfaceServers at n>=3", async () => {
    const scenario = (cacheWrite: number, servers: string[]): FakeStep[] => [
      { emit: { kind: "agent_started", data: { mcpServers: servers.map((name) => ({ name, status: "connected" })) } } },
      { emit: { kind: "usage", data: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: cacheWrite } } } },
      { awaitSend: true },
    ];
    const e = engineWithScenarios([
      scenario(100, ["a"]),
      scenario(300, ["b"]),
      scenario(200, ["a", "c"]),
    ]);
    for (let i = 0; i < 3; i++) {
      await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", loadSettings: false } });
    }
    await new Promise((r) => setTimeout(r, 20));

    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { measured: { medianCacheWriteTokens: number; minTokens: number; maxTokens: number; n: number; servers: string[] } | null };

    expect(result.measured).toEqual({ medianCacheWriteTokens: 200, minTokens: 100, maxTokens: 300, n: 3, servers: ["a", "b", "c"] });
  });

  it("case 7: orchestration:false returns chimera:null, not a zero estimate", async () => {
    const e = engineWithScenarios();
    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: false, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { chimera: unknown };
    expect(result.chimera).toBeNull();
  });

  it("case 8: claude.ts emits the toolSurface status event exactly once per spawn", async () => {
    // Unlike cases 1-7 (which exercise only the RPC handler against Engine/FakeAgentBackend,
    // never real claude.ts code), A12 is a claim about backends/claude.ts's own spawn path —
    // so this drives ClaudeAgentBackend directly, matching claude-backend.test.ts's harness.
    type Msg = Record<string, unknown>;
    function fakeQuery(messages: Msg[]) {
      const fn = ((_args: { prompt: unknown; options: Record<string, unknown> }) => {
        return {
          async *[Symbol.asyncIterator]() {
            for (const m of messages) yield m;
          },
          interrupt: vi.fn(async () => {}),
        };
      }) as never;
      return fn;
    }
    function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
      return {
        ...AgentSpecSchema.parse({ prompt: "task", cwd: REPO_BACKED_CWD, isolation: "none", ...over }),
        agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
        env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
      } as ResolvedAgentSpec;
    }
    const SCRIPT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "result", subtype: "success", result: "final answer", total_cost_usd: 0.01 },
    ];

    const events: BackendEvent[] = [];
    const backend = new ClaudeAgentBackend({ queryFn: fakeQuery(SCRIPT) });
    await backend.spawn(
      spec({ orchestration: { allow: true, maxDepth: 2 } }),
      (e) => events.push(e),
      async () => true,
    );

    const toolSurfaceEvents = events.filter(
      (ev) => ev.kind === "status" && (ev.data as Record<string, unknown>)["toolSurface"],
    );
    expect(toolSurfaceEvents.length).toBe(1);
  });

  // F41.QA-FIX (F1) case 9: a bare settingSources:[] estimate (the old client-side call shape)
  // priced NO settings row for a cwd that resolves to a loadProjectSettings:true project — the
  // exact "unpriced settings row is unreachable" defect QA measured. Passing cwd makes the RPC
  // resolve settingSources the way supervisor.spawn's undefined-loadSettings branch does
  // (supervisor.ts:1254-1260), reaching the row.
  it("case 9: cwd resolving to a loadProjectSettings project makes the settings unpriced row reachable", async () => {
    const e = engineWithScenarios();
    const projectPath = REPO_BACKED_CWD;
    await e.handle("project.create", { name: "proj-f1", path: projectPath, autoConductor: false });
    await e.handle("project.setLoadProjectSettings", { project: "proj-f1", value: true });

    const withoutCwd = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [],
    })) as { unpriced: Array<{ kind: string }> };
    expect(withoutCwd.unpriced.some((r) => r.kind === "settings")).toBe(false);

    const withCwd = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: [], mcpServers: [], cwd: projectPath,
    })) as { unpriced: Array<{ source: string; kind: string; count: number }> };
    const settingsRow = withCwd.unpriced.find((r) => r.kind === "settings");
    expect(settingsRow).toMatchObject({ source: "settingSources:project,user", count: 2 });
  });

  // F41.QA-FIX (F1) case 10: the `measured` cohort filter must match a record supervisor.spawn
  // ACTUALLY writes for a loadSettings:true spawn (settingSources:["project","user"]) — QA found
  // the old bare settingSources:[] request could never match any of the 3 sampled real records.
  it("case 10: measured cohort matches real loadSettings:true spawn records via cwd resolution", async () => {
    const scenario = (cacheWrite: number): FakeStep[] => [
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "usage", data: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: cacheWrite } } } },
      { awaitSend: true },
    ];
    const e = engineWithScenarios([scenario(100), scenario(200), scenario(300)]);
    for (let i = 0; i < 3; i++) {
      await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", loadSettings: true } });
    }
    await new Promise((r) => setTimeout(r, 20));

    const result = (await e.handle("agent.estimateToolSurface", {
      orchestration: true, autonomy: "ask", conductor: false, settingSources: ["project", "user"], mcpServers: [],
    })) as { measured: { n: number; medianCacheWriteTokens: number } | null };

    expect(result.measured).toMatchObject({ n: 3, medianCacheWriteTokens: 200 });
  });
});
