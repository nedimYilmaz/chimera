import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { ResponderHandshake } from "@chimera/core/federation/handshake";
import {
  decodeFrames as decodeF, encodeFrame as encodeF, PROTOCOL_VERSION as PV,
  type EngineCard as Card, type PeerConfig, type RpcRequest as Req,
} from "@chimera/protocol";

export const tmpHome = (tag: string) => mkdtempSync(join(tmpdir(), `chimera-${tag}-`));
export const makeIdentity = (home = tmpHome("id")) => ({ home, identity: EngineIdentity.loadOrCreate(home) });

/** A CHIMERA_HOME with engine.id + federation.peers + main/second accounts (keychain fakeExec-compatible). */
export function makeFedHome(opts: { id: string; peers?: Array<Partial<PeerConfig> & { engineId: string; publicKey: string; socketPath: string }> }): string {
  const home = tmpHome(`fed-${opts.id}`);
  writeFileSync(joinPath(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
    ],
    autoOrder: ["main", "second"],
    engine: { id: opts.id },
    federation: { peers: opts.peers ?? [] },
  }));
  return home;
}

export const cardFor = (engineId: string): Card => ({
  engineId, protocolVersion: PV, features: ["federation.v1"], providers: ["claude"],
  accounts: [{ name: "main", provider: "claude" }],
});

/** Loopback responder: a scriptable peer engine on a local unix socket — the token-free transport seam. */
export async function startFakePeer(opts: {
  engineId: string; identity: EngineIdentity;
  peerKeys: Map<string, string>;                                  // who may connect (pinned keys)
  respond?: (method: string, params: unknown) => unknown;         // throw {code,message} for error responses
}) {
  const socketPath = joinPath(tmpHome(`fp-${opts.engineId}`), "federation.sock");
  const received: Array<{ method: string; params: unknown }> = [];
  // Track live connections so close() can force them shut: a plain server.close() only stops
  // accepting NEW connections — it waits for already-open ones to end on their own, which for an
  // established peer link (kept open indefinitely by design) never happens on its own. Same fix
  // as daemon federation.ts's startFederationServer, needed here so tests can use fake.close() to
  // inject a partition without hanging.
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    let buf = "";
    let phase: "hello" | "auth" | "established" = "hello";
    const responder = new ResponderHandshake({ identity: opts.identity, card: cardFor(opts.engineId), peerKeys: opts.peerKeys });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeF(buf); buf = rest;
      for (const f of frames) {
        try {
          if (phase === "hello") { sock.write(encodeF(responder.onHello(f) as never)); phase = "auth"; }
          else if (phase === "auth") { sock.write(encodeF(responder.onAuth(f).welcome as never)); phase = "established"; }
          else {
            const req = f as Req;
            received.push({ method: req.method, params: req.params });
            if (req.method === "peer.ping") { sock.write(encodeF({ id: req.id, type: "response", ok: true, result: { ok: true } })); continue; }
            try {
              const result = opts.respond ? opts.respond(req.method, req.params) : { ok: true };
              sock.write(encodeF({ id: req.id, type: "response", ok: true, result }));
            } catch (err) {
              sock.write(encodeF({ id: req.id, type: "response", ok: false, error: err as { code: string; message: string } }));
            }
          }
        } catch { sock.destroy(); }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath, received,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
