import { randomBytes } from "node:crypto";
import {
  PROTOCOL_VERSION, challengePayload,
  FedHelloSchema, FedChallengeSchema, FedAuthSchema, FedWelcomeSchema,
  type EngineCard, type FedAuthFrame, type FedChallengeFrame, type FedHelloFrame, type FedWelcomeFrame,
} from "@chimera/protocol";
import { verifySignature, type EngineIdentity } from "./identity.js";

export class HandshakeError extends Error {
  code = "peer-auth" as const;
}

export type HandshakeDeps = {
  identity: EngineIdentity;
  card: EngineCard;
  peerKeys: Map<string, string>;
  // D8 pairing (OPTIONAL seams — absent ⇒ ordinary default-deny handshake, byte-identical):
  //   checkInvite — peek whether an UNKNOWN initiator's presented token is valid+unburned+unexpired.
  //     When it returns true, the responder admits that initiator via TOFU: it pins the publicKey
  //     the initiator carries in its auth card (the token is the bearer authorization).
  //   onPaired — fired on the responder AFTER a successful invite-based auth, with the joiner's card
  //     (engineId/publicKey/endpoint) and the token to burn. The engine pins the peer + burns here.
  checkInvite?: (token: string) => boolean;
  onPaired?: (peer: EngineCard, token: string) => void;
};

const nonce = () => randomBytes(16).toString("base64");

export class InitiatorHandshake {
  private nonceA = nonce();
  private authenticated = false;

  // D8: an optional inviteToken makes this a PAIRING handshake — hello() carries it so an
  // unknown-peer responder can TOFU-admit us. The card should carry publicKey+endpoint for pinning.
  constructor(private deps: HandshakeDeps, private expectedPeerId: string, private inviteToken?: string) {}

  hello(): FedHelloFrame {
    return {
      fed: "hello", engineId: this.deps.card.engineId, protocolVersion: PROTOCOL_VERSION, nonce: this.nonceA,
      ...(this.inviteToken ? { inviteToken: this.inviteToken } : {}),
    };
  }

  onChallenge(frame: unknown): FedAuthFrame {
    const ch = FedChallengeSchema.safeParse(frame);
    if (!ch.success) throw new HandshakeError("malformed challenge frame");
    const c = ch.data;
    if (c.engineId !== this.expectedPeerId) throw new HandshakeError(`peer claims "${c.engineId}", expected "${this.expectedPeerId}"`);
    if (c.protocolVersion !== PROTOCOL_VERSION) throw new HandshakeError(`protocol skew: peer ${c.protocolVersion} != ${PROTOCOL_VERSION}; run the same chimera release on both engines`);
    const pinned = this.deps.peerKeys.get(c.engineId);
    if (!pinned) throw new HandshakeError(`no pinned key for "${c.engineId}"`);
    const payload = challengePayload(this.nonceA, c.nonce, this.deps.card.engineId, c.engineId);
    if (!verifySignature(pinned, payload, c.signature)) throw new HandshakeError("responder proof failed verification");
    this.authenticated = true;    // responder proved first; now we prove
    return { fed: "auth", signature: this.deps.identity.sign(payload), card: this.deps.card };
  }

  onWelcome(frame: unknown): EngineCard {
    if (!this.authenticated) throw new HandshakeError("welcome before challenge verification");
    const w = FedWelcomeSchema.safeParse(frame);
    if (!w.success) throw new HandshakeError("malformed welcome frame");
    if (w.data.card.engineId !== this.expectedPeerId) throw new HandshakeError("welcome card engineId mismatch");
    return w.data.card;
  }
}

export class ResponderHandshake {
  private nonceB = nonce();
  private pending: { helloNonce: string; initiatorId: string; inviteToken: string | null } | null = null;

  constructor(private deps: HandshakeDeps) {}

  onHello(frame: unknown): FedChallengeFrame {
    const h = FedHelloSchema.safeParse(frame);
    if (!h.success) throw new HandshakeError("malformed hello frame");
    const hello = h.data;
    if (hello.engineId === this.deps.card.engineId) throw new HandshakeError(`both engines claim id "${hello.engineId}" — engine ids must be unique`);
    if (hello.protocolVersion !== PROTOCOL_VERSION) throw new HandshakeError(`protocol skew: peer ${hello.protocolVersion} != ${PROTOCOL_VERSION}; run the same chimera release on both engines`);
    // D8: a KNOWN peer takes the ordinary pinned-key path. An UNKNOWN peer is default-denied
    // UNLESS it presents a valid unburned unexpired invite token (TOFU admission — the key it
    // will pin arrives in its auth card). Any other unknown peer is rejected as before.
    const known = this.deps.peerKeys.has(hello.engineId);
    let inviteToken: string | null = null;
    if (!known) {
      if (hello.inviteToken && this.deps.checkInvite?.(hello.inviteToken)) inviteToken = hello.inviteToken;
      else throw new HandshakeError(`unknown peer "${hello.engineId}" — default deny`);
    }
    this.pending = { helloNonce: hello.nonce, initiatorId: hello.engineId, inviteToken };
    const payload = challengePayload(hello.nonce, this.nonceB, hello.engineId, this.deps.card.engineId);
    return {
      fed: "challenge", engineId: this.deps.card.engineId, protocolVersion: PROTOCOL_VERSION,
      nonce: this.nonceB, signature: this.deps.identity.sign(payload),
    };
  }

  onAuth(frame: unknown): { welcome: FedWelcomeFrame; peer: EngineCard } {
    if (!this.pending) throw new HandshakeError("auth before hello");
    const a = FedAuthSchema.safeParse(frame);
    if (!a.success) throw new HandshakeError("malformed auth frame");
    const { helloNonce, initiatorId, inviteToken } = this.pending;
    if (a.data.card.engineId !== initiatorId) throw new HandshakeError("auth card engineId mismatch");
    // Pinned-key source: an established peer uses its config-pinned key; an invite-admitted peer
    // TOFU-pins the key it presents in this auth card (the token is what authorizes that pinning).
    const pinned = this.deps.peerKeys.get(initiatorId)
      ?? (inviteToken ? a.data.card.publicKey : undefined);
    if (!pinned) throw new HandshakeError(inviteToken ? "invite auth is missing card.publicKey" : `no pinned key for "${initiatorId}"`);
    const payload = challengePayload(helloNonce, this.nonceB, initiatorId, this.deps.card.engineId);
    if (!verifySignature(pinned, payload, a.data.signature)) throw new HandshakeError("initiator proof failed verification");
    if (inviteToken) this.deps.onPaired?.(a.data.card, inviteToken);   // pin + burn on the engine, AFTER proof
    return { welcome: { fed: "welcome", card: this.deps.card }, peer: a.data.card };
  }
}
