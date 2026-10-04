import { describe, expect, it } from "vitest";
import { McpStoreEntrySchema, McpStoreServerSpecSchema, McpStoreImportableSchema, McpStoreHttpAuthSchema } from "@chimera/protocol";

describe("MCP store schemas", () => {
  it("loads legacy entries without a type as stdio", () => {
    expect(McpStoreEntrySchema.parse({ name: "legacy", command: "node" })).toEqual({
      name: "legacy", type: "stdio", command: "node", args: [], env: {}, direct: false, enabled: true, trust: "full",
    });
  });

  it("round-trips stdio and http server specs", () => {
    const specs = [
      { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "x" } },
      { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
    ] as const;
    for (const spec of specs) {
      const parsed = McpStoreServerSpecSchema.parse(spec);
      expect(McpStoreServerSpecSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it("defaults http headers and rejects missing url or stdio-only fields", () => {
    expect(McpStoreEntrySchema.parse({ name: "remote", type: "http", url: "https://mcp.example.com" })).toEqual({
      name: "remote", type: "http", url: "https://mcp.example.com", headers: {}, direct: false, enabled: true, trust: "full",
    });
    expect(() => McpStoreEntrySchema.parse({ name: "remote", type: "http" })).toThrow();
    expect(() => McpStoreEntrySchema.parse({ name: "remote", type: "http", url: "https://mcp.example.com", command: "node" })).toThrow();
  });

  // MCP-REMOTE-IMPORT slice 1: an old stdio mcpstore.json entry (no `auth` field at all,
  // predating this change) must still parse byte-identically -- `auth` is optional and
  // absent, never defaulted to some object.
  it("an old stdio entry with no auth field parses unchanged (and defaults trust to full)", () => {
    const legacy = { type: "stdio" as const, command: "npx", args: ["-y", "pkg"], env: { TOKEN: "x" }, direct: false, enabled: true };
    expect(McpStoreServerSpecSchema.parse(legacy)).toEqual({ ...legacy, trust: "full" });
  });

  // An old http entry (predating `auth`) also parses unchanged -- no `auth` key appears.
  it("an old http entry with no auth field parses unchanged (and defaults trust to full)", () => {
    const legacy = { type: "http" as const, url: "https://mcp.example.com/mcp", headers: {}, direct: false, enabled: true };
    const parsed = McpStoreServerSpecSchema.parse(legacy);
    expect(parsed).toEqual({ ...legacy, trust: "full" });
    expect("auth" in parsed).toBe(false);
  });

  it("an http spec with keychain-backed auth round-trips through JSON", () => {
    const spec = {
      type: "http" as const,
      url: "https://mcp.example.com/mcp",
      headers: {},
      direct: false,
      enabled: true,
      auth: { header: "X-Api-Key", scheme: "Token", keychainRef: "chimera:mcp:remote-one" },
    };
    const parsed = McpStoreServerSpecSchema.parse(spec);
    expect(parsed).toEqual({ ...spec, auth: { ...spec.auth, kind: "bearer" }, trust: "full" });
    expect(McpStoreServerSpecSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("an http auth without header/scheme defaults nothing but `kind` at the schema layer (consumer defaults header/scheme)", () => {
    const spec = { type: "http" as const, url: "https://mcp.example.com/mcp", headers: {}, direct: false, enabled: true, auth: { keychainRef: "chimera:mcp:x" } };
    expect(McpStoreServerSpecSchema.parse(spec)).toEqual({ ...spec, auth: { ...spec.auth, kind: "bearer" }, trust: "full" });
  });

  // TRUST-TIER: an explicit trust value round-trips; an unrecognised value fails CLOSED to
  // "untrusted" (never silently falls back to the permissive default -- a typo must not
  // disable gating). Absent (tested above via the legacy fixtures) -> "full".
  describe("McpStoreTrustSchema (fail-closed)", () => {
    it("an explicit trust:\"untrusted\" round-trips", () => {
      const spec = { type: "stdio" as const, command: "node", args: [], env: {}, direct: false, enabled: true, trust: "untrusted" as const };
      expect(McpStoreServerSpecSchema.parse(spec)).toEqual(spec);
    });

    it("an explicit trust:\"full\" round-trips", () => {
      const spec = { type: "stdio" as const, command: "node", args: [], env: {}, direct: false, enabled: true, trust: "full" as const };
      expect(McpStoreServerSpecSchema.parse(spec)).toEqual(spec);
    });

    it("an unrecognised trust string (a typo) fails CLOSED to \"untrusted\", not to the default \"full\"", () => {
      const spec = { type: "stdio" as const, command: "node", args: [], env: {}, direct: false, enabled: true, trust: "Full" };
      expect(McpStoreServerSpecSchema.parse(spec).trust).toBe("untrusted");
    });

    it("a bogus non-enum trust value also fails closed to \"untrusted\"", () => {
      const spec = { type: "stdio" as const, command: "node", args: [], env: {}, direct: false, enabled: true, trust: "yolo" };
      expect(McpStoreServerSpecSchema.parse(spec).trust).toBe("untrusted");
    });
  });

  // MCP-OAUTH slice 1: a bearer auth entry persisted BEFORE `kind` existed (no `kind` key at
  // all) must still parse to kind:"bearer" byte-identically to every other field -- the whole
  // point of `.default("bearer")` is that an operator's existing mcpstore.json never needs a
  // migration for this change.
  it("a pre-existing bearer auth entry with no `kind` field parses as kind:\"bearer\" unchanged", () => {
    const legacyAuth = { header: "X-Api-Key", scheme: "Token", keychainRef: "chimera:mcp:remote-one" };
    expect(McpStoreHttpAuthSchema.parse(legacyAuth)).toEqual({ ...legacyAuth, kind: "bearer" });
  });

  it("an oauth-kind auth round-trips through JSON and rejects unknown keys (.strict())", () => {
    const auth = { kind: "oauth" as const, keychainRef: "chimera:mcp:remote-one", scopes: ["read", "write"] };
    const parsed = McpStoreHttpAuthSchema.parse(auth);
    expect(parsed).toEqual(auth);
    expect(McpStoreHttpAuthSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(auth);
    expect(() => McpStoreHttpAuthSchema.parse({ ...auth, bogus: 1 })).toThrow();
  });

  it("rejects a `kind` value that isn't bearer or oauth", () => {
    expect(() => McpStoreHttpAuthSchema.parse({ kind: "apikey", keychainRef: "x" })).toThrow();
  });

  it("auth.keychainRef is required and auth rejects unknown keys (.strict())", () => {
    expect(() => McpStoreServerSpecSchema.parse({ type: "http", url: "https://mcp.example.com", auth: {} }))
      .toThrow();
    expect(() => McpStoreServerSpecSchema.parse({
      type: "http", url: "https://mcp.example.com", auth: { keychainRef: "x", secret: "leaked" },
    })).toThrow();
  });

  it("mcpstore.setAuth-style auth is never accepted on a stdio spec", () => {
    expect(() => McpStoreServerSpecSchema.parse({
      type: "stdio", command: "node", auth: { keychainRef: "chimera:mcp:x" },
    })).toThrow();
  });

  it("McpStoreImportableSchema keeps parsing an existing stdio importable unchanged (no new fields present)", () => {
    const importable = { source: "claude" as const, name: "ui5-mcp-server", command: "npx", args: ["-y", "@ui5/mcp-server"], env: {} };
    expect(McpStoreImportableSchema.parse(importable)).toEqual(importable);
  });

  it("McpStoreImportableSchema accepts a remote (http) importable row", () => {
    const importable = {
      source: "claude" as const, name: "remote-one", type: "http" as const,
      url: "https://mcp.example.com/mcp", headers: {}, requiresAuth: true,
    };
    expect(McpStoreImportableSchema.parse(importable)).toEqual(importable);
  });
});
