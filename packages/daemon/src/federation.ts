import { createServer, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { encodeFrame } from "@chimera/protocol";
import type { Engine } from "@chimera/core/engine";
import type { EngineIdentity } from "@chimera/core/federation/identity";
import { ResponderHandshake, HandshakeError } from "@chimera/core/federation/handshake";

// Established-phase ingress is UNTRUSTED peer input: validate every frame as an
// RpcRequest before dispatch (Phase-5 deferred MUST). Unknown extra fields are
// ignored (no .strict()) — future frame extensions stay additive.
const RpcReq = z.object({
  id: z.string().min(1),
  type: z.literal("request"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

/**
 * Local defensive line-decoder for untrusted peer ingress. Behaviorally identical
 * to the shared @chimera/protocol decodeFrames (NDJSON split on "\n", trailing
 * partial line kept in `rest`, torn/garbage complete lines skipped rather than
 * thrown) — kept as a separate local copy rather than importing decodeFrames so
 * peer-ingress parsing has no dependency on the RpcFrame-typed shared decoder.
 */
function decodePeerFrames(buf: string): { frames: unknown[]; rest: string } {
  const frames: unknown[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // torn/garbage complete line — skip it, never wedge the connection
    }
  }
  return { frames, rest };
}

/**
 * Peer-protocol-only listener (spec §15). daemon.sock is never served here; this
 * is the ONLY socket SSH forwards between engines. Per connection: a fresh
 * ResponderHandshake (fresh nonces defeat replay) drives awaiting-hello ->
 * awaiting-auth -> established. ANY violation before established (non-`fed`
 * frame, unknown peer, bad signature) writes one FedError frame and destroys the
 * socket. After established, only RpcRequest frames are accepted: `peer.ping` is
 * answered locally (heartbeat, Task 8); everything else goes through
 * engine.handlePeer's default-deny peer allowlist.
 */
export async function startFederationServer(opts: { socketPath: string; engine: Engine; identity: EngineIdentity }) {
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);   // stale socket from a dead daemon

  const sockets = new Set<Socket>();   // track live connections so close() can force them shut

  const handleConnection = (sock: Socket) => {
    sockets.add(sock);
    let buf = "";
    // StringDecoder buffers an incomplete multi-byte UTF-8 sequence split across
    // socket chunk boundaries instead of emitting replacement chars per chunk.
    const decoder = new StringDecoder("utf8");
    let phase: "hello" | "auth" | "established" = "hello";
    let peerId: string | null = null;
    // D8: peerKeys are read FRESH per connection from the live engine config — a peer pinned by a
    // pairing (fed.join auto-pin) or a manual overlay edit is recognized without a daemon restart.
    const peerKeys = new Map(opts.engine.peerConfigs().map((p) => [p.engineId, p.publicKey]));
    // Fresh handshake state PER CONNECTION — fresh nonces defeat replay across links. The invite
    // seams admit an unknown peer bearing a valid token (TOFU) and auto-pin it after proof.
    const responder = new ResponderHandshake({
      identity: opts.identity, card: opts.engine.engineCard(), peerKeys,
      checkInvite: (token) => opts.engine.checkInvite(token),
      onPaired: (card, token) => opts.engine.onPeerPaired(card, token),
    });

    const fail = (message: string) => {
      sock.write(encodeFrame({ fed: "error", code: "peer-auth", message } as never));
      sock.destroy();
    };

    const dispatch = async (frame: unknown) => {
      if (phase === "hello") {
        try {
          sock.write(encodeFrame(responder.onHello(frame) as never));
          phase = "auth";
        } catch (err) {
          fail(err instanceof HandshakeError ? err.message : "federation protocol violation");
        }
        return;
      }
      if (phase === "auth") {
        try {
          const { welcome, peer } = responder.onAuth(frame);
          peerId = peer.engineId;
          sock.write(encodeFrame(welcome as never));
          phase = "established";
        } catch (err) {
          fail(err instanceof HandshakeError ? err.message : "federation protocol violation");
        }
        return;
      }

      // established: RpcRequest frames only, schema-validated (peer input is UNTRUSTED).
      const parsed = RpcReq.safeParse(frame);
      if (!parsed.success) {
        // A malformed established-phase frame must NEVER destroy the connection
        // (one garbage frame killing an authenticated link is exactly the DoS the
        // Phase-5 deferred MUST forbids). Reply with an error if a usable string
        // id is present; otherwise skip it silently.
        const maybeId = (frame as { id?: unknown } | null | undefined)?.id;
        if (typeof maybeId === "string" && maybeId.length > 0)
          sock.write(encodeFrame({ id: maybeId, type: "response", ok: false, error: { code: "protocol", message: "invalid rpc request frame" } }));
        return;
      }
      const req = parsed.data;
      if (req.method === "peer.ping") {
        sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, ts: Date.now() } }));
        return;
      }
      try {
        const result = await opts.engine.handlePeer(peerId!, req.method, req.params ?? {});
        sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result }));
      } catch (err) {
        sock.write(encodeFrame({ id: req.id, type: "response", ok: false, error: err as { code: string; message: string } }));
      }
    };

    sock.on("data", (chunk) => {
      buf += decoder.write(chunk);
      const { frames, rest } = decodePeerFrames(buf);
      buf = rest;
      for (const f of frames) void dispatch(f);
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => { sockets.delete(sock); sock.destroy(); });
  };

  const server = createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, resolve);
  });
  chmodSync(opts.socketPath, 0o600);
  return {
    close: () => new Promise<void>((resolve) => {
      // force-close live connections (an established peer link never closes on its
      // own) so server.close() can't hang the daemon's shutdown forever
      for (const s of sockets) s.destroy();
      server.close(() => { if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath); resolve(); });
    }),
  };
}
