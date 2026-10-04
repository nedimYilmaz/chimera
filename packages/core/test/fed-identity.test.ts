import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineIdentity, verifySignature } from "@chimera/core/federation/identity";

describe("EngineIdentity", () => {
  it("creates a keypair once (0600) and loads it stably", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-id-"));
    const id1 = EngineIdentity.loadOrCreate(home);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(statSync(join(home, "engine_key")).mode & 0o777).toBe(0o600);
    const id2 = EngineIdentity.loadOrCreate(home);            // load, not regenerate
    expect(id2.publicKey).toBe(id1.publicKey);
    expect(id1.publicKey.length).toBeGreaterThan(20);
  });

  it("signs and verifies; rejects the wrong key and tampered payloads", () => {
    const a = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-id-a-")));
    const b = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-id-b-")));
    const payload = Buffer.from("nA\nnB\nmbp\nstudio", "utf8");
    const sig = a.sign(payload);
    expect(verifySignature(a.publicKey, payload, sig)).toBe(true);
    expect(verifySignature(b.publicKey, payload, sig)).toBe(false);                       // wrong key
    expect(verifySignature(a.publicKey, Buffer.from("tampered"), sig)).toBe(false);       // wrong payload
    expect(verifySignature(a.publicKey, payload, "not-base64!!")).toBe(false);            // garbage never throws
    expect(verifySignature("garbage-key", payload, sig)).toBe(false);
  });

  it("writes engine_key.pub as base64 matching the loaded publicKey", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-id-pub-"));
    const id = EngineIdentity.loadOrCreate(home);
    expect(existsSync(join(home, "engine_key.pub"))).toBe(true);
    const pubFileContents = readFileSync(join(home, "engine_key.pub"), "utf8").trim();
    expect(pubFileContents).toBe(id.publicKey);
  });

  it("creates the home directory recursively when it does not already exist", () => {
    const base = mkdtempSync(join(tmpdir(), "chimera-id-nested-"));
    const home = join(base, "nested", "subdir");
    expect(existsSync(home)).toBe(false);
    const id = EngineIdentity.loadOrCreate(home);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(id.publicKey.length).toBeGreaterThan(20);
  });

  it("remains stable across more than two loadOrCreate calls", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-id-stable-"));
    const id1 = EngineIdentity.loadOrCreate(home);
    const id2 = EngineIdentity.loadOrCreate(home);
    const id3 = EngineIdentity.loadOrCreate(home);
    expect(id2.publicKey).toBe(id1.publicKey);
    expect(id3.publicKey).toBe(id1.publicKey);
  });

  it("forces private key mode to 0600 even when the process umask would allow it wider", () => {
    const originalUmask = process.umask(0o000); // widest possible umask: would leave requested mode untouched by masking, but proves chmodSync is the enforcer, not luck
    try {
      const home = mkdtempSync(join(tmpdir(), "chimera-id-umask-"));
      EngineIdentity.loadOrCreate(home);
      expect(statSync(join(home, "engine_key")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });

  it("signs and verifies an empty payload buffer", () => {
    const id = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-id-empty-")));
    const empty = Buffer.from("", "utf8");
    const sig = id.sign(empty);
    expect(verifySignature(id.publicKey, empty, sig)).toBe(true);
  });

  it("sign() never throws for a freshly created or freshly loaded identity", () => {
    expect.assertions(2);
    const home = mkdtempSync(join(tmpdir(), "chimera-id-signthrow-"));
    const fresh = EngineIdentity.loadOrCreate(home);
    expect(() => fresh.sign(Buffer.from("payload"))).not.toThrow();
    const loaded = EngineIdentity.loadOrCreate(home);
    expect(() => loaded.sign(Buffer.from("payload"))).not.toThrow();
  });
});

describe("verifySignature — malformed-input edge cases (must return false, never throw)", () => {
  it("never throws regardless of input shape", () => {
    // Self-guarding: assert the call count so a silently-skipped assertion inside a
    // bare try/catch cannot make this test pass without actually exercising the guard.
    expect.assertions(8);

    const a = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-id-edge-a-")));
    const payload = Buffer.from("edge-case-payload", "utf8");
    const sig = a.sign(payload);

    expect(() => verifySignature("", payload, sig)).not.toThrow();
    expect(verifySignature("", payload, sig)).toBe(false); // empty public key

    expect(() => verifySignature(a.publicKey, payload, "")).not.toThrow();
    expect(verifySignature(a.publicKey, payload, "")).toBe(false); // empty signature

    expect(() => verifySignature("", payload, "")).not.toThrow();
    expect(verifySignature("", payload, "")).toBe(false); // both empty

    // Valid SPKI/DER of a *different* key type (RSA, not ed25519) — decodes fine as a
    // key but the ed25519 signature cannot verify against it; must be caught, not thrown.
    const rsaPub = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    expect(() => verifySignature(rsaPub, payload, sig)).not.toThrow();
    expect(verifySignature(rsaPub, payload, sig)).toBe(false); // wrong key type
  });

  it("rejects a base64 payload that decodes to valid bytes but not a valid SPKI structure", () => {
    const a = EngineIdentity.loadOrCreate(mkdtempSync(join(tmpdir(), "chimera-id-edge-b-")));
    const payload = Buffer.from("edge-case-payload-2", "utf8");
    const sig = a.sign(payload);
    const notASpkiKey = Buffer.from("just some random bytes, not a key at all!!").toString("base64");
    expect(verifySignature(notASpkiKey, payload, sig)).toBe(false);
  });
});
