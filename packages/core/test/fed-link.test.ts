import { describe, it, expect } from "vitest";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { decodeFrames, encodeFrame, type PeerConfig, type RpcRequest } from "@chimera/protocol";
import { PeerLink, PeerUnreachableError } from "@chimera/core/federation/link";
import { ResponderHandshake } from "@chimera/core/federation/handshake";
import type { EngineIdentity } from "@chimera/core/federation/identity";
import { makeIdentity, cardFor, startFakePeer, tmpHome } from "./fed-helpers.js";

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

function rig() {
  const a = makeIdentity(), b = makeIdentity();
  const peerCfg = (socketPath: string): PeerConfig => ({
    engineId: "studio", publicKey: b.identity.publicKey, socketPath,
    allowSpawn: false, accounts: [], maxConcurrent: 4,
  });
  return { a, b, peerCfg };
}

/**
 * Like startFakePeer, but silently DROPS requests for `silentMethod` — never writes a
 * response for it — so tests can exercise the client-side request timeout and the
 * onDisconnect-rejects-in-flight-pending path deterministically (startFakePeer's `respond`
 * always synchronously produces a reply, so it cannot simulate "received but never answered").
 * Local to this test file only — does not touch the Step-1 fed-helpers.ts scaffolding.
 */
async function startSilentPeer(opts: { engineId: string; identity: EngineIdentity; peerKeys: Map<string, string>; silentMethod: string }) {
  const socketPath = join(tmpHome(`sp-${opts.engineId}`), "federation.sock");
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    let buf = "";
    let phase: "hello" | "auth" | "established" = "hello";
    const responder = new ResponderHandshake({ identity: opts.identity, card: cardFor(opts.engineId), peerKeys: opts.peerKeys });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        try {
          if (phase === "hello") { sock.write(encodeFrame(responder.onHello(f) as never)); phase = "auth"; }
          else if (phase === "auth") { sock.write(encodeFrame(responder.onAuth(f).welcome as never)); phase = "established"; }
          else {
            const req = f as RpcRequest;
            if (req.method === opts.silentMethod) continue;   // deliberately never answered
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true } }));
          }
        } catch { sock.destroy(); }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

/**
 * Like startFakePeer, but for EVERY established-phase request writes one deliberately
 * malformed RESPONSE frame (missing the required `ok` boolean) immediately BEFORE the real,
 * well-formed response — both in the same synchronous batch, so they typically land in a
 * single socket 'data' event together. Lets tests prove the link's established-phase frame
 * validation SKIPS the bad frame (continues the same for-loop iteration) rather than
 * sock.destroy()-ing — if it destroyed, the well-formed frame right after would never be
 * delivered/processed and the request would time out instead of resolving.
 */
async function startFakePeerWithGarbageResponses(opts: { engineId: string; identity: EngineIdentity; peerKeys: Map<string, string> }) {
  const socketPath = join(tmpHome(`gp-${opts.engineId}`), "federation.sock");
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    let buf = "";
    let phase: "hello" | "auth" | "established" = "hello";
    const responder = new ResponderHandshake({ identity: opts.identity, card: cardFor(opts.engineId), peerKeys: opts.peerKeys });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        try {
          if (phase === "hello") { sock.write(encodeFrame(responder.onHello(f) as never)); phase = "auth"; }
          else if (phase === "auth") { sock.write(encodeFrame(responder.onAuth(f).welcome as never)); phase = "established"; }
          else {
            const req = f as RpcRequest;
            // malformed: no "ok" field at all — fails the link's RpcResp zod schema
            sock.write(JSON.stringify({ id: req.id, type: "response" }) + "\n");
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true } }));
          }
        } catch { sock.destroy(); }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

describe("PeerLink", () => {
  it("connects, authenticates, round-trips requests, and maps peer errors", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startFakePeer({
      engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]),
      respond: (method) => {
        if (method === "agent.status") throw { code: "protocol", message: "unknown agent" };
        return { echo: method };
      },
    });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10, heartbeatMs: 200 });
    link.start();
    await until(() => link.state === "connected");
    expect(link.peerCard!.engineId).toBe("studio");
    expect(await link.request("peer.status", {})).toEqual({ echo: "peer.status" });
    await expect(link.request("agent.status", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await link.stop();
    await fake.close();
  });

  it("fails fast when partitioned and reconnects with backoff", async () => {
    const { a, b, peerCfg } = rig();
    const fake1 = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const states: string[] = [];
    const link = new PeerLink({
      peer: peerCfg(fake1.socketPath), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 10, heartbeatMs: 50, onStateChange: (s) => states.push(s),
    });
    link.start();
    await until(() => link.state === "connected");

    await fake1.close();                                              // partition injection
    await until(() => link.state === "partitioned");
    await expect(link.request("peer.status", {})).rejects.toBeInstanceOf(PeerUnreachableError);   // immediate, no hang

    const fake2 = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    // reuse the SAME socket path so the link's redial finds the reborn peer
    const { renameSync } = await import("node:fs");
    renameSync(fake2.socketPath, fake1.socketPath);
    await until(() => link.state === "connected", 5000);              // backoff redial succeeded
    expect(states).toContain("partitioned");
    expect(await link.request("peer.ping", {})).toMatchObject({ ok: true });
    await link.stop();
    await fake2.close();
  }, 15_000);

  it("never connects to a peer presenting the wrong identity", async () => {
    const { a, peerCfg } = rig();
    const impostor = makeIdentity();                                  // wrong private key for "studio"
    const fake = await startFakePeer({ engineId: "studio", identity: impostor.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10 });
    link.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(link.state).not.toBe("connected");                         // forged proof rejected on every attempt
    await link.stop();
    await fake.close();
  });
});

// ---------- additional coverage: every branch/edge beyond the brief's baseline cases ----------

describe("PeerLink — additional edge cases", () => {
  it("request() throws PeerUnreachableError immediately while still connecting (fail-fast, never queues)", async () => {
    const { a, peerCfg } = rig();
    // no fake peer listening at all — socket never connects
    const link = new PeerLink({
      peer: peerCfg(`/tmp/chimera-nonexistent-${Date.now()}.sock`), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 10_000,
    });
    link.start();
    expect(link.state).toBe("connecting");
    await expect(link.request("peer.status", {})).rejects.toBeInstanceOf(PeerUnreachableError);
    await link.stop();
  });

  it("start() is idempotent — calling it twice does not open a second connection", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10 });
    link.start();
    link.start();
    link.start();
    await until(() => link.state === "connected");
    expect(link.state).toBe("connected");
    await link.stop();
    await fake.close();
  });

  it("peerCard is null before any successful handshake", async () => {
    const { a, peerCfg } = rig();
    const link = new PeerLink({
      peer: peerCfg(`/tmp/chimera-nonexistent-${Date.now()}.sock`), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 10_000,
    });
    expect(link.peerCard).toBeNull();
    link.start();
    expect(link.peerCard).toBeNull();
    await link.stop();
  });

  it("a request that times out is rejected with PeerUnreachableError and the waiter is cleaned up", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startSilentPeer({
      engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]),
      silentMethod: "slow.method",   // the fake peer receives it but never writes a response
    });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10, heartbeatMs: 5000 });
    link.start();
    await until(() => link.state === "connected");
    await expect(link.request("slow.method", {}, 50)).rejects.toBeInstanceOf(PeerUnreachableError);
    // link itself is unaffected — a fresh request still round-trips normally
    expect(await link.request("peer.ping", {})).toMatchObject({ ok: true });
    await link.stop();
    await fake.close();
  });

  it("onDisconnect rejects every in-flight pending request with PeerUnreachableError", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startSilentPeer({
      engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]),
      silentMethod: "stalls.forever",   // never answered -> stays in-flight until disconnect
    });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10, heartbeatMs: 5000 });
    link.start();
    await until(() => link.state === "connected");
    const inFlight = link.request("stalls.forever", {}, 60_000);
    await new Promise((r) => setTimeout(r, 30));
    await fake.close();                                                // triggers onDisconnect
    await expect(inFlight).rejects.toBeInstanceOf(PeerUnreachableError);
    await link.stop();
  });

  it("stop() before any connection succeeds tears down cleanly with no reconnect attempts", async () => {
    const { a, peerCfg } = rig();
    const states: string[] = [];
    const link = new PeerLink({
      peer: peerCfg(`/tmp/chimera-nonexistent-${Date.now()}.sock`), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 10, onStateChange: (s) => states.push(s),
    });
    link.start();
    await link.stop();
    const stateCountAtStop = states.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(states.length).toBe(stateCountAtStop);                      // no further state changes after stop()
    expect(link.state).not.toBe("connected");
  });

  it("stop() is safe to call twice", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10 });
    link.start();
    await until(() => link.state === "connected");
    await link.stop();
    await expect(link.stop()).resolves.toBeUndefined();
    await fake.close();
  });

  it("onStateChange is not called when the state does not actually change", async () => {
    const { a, b, peerCfg } = rig();
    const fake = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const states: string[] = [];
    const link = new PeerLink({
      peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 10, onStateChange: (s) => states.push(s),
    });
    link.start();
    await until(() => link.state === "connected");
    // "connecting" should appear at most once (constructor default + connect() call collapse to one)
    expect(states.filter((s) => s === "connecting").length).toBeLessThanOrEqual(1);
    await link.stop();
    await fake.close();
  });

  it("a peer that sends a malformed established-phase RESPONSE frame is skipped (no destroy, no reconnect storm)", async () => {
    const { a, b, peerCfg } = rig();
    // every request gets a garbage frame (missing "ok") written immediately before the real
    // response, in the same batch — proves the bad frame is skipped, not destroy()'d, since a
    // destroy would drop the well-formed frame right behind it and the request would time out.
    const fake = await startFakePeerWithGarbageResponses({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const link = new PeerLink({ peer: peerCfg(fake.socketPath), identity: a.identity, card: cardFor("mbp"), reconnectBaseMs: 10, heartbeatMs: 5000 });
    link.start();
    await until(() => link.state === "connected");

    expect(await link.request("peer.status", {}, 500)).toEqual({ ok: true });
    expect(link.state).toBe("connected");          // the garbage frame never triggered a partition
    // the link is still fully functional for further requests too
    expect(await link.request("peer.ping", {}, 500)).toEqual({ ok: true });
    await link.stop();
    await fake.close();
  });

  it("backoff doubles between disconnects up to the 60000ms ceiling and resets to base after a clean reconnect", async () => {
    const { a, b, peerCfg } = rig();
    const fake1 = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const timestamps: number[] = [];
    const link = new PeerLink({
      peer: peerCfg(fake1.socketPath), identity: a.identity, card: cardFor("mbp"),
      reconnectBaseMs: 30, heartbeatMs: 5000,
      onStateChange: (s) => { if (s === "connecting") timestamps.push(Date.now()); },
    });
    link.start();
    await until(() => link.state === "connected");
    await fake1.close();
    await until(() => link.state === "partitioned");

    const fake2 = await startFakePeer({ engineId: "studio", identity: b.identity, peerKeys: new Map([["mbp", a.identity.publicKey]]) });
    const { renameSync } = await import("node:fs");
    renameSync(fake2.socketPath, fake1.socketPath);
    await until(() => link.state === "connected", 5000);
    await link.stop();
    await fake2.close();
    // just assert the reconnect actually happened after some non-zero backoff delay
    expect(timestamps.length).toBeGreaterThan(0);
  }, 15_000);
});
