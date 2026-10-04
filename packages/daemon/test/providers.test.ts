import { describe, it, expect, afterAll } from "vitest";
import { ChimeraClient } from "@chimera/client";
import { makeMultiProviderHome } from "../../core/test/helpers.js";

const home = makeMultiProviderHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimerad multi-provider registration", () => {
  it("spawns claude and codex agents from one daemon (fake backends per provider)", async () => {
    const client = await ChimeraClient.connect({ home, env });

    const cl = await client.request<{ agentId: string }>("agent.spawn",
      { spec: { prompt: "hi claude", cwd: "/tmp", isolation: "none" } });
    const cx = await client.request<{ agentId: string }>("agent.spawn",
      { spec: { prompt: "hi codex", cwd: "/tmp", isolation: "none", provider: "codex" } });

    const clFinal = await client.request<{ state: string; resultText: string; provider: string }>(
      "agent.wait", { agentId: cl.agentId, timeoutMs: 5000 });
    const cxFinal = await client.request<{ state: string; resultText: string; provider: string; accountName: string }>(
      "agent.wait", { agentId: cx.agentId, timeoutMs: 5000 });

    expect(clFinal.state).toBe("done");
    expect(clFinal.provider).toBe("claude");
    expect(clFinal.resultText).toBe("fake:hi claude");
    expect(cxFinal.state).toBe("done");
    expect(cxFinal.provider).toBe("codex");
    expect(cxFinal.accountName).toBe("cx");
    expect(cxFinal.resultText).toBe("fake:hi codex");
    client.close();
  }, 20_000);
});
