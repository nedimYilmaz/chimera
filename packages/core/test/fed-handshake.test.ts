import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type EngineCard } from "@chimera/protocol";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { InitiatorHandshake, ResponderHandshake, HandshakeError } from "@chimera/core/federation/handshake";

const newIdentity = () => EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-hs-")));
const card = (engineId: string): EngineCard => ({
  engineId, protocolVersion: PROTOCOL_VERSION, features: ["federation.v1"],
  providers: ["claude"], accounts: [{ name: "main", provider: "claude" }],
});

function makePair() {
  const idA = newIdentity(), idB = newIdentity();
  const depsA = { identity: idA, card: card("mbp"),    peerKeys: new Map([["studio", idB.publicKey]]) };
  const depsB = { identity: idB, card: card("studio"), peerKeys: new Map([["mbp", idA.publicKey]]) };
  return { idA, idB, depsA, depsB };
}

describe("federation handshake", () => {
  it("completes mutual auth and exchanges cards", () => {
    const { depsA, depsB } = makePair();
    const init = new InitiatorHandshake(depsA, "studio");
    const resp = new ResponderHandshake(depsB);
    const challenge = resp.onHello(init.hello());
    const auth = init.onChallenge(challenge);
    const { welcome, peer } = resp.onAuth(auth);
    expect(peer.engineId).toBe("mbp");                                  // responder authenticated the initiator
    expect(init.onWelcome(welcome).engineId).toBe("studio");            // initiator authenticated the responder
  });

  it("default-denies an unknown initiator engineId", () => {
    const { depsB } = makePair();
    const stranger = new InitiatorHandshake(
      { identity: newIdentity(), card: card("intruder"), peerKeys: new Map() }, "studio");
    expect(() => new ResponderHandshake(depsB).onHello(stranger.hello())).toThrow(HandshakeError);
  });

  it("refuses same-engineId links and protocol version skew", () => {
    const { depsA, depsB } = makePair();
    const resp = new ResponderHandshake({ ...depsB, card: card("mbp") });        // both claim "mbp"
    expect(() => resp.onHello(new InitiatorHandshake(depsA, "mbp").hello())).toThrow(HandshakeError);
    const skewed = { ...new InitiatorHandshake(depsA, "studio").hello(), protocolVersion: 99 };
    expect(() => new ResponderHandshake(depsB).onHello(skewed)).toThrow(HandshakeError);
  });

  it("rejects a forged responder proof (initiator side) and a forged initiator proof (responder side)", () => {
    const { depsA, depsB } = makePair();
    // responder signing with the WRONG key: impersonator knows studio's engineId but not its private key
    const impostor = { identity: newIdentity(), card: card("studio"), peerKeys: depsB.peerKeys };
    const init = new InitiatorHandshake(depsA, "studio");
    const forged = new ResponderHandshake(impostor).onHello(init.hello());
    expect(() => init.onChallenge(forged)).toThrow(HandshakeError);
    // initiator proof over the WRONG nonces (replay of an old session) must fail responder verify
    const init2 = new InitiatorHandshake(depsA, "studio");
    const resp2 = new ResponderHandshake(depsB);
    const ch = resp2.onHello(init2.hello());
    const auth = init2.onChallenge(ch);
    const resp3 = new ResponderHandshake(depsB);
    resp3.onHello(new InitiatorHandshake(depsA, "studio").hello());     // NEW session, new nonces
    expect(() => resp3.onAuth(auth)).toThrow(HandshakeError);           // old-session proof replayed -> reject
  });

  it("rejects out-of-order or malformed frames", () => {
    const { depsA, depsB } = makePair();
    expect(() => new ResponderHandshake(depsB).onHello({ garbage: true })).toThrow(HandshakeError);
    const init = new InitiatorHandshake(depsA, "studio");
    init.hello();
    expect(() => init.onWelcome({ fed: "welcome" })).toThrow(HandshakeError);   // malformed + before auth
  });

  // ---- additional coverage: every branch/edge beyond the brief's baseline cases ----

  describe("InitiatorHandshake — additional edge cases", () => {
    it("throws HandshakeError (code peer-auth) with the right shape", () => {
      expect.assertions(2);
      const { depsB } = makePair();
      try {
        new ResponderHandshake(depsB).onHello({ garbage: true });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(HandshakeError);
        expect((e as HandshakeError).code).toBe("peer-auth");
      }
    });

    it("onChallenge rejects a challenge claiming a different engineId than expected", () => {
      const { idA, idB } = makePair();
      const idC = newIdentity();
      // depsA is willing to talk to BOTH "studio" and "mallory" (both pinned), but this
      // particular InitiatorHandshake session explicitly expects "studio".
      const depsA = { identity: idA, card: card("mbp"), peerKeys: new Map([["studio", idB.publicKey], ["mallory", idC.publicKey]]) };
      const depsMallory = { identity: idC, card: card("mallory"), peerKeys: new Map([["mbp", idA.publicKey]]) };
      const init = new InitiatorHandshake(depsA, "studio");
      const respMallory = new ResponderHandshake(depsMallory);
      // mallory proves itself validly (owns idC's private key) — but it isn't who we expected.
      const challengeFromMallory = respMallory.onHello(init.hello());
      expect(() => init.onChallenge(challengeFromMallory)).toThrow(HandshakeError);
    });

    it("onChallenge rejects protocol version skew from the responder", () => {
      const { depsA, depsB } = makePair();
      const init = new InitiatorHandshake(depsA, "studio");
      const resp = new ResponderHandshake(depsB);
      const challenge = resp.onHello(init.hello());
      const skewedChallenge = { ...challenge, protocolVersion: 42 };
      expect(() => init.onChallenge(skewedChallenge)).toThrow(HandshakeError);
    });

    it("onChallenge default-denies when there is no pinned key for the claimed engineId", () => {
      const { idB } = makePair();
      const idA = newIdentity();
      const depsANoPeer = { identity: idA, card: card("mbp"), peerKeys: new Map<string, string>() };
      const depsBKnowsA = { identity: idB, card: card("studio"), peerKeys: new Map([["mbp", idA.publicKey]]) };
      const init = new InitiatorHandshake(depsANoPeer, "studio");
      const resp = new ResponderHandshake(depsBKnowsA);
      const challenge = resp.onHello(init.hello());
      expect(() => init.onChallenge(challenge)).toThrow(HandshakeError); // A has no pinned key for "studio"
    });

    it("onChallenge throws on a malformed frame (fails schema safeParse)", () => {
      const { depsA } = makePair();
      const init = new InitiatorHandshake(depsA, "studio");
      init.hello();
      expect(() => init.onChallenge({ fed: "challenge" })).toThrow(HandshakeError); // missing required fields
      expect(() => init.onChallenge(null)).toThrow(HandshakeError);
      expect(() => init.onChallenge(undefined)).toThrow(HandshakeError);
      expect(() => init.onChallenge("not-an-object")).toThrow(HandshakeError);
    });

    it("onWelcome throws when the welcome card's engineId does not match the expected peer", () => {
      const { depsA, depsB } = makePair();
      const init = new InitiatorHandshake(depsA, "studio");
      const resp = new ResponderHandshake(depsB);
      const challenge = resp.onHello(init.hello());
      init.onChallenge(challenge);
      expect(() => init.onWelcome({ fed: "welcome", card: card("impersonator") })).toThrow(HandshakeError);
    });

    it("onWelcome throws on a malformed welcome frame even after successful auth", () => {
      const { depsA, depsB } = makePair();
      const init = new InitiatorHandshake(depsA, "studio");
      const resp = new ResponderHandshake(depsB);
      const challenge = resp.onHello(init.hello());
      init.onChallenge(challenge);
      expect(() => init.onWelcome({ fed: "welcome" })).toThrow(HandshakeError); // missing card
      expect(() => init.onWelcome({ fed: "hello" })).toThrow(HandshakeError);   // wrong discriminant
    });

    it("onWelcome succeeds only after a valid onChallenge call (state ordering enforced)", () => {
      const { depsA } = makePair();
      const init = new InitiatorHandshake(depsA, "studio");
      // never called hello()/onChallenge() — straight to onWelcome
      expect(() => init.onWelcome({ fed: "welcome", card: card("studio") })).toThrow(HandshakeError);
    });
  });

  describe("ResponderHandshake — additional edge cases", () => {
    it("onHello throws on a malformed hello frame (missing/blank fields)", () => {
      const { depsB } = makePair();
      const resp = new ResponderHandshake(depsB);
      expect(() => resp.onHello(null)).toThrow(HandshakeError);
      expect(() => resp.onHello(undefined)).toThrow(HandshakeError);
      expect(() => resp.onHello(42)).toThrow(HandshakeError);
      expect(() => resp.onHello({ fed: "hello", engineId: "", protocolVersion: PROTOCOL_VERSION, nonce: "x".repeat(16) })).toThrow(HandshakeError);
      expect(() => resp.onHello({ fed: "hello", engineId: "mbp", protocolVersion: PROTOCOL_VERSION, nonce: "short" })).toThrow(HandshakeError); // nonce too short
    });

    it("onHello rejects wrong discriminant (fed !== 'hello')", () => {
      const { depsA, depsB } = makePair();
      const resp = new ResponderHandshake(depsB);
      const wrongKind = { ...new InitiatorHandshake(depsA, "studio").hello(), fed: "auth" };
      expect(() => resp.onHello(wrongKind)).toThrow(HandshakeError);
    });

    it("onAuth throws when called before onHello (no pending session)", () => {
      const { depsA, depsB } = makePair();
      const resp = new ResponderHandshake(depsB);
      const auth = { fed: "auth" as const, signature: "whatever", card: card("mbp") };
      expect(() => resp.onAuth(auth)).toThrow(HandshakeError);
    });

    it("onAuth throws on a malformed auth frame", () => {
      const { depsA, depsB } = makePair();
      const resp = new ResponderHandshake(depsB);
      resp.onHello(new InitiatorHandshake(depsA, "studio").hello());
      expect(() => resp.onAuth({ fed: "auth" })).toThrow(HandshakeError); // missing signature/card
      expect(() => resp.onAuth(null)).toThrow(HandshakeError);
      expect(() => resp.onAuth("garbage")).toThrow(HandshakeError);
    });

    it("onAuth throws when the auth card's engineId does not match the initiator that said hello", () => {
      const { depsA, depsB } = makePair();
      const resp = new ResponderHandshake(depsB);
      const init = new InitiatorHandshake(depsA, "studio");
      const challenge = resp.onHello(init.hello());
      const auth = init.onChallenge(challenge);
      const tamperedAuth = { ...auth, card: card("someone-else") };
      expect(() => resp.onAuth(tamperedAuth)).toThrow(HandshakeError);
    });

    it("each ResponderHandshake instance issues a fresh nonceB across separate sessions", () => {
      const { depsA, depsB } = makePair();
      const resp1 = new ResponderHandshake(depsB);
      const resp2 = new ResponderHandshake(depsB);
      const c1 = resp1.onHello(new InitiatorHandshake(depsA, "studio").hello());
      const c2 = resp2.onHello(new InitiatorHandshake(depsA, "studio").hello());
      expect(c1.nonce).not.toBe(c2.nonce);
    });

    it("each InitiatorHandshake instance issues a fresh nonceA across separate hello() calls", () => {
      const { depsA } = makePair();
      const h1 = new InitiatorHandshake(depsA, "studio").hello();
      const h2 = new InitiatorHandshake(depsA, "studio").hello();
      expect(h1.nonce).not.toBe(h2.nonce);
    });
  });

  describe("HandshakeError shape", () => {
    it("is an instance of Error and carries the fixed peer-auth code", () => {
      const err = new HandshakeError("test message");
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("peer-auth");
      expect(err.message).toBe("test message");
    });
  });

  // D8: invite-based TOFU admission — an UNKNOWN initiator bearing a valid token is admitted and
  // its presented key is pinned; onPaired fires AFTER proof; a bad/absent token is default-denied.
  describe("invite TOFU admission", () => {
    const pairingCard = (engineId: string, publicKey: string): EngineCard => ({ ...card(engineId), publicKey });

    it("admits an unknown initiator with a valid token and pins its presented key; onPaired fires after proof", () => {
      const idA = newIdentity(), idB = newIdentity();
      // responder B knows NO peers, but accepts the token and captures the pairing
      let paired: { engineId: string; publicKey?: string; token: string } | null = null;
      const depsB = {
        identity: idB, card: card("studio"), peerKeys: new Map<string, string>(),
        checkInvite: (t: string) => t === "good-token",
        onPaired: (c: EngineCard, token: string) => { paired = { engineId: c.engineId, publicKey: c.publicKey, token }; },
      };
      // initiator A presents its publicKey in its pairing card + the token in hello
      const depsA = { identity: idA, card: pairingCard("mbp", idA.publicKey), peerKeys: new Map([["studio", idB.publicKey]]) };
      const init = new InitiatorHandshake(depsA, "studio", "good-token");
      const resp = new ResponderHandshake(depsB);
      const challenge = resp.onHello(init.hello());
      const auth = init.onChallenge(challenge);
      expect(paired).toBeNull();                    // not yet — proof not verified
      const { peer } = resp.onAuth(auth);
      expect(peer.engineId).toBe("mbp");
      expect(paired).toEqual({ engineId: "mbp", publicKey: idA.publicKey, token: "good-token" });
    });

    it("default-denies an unknown initiator whose token check fails", () => {
      const idA = newIdentity(), idB = newIdentity();
      const depsB = { identity: idB, card: card("studio"), peerKeys: new Map<string, string>(), checkInvite: () => false };
      const depsA = { identity: idA, card: pairingCard("mbp", idA.publicKey), peerKeys: new Map([["studio", idB.publicKey]]) };
      const resp = new ResponderHandshake(depsB);
      expect(() => resp.onHello(new InitiatorHandshake(depsA, "studio", "bad-token").hello())).toThrow(HandshakeError);
    });

    it("rejects an invite-admitted auth that omits card.publicKey (nothing to pin)", () => {
      const idA = newIdentity(), idB = newIdentity();
      const depsB = { identity: idB, card: card("studio"), peerKeys: new Map<string, string>(), checkInvite: () => true, onPaired: () => {} };
      const depsA = { identity: idA, card: card("mbp"), peerKeys: new Map([["studio", idB.publicKey]]) };   // card has NO publicKey
      const resp = new ResponderHandshake(depsB);
      const init = new InitiatorHandshake(depsA, "studio", "good-token");
      const challenge = resp.onHello(init.hello());
      expect(() => resp.onAuth(init.onChallenge(challenge))).toThrow(HandshakeError);
    });
  });
});
