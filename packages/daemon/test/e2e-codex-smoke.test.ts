import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";

// Costs real tokens. Auth (verified): the codex CLI does NOT read OPENAI_API_KEY from the
// environment at runtime — an exported OPENAI_API_KEY only works because smokeAuth() below routes
// it through an env-type account into CodexOptions.apiKey (the SDK injects it as CODEX_API_KEY on
// the spawned CLI). Without OPENAI_API_KEY exported, a codex login (~/.codex/auth.json) is required.
// Run with: CHIMERA_E2E_CODEX=1 pnpm vitest run packages/daemon -t "codex smoke"
const smokeAuth = () =>
  process.env.OPENAI_API_KEY
    ? { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" }
    : { type: "subscription" };

function smokeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-e2e-cx-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "codex", provider: "codex", auth: smokeAuth() }],
    autoOrder: ["codex"],
  }));
  return home;
}

async function connectReal(home: string): Promise<ChimeraClient> {
  const env = { ...process.env, CHIMERA_HOME: home };   // NO CHIMERA_BACKEND → real CodexAgentBackend
  delete (env as Record<string, unknown>)["CHIMERA_BACKEND"];
  return ChimeraClient.connect({ home, env });
}

describe.skipIf(!process.env.CHIMERA_E2E_CODEX)("e2e codex smoke (real Codex backend)", () => {
  it("spawns one real codex agent and gets a result with token usage", async () => {
    const home = smokeHome();
    const client = await connectReal(home);
    try {
      const rec = await client.request<{ agentId: string }>("agent.spawn", {
        spec: {
          prompt: "Reply with exactly: pong", cwd: home, isolation: "none",
          provider: "codex", permissionProfile: "readOnly", maxTurns: 2,
        },
      });
      const final = await client.request<{ state: string; resultText: string; costUsd: number }>(
        "agent.wait", { agentId: rec.agentId, timeoutMs: 180_000 });
      expect(final.state).toBe("done");
      expect(final.resultText.toLowerCase()).toContain("pong");
      expect(final.costUsd).toBe(0);                        // codex reports tokens, not USD (see Architecture)
      const events = await client.request<Array<{ kind: string; data: Record<string, unknown> }>>(
        "agent.tail", { agentId: rec.agentId, n: 100 });
      const turn = events.find((e) => e.kind === "turn_complete" && e.data["usage"] !== undefined);
      expect((turn?.data["usage"] as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    } finally {
      // A failed assertion must never orphan a detached real-credential chimerad (mirrors providers.test.ts).
      await client.request("daemon.stop").catch(() => {});
      client.close();
    }
  }, 240_000);

  it("self-orchestrates through the injected chimera MCP (config→TOML flattening, real mode)", async () => {
    // The CodexOptions.config.mcp_servers → --config TOML flattening of command/args/env maps is the
    // single riskiest never-executed-by-fakes path in this phase; this test makes DoD 4's
    // self-orchestration claim measurable against the real CLI (PM decision, resolved).
    const home = smokeHome();
    const client = await connectReal(home);
    try {
      const rec = await client.request<{ agentId: string }>("agent.spawn", {
        spec: {
          prompt: "Call the chimera MCP tool accounts_list and reply with the first account name.",
          cwd: home, isolation: "none", provider: "codex", permissionProfile: "readOnly",
          maxTurns: 4, orchestration: { allow: true, maxDepth: 1 },
        },
      });
      const final = await client.request<{ state: string }>(
        "agent.wait", { agentId: rec.agentId, timeoutMs: 180_000 });
      expect(final.state).toBe("done");
      const events = await client.request<Array<{ kind: string; data: Record<string, unknown> }>>(
        "agent.tail", { agentId: rec.agentId, n: 200 });
      expect(events.some((e) =>
        e.kind === "tool_call" && String(e.data["toolName"] ?? "").startsWith("mcp:chimera/"),
      )).toBe(true);                                    // the codex agent really reached chimera's own MCP
    } finally {
      await client.request("daemon.stop").catch(() => {});
      client.close();
    }
  }, 300_000);
});
