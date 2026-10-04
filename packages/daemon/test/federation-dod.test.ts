import { describe, it, expect } from "vitest";
import { makeFederatedPair, until } from "./fed-rig.js";

describe("federation MVP definition-of-done walk", () => {
  it("DoD 1/2/5/7: handshake visibility, full remote lifecycle, depth guardrail, unreachable-then-reconcile", async () => {
    const pair = await makeFederatedPair({
      scenariosB: [[{ awaitSend: true }, { end: { resultText: "remote finished" } }]],
    });
    // DoD 1 — peer state visible in daemon.status on both sides
    await until(() => (pair.a.engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await until(() => (pair.b.engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    const stA = await pair.a.engine.handle("daemon.status", {}) as { peers: Array<{ state: string }> };
    expect(stA.peers[0]!.state).toBe("connected");

    // DoD 2 — spawn on B from A; status/send/result/kill through the unchanged surface, only addressing differs
    const rec = await pair.a.engine.handle("agent.spawn", {
      spec: { prompt: "lifecycle", cwd: "/tmp", account: "second", isolation: "none" }, engine: "studio",
    }) as { agentId: string };
    expect(pair.b.fake.spawns[0]!.env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-second");   // B-locally resolved credential
    expect(await pair.a.engine.handle("agent.status", { agentId: rec.agentId })).toMatchObject({ state: "running" });
    await pair.a.engine.handle("agent.send", { agentId: rec.agentId, text: "go on", from: "orchestrator" });
    {                                                                       // fake echoes the send then ends
      const t0 = Date.now();
      let state = "";
      while (state !== "done") {
        if (Date.now() - t0 > 8000) throw new Error("timeout waiting for agent.status to reach done");
        const s = await pair.a.engine.handle("agent.status", { agentId: rec.agentId }) as { state: string };
        state = s.state;
        if (state !== "done") await new Promise((r) => setTimeout(r, 15));
      }
    }
    const result = await pair.a.engine.handle("agent.result", { agentId: rec.agentId }) as { text?: string };
    expect(result.text).toBe("remote finished");
    const tail = await pair.a.engine.handle("agent.tail", { agentId: rec.agentId, n: 50 }) as unknown[];
    expect(tail.length).toBeGreaterThan(0);

    // DoD 5 — depth propagates; a chain beyond the local cap is rejected daemon-side with a guardrail error
    await expect(pair.a.engine.handle("agent.spawn", {
      spec: { prompt: "too deep", cwd: "/tmp", account: "main", isolation: "none" },
      engine: "studio", depth: 99,
    })).rejects.toMatchObject({ code: "guardrail" });

    // DoD 7 — link loss: remote agent NOT killed, status degrades to unreachable, reconcile on reconnect
    const rec2 = await pair.a.engine.handle("agent.spawn", {
      spec: { prompt: "survivor", cwd: "/tmp", account: "main", isolation: "none" }, engine: "studio",
    }) as { agentId: string };
    await pair.b.server.close();                                         // partition injection
    await until(() => pair.a.engine.federation!.peersStatus()[0]!.state === "partitioned");
    const stale = await pair.a.engine.handle("agent.status", { agentId: rec2.agentId }) as { state: string; stale?: boolean };
    expect(stale.state).toBe("unreachable");
    expect(stale.stale).toBe(true);
    await pair.b.restartServer();                                        // reconcile
    await until(() => pair.a.engine.federation!.peersStatus()[0]!.state === "connected");
    const fresh = await pair.a.engine.handle("agent.status", { agentId: rec2.agentId }) as { state: string };
    expect(["running", "done"]).toContain(fresh.state);                  // real state again; never "failed" from link loss
    await pair.stop();
  }, 40_000);
});
