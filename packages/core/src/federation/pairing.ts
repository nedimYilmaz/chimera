import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { encodeFrame, FedErrorSchema, type EngineCard } from "@chimera/protocol";
import { InitiatorHandshake } from "./handshake.js";
import type { EngineIdentity } from "./identity.js";

// D8 (pairing, coverage C7 · B15). The JOINER-side one-shot pairing client that fed.join drives
// as its "tunnel" + "handshake" steps. Deliberately NOT the durable PeerLink: it dials once,
// completes the mutual challenge-response carrying the invite token (so the responder TOFU-admits
// and auto-pins us), then closes. The durable link is (re)built afterward by the FederationManager
// once the new peer is written into the config overlay. No SSH here — the socketPath is already
// SSH-forwarded in production and a direct unix socket in tests.

class PairingError extends Error { code = "peer-auth" as const; }

/** Tunnel-reachability probe: connect to `socketPath` and immediately close. Resolves when the
 *  socket accepts, rejects ({code:"peer-unreachable"}) on connect error or timeout — this is the
 *  fed.join "tunnel" step, distinct from the "handshake" step so a dead forward reports precisely. */
export function probeTunnel(socketPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const done = (err?: Error) => {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => done(Object.assign(new Error(`tunnel probe timed out (${socketPath})`), { code: "peer-unreachable" })), timeoutMs);
    sock.on("connect", () => done());
    sock.on("error", (e) => done(Object.assign(new Error(`tunnel unreachable: ${e.message}`), { code: "peer-unreachable" })));
  });
}

/** One-shot pairing handshake. Resolves with the RESPONDER's authenticated card, or rejects
 *  ({code:"peer-auth"}) on a FedError / verification failure / timeout — the fed.join "handshake"
 *  step. On the responder, a successful auth here fires its onPaired (auto-pin + token burn). */
export function runPairingHandshake(opts: {
  socketPath: string;
  identity: EngineIdentity;
  card: EngineCard;             // OUR pairing card: publicKey + endpoint so the responder can pin us
  expectedPeerId: string;
  peerPublicKey: string;        // the responder's ed25519 key, from the blob we trusted — pin it here
  inviteToken: string;
  timeoutMs?: number;
}): Promise<EngineCard> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    // The blob is the trust root on OUR side: we pin the responder's key straight from it, so the
    // ordinary InitiatorHandshake verifies the responder's proof against a real (blob-supplied) key.
    const hs = new InitiatorHandshake(
      { identity: opts.identity, card: opts.card, peerKeys: new Map([[opts.expectedPeerId, opts.peerPublicKey]]) },
      opts.expectedPeerId, opts.inviteToken,
    );
    const sock = createConnection(opts.socketPath);
    const decoder = new StringDecoder("utf8");
    let buf = "";
    let phase: "challenge" | "welcome" | "done" = "challenge";
    const finish = (err: Error | null, card?: EngineCard) => {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      if (err) reject(err); else resolve(card!);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("pairing handshake timed out"), { code: "peer-auth" })), timeoutMs);

    sock.on("connect", () => sock.write(encodeFrame(hs.hello() as never)));
    sock.on("error", (e) => finish(Object.assign(new Error(`pairing handshake socket error: ${e.message}`), { code: "peer-auth" })));
    sock.on("close", () => { if (phase !== "done") finish(new PairingError("pairing handshake closed before completion")); });
    sock.on("data", (chunk) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { continue; }
        // A FedError from the responder (bad/expired/burned token → default deny) fails the step.
        const fe = FedErrorSchema.safeParse(frame);
        if (fe.success) return finish(new PairingError(`responder rejected pairing: ${fe.data.message}`));
        try {
          if (phase === "challenge") {
            const auth = hs.onChallenge(frame);   // verifies A's proof against the blob-pinned key
            sock.write(encodeFrame(auth as never));
            phase = "welcome";
          } else if (phase === "welcome") {
            const card = hs.onWelcome(frame);
            phase = "done";
            finish(null, card);
          }
        } catch (e) {
          finish(new PairingError((e as Error).message));
        }
      }
    });
  });
}
