import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";
import { EngineIdentity } from "@chimera/core/federation/identity";

describe("chimerad federation boot", () => {
  it("opens federation.sock and reports peers when config defines engine.id", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-boot-"));
    const peerId = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-bootp-")));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"], engine: { id: "mbp" },
      federation: { peers: [{ engineId: "studio", publicKey: peerId.publicKey, socketPath: join(home, "peer-studio.sock") }] },
    }));
    const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
    const client = await ChimeraClient.connect({ home, env });
    const st = await client.request<{ engineId: string; peers: Array<{ engineId: string; state: string }> }>("daemon.status");
    expect(st.engineId).toBe("mbp");
    expect(st.peers[0]).toMatchObject({ engineId: "studio" });          // link exists (state: connecting/partitioned — peer is down)
    expect(existsSync(join(home, "federation.sock"))).toBe(true);       // the peer-protocol listener
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    await client.request("daemon.stop").catch(() => {});
    client.close();
  }, 20_000);
});
