import { describe, it, expect } from "vitest";
import { ChimeraClient } from "@chimera/client";

// Costs real tokens AND needs a live paired peer. Preflight (synthesis §5.5): same release on both machines,
// SSH tunnel up (or supervised via peers[].ssh), provider logins native on the peer, repo paths peer-local.
// Run with: CHIMERA_E2E_FED=1 CHIMERA_FED_PEER=<engineId> pnpm vitest run packages/daemon -t "fed smoke"
describe.skipIf(!process.env.CHIMERA_E2E_FED)("e2e fed smoke (real peer engine)", () => {
  it("round-trips one real spawn on the peer and gets the result back", async () => {
    const peer = process.env.CHIMERA_FED_PEER;
    expect(peer, "set CHIMERA_FED_PEER=<engineId>").toBeTruthy();
    const client = await ChimeraClient.connect();                        // operator's real CHIMERA_HOME + config
    const st = await client.request<{ peers: Array<{ engineId: string; state: string }> }>("daemon.status");
    expect(st.peers.find((p) => p.engineId === peer)?.state).toBe("connected");

    const accounts = await client.request<Array<{ name: string }>>("accounts.list", { engine: peer });
    expect(accounts.length).toBeGreaterThan(0);

    const rec = await client.request<{ agentId: string }>("agent.spawn", {
      spec: { prompt: "Reply with exactly: fed-pong", cwd: "/tmp", isolation: "none",
              permissionProfile: "readOnly", model: "claude-haiku-4-5-20251001", maxTurns: 2 },
      engine: peer,
    });
    expect(rec.agentId.startsWith(`${peer}/`)).toBe(true);
    const t0 = Date.now();
    let state = "running"; let text = "";
    while (state === "running" && Date.now() - t0 < 120_000) {           // agent.wait is not federated: poll (by design)
      await new Promise((r) => setTimeout(r, 2000));
      const s = await client.request<{ state: string; resultText?: string }>("agent.status", { agentId: rec.agentId });
      state = s.state; text = s.resultText ?? "";
    }
    expect(state).toBe("done");
    expect(text.toLowerCase()).toContain("fed-pong");
    client.close();
  }, 180_000);
});
