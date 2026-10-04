import { describe, it, expect } from "vitest";
import {
  EngineIdSchema, PeerConfigSchema, ChimeraConfigSchema, EngineCardSchema,
  FedFrameSchema, challengePayload, PEER_METHODS, isPeerMethod,
  MailboxForwardParamsSchema, assertFederationSafeSpec,
  AgentSpecSchema, parseAgentAddress, formatAgentAddress,
} from "@chimera/protocol";

describe("EngineIdSchema", () => {
  it("accepts charset ids, rejects 'local' and slashes", () => {
    expect(EngineIdSchema.parse("mbp-alice")).toBe("mbp-alice");
    expect(() => EngineIdSchema.parse("local")).toThrow();
    expect(() => EngineIdSchema.parse("a/b")).toThrow();
    expect(() => EngineIdSchema.parse("")).toThrow();
  });

  it("accepts a single-character id and ids with dots/underscores (boundary/charset edges)", () => {
    expect(EngineIdSchema.parse("a")).toBe("a");
    expect(EngineIdSchema.parse("mbp.alice_2")).toBe("mbp.alice_2");
  });

  it("rejects ids with disallowed characters (space, unicode)", () => {
    expect.assertions(2);
    expect(() => EngineIdSchema.parse("mbp alice")).toThrow();
    expect(() => EngineIdSchema.parse("mbpé")).toThrow();
  });
});

describe("PeerConfigSchema / ChimeraConfig federation surface", () => {
  it("defaults to read-only deny (allowSpawn false, accounts [])", () => {
    const p = PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PKB64", socketPath: "/tmp/peers/studio.sock",
    });
    expect(p.allowSpawn).toBe(false);
    expect(p.accounts).toEqual([]);
    expect(p.maxConcurrent).toBe(4);
  });

  it("keeps pre-federation configs parsing unchanged (engine/federation optional)", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    });
    expect(cfg.engine).toBeUndefined();
    expect(cfg.federation).toBeUndefined();
  });

  it("parses a federated config", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      engine: { id: "mbp" },
      federation: { peers: [{ engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock", allowSpawn: true, accounts: ["main"] }] },
    });
    expect(cfg.engine!.id).toBe("mbp");
    expect(cfg.federation!.peers[0]!.allowSpawn).toBe(true);
  });

  it("rejects a PeerConfig with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock", authType: "keychain",
    })).toThrow();
  });

  it("rejects a PeerConfig whose engineId is the reserved 'local'", () => {
    expect.assertions(1);
    expect(() => PeerConfigSchema.parse({
      engineId: "local", publicKey: "PK", socketPath: "/tmp/s.sock",
    })).toThrow();
  });

  it("accepts accounts: 'auto' as a union alternative to an array", () => {
    const p = PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock", accounts: "auto",
    });
    expect(p.accounts).toBe("auto");
  });

  it("rejects maxConcurrent <= 0 (positive-int boundary)", () => {
    expect.assertions(2);
    expect(() => PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock", maxConcurrent: 0,
    })).toThrow();
    expect(() => PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock", maxConcurrent: -1,
    })).toThrow();
  });

  it("accepts an ssh block and defaults remoteSocket", () => {
    const p = PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock",
      ssh: { host: "studio-box" },
    });
    expect(p.ssh!.remoteSocket).toBe(".chimera/federation.sock");
  });

  it("rejects an ssh block with an unknown key (strict) and an empty host", () => {
    expect.assertions(2);
    expect(() => PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock",
      ssh: { host: "studio-box", bogus: 1 },
    })).toThrow();
    expect(() => PeerConfigSchema.parse({
      engineId: "studio", publicKey: "PK", socketPath: "/tmp/s.sock",
      ssh: { host: "" },
    })).toThrow();
  });

  it("defaults federation.peers to [] when federation block is present but empty", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      federation: {},
    });
    expect(cfg.federation!.peers).toEqual([]);
  });

  it("rejects an engine block missing the required id", () => {
    expect.assertions(1);
    expect(() => ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      engine: {},
    })).toThrow();
  });

  it("rejects an engine block with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      engine: { id: "mbp", extra: true },
    })).toThrow();
  });
});

describe("EngineCardSchema", () => {
  it("carries account names only — auth details are a parse error", () => {
    const card = EngineCardSchema.parse({
      engineId: "studio", protocolVersion: 1, features: ["federation.v1"],
      providers: ["claude"], accounts: [{ name: "main", provider: "claude" }],
    });
    expect(card.accounts[0]).toEqual({ name: "main", provider: "claude" });
    expect(() => EngineCardSchema.parse({
      engineId: "studio", protocolVersion: 1, features: [], providers: [],
      accounts: [{ name: "main", provider: "claude", authType: "keychain" }],
    })).toThrow();
  });

  it("accepts empty features/providers/accounts arrays (n<=0 boundary)", () => {
    const card = EngineCardSchema.parse({
      engineId: "studio", protocolVersion: 1, features: [], providers: [], accounts: [],
    });
    expect(card.accounts).toEqual([]);
  });

  it("rejects a card whose engineId is 'local'", () => {
    expect.assertions(1);
    expect(() => EngineCardSchema.parse({
      engineId: "local", protocolVersion: 1, features: [], providers: [], accounts: [],
    })).toThrow();
  });

  it("rejects a card with an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => EngineCardSchema.parse({
      engineId: "studio", protocolVersion: 1, features: [], providers: [], accounts: [], bogus: 1,
    })).toThrow();
  });

  it("rejects an account entry missing the provider", () => {
    expect.assertions(1);
    expect(() => EngineCardSchema.parse({
      engineId: "studio", protocolVersion: 1, features: [], providers: [],
      accounts: [{ name: "main" }],
    })).toThrow();
  });
});

describe("handshake frames", () => {
  it("round-trips the fed union and builds a deterministic challenge payload", () => {
    const hello = FedFrameSchema.parse({ fed: "hello", engineId: "mbp", protocolVersion: 1, nonce: "QUFBQUFBQUFBQUFBQUFBQQ==" });
    expect(hello.fed).toBe("hello");
    expect(() => FedFrameSchema.parse({ fed: "nope" })).toThrow();
    const p1 = challengePayload("nA", "nB", "mbp", "studio");
    const p2 = challengePayload("nA", "nB", "mbp", "studio");
    expect(Buffer.compare(p1, p2)).toBe(0);
    expect(Buffer.compare(p1, challengePayload("nA", "nB", "studio", "mbp"))).not.toBe(0);
  });

  it("rejects a hello frame with a nonce shorter than 16 chars (boundary)", () => {
    expect.assertions(1);
    expect(() => FedFrameSchema.parse({
      fed: "hello", engineId: "mbp", protocolVersion: 1, nonce: "short",
    })).toThrow();
  });

  it("accepts a nonce of exactly 16 chars (exact-window boundary)", () => {
    const hello = FedFrameSchema.parse({
      fed: "hello", engineId: "mbp", protocolVersion: 1, nonce: "0123456789abcdef",
    });
    expect(hello.nonce).toBe("0123456789abcdef");
  });

  it("round-trips challenge, auth, welcome, and error frames through the union", () => {
    const challenge = FedFrameSchema.parse({
      fed: "challenge", engineId: "studio", protocolVersion: 1,
      nonce: "0123456789abcdef", signature: "sig",
    });
    expect(challenge.fed).toBe("challenge");

    const card = { engineId: "studio", protocolVersion: 1, features: [], providers: [], accounts: [] };
    const auth = FedFrameSchema.parse({ fed: "auth", signature: "sig", card });
    expect(auth.fed).toBe("auth");

    const welcome = FedFrameSchema.parse({ fed: "welcome", card });
    expect(welcome.fed).toBe("welcome");

    const err = FedFrameSchema.parse({ fed: "error", code: "bad_signature", message: "nope" });
    expect(err.fed).toBe("error");
  });

  it("rejects a fed frame with an unknown key on a matched variant (strict)", () => {
    expect.assertions(1);
    expect(() => FedFrameSchema.parse({
      fed: "hello", engineId: "mbp", protocolVersion: 1, nonce: "0123456789abcdef", extra: true,
    })).toThrow();
  });

  it("rejects a fed frame missing the discriminator", () => {
    expect.assertions(1);
    expect(() => FedFrameSchema.parse({ engineId: "mbp", protocolVersion: 1, nonce: "0123456789abcdef" })).toThrow();
  });

  it("challengePayload produces distinct output when only nonceA or nonceB differs", () => {
    const base = challengePayload("nA", "nB", "mbp", "studio");
    expect(Buffer.compare(base, challengePayload("nA2", "nB", "mbp", "studio"))).not.toBe(0);
    expect(Buffer.compare(base, challengePayload("nA", "nB2", "mbp", "studio"))).not.toBe(0);
  });
});

describe("peer method allowlist", () => {
  it("exposes exactly the peer subprotocol — local admin surface excluded", () => {
    expect(isPeerMethod("agent.spawn")).toBe(true);
    expect(isPeerMethod("mailbox.forward")).toBe(true);
    for (const m of ["daemon.stop", "subscribe", "daemon.hello", "agent.wait", "agent.permissionRespond", "team.create"])
      expect(isPeerMethod(m)).toBe(false);
    expect(PEER_METHODS).toContain("accounts.list");
  });

  it("PEER_METHODS contains exactly the 9 documented methods, nothing more/less", () => {
    expect([...PEER_METHODS].sort()).toEqual([
      "accounts.list", "agent.kill", "agent.result", "agent.send",
      "agent.spawn", "agent.status", "agent.tail", "mailbox.forward", "peer.status",
    ].sort());
  });

  it("rejects an empty string and is case-sensitive", () => {
    expect(isPeerMethod("")).toBe(false);
    expect(isPeerMethod("AGENT.SPAWN")).toBe(false);
    expect(isPeerMethod("Agent.Spawn")).toBe(false);
  });
});

describe("mailbox.forward wire shape", () => {
  it("preserves sender-assigned id/ts and origin engineId", () => {
    const p = MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-1", ts: 111, from: "studio/child9", kind: "child_result", text: "done", engineId: "studio" },
    });
    expect(p.message.id).toBe("m-1");
    expect(p.message.engineId).toBe("studio");
  });

  it("accepts an optional meta record and omits it when absent", () => {
    const withMeta = MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-2", ts: 1, from: "studio/c1", kind: "signal", text: "", engineId: "studio", meta: { foo: "bar" } },
    });
    expect(withMeta.message.meta).toEqual({ foo: "bar" });

    const withoutMeta = MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-3", ts: 1, from: "studio/c1", kind: "user_message", text: "hi", engineId: "studio" },
    });
    expect(withoutMeta.message.meta).toBeUndefined();
  });

  it("rejects an unknown message kind", () => {
    expect.assertions(1);
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-4", ts: 1, from: "studio/c1", kind: "bogus_kind", text: "x", engineId: "studio" },
    })).toThrow();
  });

  it("rejects a message missing engineId (origin tag mandatory)", () => {
    expect.assertions(1);
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-5", ts: 1, from: "studio/c1", kind: "signal", text: "x" },
    })).toThrow();
  });

  it("rejects an unknown top-level key (strict) and an unknown nested message key", () => {
    expect.assertions(2);
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "a1", bogus: 1,
      message: { id: "m-6", ts: 1, from: "studio/c1", kind: "signal", text: "x", engineId: "studio" },
    })).toThrow();
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "m-7", ts: 1, from: "studio/c1", kind: "signal", text: "x", engineId: "studio", bogus: 1 },
    })).toThrow();
  });

  it("rejects an empty agentId or empty message.id (min(1) boundaries)", () => {
    expect.assertions(2);
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "",
      message: { id: "m-8", ts: 1, from: "studio/c1", kind: "signal", text: "x", engineId: "studio" },
    })).toThrow();
    expect(() => MailboxForwardParamsSchema.parse({
      agentId: "a1",
      message: { id: "", ts: 1, from: "studio/c1", kind: "signal", text: "x", engineId: "studio" },
    })).toThrow();
  });
});

describe("federated spawn safety + addressing", () => {
  it("assertFederationSafeSpec rejects providerOptions env/auth smuggling", () => {
    const ok = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", providerOptions: { maxThinkingTokens: 1 } });
    expect(() => assertFederationSafeSpec(ok)).not.toThrow();
    const env = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", providerOptions: { env: { ANTHROPIC_API_KEY: "sk" } } });
    expect(() => assertFederationSafeSpec(env)).toThrow(expect.objectContaining({ code: "guardrail" }));
    const tok = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", providerOptions: { authToken: "sk" } });
    expect(() => assertFederationSafeSpec(tok)).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec rejects a non-empty plugins list (executor-side code-load), but allows the empty default (WS-E)", () => {
    const none = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });                       // default plugins: []
    expect(() => assertFederationSafeSpec(none)).not.toThrow();
    const withPlugins = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", plugins: [{ type: "local", path: "/evil" }] });
    expect(() => assertFederationSafeSpec(withPlugins)).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec also blocks the providerOptions.plugins back-channel (spread last into SDK options) (WS-E)", () => {
    // `plugins` reaches options.plugins via the last-wins ...providerOptions spread, so it must
    // be rejected on a federated spec even when smuggled through the escape hatch, not just as spec.plugins.
    const smuggled = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", providerOptions: { plugins: [{ type: "local", path: "/evil" }] } });
    expect(() => assertFederationSafeSpec(smuggled)).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("deliverTo now accepts ONE engine qualifier and still rejects deeper paths", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "studio/a1" }).deliverTo).toBe("studio/a1");
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "a1" }).deliverTo).toBe("a1");
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "a/b/c" })).toThrow();
    expect(parseAgentAddress("studio/a1")).toEqual({ engineId: "studio", localId: "a1" });
    expect(formatAgentAddress("studio", "a1")).toBe("studio/a1");
  });

  it("assertFederationSafeSpec rejects each individual unsafe-key pattern (key, secret, credential, token/case-insensitive, snake_case)", () => {
    expect.assertions(4);
    expect(() => assertFederationSafeSpec({ providerOptions: { apiKey: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { mySecret: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { credentialBundle: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { AUTH_TOKEN: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec does NOT flag maxThinkingTokens because it is an explicit allowlisted safe key, not because 'token' is exempt from substring matching (fix pass: aggressive matcher + allowlist)", () => {
    expect(() => assertFederationSafeSpec({ providerOptions: { maxThinkingTokens: 5 } })).not.toThrow();
  });

  it("assertFederationSafeSpec rejects glued-lowercase credential keys with no camelCase/snake_case boundary (regression: fix pass)", () => {
    expect.assertions(5);
    expect(() => assertFederationSafeSpec({ providerOptions: { apikey: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { authtoken: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { mysecret: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { clientsecret: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { credentialbundle: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec rejects a plural credential key (apiKeys) (regression: fix pass)", () => {
    expect(() => assertFederationSafeSpec({ providerOptions: { apiKeys: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec rejects glued-lowercase and plural 'token' family keys that the prior exact-segment-only 'token' match let through (regression: fix pass 2, federation trust-boundary finding)", () => {
    expect.assertions(5);
    expect(() => assertFederationSafeSpec({ providerOptions: { accesstoken: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { sessiontoken: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { accessTokens: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { xtoken: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
    expect(() => assertFederationSafeSpec({ providerOptions: { bearertoken: "x" } })).toThrow(expect.objectContaining({ code: "guardrail" }));
  });

  it("assertFederationSafeSpec throws a PLAIN OBJECT, not an Error instance", () => {
    expect.assertions(2);
    try {
      assertFederationSafeSpec({ providerOptions: { env: {} } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).not.toBeInstanceOf(Error);
      expect(e).toEqual({ code: "guardrail", message: expect.stringContaining("env") });
    }
  });

  it("assertFederationSafeSpec passes through an empty providerOptions object (n<=0 boundary)", () => {
    expect(() => assertFederationSafeSpec({ providerOptions: {} })).not.toThrow();
  });

  it("deliverTo rejects a trailing-slash / empty-segment address", () => {
    expect.assertions(2);
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "studio/" })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "/a1" })).toThrow();
  });

  it("deliverTo still allows null (default) after the widening", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t" }).deliverTo).toBeNull();
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: null }).deliverTo).toBeNull();
  });
});
