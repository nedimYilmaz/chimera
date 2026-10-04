import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import type { ExecFn } from "@chimera/core/credentials";
import { makeEngineHome, fakeExec } from "./helpers.js";
import { makeFedHome, makeIdentity } from "./fed-helpers.js";

// WD Stage 2 (coverage B14): the host.tools / host.setPolicy RPC surface on a real
// Engine — the injected hostExec seam, policy decoration, toolpolicy.json overlay
// persistence, LIVE enforcement through the engine's own supervisor seam, and the
// additive peer.status hostTools summary (cached-scan-only: a peer can never
// trigger local process execution).

// two installed tools, one with contexts — everything else "missing"
const hostExec: ExecFn = async (cmd, args) => {
  if (cmd === "kubectl" && args[0] === "version") return { stdout: "Client Version: v1.30.2", code: 0 };
  if (cmd === "kubectl" && args[0] === "config") return { stdout: "prod\nstaging\n", code: 0 };
  if (cmd === "node") return { stdout: "v24.1.0", code: 0 };
  return { stdout: "", code: 1 };
};

type HostTools = { host: string; tools: Array<{ tool: string; version: string; profiles: string[]; policy: Record<string, string> }> };

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]), hostExec });
}

describe("host.tools / host.setPolicy RPCs", () => {
  it("host.tools returns {host, tools} with versions, profiles, and a per-tool policy map", async () => {
    const st = (await engineOn(makeEngineHome()).handle("host.tools", {})) as HostTools;
    expect(st.host).toBe("local");
    expect(st.tools).toEqual([
      { tool: "kubectl", version: "1.30.2", profiles: ["prod", "staging"], policy: {} },
      { tool: "node", version: "24.1.0", profiles: [], policy: {} },
    ]);
  });

  it("config.json's toolPolicy field decorates the rows; host.setPolicy overlays it and persists across restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-home-pol-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      toolPolicy: { kubectl: { "*": "ask" } },
    }));
    const e = engineOn(home);
    let st = (await e.handle("host.tools", {})) as HostTools;
    expect(st.tools.find((t) => t.tool === "kubectl")?.policy).toEqual({ "*": "ask" });

    expect(await e.handle("host.setPolicy", { tool: "kubectl", profile: "prod", mode: "deny" }))
      .toEqual({ tool: "kubectl", policy: { "*": "ask", prod: "deny" } });
    st = (await e.handle("host.tools", {})) as HostTools;
    expect(st.tools.find((t) => t.tool === "kubectl")?.policy).toEqual({ "*": "ask", prod: "deny" });

    // restart on the same home → the overlay (toolpolicy.json) still applies
    const st2 = (await engineOn(home).handle("host.tools", {})) as HostTools;
    expect(st2.tools.find((t) => t.tool === "kubectl")?.policy).toEqual({ "*": "ask", prod: "deny" });
  });

  it("host.setPolicy validates the mode enum", async () => {
    await expect(engineOn(makeEngineHome()).handle("host.setPolicy", { tool: "kubectl", profile: "*", mode: "maybe" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("a host.setPolicy deny gates the very NEXT Bash call through the engine's live supervisor seam", async () => {
    const e = engineOn(makeEngineHome(), [[
      { askPermission: { toolName: "Bash", input: { command: "kubectl --context prod delete ns x" } } },
      { end: { resultText: "d" } },
    ]]);
    await e.handle("host.setPolicy", { tool: "kubectl", profile: "prod", mode: "deny" });
    const rec = (await e.handle("agent.spawn", {
      spec: { prompt: "x", cwd: "/tmp", isolation: "none", permissionProfile: "full" },
    })) as AgentRecord;
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });
    const tail = (await e.handle("agent.tail", { agentId: rec.agentId, n: 50 })) as Array<{ kind: string; data: Record<string, unknown> }>;
    const denied = tail.find((ev) => ev.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: "kubectl", profile: "prod", command: "kubectl --context prod delete ns x" });
    expect(tail.filter((ev) => ev.kind === "tool_call")).toHaveLength(0);
  });
});

describe("peer.status hostTools summary (additive, coverage B14)", () => {
  const PEER = { engineId: "mbp", publicKey: makeIdentity().identity.publicKey, socketPath: "/tmp/unused.sock" };

  function fedEngine() {
    const home = makeFedHome({ id: "studio", peers: [PEER] });
    return new Engine({
      home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
      exec: fakeExec, hostExec,
    });
  }

  it("is null before any local scan — peer.status NEVER triggers probes remotely", async () => {
    const engine = fedEngine();
    const st = (await engine.handlePeer("mbp", "peer.status", {})) as { hostTools: unknown };
    expect(st.hostTools).toBeNull();
  });

  it("carries the cached scan (with the EXECUTING engine's own policy) once host.tools has run locally", async () => {
    const engine = fedEngine();
    await engine.handle("host.setPolicy", { tool: "kubectl", profile: "prod", mode: "deny" });
    await engine.handle("host.tools", {});                    // the local scan peers may now see
    const st = (await engine.handlePeer("mbp", "peer.status", {})) as { engineId: string; hostTools: HostTools };
    expect(st.engineId).toBe("studio");
    expect(st.hostTools.host).toBe("studio");
    expect(st.hostTools.tools.find((t) => t.tool === "kubectl")).toEqual({
      tool: "kubectl", version: "1.30.2", profiles: ["prod", "staging"], policy: { prod: "deny" },
    });
  });
});
