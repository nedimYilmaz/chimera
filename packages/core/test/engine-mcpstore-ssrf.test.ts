import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpStoreEntry } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// SSRF through the engine's REAL discovery path: no `mcpStoreDetectAuth` stub, so mcpstore.add /
// mcpstore.detectAuth run the production detector -> production guard -> production transport
// against a live loopback listener. A hit counter on that listener is the proof the daemon never
// reached it; the entry must still be stored (disabled + untrusted) because a blocked probe is
// merely inconclusive.
vi.setConfig({ testTimeout: 15_000 });

async function withLoopbackListener<T>(run: (port: number, hits: () => number) => Promise<T>): Promise<T> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ resource: "http://x/mcp", authorization_servers: ["http://127.0.0.1"] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run((server.address() as AddressInfo).port, () => hits);
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  }
}

function realDetectorEngine() {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

describe("mcpstore discovery never reaches a private destination (production detector, no stub)", () => {
  it("add of a loopback http proposal stores it disabled/untrusted without contacting the listener", async () => {
    await withLoopbackListener(async (port, hits) => {
      const engine = realDetectorEngine();
      const added = await engine.handle("mcpstore.add", {
        name: "proposal", type: "http", url: `http://127.0.0.1:${port}/mcp`, enabled: false, trust: "untrusted",
      }) as McpStoreEntry & { enabled?: boolean; trust?: string; auth?: { kind: string } };
      expect(added).toMatchObject({ name: "proposal", type: "http", enabled: false, trust: "untrusted" });
      expect(added.auth).toBeUndefined();
      expect(engine.mcpStore.list().map((e) => e.name)).toEqual(["proposal"]);
      expect(hits()).toBe(0);
    });
  });

  it("detectAuth by url on a loopback / link-local / mapped literal is inconclusive and silent", async () => {
    await withLoopbackListener(async (port, hits) => {
      const engine = realDetectorEngine();
      for (const url of [
        `http://127.0.0.1:${port}/mcp`, `http://[::ffff:127.0.0.1]:${port}/mcp`, `http://[::1]:${port}/mcp`,
        "http://169.254.169.254/latest/meta-data/",
      ]) {
        await expect(engine.handle("mcpstore.detectAuth", { url })).resolves.toEqual({ oauth: false });
      }
      expect(hits()).toBe(0);
    });
  });

  it("detectAuth by name on an already-stored loopback entry is equally inert", async () => {
    await withLoopbackListener(async (port, hits) => {
      const engine = realDetectorEngine();
      await engine.handle("mcpstore.add", { name: "lan", type: "http", url: `http://127.0.0.1:${port}/mcp`, enabled: false, trust: "untrusted" });
      await expect(engine.handle("mcpstore.detectAuth", { name: "lan" })).resolves.toEqual({ oauth: false });
      expect(hits()).toBe(0);
    });
  });
});
