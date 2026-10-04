import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { InitiatorHandshake } from "@chimera/core/federation/handshake";
import { PROTOCOL_VERSION, decodeFrames, encodeFrame, type EngineCard, type RpcFrame } from "@chimera/protocol";
import { startFederationServer } from "@chimera/daemon/federation";
import { fakeExec } from "../../core/test/helpers.js";
import { makeFedHome, makeIdentity } from "../../core/test/fed-helpers.js";

function rawClient(socketPath: string) {
  const sock = createConnection(socketPath);
  let buf = ""; const waiters: Array<(f: unknown) => void> = []; const inbox: unknown[] = [];
  sock.on("data", (d) => {
    buf += d.toString();
    const { frames, rest } = decodeFrames(buf); buf = rest;
    for (const f of frames) { const w = waiters.shift(); w ? w(f) : inbox.push(f); }
  });
  const next = () => new Promise<unknown>((r) => { const f = inbox.shift(); f !== undefined ? r(f) : waiters.push(r); });
  return { sock, next, send: (f: unknown) => sock.write(JSON.stringify(f) + "\n"),
           closed: new Promise<void>((r) => sock.on("close", () => r())) };
}

const card = (engineId: string, pub: string): EngineCard => ({
  engineId, protocolVersion: PROTOCOL_VERSION, features: ["federation.v1"], providers: ["claude"], accounts: [],
});

describe("federation socket server", () => {
  async function makeServer() {
    const mbp = makeIdentity();                                          // the remote peer ("mbp")
    const home = makeFedHome({ id: "studio", peers: [{ engineId: "mbp", publicKey: mbp.identity.publicKey, socketPath: "/tmp/unused.sock", allowSpawn: true, accounts: ["main"] }] });
    const identity = EngineIdentity.loadOrCreate(home);                  // studio's own identity
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]), exec: fakeExec });
    const socketPath = join(home, "federation.sock");
    const server = await startFederationServer({ socketPath, engine, identity });
    return { mbp, home, identity, engine, socketPath, server };
  }

  it("authenticates a pinned peer, then serves ONLY the peer allowlist", async () => {
    const { mbp, identity, socketPath, server } = await makeServer();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const c = rawClient(socketPath);
    const init = new InitiatorHandshake(
      { identity: mbp.identity, card: card("mbp", mbp.identity.publicKey), peerKeys: new Map([["studio", identity.publicKey]]) },
      "studio");
    c.send(init.hello());
    const auth = init.onChallenge(await c.next());
    c.send(auth);
    const peerCard = init.onWelcome(await c.next());
    expect(peerCard.engineId).toBe("studio");

    c.send({ id: "1", type: "request", method: "peer.ping", params: {} });
    expect(await c.next()).toMatchObject({ id: "1", ok: true });
    c.send({ id: "2", type: "request", method: "peer.status", params: {} });
    expect(await c.next()).toMatchObject({ id: "2", ok: true, result: { engineId: "studio" } });
    c.send({ id: "3", type: "request", method: "agent.spawn", params: { spec: { prompt: "hi", cwd: "/tmp", account: "main", isolation: "none" }, spawnId: "s1" } });
    expect(await c.next()).toMatchObject({ id: "3", ok: true });
    c.send({ id: "4", type: "request", method: "daemon.stop", params: {} });
    expect(await c.next()).toMatchObject({ id: "4", ok: false, error: { code: "protocol" } });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("destroys unauthenticated or forged connections with a FedError", async () => {
    const { socketPath, server, mbp, identity } = await makeServer();
    const c1 = rawClient(socketPath);                                    // RPC before handshake
    c1.send({ id: "1", type: "request", method: "peer.status", params: {} });
    expect(await c1.next()).toMatchObject({ fed: "error" });
    await c1.closed;

    const c2 = rawClient(socketPath);                                    // unknown engineId
    const stranger = makeIdentity();
    const init = new InitiatorHandshake(
      { identity: stranger.identity, card: card("intruder", stranger.identity.publicKey), peerKeys: new Map([["studio", identity.publicKey]]) },
      "studio");
    c2.send(init.hello());
    expect(await c2.next()).toMatchObject({ fed: "error" });
    await c2.closed;

    const c3 = rawClient(socketPath);                                    // right engineId, WRONG key
    const forger = makeIdentity();
    const forgedInit = new InitiatorHandshake(
      { identity: forger.identity, card: card("mbp", forger.identity.publicKey), peerKeys: new Map([["studio", identity.publicKey]]) },
      "studio");
    c3.send(forgedInit.hello());
    const challenge = await c3.next();                                   // responder still challenges…
    c3.send(forgedInit.onChallenge(challenge as never));                 // …but the forged proof must fail
    expect(await c3.next()).toMatchObject({ fed: "error" });
    await c3.closed;
    await server.close();
  }, 15_000);
});

// ---------- additional coverage: every branch/edge in federation.ts ----------

async function setupFedServer(peerOverrides: Partial<{ allowSpawn: boolean; accounts: string[] | "auto" }> = {}) {
  const mbp = makeIdentity();
  const home = makeFedHome({
    id: "studio",
    peers: [{ engineId: "mbp", publicKey: mbp.identity.publicKey, socketPath: "/tmp/unused.sock", allowSpawn: true, accounts: ["main"], ...peerOverrides }],
  });
  const identity = EngineIdentity.loadOrCreate(home);
  const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]), exec: fakeExec });
  const socketPath = join(home, "federation.sock");
  const server = await startFederationServer({ socketPath, engine, identity });
  return { mbp, home, identity, engine, socketPath, server };
}

/** Drives a raw client through the full handshake so it lands in "established". */
async function authenticate(c: ReturnType<typeof rawClient>, peerIdentity: EngineIdentity, peerEngineId: string, studioIdentity: EngineIdentity) {
  const init = new InitiatorHandshake(
    { identity: peerIdentity, card: card(peerEngineId, peerIdentity.publicKey), peerKeys: new Map([["studio", studioIdentity.publicKey]]) },
    "studio");
  c.send(init.hello());
  const auth = init.onChallenge(await c.next());
  c.send(auth);
  init.onWelcome(await c.next());
}

describe("federation socket server: socket lifecycle", () => {
  it("unlinks a stale socket file left behind by a dead daemon before listening", async () => {
    const mbp = makeIdentity();
    const home = makeFedHome({ id: "studio", peers: [{ engineId: "mbp", publicKey: mbp.identity.publicKey, socketPath: "/tmp/unused.sock" }] });
    const identity = EngineIdentity.loadOrCreate(home);
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]), exec: fakeExec });
    const socketPath = join(home, "federation.sock");
    writeFileSync(socketPath, "stale leftover from a dead daemon");
    expect(existsSync(socketPath)).toBe(true);

    const server = await startFederationServer({ socketPath, engine, identity });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await server.close();
  });

  it("close() unlinks the socket file", async () => {
    const { socketPath, server } = await setupFedServer();
    expect(existsSync(socketPath)).toBe(true);
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("close() does not throw if the socket file was already removed externally", async () => {
    const { socketPath, server } = await setupFedServer();
    unlinkSync(socketPath); // simulate something else having cleaned it up already
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects when the socket's parent directory does not exist", async () => {
    const mbp = makeIdentity();
    const home = makeFedHome({ id: "studio", peers: [{ engineId: "mbp", publicKey: mbp.identity.publicKey, socketPath: "/tmp/unused.sock" }] });
    const identity = EngineIdentity.loadOrCreate(home);
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]), exec: fakeExec });
    const badSocketPath = join(tmpdir(), `chimera-fed-missing-dir-${Date.now()}`, "federation.sock");
    await expect(startFederationServer({ socketPath: badSocketPath, engine, identity })).rejects.toBeDefined();
  });

  it("close() force-destroys a lingering authenticated connection instead of hanging server shutdown", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);
    // an established peer link stays open indefinitely; without a force-destroy
    // Node's server.close() would wait for it forever.
    const outcome = await Promise.race([
      server.close().then(() => "closed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("closed");
    expect(existsSync(socketPath)).toBe(false); // still unlinks after force-closing the socket
  }, 15_000);
});

describe("federation socket server: peer.ping heartbeat", () => {
  it("answers peer.ping locally with {ok:true, result:{ok:true, ts:<number>}}", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    const before = Date.now();
    c.send({ id: "p1", type: "request", method: "peer.ping", params: {} });
    const resp = await c.next() as { id: string; ok: boolean; result: { ok: boolean; ts: number } };
    expect(resp).toMatchObject({ id: "p1", ok: true, result: { ok: true } });
    expect(resp.result.ts).toBeGreaterThanOrEqual(before);
    c.sock.end();
    await server.close();
  }, 15_000);
});

describe("federation socket server: auth-phase violation", () => {
  it("a malformed auth-phase frame (not a fed:auth shape) gets a FedError and destroys the connection", async () => {
    const { mbp, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    const init = new InitiatorHandshake(
      { identity: mbp.identity, card: card("mbp", mbp.identity.publicKey), peerKeys: new Map() },
      "studio");
    c.send(init.hello());
    await c.next(); // consume the challenge — phase is now "auth"
    c.send({ not: "an auth frame" });
    expect(await c.next()).toMatchObject({ fed: "error" });
    await c.closed;
    await server.close();
  }, 15_000);
});

describe("federation socket server: engine.handlePeer error mapping (established phase)", () => {
  it("maps a guardrail rejection from engine.handlePeer to {ok:false, error:{code:'guardrail'}}", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer({ allowSpawn: false });
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.send({ id: "g1", type: "request", method: "agent.spawn", params: { spec: { prompt: "hi", cwd: "/tmp", account: "main", isolation: "none" }, spawnId: "g1" } });
    expect(await c.next()).toMatchObject({ id: "g1", ok: false, error: { code: "guardrail" } });
    c.sock.end();
    await server.close();
  }, 15_000);
});

describe("federation socket server: established-phase malformed frames never destroy the connection", () => {
  it("a malformed frame WITH a usable string id gets a protocol-error response, and the connection stays alive", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.send({ id: "bad1", type: "request" }); // missing "method"
    expect(await c.next()).toMatchObject({ id: "bad1", ok: false, error: { code: "protocol" } });

    c.send({ id: "after1", type: "request", method: "peer.ping", params: {} }); // connection still alive
    expect(await c.next()).toMatchObject({ id: "after1", ok: true });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("a malformed frame WITHOUT a usable id is silently skipped, and the connection stays alive", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.send({ type: "request", method: "peer.ping" }); // no id at all
    c.send({ id: "", type: "request", method: "peer.ping" }); // empty-string id fails min(1)
    c.send({ id: "after2", type: "request", method: "peer.ping", params: {} });
    expect(await c.next()).toMatchObject({ id: "after2", ok: true }); // ONLY this response ever arrives
    c.sock.end();
    await server.close();
  }, 15_000);

  it("a torn/garbage COMPLETE line (invalid JSON) is skipped without destroying the connection", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.sock.write("{not valid json at all\n"); // complete line, unparseable
    c.send({ id: "after3", type: "request", method: "peer.ping", params: {} });
    expect(await c.next()).toMatchObject({ id: "after3", ok: true });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("a non-object established-phase frame (JSON null / array) is skipped without throwing", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.sock.write("null\n");
    c.sock.write("[1,2,3]\n");
    c.send({ id: "after4", type: "request", method: "peer.ping", params: {} });
    expect(await c.next()).toMatchObject({ id: "after4", ok: true });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("a frame with the wrong 'type' literal (e.g. an echoed response) with an id gets a protocol-error response", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.send({ id: "wt1", type: "response", ok: true, result: {} });
    expect(await c.next()).toMatchObject({ id: "wt1", ok: false, error: { code: "protocol" } });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("a blank line between frames is ignored (not a violation, not a frame)", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    c.sock.write("\n");
    c.send({ id: "after5", type: "request", method: "peer.ping", params: {} });
    expect(await c.next()).toMatchObject({ id: "after5", ok: true });
    c.sock.end();
    await server.close();
  }, 15_000);

  it("processes multiple frames delivered in a single TCP write, in order", async () => {
    const { mbp, identity, socketPath, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    const batch = JSON.stringify({ id: "b1", type: "request", method: "peer.ping", params: {} }) + "\n"
      + JSON.stringify({ id: "b2", type: "request", method: "peer.ping", params: {} }) + "\n";
    c.sock.write(batch);
    expect(await c.next()).toMatchObject({ id: "b1", ok: true });
    expect(await c.next()).toMatchObject({ id: "b2", ok: true });
    c.sock.end();
    await server.close();
  }, 15_000);
});

describe("federation socket server: multi-byte UTF-8 frame reassembly", () => {
  it("decodes an established-phase frame whose multi-byte UTF-8 char is split across two socket writes", async () => {
    const { mbp, identity, socketPath, engine, server } = await setupFedServer();
    const c = rawClient(socketPath);
    await authenticate(c, mbp.identity, "mbp", identity);

    // A per-chunk chunk.toString() would emit replacement chars here and corrupt
    // the prompt; StringDecoder.write() must buffer the split sequence instead.
    const prompt = "こんにちは世界";
    const frameStr = encodeFrame({
      id: "u1", type: "request", method: "agent.spawn",
      params: { spec: { prompt, cwd: "/tmp", account: "main", isolation: "none" }, spawnId: "u1" },
    });
    const bytes = Buffer.from(frameStr, "utf8");
    const cut = bytes.indexOf(Buffer.from("世", "utf8")) + 1; // splits the 3-byte "世" after its first byte

    c.sock.write(bytes.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20)); // force two separate 'data' events
    c.sock.write(bytes.subarray(cut));

    const spawned = await c.next() as { ok: boolean; result: { agentId: string } };
    expect(spawned.ok).toBe(true);
    await engine.handle("agent.wait", { agentId: spawned.result.agentId, timeoutMs: 2000 });

    c.send({ id: "u2", type: "request", method: "agent.result", params: { agentId: spawned.result.agentId } });
    const result = await c.next() as { ok: boolean; result: { text: string } };
    expect(result.result.text).toBe(`fake:${prompt}`); // the prompt survived the split intact
    c.sock.end();
    await server.close();
  }, 15_000);
});
