import { describe, it, expect } from "vitest";
import { AuditActionSchema, ChimeraConfigSchema } from "../src/index.js";

// F49 LOOPBACK-MCP: the schema half of "loopback-only by construction". The config surface is
// deliberately a single boolean — there is no bind/port/interface knob to get wrong — and the
// inner .strict() is what turns an operator's hopeful `bind` key into a parse error instead of
// a silently ignored one.
describe("ChimeraConfigSchema.mcpListener", () => {
  const base = {
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    failoverCooldownMinutes: 30,
    caps: { maxAgentsTotal: 12, perAccount: { main: 6 } },
  };

  it("an existing config with no mcpListener key parses byte-identically and is disabled", () => {
    const parsed = ChimeraConfigSchema.parse(base);
    // every pre-existing key survives untouched...
    expect(parsed.accounts).toEqual(base.accounts);
    expect(parsed.autoOrder).toEqual(base.autoOrder);
    expect(parsed.failoverCooldownMinutes).toBe(30);
    expect(parsed.caps.maxAgentsTotal).toBe(12);
    // ...and the only new key defaults to off, identically to spelling it out.
    expect(parsed.mcpListener).toEqual({ enabled: false });
    expect(parsed).toEqual(ChimeraConfigSchema.parse({ ...base, mcpListener: { enabled: false } }));
  });

  it("mcpListener: { bind: \"0.0.0.0\" } is rejected by .strict()", () => {
    expect(() => ChimeraConfigSchema.parse({ ...base, mcpListener: { bind: "0.0.0.0" } })).toThrow();
    expect(() => ChimeraConfigSchema.parse({ ...base, mcpListener: { enabled: true, port: 8080 } })).toThrow();
    // the one field it does have still works
    expect(ChimeraConfigSchema.parse({ ...base, mcpListener: { enabled: true } }).mcpListener.enabled).toBe(true);
  });

  it("\"mcp_listener_grant\" is an accepted AuditAction", () => {
    expect(AuditActionSchema.parse("mcp_listener_grant")).toBe("mcp_listener_grant");
  });
});
