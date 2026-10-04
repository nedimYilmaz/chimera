import { describe, it, expect, afterEach } from "vitest";
import {
  encodePairBlob, decodePairBlob, PAIR_BLOB_PREFIX, type PairBlob,
} from "@chimera/protocol";

// A pairing blob crosses a Node<->browser boundary: the daemon (Node) mints it via
// fed.invite.create; the operator pastes it into the app's webview (browser) join field. The
// codec must be isomorphic — no Buffer, which is undefined in the webview runtime. These tests
// pin the round-trip (incl. unicode) and prove the codec works with globalThis.Buffer deleted.

const sample: PairBlob = {
  card: {
    engineId: "studio",                // engineId charset is constrained; unicode lives elsewhere
    protocolVersion: 1,
    features: ["federation.v1"],
    providers: ["claude"],
    accounts: [{ name: "main", provider: "claude" }],
    publicKey: "MCowBQYDK2VwAyEA" + "x".repeat(20),
  },
  endpoint: { socketPath: "/tmp/chimera-studio.sock" },
  inviteToken: "0123456789abcdef0123456789abcdef",
  exp: 1_800_000_000_000,
};

describe("pairing blob codec (isomorphic)", () => {
  it("keeps the exact prefix + base64 body format", () => {
    const blob = encodePairBlob(sample);
    expect(blob.startsWith(PAIR_BLOB_PREFIX)).toBe(true);
    const body = blob.slice(PAIR_BLOB_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);   // standard base64 alphabet
  });

  it("round-trips a plain payload", () => {
    expect(decodePairBlob(encodePairBlob(sample))).toEqual(sample);
  });

  it("round-trips arbitrary unicode payloads (multi-byte UTF-8)", () => {
    const unicode: PairBlob = {
      ...sample,
      card: { ...sample.card, accounts: [{ name: "エンジン-日本語-😀-Ω-café", provider: "claude" }] },
      endpoint: { socketPath: "/tmp/naïve-Ωpath-💾.sock" },
      inviteToken: "тОкен-鍵-🔑-ﷺ",
    };
    const decoded = decodePairBlob(encodePairBlob(unicode));
    expect(decoded).toEqual(unicode);
    expect(decoded.card.accounts[0].name).toBe("エンジン-日本語-😀-Ω-café");
    expect(decoded.endpoint.socketPath).toBe("/tmp/naïve-Ωpath-💾.sock");
  });

  it("emits base64 byte-for-byte identical to Node's Buffer (daemon<->browser interop)", () => {
    // The daemon mints blobs with Node's Buffer historically; the browser reads them. The
    // Buffer-free encoder MUST produce the exact same bytes or the two sides can't interop.
    const unicode: PairBlob = {
      ...sample,
      card: { ...sample.card, accounts: [{ name: "本番-😀", provider: "claude" }] },
      inviteToken: "тОкен-鍵-🔑",
    };
    const ours = encodePairBlob(unicode).slice(PAIR_BLOB_PREFIX.length);
    const node = Buffer.from(JSON.stringify(unicode), "utf8").toString("base64");
    expect(ours).toBe(node);
  });

  it("throws {code:'protocol'} on a bad prefix", () => {
    expect(() => decodePairBlob("nope;abcd")).toThrow(
      expect.objectContaining({ code: "protocol" }),
    );
  });

  it("throws {code:'protocol'} on a valid-prefix but garbage body", () => {
    expect(() => decodePairBlob(PAIR_BLOB_PREFIX + "!!!not base64!!!")).toThrow(
      expect.objectContaining({ code: "protocol" }),
    );
  });
});

describe("pairing blob codec — browser runtime (no Buffer)", () => {
  const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;
  afterEach(() => {
    (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
  });

  it("encodes AND decodes with globalThis.Buffer deleted (simulated webview)", () => {
    // Simulate the app's browser/webview runtime where Buffer is undefined. Any reference to
    // Buffer inside the codec would throw a ReferenceError here instead of round-tripping.
    delete (globalThis as { Buffer?: unknown }).Buffer;
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();

    const blob = encodePairBlob(sample);
    expect(blob.startsWith(PAIR_BLOB_PREFIX)).toBe(true);
    expect(decodePairBlob(blob)).toEqual(sample);
  });

  it("produces a body byte-for-byte identical across Buffer-present and Buffer-deleted runs", () => {
    // The daemon (Buffer present) and the webview (Buffer absent) must mint/read the SAME bytes.
    const withBuffer = encodePairBlob(sample);
    delete (globalThis as { Buffer?: unknown }).Buffer;
    const withoutBuffer = encodePairBlob(sample);
    expect(withoutBuffer).toBe(withBuffer);
  });
});
