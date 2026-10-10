import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// REMOTE-CONTROL: agent.remoteControl RPC — routes to supervisor.remoteControl.

function engineWithScenarios(scenarios: FakeStep[][], remoteControlSupported = true): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios, "claude", remoteControlSupported)]]),
  });
}

describe("Engine.handle agent.remoteControl", () => {
  it("validates and routes desktop pairing without exposing it as a model tool", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.remotePair", {})).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("agent.remotePair", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    const { MCP_TOOL_NAMES } = await import("@chimera/protocol/mcp-tools");
    expect(MCP_TOOL_NAMES).not.toContain("agent_remote_pair");
  });
  it("enables and returns the RemoteControlStatus", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-1" } } }, { awaitSend: true }],
    ]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));

    const status = (await e.handle("agent.remoteControl", { agentId: rec.agentId, enable: true })) as
      { agentId: string; enabled: boolean; sessionUrl?: string };

    expect(status.agentId).toBe(rec.agentId);
    expect(status.enabled).toBe(true);
    expect(status.sessionUrl).toBeDefined();
  });

  it("accepts an explicit name param", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }],
    ]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));

    const status = (await e.handle("agent.remoteControl", { agentId: rec.agentId, enable: true, name: "custom" })) as { name?: string };
    expect(status.name).toBe("custom");
  });

  it("rejects an unknown agentId with a protocol-coded error", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.remoteControl", { agentId: "ghost", enable: true }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects malformed params (missing enable) with a protocol-coded error", async () => {
    const e = engineWithScenarios([[{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await expect(e.handle("agent.remoteControl", { agentId: rec.agentId }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a provider whose handle has no remoteControl() with a protocol-coded error", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }],
    ], false);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));

    await expect(e.handle("agent.remoteControl", { agentId: rec.agentId, enable: true }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
