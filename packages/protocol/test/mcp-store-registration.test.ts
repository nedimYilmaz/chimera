import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_TOOL_TABLE } from "@chimera/protocol";

describe("agent MCP registration cannot bypass operator review", () => {
  const tool = MCP_TOOL_TABLE.find((t) => t.name === "mcp_store_add")!;
  it("always proposes a disabled/untrusted server, even with injected enable/trust fields", () => {
    const input = { name: "proposed", command: "node", args: ["server.js"], enabled: true, trust: "full" };
    const parsed = z.object(tool.inputSchema).parse(input);
    for (const args of [parsed, input]) expect(tool.resolve(args)).toEqual({
      kind: "rpc", method: "mcpstore.add", params: { name: "proposed", command: "node", args: ["server.js"], env: {}, enabled: false, trust: "untrusted" },
    });
  });
  it("maps a remote url to a disabled/untrusted http proposal with no auth/headers/direct", () => {
    const expected = { kind: "rpc", method: "mcpstore.add", params: { name: "remote", type: "http", url: "https://mcp.example.com/mcp", enabled: false, trust: "untrusted" } };
    expect(tool.resolve({ name: "remote", url: "https://mcp.example.com/mcp" })).toEqual(expected);
    expect(tool.resolve({ name: "remote", url: "http://localhost:8080/mcp" })).toMatchObject({ kind: "rpc", params: { type: "http", url: "http://localhost:8080/mcp" } });
  });
  it("drops every injected enable/trust/credential field on an http proposal", () => {
    const input = {
      name: "remote", url: "https://mcp.example.com/mcp", enabled: true, trust: "full", direct: true,
      auth: { kind: "bearer", token: "x" }, headers: { Authorization: "Bearer secret" },
    };
    const parsed = z.object(tool.inputSchema).parse(input);
    for (const args of [parsed, input]) {
      expect(tool.resolve(args)).toEqual({
        kind: "rpc", method: "mcpstore.add", params: { name: "remote", type: "http", url: "https://mcp.example.com/mcp", enabled: false, trust: "untrusted" },
      });
    }
  });
  it.each([
    ["neither command nor url", { name: "x" }],
    ["both command and url", { name: "x", command: "node", url: "https://mcp.example.com/mcp" }],
    ["url with args", { name: "x", url: "https://mcp.example.com/mcp", args: ["a"] }],
    ["url with env", { name: "x", url: "https://mcp.example.com/mcp", env: { A: "b" } }],
    ["a non-absolute url", { name: "x", url: "mcp.example.com/mcp" }],
    ["a non-http(s) scheme", { name: "x", url: "ftp://mcp.example.com/mcp" }],
    ["a stdio-smuggling scheme", { name: "x", url: "file:///etc/passwd" }],
    ["credentials embedded in the url", { name: "x", url: "https://user:secret@mcp.example.com/mcp" }],
    ["a username-only url", { name: "x", url: "https://token@mcp.example.com/mcp" }],
    ["the cloud-metadata literal", { name: "x", url: "http://169.254.169.254/latest/meta-data" }],
    ["the metadata literal in decimal form", { name: "x", url: "http://2852039166/" }],
    ["the unspecified address", { name: "x", url: "http://0.0.0.0:8080/mcp" }],
    ["an IPv6 link-local literal", { name: "x", url: "http://[fe80::1]/mcp" }],
    ["an IPv4-mapped metadata literal", { name: "x", url: "http://[::ffff:169.254.169.254]/" }],
  ])("rejects %s without reaching the engine", (_label, input) => {
    expect(tool.resolve(input)).toMatchObject({ kind: "error", error: { code: "protocol" } });
  });
  it("still accepts localhost and a private LAN address (a local HTTP MCP server is a valid proposal)", () => {
    for (const url of ["http://localhost:8080/mcp", "http://192.168.1.20:3000/mcp"]) {
      expect(tool.resolve({ name: "x", url })).toMatchObject({ kind: "rpc", method: "mcpstore.add" });
    }
  });
  it("describes proposal semantics, not an install", () => {
    expect(tool.description).toMatch(/DISABLED and UNTRUSTED/);
    expect(tool.description).toMatch(/url/);
    expect(tool.description).toMatch(/operator reviews/i);
  });
  it("does not expose package lifecycle or enable/trust administration as tools", () => {
    expect(MCP_TOOL_TABLE.some((t) => /mcp.*(?:package|set_enabled|set_trust)/.test(t.name))).toBe(false);
  });
});
