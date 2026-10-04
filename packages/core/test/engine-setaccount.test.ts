import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";

// ACCOUNT-SWITCH-LIVE: agent.setAccount RPC — routes to supervisor.setAccount. Needs TWO
// same-provider accounts (unlike makeEngineHome's single-account config) so a real switch
// has somewhere to land.
function makeTwoAccountHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      { name: "second", provider: "claude", auth: { type: "subscription" } },
    ],
    autoOrder: ["main", "second"],
  }));
  return home;
}

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeTwoAccountHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine.handle agent.setAccount", () => {
  it("routes to supervisor.setAccount and returns the respawned record", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-1" } } }, { awaitSend: true }],
      [{ awaitSend: true }],
    ]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", account: "main" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle

    const updated = (await e.handle("agent.setAccount", { agentId: rec.agentId, account: "second" })) as { agentId: string; accountName: string };

    expect(updated.agentId).toBe(rec.agentId);
    expect(updated.accountName).toBe("second");
  });

  it("rejects an unknown agentId with a protocol-coded error", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.setAccount", { agentId: "ghost", account: "second" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects malformed params (missing account) with a protocol-coded error", async () => {
    const e = engineWithScenarios([[{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", account: "main" } })) as { agentId: string };
    await expect(e.handle("agent.setAccount", { agentId: rec.agentId }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("routes cross-provider account/model switching without reusing the native session", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [
        { name: "cl-main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx-main", provider: "codex", auth: { type: "subscription" } },
      ],
      autoOrder: ["cl-main", "cx-main"],
    }));
    const e = new Engine({
      home,
      backends: new Map<string, AgentBackend>([
        ["claude", new FakeAgentBackend([[{ emit: { kind: "agent_started", data: { sessionId: "sess-1" } } }, { awaitSend: true }]])],
        ["codex", new FakeAgentBackend([], "codex")],
      ]),
    });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", account: "cl-main" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));

    await expect(e.handle("agent.setAccount", { agentId: rec.agentId, account: "cx-main", model: "gpt-6-astra" }))
      .resolves.toMatchObject({ agentId: rec.agentId, accountName: "cx-main", provider: "codex", spec: { model: "gpt-6-astra", resume: null } });
  });
});
