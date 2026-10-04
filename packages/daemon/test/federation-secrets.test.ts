import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFederatedPair, startRecordingProxy, until } from "./fed-rig.js";

describe("federation wire content (MVP DoD #6)", () => {
  it("no credential material crosses the peer link — ever", async () => {
    const pair = await makeFederatedPair({ grantB: { allowSpawn: true, accounts: ["second"] } });
    // interpose the recording proxy on A's route to B: rewrite A's peer socketPath, reboot A's engine-side link
    const proxy = await startRecordingProxy(pair.b.socketPath);
    const cfgPath = join(pair.a.home, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.federation.peers[0].socketPath = proxy.socketPath;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await pair.a.engine.federation!.stop();
    const { Engine } = await import("@chimera/core/engine");
    const { FakeAgentBackend } = await import("@chimera/core/backends/fake");
    const { fakeExec } = await import("../../core/test/helpers.js");
    const engineA = new Engine({
      home: pair.a.home, backends: new Map([["claude", new FakeAgentBackend([])]]),
      exec: fakeExec, fedReconnectBaseMs: 25, fedHeartbeatMs: 200,
    });

    await until(() => engineA.federation!.peersStatus()[0]!.state === "connected");
    // exercise the full MVP surface through the proxy: card, accounts, spawn on "second", status, send, result
    const accounts = await engineA.handle("accounts.list", { engine: "studio" }) as Array<{ name: string }>;
    expect(accounts).toEqual([{ name: "second", provider: "claude" }]);
    const rec = await engineA.handle("agent.spawn", {
      spec: { prompt: "wire check", cwd: "/tmp", account: "second", isolation: "none", deliverTo: "caller1" },
      engine: "studio",
    }) as { agentId: string };
    await until(() => pair.b.fake.spawns.length === 1);
    expect(pair.b.fake.spawns[0]!.env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-second");   // resolved ON B (fakeExec keychain)
    await engineA.handle("agent.status", { agentId: rec.agentId });
    await until(() => engineA.mailboxes.pending("caller1").length === 1);

    // the redaction corpus: everything the rig knows to be secret-shaped
    const transcript = proxy.transcript();
    expect(transcript.length).toBeGreaterThan(0);
    for (const secret of ["tok-second", "find-generic-password", "ANTHROPIC_AUTH_TOKEN=", '"authType"', '"service":"svc"', "injectAs"])
      expect(transcript).not.toContain(secret);
    expect(transcript).toContain('"agent.spawn"');                       // sanity: we really captured the frames

    await engineA.federation!.stop();
    await proxy.close();
    await pair.stop();
  }, 30_000);
});
