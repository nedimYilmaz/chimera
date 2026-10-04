import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";

// Costs real tokens. Run with: CHIMERA_E2E=1 pnpm vitest run packages/daemon -t smoke
describe.skipIf(!process.env.CHIMERA_E2E)("e2e smoke (real Claude backend)", () => {
  it("spawns one real agent per configured account and gets a result", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-e2e-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    }));
    const env = { ...process.env, CHIMERA_HOME: home };   // NO CHIMERA_BACKEND → real ClaudeAgentBackend
    delete (env as Record<string, unknown>)["CHIMERA_BACKEND"];
    const client = await ChimeraClient.connect({ home, env });
    const rec = await client.request<{ agentId: string }>("agent.spawn", {
      spec: {
        prompt: "Reply with exactly: pong", cwd: home, isolation: "none",
        permissionProfile: "readOnly", model: "claude-haiku-4-5-20251001", maxTurns: 2,
      },
    });
    const final = await client.request<{ state: string; resultText: string; costUsd: number }>(
      "agent.wait", { agentId: rec.agentId, timeoutMs: 120_000 });
    expect(final.state).toBe("done");
    expect(final.resultText.toLowerCase()).toContain("pong");
    expect(final.costUsd).toBeGreaterThan(0);
    await client.request("daemon.stop").catch(() => {});
    client.close();
  }, 180_000);
});
