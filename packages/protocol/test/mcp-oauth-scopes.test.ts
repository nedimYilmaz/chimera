import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema, findMcpOAuthGateway, resolveDefaultOAuthScopes, type McpOAuthGateway } from "../src/index.js";

// MCP-OAUTH-FOREIGN-SCOPES: chimera used to stamp a gateway's downstream scope catalog onto EVERY
// oauth-kind http entry. Measured against the real servers this bit on: cloudflare advertises no
// scopes_supported at all, context7 advertises openid/profile/email/..., atlassian advertises 32
// of its own — none overlap a gateway's private list, and connecting cloudflare came back
// Unauthorized because of it. The catalog is now operator config (`mcpOAuthGateways`).

const GATEWAYS: McpOAuthGateway[] = [
  { hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets"], optionalScopes: ["admin"] },
];

describe("default oauth scopes for an mcp store server", () => {
  it("uses what the server itself advertises, over a configured gateway's catalog", () => {
    const advertised = ["openid", "profile", "email", "offline_access"];
    expect(resolveDefaultOAuthScopes("https://mcp.context7.com/mcp", advertised, GATEWAYS)).toEqual(advertised);
  });

  it("sends NO scope for a foreign server that advertises none — cloudflare's exact shape", () => {
    // RFC 6749 §3.3 makes `scope` optional and the AS then applies its registered default;
    // an unknown scope is an outright error on most servers. "No opinion" beats "wrong opinion".
    expect(resolveDefaultOAuthScopes("https://mcp.cloudflare.com/mcp", undefined, GATEWAYS)).toBeUndefined();
    expect(resolveDefaultOAuthScopes("https://mcp.cloudflare.com/mcp", [], GATEWAYS)).toBeUndefined();
  });

  it("applies the matched gateway's defaultScopes (never its optionalScopes) on its own hosts", () => {
    expect(resolveDefaultOAuthScopes("https://gateway.example.com/mcp", undefined, GATEWAYS)).toEqual(["docs", "tickets"]);
    expect(resolveDefaultOAuthScopes("https://jira.mcp.example.com/sse", [], GATEWAYS)).toEqual(["docs", "tickets"]);
  });

  it("prefers a gateway server's OWN advertised scopes when it publishes them", () => {
    expect(resolveDefaultOAuthScopes("https://gateway.example.com/mcp", ["docs"], GATEWAYS)).toEqual(["docs"]);
  });

  it("sends no scope for the gateway's host when no gateway is configured", () => {
    expect(resolveDefaultOAuthScopes("https://gateway.example.com/mcp", undefined, undefined)).toBeUndefined();
    expect(resolveDefaultOAuthScopes("https://gateway.example.com/mcp", undefined, [])).toBeUndefined();
  });

  it("sends no scope for a matched gateway whose defaultScopes is empty", () => {
    const optionalOnly: McpOAuthGateway[] = [{ hosts: ["gateway.example.com"], defaultScopes: [], optionalScopes: ["admin"] }];
    expect(resolveDefaultOAuthScopes("https://gateway.example.com/mcp", undefined, optionalOnly)).toBeUndefined();
  });

  it("returns a copy, never the config's own array", () => {
    const scopes = resolveDefaultOAuthScopes("https://gateway.example.com/mcp", undefined, GATEWAYS)!;
    scopes.push("mutated");
    expect(GATEWAYS[0]!.defaultScopes).toEqual(["docs", "tickets"]);
  });
});

describe("gateway host matching", () => {
  it("matches an exact host entry and any subdomain of a leading-dot entry", () => {
    expect(findMcpOAuthGateway("https://gateway.example.com/mcp", GATEWAYS)).toBe(GATEWAYS[0]);
    expect(findMcpOAuthGateway("https://jira.mcp.example.com/sse", GATEWAYS)).toBe(GATEWAYS[0]);
    expect(findMcpOAuthGateway("https://a.b.mcp.example.com/sse", GATEWAYS)).toBe(GATEWAYS[0]);
  });

  it("compares hostnames case-insensitively, ignoring port and path", () => {
    expect(findMcpOAuthGateway("https://GATEWAY.Example.com:8443/x", GATEWAYS)).toBe(GATEWAYS[0]);
    const upper: McpOAuthGateway[] = [{ hosts: ["Gateway.Example.COM"], defaultScopes: ["docs"] }];
    expect(findMcpOAuthGateway("https://gateway.example.com/mcp", upper)).toBe(upper[0]);
  });

  it("an exact entry does not match subdomains, and a leading-dot entry does not match its apex", () => {
    expect(findMcpOAuthGateway("https://sub.gateway.example.com/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://mcp.example.com/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://example.com/mcp", GATEWAYS)).toBeUndefined();
  });

  it("is a HOST check, not a substring one — a lookalike domain must not inherit the scopes", () => {
    expect(findMcpOAuthGateway("https://gateway.example.com.evil.tld/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://notgateway.example.com/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://evilmcp.example.com/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://evil.tld/?x=gateway.example.com", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://evil.tld/gateway.example.com/mcp", GATEWAYS)).toBeUndefined();
    expect(findMcpOAuthGateway("https://gateway.example.com@evil.tld/mcp", GATEWAYS)).toBeUndefined();
  });

  it("treats an unparseable url as no gateway rather than throwing", () => {
    expect(findMcpOAuthGateway("not a url", GATEWAYS)).toBeUndefined();
    expect(resolveDefaultOAuthScopes("not a url", undefined, GATEWAYS)).toBeUndefined();
  });

  it("returns the FIRST configured gateway whose hosts match", () => {
    const two: McpOAuthGateway[] = [
      { hosts: [".example.com"], defaultScopes: ["first"] },
      { hosts: ["gateway.example.com"], defaultScopes: ["second"] },
    ];
    expect(findMcpOAuthGateway("https://gateway.example.com/mcp", two)).toBe(two[0]);
  });
});

describe("ChimeraConfigSchema.mcpOAuthGateways", () => {
  it("is absent from a config that never sets it", () => {
    expect(ChimeraConfigSchema.parse({}).mcpOAuthGateways).toBeUndefined();
  });

  it("parses a gateway list, optionalScopes optional", () => {
    const parsed = ChimeraConfigSchema.parse({
      mcpOAuthGateways: [...GATEWAYS, { hosts: ["other.example.org"], defaultScopes: ["read"] }],
    });
    expect(parsed.mcpOAuthGateways).toEqual([...GATEWAYS, { hosts: ["other.example.org"], defaultScopes: ["read"] }]);
  });

  it.each([
    ["no hosts", { hosts: [], defaultScopes: ["docs"] }],
    ["a url instead of a host", { hosts: ["https://gateway.example.com/mcp"], defaultScopes: ["docs"] }],
    ["a host with a port", { hosts: ["gateway.example.com:443"], defaultScopes: ["docs"] }],
    ["a bare dot", { hosts: ["."], defaultScopes: ["docs"] }],
    ["an empty host", { hosts: [""], defaultScopes: ["docs"] }],
    ["an empty scope", { hosts: ["gateway.example.com"], defaultScopes: [""] }],
    ["an empty optional scope", { hosts: ["gateway.example.com"], defaultScopes: ["docs"], optionalScopes: [""] }],
    ["missing defaultScopes", { hosts: ["gateway.example.com"] }],
    ["an unknown key", { hosts: ["gateway.example.com"], defaultScopes: ["docs"], scopes: ["x"] }],
  ])("rejects %s", (_label, gateway) => {
    expect(ChimeraConfigSchema.safeParse({ mcpOAuthGateways: [gateway] }).success).toBe(false);
  });
});
