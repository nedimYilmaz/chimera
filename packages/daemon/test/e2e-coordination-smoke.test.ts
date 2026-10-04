import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";

// Costs real tokens. Run with: CHIMERA_E2E=1 pnpm vitest run packages/daemon -t "coordination smoke"
describe.skipIf(!process.env.CHIMERA_E2E)("e2e coordination smoke (real Claude backend)", () => {
  it("drains one real queue task through a one-role team", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-e2e-coord-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    }));
    const env = { ...process.env, CHIMERA_HOME: home };      // NO CHIMERA_BACKEND → real ClaudeAgentBackend
    delete (env as Record<string, unknown>)["CHIMERA_BACKEND"];
    const client = await ChimeraClient.connect({ home, env });

    await client.request("queue.create", { spec: { name: "smoke", retryLimit: 0 } });
    await client.request("team.create", { spec: {
      name: "solo",
      roles: { dev: {
        cwd: home, isolation: "none", permissionProfile: "readOnly",
        model: "claude-haiku-4-5-20251001", maxTurns: 2, account: "main",
      } },
      maxConcurrent: 1, queue: "smoke",
    } });
    const task = await client.request<{ taskId: string }>("queue.push", { queue: "smoke", prompt: "Reply with exactly: pong" });

    let final: { state: string; resultText: string | null } | undefined;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const st = await client.request<{ tasks: Array<{ taskId: string; state: string; resultText: string | null }> }>(
        "queue.status", { queue: "smoke" });
      final = st.tasks.find((t) => t.taskId === task.taskId);
      if (final && final.state !== "pending" && final.state !== "in_progress") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(final?.state).toBe("done");
    expect((final?.resultText ?? "").toLowerCase()).toContain("pong");

    await client.request("daemon.stop").catch(() => {});
    client.close();
  }, 180_000);
});
