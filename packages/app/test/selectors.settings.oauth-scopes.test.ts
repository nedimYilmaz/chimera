import { describe, it, expect } from "vitest";
import type { McpOAuthGateway } from "@chimera/protocol";
import { defaultMcpOAuthScopeSelection, mcpOAuthScopeCatalog, resolveMcpOAuthScopes } from "../src/state/selectors.settings";

// The add-remote form used to pre-check a gateway's scope catalog for EVERY http server, so an
// operator adding Cloudflare had seven meaningless scopes ticked before they typed anything. The
// catalog now comes from config `mcpOAuthGateways`, and only for a url on a configured gateway.
const GATEWAYS: McpOAuthGateway[] = [
  { hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets"], optionalScopes: ["admin"] },
];

describe("add-remote scope checkboxes", () => {
  it("shows no catalog and pre-checks nothing for a foreign server", () => {
    expect(mcpOAuthScopeCatalog("https://mcp.cloudflare.com/mcp", GATEWAYS)).toEqual([]);
    const sel = defaultMcpOAuthScopeSelection("https://mcp.cloudflare.com/mcp", GATEWAYS);
    expect(sel).toEqual({});
    expect(resolveMcpOAuthScopes(sel, "", [])).toEqual([]);
  });

  it("shows the matched gateway's catalog, defaults checked and optional scopes opt-in", () => {
    expect(mcpOAuthScopeCatalog("https://gateway.example.com/mcp", GATEWAYS)).toEqual(["docs", "tickets", "admin"]);
    const sel = defaultMcpOAuthScopeSelection("https://jira.mcp.example.com/sse", GATEWAYS);
    expect(sel).toEqual({ docs: true, tickets: true, admin: false });
  });

  it("shows no catalog when no gateway is configured, even for what would be a gateway host", () => {
    expect(mcpOAuthScopeCatalog("https://gateway.example.com/mcp", undefined)).toEqual([]);
    expect(mcpOAuthScopeCatalog("https://gateway.example.com/mcp", [])).toEqual([]);
    expect(defaultMcpOAuthScopeSelection("https://gateway.example.com/mcp")).toEqual({});
  });

  it("shows no catalog before a url is typed", () => {
    expect(mcpOAuthScopeCatalog(undefined, GATEWAYS)).toEqual([]);
    expect(defaultMcpOAuthScopeSelection(undefined, GATEWAYS)).toEqual({});
  });

  it("dedupes a scope listed as both default and optional, keeping it a default", () => {
    const overlap: McpOAuthGateway[] = [{ hosts: ["gateway.example.com"], defaultScopes: ["docs"], optionalScopes: ["docs", "admin"] }];
    expect(mcpOAuthScopeCatalog("https://gateway.example.com/mcp", overlap)).toEqual(["docs", "admin"]);
    expect(defaultMcpOAuthScopeSelection("https://gateway.example.com/mcp", overlap)).toEqual({ docs: true, admin: false });
  });

  it("still lets an operator pick an optional catalog scope or a free-text one by hand", () => {
    const catalog = mcpOAuthScopeCatalog("https://gateway.example.com/mcp", GATEWAYS);
    const sel = { ...defaultMcpOAuthScopeSelection("https://gateway.example.com/mcp", GATEWAYS), admin: true };
    expect(resolveMcpOAuthScopes(sel, "custom:read, custom:write", catalog)).toEqual(["docs", "tickets", "admin", "custom:read", "custom:write"]);
  });

  it("ignores a checked scope that is not in the catalog on screen", () => {
    expect(resolveMcpOAuthScopes({ stale: true, docs: true }, "", ["docs"])).toEqual(["docs"]);
  });
});
