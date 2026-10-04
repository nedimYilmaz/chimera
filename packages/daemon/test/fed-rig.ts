import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection, type Server } from "node:net";
import { Engine } from "@chimera/core/engine";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { startFederationServer } from "@chimera/daemon/federation";
import { fakeExec } from "../../core/test/helpers.js";

export type FedNode = {
  home: string; engineId: string; engine: Engine; fake: FakeAgentBackend;
  server: { close(): Promise<void> }; socketPath: string;
  restartServer(): Promise<void>;
};

/** Two engines, one process, zero tokens, zero SSH: A("mbp") <-> B("studio"), mutually granted. */
export async function makeFederatedPair(opts: {
  scenariosA?: FakeStep[][]; scenariosB?: FakeStep[][];
  grantB?: Partial<{ allowSpawn: boolean; accounts: string[] | "auto"; maxConcurrent: number }>;
} = {}): Promise<{ a: FedNode; b: FedNode; stop(): Promise<void> }> {
  const homeA = mkdtempSync(join(tmpdir(), "chimera-fedA-"));
  const homeB = mkdtempSync(join(tmpdir(), "chimera-fedB-"));
  const idA = EngineIdentity.loadOrCreate(homeA);
  const idB = EngineIdentity.loadOrCreate(homeB);
  const sockA = join(homeA, "federation.sock");
  const sockB = join(homeB, "federation.sock");
  const accounts = [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ];
  writeFileSync(join(homeA, "config.json"), JSON.stringify({
    accounts, autoOrder: ["main"], engine: { id: "mbp" },
    federation: { peers: [{ engineId: "studio", publicKey: idB.publicKey, socketPath: sockB, allowSpawn: true, accounts: "auto" }] },
  }));
  writeFileSync(join(homeB, "config.json"), JSON.stringify({
    accounts, autoOrder: ["main"], engine: { id: "studio" },
    federation: { peers: [{ engineId: "mbp", publicKey: idA.publicKey, socketPath: sockA,
      allowSpawn: opts.grantB?.allowSpawn ?? true, accounts: opts.grantB?.accounts ?? "auto",
      maxConcurrent: opts.grantB?.maxConcurrent ?? 4 }] },
  }));

  const node = async (home: string, engineId: string, socketPath: string, scenarios: FakeStep[][]): Promise<FedNode> => {
    const fake = new FakeAgentBackend(scenarios);
    const engine = new Engine({
      home, backends: new Map<string, AgentBackend>([["claude", fake]]),
      exec: fakeExec, fedReconnectBaseMs: 25, fedHeartbeatMs: 200,
    });
    const identity = EngineIdentity.loadOrCreate(home);
    let server = await startFederationServer({ socketPath, engine, identity });
    return {
      home, engineId, engine, fake, socketPath,
      get server() { return server; },
      restartServer: async () => { server = await startFederationServer({ socketPath, engine, identity }); },
    } as FedNode;
  };

  const a = await node(homeA, "mbp", sockA, opts.scenariosA ?? []);
  const b = await node(homeB, "studio", sockB, opts.scenariosB ?? []);
  // Both engines eager-start their FederationManagers in their constructors and dial each
  // other immediately; the initial handshake round-trip (and, on whichever side dialed before
  // the peer's socket existed, the very first fail -> backoff -> redial cycle) is asynchronous
  // over real loopback sockets and is NOT guaranteed to have settled by the time this async
  // function returns. Every other Task 8/9/10 federation suite (fed-manager.test.ts,
  // fed-link.test.ts, fed-routing.test.ts) waits for state==="connected" before issuing the
  // first call for exactly this reason — PeerLink.request() is intentionally fail-fast (see
  // fed-link.test.ts "request() throws PeerUnreachableError immediately while still
  // connecting"), so a caller racing ahead of the handshake gets an immediate, real
  // PeerUnreachableError, not a hang. This rig is reused by Tasks 12/14, so it waits for BOTH
  // directions here rather than letting every consumer test re-derive the same guard.
  await Promise.all([
    until(() => a.engine.federation!.peersStatus()[0]!.state === "connected"),
    until(() => b.engine.federation!.peersStatus()[0]!.state === "connected"),
  ]);
  return {
    a, b,
    stop: async () => {
      await a.engine.federation?.stop(); await b.engine.federation?.stop();
      await a.server.close().catch(() => {}); await b.server.close().catch(() => {});
    },
  };
}

// ---------- D8: N-HOME mesh rig (A-B, A-C, B-C = independent pairwise links) ----------
// Each node boots FEDERATED (engine.id set) but with an EMPTY peer set — every link is formed by
// driving the real invite/join pairing flow (pair()), exercising the D7/D8 live add-peer hooks.
// SHORT /tmp homes keep the federation.sock path under the 104-byte UDS limit (macOS os.tmpdir()
// is long enough to blow it for a 3-node rig).
export type MeshNode = { id: string; home: string; engine: Engine; fake: FakeAgentBackend; server: { close(): Promise<void> } };

export async function makeFederatedMesh(ids: string[]): Promise<{
  nodes: MeshNode[]; get(id: string): MeshNode;
  pair(aId: string, bId: string): Promise<unknown>;
  stop(): Promise<void>;
}> {
  const accounts = [{ name: "main", provider: "claude", auth: { type: "subscription" } }];
  // Hermetic host-tools probe: only "git" is "installed" — no real binaries run, so peer.status's
  // hostTools carriage is deterministic and fast (D4: a peer only ever gets the last local scan).
  const hostExec = async (cmd: string) => (cmd === "git" ? { stdout: "git version 2.40.0", code: 0 } : { stdout: "", code: 1 });
  const nodes: MeshNode[] = [];
  for (const id of ids) {
    const home = mkdtempSync("/tmp/cm");   // short: /tmp/cmXXXXXX + /federation.sock ≈ 30 chars
    writeFileSync(join(home, "config.json"), JSON.stringify({ accounts, autoOrder: ["main"], engine: { id }, federation: { peers: [] } }));
    const fake = new FakeAgentBackend([]);
    const engine = new Engine({
      home, backends: new Map<string, AgentBackend>([["claude", fake]]),
      exec: fakeExec, hostExec, fedReconnectBaseMs: 25, fedHeartbeatMs: 200,
    });
    const identity = EngineIdentity.loadOrCreate(home);
    const server = await startFederationServer({ socketPath: join(home, "federation.sock"), engine, identity });
    nodes.push({ id, home, engine, fake, server });
  }
  const get = (id: string) => nodes.find((n) => n.id === id)!;

  // Drive a real pairing: A mints an invite, B joins it. On success A auto-pins B and B pins A →
  // both durable links come up. Waits for BOTH directions to reach "connected".
  const pair = async (aId: string, bId: string) => {
    const a = get(aId), b = get(bId);
    const { blob } = await a.engine.handle("fed.invite.create", {}) as { blob: string };
    const result = await b.engine.handle("fed.join", { blob }) as { steps: Array<{ step: string; ok: boolean }>; paired: string | null };
    await until(() => (a.engine.federation!.peersStatus().find((p) => p.engineId === bId)?.state ?? "") === "connected");
    await until(() => (b.engine.federation!.peersStatus().find((p) => p.engineId === aId)?.state ?? "") === "connected");
    return result;
  };

  return {
    nodes, get, pair,
    stop: async () => {
      for (const n of nodes) { await n.engine.federation?.stop().catch(() => {}); await n.server.close().catch(() => {}); }
    },
  };
}

/** Byte-recording unix-socket proxy: point a peer's socketPath at proxy.socketPath to capture every frame (Task 12). */
export async function startRecordingProxy(targetSocket: string): Promise<{ socketPath: string; transcript: () => string; close(): Promise<void> }> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "chimera-proxy-")), "proxy.sock");
  const chunks: Buffer[] = [];
  const server: Server = createServer((client) => {
    const upstream = createConnection(targetSocket);
    client.on("data", (d) => { chunks.push(Buffer.from(d)); upstream.write(d); });
    upstream.on("data", (d) => { chunks.push(Buffer.from(d)); client.write(d); });
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on("close", drop); client.on("error", drop);
    upstream.on("close", drop); upstream.on("error", drop);
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    transcript: () => Buffer.concat(chunks).toString("utf8"),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); }
};
