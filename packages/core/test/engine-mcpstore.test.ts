import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpStoreEntry, McpStoreImportable } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { McpImportScanner, type FsSeam } from "@chimera/core/mcp-imports";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEngineHome } from "./helpers.js";

// MCP-STORE: the mcpstore.* RPC surface on a real Engine — registry CRUD (P1), dynamic
// discovery (P2, SDK client mocked the same way generic-mcp.test.ts/mcpstore.test.ts do),
// and the importables/import RPC pair (P3, a fake FsSeam-backed McpImportScanner injected
// via Engine's mcpImportScanner test seam).

// CORE-SUITE-BASELINE: pure in-process RPC coordination (mocked SDK client) can still
// exceed vitest's 5000ms default under this machine's concurrent-agent load (event-loop
// scheduling itself gets delayed); widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 15_000 });

const queue: Array<{ tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>; connectError?: string }> = [];
function enqueueClientConfig(cfg: (typeof queue)[number]): void { queue.push(cfg); }

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    cfg: (typeof queue)[number];
    constructor() { this.cfg = queue.shift() ?? {}; }
    async connect() { if (this.cfg.connectError) throw new Error(this.cfg.connectError); }
    async listTools() { return { tools: this.cfg.tools ?? [] }; }
    async callTool() { return { content: [{ type: "text", text: "echo: hi" }] }; }
    async close() {}
  }
  return { Client: MockClient };
});
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  class MockStdioClientTransport { constructor(public params: unknown) {} }
  return { StdioClientTransport: MockStdioClientTransport };
});

// MCP-OAUTH-DISCOVERABILITY: every test below that adds/imports an http entry must NOT hit
// the real network via mcpstore.add/import's auto-detect probe — this stub (never oauth
// unless a case overrides it) keeps every existing assertion about the bearer/no-auth
// shape unchanged and every test deterministic regardless of sandbox network egress.
function engineOn(home: string, opts: { importScanner?: McpImportScanner; detectAuth?: (url: string) => Promise<{ oauth: boolean; authorizationServers?: string[]; scopesSupported?: string[] }> } = {}) {
  const fake = new FakeAgentBackend([]);
  const engine = new Engine({
    home, backends: new Map<string, AgentBackend>([["claude", fake]]),
    mcpStoreDetectAuth: opts.detectAuth ?? (async () => ({ oauth: false })),
    ...(opts.importScanner ? { mcpImportScanner: opts.importScanner } : {}),
  });
  return { engine };
}

beforeEach(() => { queue.length = 0; });

describe("mcpstore.list / add / remove", () => {
  it("does not let ordinary add forge a managed installation record", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.add", {
      name: "forged", type: "stdio", command: "node",
      managed: { id: "12345678-1234-4234-9234-123456789012", ecosystem: "npm", packageName: "fake", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, bin: "fake" },
    })).rejects.toMatchObject({ code: "protocol" });
    expect(engine.mcpStore.list()).toEqual([]);
  });
  it("add persists, list returns it, remove deletes it — surviving an engine restart", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    const added = await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} }) as McpStoreEntry;
    expect(added).toEqual({ name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {}, direct: false, enabled: true, trust: "full" });

    const { engine: e2 } = engineOn(home);
    expect(await e2.handle("mcpstore.list", {})).toEqual([{ name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {}, direct: false, enabled: true, trust: "full" }]);

    expect(await e2.handle("mcpstore.remove", { name: "echo-server" })).toEqual({ name: "echo-server", removed: true });
    expect(await e2.handle("mcpstore.list", {})).toEqual([]);
  });

  it("a duplicate name is a clean protocol error, not a crash", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "x", type: "stdio", command: "node", args: [], env: {} });
    await expect(engine.handle("mcpstore.add", { name: "x", type: "stdio", command: "node", args: [], env: {} }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("an invalid name is rejected by the zod schema (protocol error)", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.add", { name: "Not Valid!", type: "stdio", command: "node", args: [], env: {} }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});

describe("mcpstore.tools / call", () => {
  it("tools() lazily connects and lists; call() proxies a tool invocation", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });

    const result = await engine.handle("mcpstore.tools", {}) as { servers: Array<{ server: string; connected: boolean }> };
    expect(result.servers).toEqual([{ server: "echo-server", connected: true, tools: [{ server: "echo-server", name: "echo", description: "echoes", inputSchema: { type: "object" } }] }]);

    const called = await engine.handle("mcpstore.call", { server: "echo-server", tool: "echo", args: { text: "hi" } });
    expect(called).toEqual({ text: "echo: hi" });
  });

  it("mcpstore.remove tears down a live connection before deleting the entry", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [] });
    await engine.handle("mcpstore.tools", {});
    // removal itself is the observable assertion here — a leaked connection would only
    // surface as a dangling child process, which the connection manager's own unit tests
    // (closeServer) already cover directly; this confirms the RPC wires that call.
    expect(await engine.handle("mcpstore.remove", { name: "s" })).toEqual({ name: "s", removed: true });
  });
});

// FEATURE-6: mcpstore.call now routes through CapabilityBroker.decideMcpStoreCall for its
// audit side-effect — the RPC's own return value (asserted above) is UNCHANGED; these
// cases assert the additional capability_decision event.
describe("mcpstore.call routes through the capability broker (FEATURE-6)", () => {
  it("emits a capability_decision(allow) event under the system 'capability' namespace when no agentId was given", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });

    const called = await engine.handle("mcpstore.call", { server: "echo-server", tool: "echo", args: { text: "hi" } });
    expect(called).toEqual({ text: "echo: hi" });   // unchanged RPC result

    const decision = engine.events.tail("capability", 10).find((e) => e.kind === "capability_decision");
    expect(decision?.data).toMatchObject({
      principal: null, action: "mcp_store_call", resource: "echo-server:echo", decision: "allow",
    });
  });

  it("attributes the event to the caller's agentId when the RPC params carry one", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });

    await engine.handle("mcpstore.call", { server: "echo-server", tool: "echo", args: {}, agentId: "agent-x" });

    expect(engine.events.tail("capability", 10).some((e) => e.kind === "capability_decision")).toBe(false);
    const decision = engine.events.tail("agent-x", 10).find((e) => e.kind === "capability_decision");
    expect(decision?.data).toMatchObject({ principal: "agent-x", action: "mcp_store_call", resource: "echo-server:echo", decision: "allow" });
  });
});

// Tamper-evident audit ledger: the broker's emit closure (engine.ts) dual-writes every
// capability_decision into engine.auditLedger, NOT just engine.events — this is the durable,
// never-pruned copy. audit.verify (the RPC surfacing AuditLedger.verify()) must see it too.
describe("mcpstore.call decisions reach the audit ledger (tamper-evident ledger)", () => {
  it("audit.verify sees the mcp_store_call decision and reports a clean chain", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });

    await engine.handle("mcpstore.call", { server: "echo-server", tool: "echo", args: { text: "hi" }, agentId: "agent-x" });

    const ledgerRecord = engine.auditLedger.verify();
    expect(ledgerRecord.ok).toBe(true);
    expect(ledgerRecord.recordCount).toBeGreaterThanOrEqual(1);

    const result = await engine.handle("audit.verify", {});
    expect(result).toEqual(ledgerRecord);
  });

  it("the ledger record for a mcp_store_call decision matches the event's action/resource/decision", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });

    await engine.handle("mcpstore.call", { server: "echo-server", tool: "echo", args: {}, agentId: "agent-x" });

    // read the raw ledger file directly (not just verify()'s summary) to confirm the actual
    // record content, mirroring how engine.events.tail is asserted against above.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lines = readFileSync(join(home, "audit", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.find((r) => r.action === "mcp_store_call");
    expect(record).toMatchObject({ agentId: "agent-x", resource: "echo-server:echo", decision: "allow" });
  });
});

function fakeScanner(importables: McpStoreImportable[]): McpImportScanner {
  const fs: FsSeam = { exists: () => false, readFile: () => { throw new Error("unused"); } };
  const scanner = new McpImportScanner({ fs });
  scanner.scan = async () => importables;
  return scanner;
}

describe("mcpstore.importables / import", () => {
  it("importables echoes the scanner's findings", async () => {
    const importables: McpStoreImportable[] = [
      { source: "claude", name: "ui5-mcp-server", command: "npx", args: ["-y", "@ui5/mcp-server"], env: {} },
      { source: "claude", name: "slack", notImportableReason: "not importable (claude.ai-managed auth — the connector's credentials live in the claude.ai session, not on this machine)" },
    ];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    expect(await engine.handle("mcpstore.importables", {})).toEqual({ importables });
  });

  it("import copies a found importable into the store, sanitizing the name by default", async () => {
    const importables: McpStoreImportable[] = [{ source: "claude", name: "UI5 MCP Server", command: "npx", args: ["-y", "@ui5/mcp-server"], env: {} }];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    const added = await engine.handle("mcpstore.import", { source: "claude", name: "UI5 MCP Server" }) as McpStoreEntry;
    expect(added).toEqual({ name: "ui5-mcp-server", type: "stdio", command: "npx", args: ["-y", "@ui5/mcp-server"], env: {}, direct: false, enabled: true, trust: "full" });
    expect(await engine.handle("mcpstore.list", {})).toEqual([added]);
  });

  it("import honors an explicit `as` rename", async () => {
    const importables: McpStoreImportable[] = [{ source: "claude", name: "ui5-mcp-server", command: "npx", args: [], env: {} }];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    const added = await engine.handle("mcpstore.import", { source: "claude", name: "ui5-mcp-server", as: "my-ui5" }) as McpStoreEntry;
    expect(added.name).toBe("my-ui5");
  });

  it("import of a remote (http) importable builds an http store entry and surfaces requiresAuth (MCP-REMOTE-IMPORT slice 2)", async () => {
    const importables: McpStoreImportable[] = [
      { source: "claude", name: "cloudflare-docs", type: "http", url: "https://docs.mcp.cloudflare.com/mcp", headers: {}, requiresAuth: true },
    ];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    const added = await engine.handle("mcpstore.import", { source: "claude", name: "cloudflare-docs" }) as McpStoreEntry & { requiresAuth: boolean; auth?: { keychainRef: string } };
    expect(added).toMatchObject({ name: "cloudflare-docs", type: "http", url: "https://docs.mcp.cloudflare.com/mcp", headers: {}, direct: false, requiresAuth: true });
    // MCP-REMOTE-IMPORT slice 3 fix: requiresAuth also wires auth.keychainRef onto
    // the entry itself, so a follow-up mcpstore.setAuth is actually read back at
    // connect time (connectTransport only injects when spec.auth is truthy).
    expect(added.auth?.keychainRef).toBeTruthy();
    expect(await engine.handle("mcpstore.list", {})).toEqual([
      { name: "cloudflare-docs", type: "http", url: "https://docs.mcp.cloudflare.com/mcp", headers: {}, direct: false, enabled: true, trust: "full", auth: { kind: "bearer", keychainRef: added.auth?.keychainRef } },
    ]);
  });

  it("import of a remote importable that does NOT require auth wires no auth.keychainRef (unchanged from slice 2)", async () => {
    const importables: McpStoreImportable[] = [
      { source: "claude", name: "open-docs", type: "http", url: "https://open.example.com/mcp", headers: {}, requiresAuth: false },
    ];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    const added = await engine.handle("mcpstore.import", { source: "claude", name: "open-docs" }) as McpStoreEntry & { requiresAuth: boolean };
    expect(added).toEqual({ name: "open-docs", type: "http", url: "https://open.example.com/mcp", headers: {}, direct: false, enabled: true, trust: "full", requiresAuth: false });
  });

  it("import of a not-importable entry is a clean protocol error naming the reason", async () => {
    const importables: McpStoreImportable[] = [{ source: "claude", name: "slack", notImportableReason: "not importable (claude.ai-managed auth — the connector's credentials live in the claude.ai session, not on this machine)" }];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables) });
    await expect(engine.handle("mcpstore.import", { source: "claude", name: "slack" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("claude.ai-managed auth") });
  });

  it("import of an unknown name is a clean protocol error", async () => {
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner([]) });
    await expect(engine.handle("mcpstore.import", { source: "claude", name: "nope" })).rejects.toMatchObject({ code: "protocol" });
  });
});

// MCP-OAUTH-DISCOVERABILITY: mcpstore.detectAuth (the read-only probe RPC), auto-defaulting
// a fresh add/import to auth.kind:"oauth" when detected, and mcpstore.setAuthKind (the
// Authorize button's retrofit-an-existing-bearer-entry path) — every case below injects the
// mcpStoreDetectAuth seam (never a real network probe, see engineOn's default stub above).
describe("mcpstore.detectAuth / auto-detect on add+import / setAuthKind", () => {
  const oauthDetect = async () => ({ oauth: true, authorizationServers: ["https://as.example.com"], scopesSupported: ["read"] });

  it("detectAuth by url returns the probe's oauth verdict verbatim", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetect });
    const result = await engine.handle("mcpstore.detectAuth", { url: "https://gateway.example.com/mcp" });
    expect(result).toEqual({ oauth: true, authorizationServers: ["https://as.example.com"], scopesSupported: ["read"] });
  });

  it("detectAuth by name resolves the installed entry's stored url", async () => {
    const home = makeEngineHome();
    // added with a "never oauth" stub so the add itself stays a plain bearer-less entry —
    // only the SUBSEQUENT detectAuth call (its own engine, oauthDetect stub) matters here.
    const { engine: adder } = engineOn(home);
    await adder.handle("mcpstore.add", { name: "gateway", type: "http", url: "https://gateway.example.com/mcp" });
    const { engine: prober } = engineOn(home, { detectAuth: oauthDetect });
    expect(await prober.handle("mcpstore.detectAuth", { name: "gateway" })).toMatchObject({ oauth: true });
  });

  it("detectAuth rejects when neither url nor name is given", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.detectAuth", {})).rejects.toMatchObject({ code: "protocol" });
  });

  it("detectAuth by name on an unknown server is a clean protocol error", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.detectAuth", { name: "nope" })).rejects.toMatchObject({ code: "protocol" });
  });

  // MCP-OAUTH-FOREIGN-SCOPES: this used to assert a gateway's own scope catalog for a server
  // on gateway.example.com with NO gateway configured for it. That was the bug, not the contract:
  // chimera stamped the gateway's scope names onto every oauth entry, and a real foreign AS
  // (cloudflare) rejected the authorize round-trip as Unauthorized. A server on no configured
  // gateway (config `mcpOAuthGateways`) now gets no scope at all unless it advertises its own.
  // A probe that says "oauth, but I advertise no scopes" — cloudflare's exact real shape, and
  // the only way to exercise the foreign-vs-gateway fallback (the shared oauthDetect stub
  // advertises ["read"], which correctly wins over both).
  const oauthDetectNoScopes = async () => ({ oauth: true, authorizationServers: ["https://as.example.com"] });
  const GATEWAYS = [{ hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets"], optionalScopes: ["admin"] }];
  const configureGateways = (engine: Engine) => engine.handle("config.patch", { patch: { mcpOAuthGateways: GATEWAYS } });

  it("mcpstore.add defaults a fresh http entry with NO explicit auth to oauth when the probe detects it", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetectNoScopes });
    const added = await engine.handle("mcpstore.add", { name: "gateway", type: "http", url: "https://gateway.example.com/mcp" }) as McpStoreEntry & { auth?: { kind: string; scopes?: string[] } };
    expect(added.auth?.kind).toBe("oauth");
    expect(added.auth?.scopes).toBeUndefined();          // no gateway configured, probe advertised none
  });

  // The agent-facing mcp_store_add sends exactly this shape for a remote URL (see
  // mcp-store-registration.test.ts). Pinned here against the real engine: the schema's
  // enabled:true / trust:"full" http defaults must NOT win over the explicit review state, and the
  // OAuth probe must still run on a disabled entry so the operator finds auth ready to authorize.
  it("an agent-shaped http proposal is stored disabled+untrusted and still gets probed oauth auth", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetectNoScopes });
    const added = await engine.handle("mcpstore.add", { name: "proposal", type: "http", url: "https://gateway.example.com/mcp", enabled: false, trust: "untrusted" }) as McpStoreEntry & { enabled?: boolean; trust?: string; auth?: { kind: string } };
    expect(added.enabled).toBe(false);
    expect(added.trust).toBe("untrusted");
    expect(added.auth?.kind).toBe("oauth");
    const listed = (await engine.handle("mcpstore.list", {}) as Array<McpStoreEntry & { enabled?: boolean; trust?: string }>).find((e) => e.name === "proposal");
    expect(listed).toMatchObject({ enabled: false, trust: "untrusted" });
  });

  it("the server's own advertised scopes win even on a configured gateway's host", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetect });   // advertises ["read"]
    await configureGateways(engine);
    const added = await engine.handle("mcpstore.add", { name: "gw2", type: "http", url: "https://jira.mcp.example.com/mcp" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(added.auth?.scopes).toEqual(["read"]);
  });

  it("mcpstore.add takes the scopes the SERVER advertises, when the probe resolves any", async () => {
    const advertised = ["openid", "profile", "offline_access"];
    const { engine } = engineOn(makeEngineHome(), { detectAuth: async () => ({ oauth: true, scopesSupported: advertised }) });
    const added = await engine.handle("mcpstore.add", { name: "ctx", type: "http", url: "https://mcp.context7.com/mcp" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(added.auth?.scopes).toEqual(advertised);
  });

  it("mcpstore.add applies a configured gateway's defaultScopes (not its optionalScopes) for its OWN hosts", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetectNoScopes });
    await configureGateways(engine);
    const added = await engine.handle("mcpstore.add", { name: "gw", type: "http", url: "https://gateway.example.com/mcp" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(added.auth?.scopes).toEqual(["docs", "tickets"]);
    // ...and only there: a lookalike host stays scope-less.
    const lookalike = await engine.handle("mcpstore.add", { name: "evil", type: "http", url: "https://gateway.example.com.evil.tld/mcp" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(lookalike.auth?.scopes).toBeUndefined();
  });

  it("reads mcpOAuthGateways from config.json at boot, and config.get returns it unredacted", async () => {
    const home = makeEngineHome();
    const cfgPath = join(home, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), mcpOAuthGateways: GATEWAYS }));
    const { engine } = engineOn(home, { detectAuth: oauthDetectNoScopes });
    // The key matches the redactor's /auth/ pattern; only string values are rewritten, so the
    // app's scope catalog depends on this array surviving config.get intact.
    expect((await engine.handle("config.get", {}) as { mcpOAuthGateways?: unknown }).mcpOAuthGateways).toEqual(GATEWAYS);
    const added = await engine.handle("mcpstore.add", { name: "gw", type: "http", url: "https://gateway.example.com/mcp" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(added.auth?.scopes).toEqual(["docs", "tickets"]);
  });

  it("mcpstore.add never overrides an EXPLICIT auth choice, even when the probe detects oauth", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetect });
    const added = await engine.handle("mcpstore.add", {
      name: "gateway", type: "http", url: "https://gateway.example.com/mcp",
      auth: { kind: "bearer", keychainRef: "chimera:mcp:gateway" },
    }) as McpStoreEntry & { auth?: { kind: string } };
    expect(added.auth?.kind).toBe("bearer");
  });

  it("mcpstore.add stays auth-less when the probe does not detect oauth (unchanged from before)", async () => {
    const { engine } = engineOn(makeEngineHome());   // default stub: oauth:false
    const added = await engine.handle("mcpstore.add", { name: "plain", type: "http", url: "https://plain.example.com/mcp" }) as McpStoreEntry;
    expect(added).toEqual({ name: "plain", type: "http", url: "https://plain.example.com/mcp", headers: {}, direct: false, enabled: true, trust: "full" });
  });

  it("mcpstore.import of a remote importable defaults to oauth when the probe detects it, overriding the conservative bearer requiresAuth default", async () => {
    const importables: McpStoreImportable[] = [
      { source: "claude", name: "gateway", type: "http", url: "https://gateway.example.com/mcp", headers: {}, requiresAuth: true },
    ];
    const { engine } = engineOn(makeEngineHome(), { importScanner: fakeScanner(importables), detectAuth: oauthDetect });
    const added = await engine.handle("mcpstore.import", { source: "claude", name: "gateway" }) as McpStoreEntry & { auth?: { kind: string } };
    expect(added.auth?.kind).toBe("oauth");
  });

  // Same correction as the add path above: converting a FOREIGN bearer entry to oauth must not
  // inherit the gateway's catalog. It re-probes the entry's own url instead.
  it("mcpstore.setAuthKind converts an existing bearer entry to oauth, with no scopes for a foreign host", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", {
      name: "gateway", type: "http", url: "https://gateway.example.com/mcp",
      auth: { kind: "bearer", keychainRef: "chimera:mcp:gateway" },
    });
    const converted = await engine.handle("mcpstore.setAuthKind", { name: "gateway", kind: "oauth" }) as McpStoreEntry & { auth?: { kind: string; scopes?: string[] } };
    expect(converted.auth).toMatchObject({ kind: "oauth", keychainRef: "chimera:mcp:gateway" });
    expect(converted.auth?.scopes).toBeUndefined();
    expect(await engine.handle("mcpstore.list", {})).toEqual([converted]);
  });

  it("mcpstore.setAuthKind honours an EXPLICIT scope list, including an empty one", async () => {
    // The app's "clear the scopes" action sends `[]`; falling back to the gateway catalog there
    // would silently re-add the very scopes the operator just removed.
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetectNoScopes });
    await configureGateways(engine);
    await engine.handle("mcpstore.add", { name: "gw", type: "http", url: "https://gateway.example.com/mcp", auth: { kind: "bearer", keychainRef: "chimera:mcp:gw" } });
    const cleared = await engine.handle("mcpstore.setAuthKind", { name: "gw", kind: "oauth", scopes: [] }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(cleared.auth?.scopes).toBeUndefined();
    const picked = await engine.handle("mcpstore.setAuthKind", { name: "gw", kind: "oauth", scopes: ["tickets"] }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(picked.auth?.scopes).toEqual(["tickets"]);
  });

  it("mcpstore.setAuthKind picks up a gateway configured AFTER boot (config.patch hot-reload)", async () => {
    const { engine } = engineOn(makeEngineHome(), { detectAuth: oauthDetectNoScopes });
    await engine.handle("mcpstore.add", { name: "gw", type: "http", url: "https://gateway.example.com/mcp", auth: { kind: "bearer", keychainRef: "chimera:mcp:gw" } });
    const before = await engine.handle("mcpstore.setAuthKind", { name: "gw", kind: "oauth" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(before.auth?.scopes).toBeUndefined();
    await configureGateways(engine);
    const after = await engine.handle("mcpstore.setAuthKind", { name: "gw", kind: "oauth" }) as McpStoreEntry & { auth?: { scopes?: string[] } };
    expect(after.auth?.scopes).toEqual(["docs", "tickets"]);
  });

  it("mcpstore.setAuthKind on an unknown server is a clean protocol error", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.setAuthKind", { name: "nope", kind: "oauth" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("mcpstore.setAuthKind on a stdio entry is a clean protocol error", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "local", type: "stdio", command: "node", args: [], env: {} });
    await expect(engine.handle("mcpstore.setAuthKind", { name: "local", kind: "oauth" })).rejects.toMatchObject({ code: "protocol" });
  });
});

// TRUST-TIER: end-to-end through the REAL Engine (capabilityBroker + supervisor wired for
// real, only the MCP SDK client mocked) — this is what proves the whole chain (mcpstore.call
// RPC -> McpStoreConnectionManager.call's gate -> broker.decideMcpStoreCall -> Supervisor.
// requestMcpStoreApproval -> agent.permissionRespond) actually connects end to end, not just
// each unit in isolation.
describe("mcpstore.call: trust-tier gating (end to end through a real Engine)", () => {
  async function spawnAgent(engine: ReturnType<typeof engineOn>["engine"]) {
    const rec = await engine.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } }) as { agentId: string };
    return rec.agentId;
  }

  it("trust:full (the default) never prompts — byte-identical to pre-trust-tier behavior", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {} });
    const agentId = await spawnAgent(engine);
    enqueueClientConfig({ tools: [{ name: "slack__slack_post_message", inputSchema: {} }] });

    const result = await engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_post_message", args: {}, agentId }) as { text: string; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const requests = engine.events.tail(agentId, 50).filter((e) => e.kind === "permission_request");
    expect(requests).toHaveLength(0);
  });

  it("untrusted server + write-capable tool (no readOnlyHint) + real agent principal -> permission_request, blocked until answered, then proceeds on allow", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {}, trust: "untrusted" });
    const agentId = await spawnAgent(engine);
    enqueueClientConfig({ tools: [{ name: "slack__slack_post_message", inputSchema: {} }] });

    const pending = engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_post_message", args: {}, agentId }) as Promise<{ text: string; isError?: boolean }>;
    // give the gate's async chain a tick to register the pending permission and emit the event
    await new Promise((r) => setTimeout(r, 20));
    const req = engine.events.tail(agentId, 50).find((e) => e.kind === "permission_request");
    expect(req).toBeTruthy();
    expect(req?.data["toolName"]).toBe("mcp_store:gateway__slack__slack_post_message");

    await engine.handle("agent.permissionRespond", { requestId: req?.data["requestId"], allow: true });
    const result = await pending;
    expect(result.isError).toBeFalsy();
  });

  it("untrusted server + write-capable tool + real agent principal, DENIED -> call never reaches the server", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {}, trust: "untrusted" });
    const agentId = await spawnAgent(engine);
    enqueueClientConfig({ tools: [{ name: "slack__slack_post_message", inputSchema: {} }] });

    const pending = engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_post_message", args: {}, agentId }) as Promise<{ text: string; isError?: boolean }>;
    await new Promise((r) => setTimeout(r, 20));
    const req = engine.events.tail(agentId, 50).find((e) => e.kind === "permission_request");
    await engine.handle("agent.permissionRespond", { requestId: req?.data["requestId"], allow: false });

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/denied/i);
  });

  it("untrusted server + READ-ONLY tool (readOnlyHint true, discovery-captured) -> allow, no prompt", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {}, trust: "untrusted" });
    const agentId = await spawnAgent(engine);
    enqueueClientConfig({ tools: [{ name: "slack__slack_read_channel", inputSchema: {}, annotations: { readOnlyHint: true } }] });

    const result = await engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_read_channel", args: {}, agentId }) as { text: string; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(engine.events.tail(agentId, 50).filter((e) => e.kind === "permission_request")).toHaveLength(0);
  });

  it("untrusted server + write-capable tool + NO agent principal (UI/RPC-originated call) -> allowed without a prompt", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {}, trust: "untrusted" });
    enqueueClientConfig({ tools: [{ name: "slack__slack_post_message", inputSchema: {} }] });

    const result = await engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_post_message", args: {} }) as { text: string; isError?: boolean };
    expect(result.isError).toBeFalsy();
  });

  // FAIL CLOSED: if the approval flow itself throws (here: a bogus/ghost agentId — the
  // supervisor has no such agent, so requestMcpStoreApproval rejects) the call must be
  // DENIED, never silently allowed through.
  it("approval-system failure (unknown agentId) BLOCKS the call rather than falling open", async () => {
    const { engine } = engineOn(makeEngineHome());
    await engine.handle("mcpstore.add", { name: "gateway", type: "stdio", command: "node", args: [], env: {}, trust: "untrusted" });
    enqueueClientConfig({ tools: [{ name: "slack__slack_post_message", inputSchema: {} }] });

    const result = await engine.handle("mcpstore.call", { server: "gateway", tool: "slack__slack_post_message", args: {}, agentId: "totally-unknown-ghost-agent" }) as { text: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/approval system unavailable/i);
  });
});


it("desktop monitor is a read-only operator RPC with no required MCP installation", async () => {
  const { engine } = engineOn(makeEngineHome());
  expect(await engine.handle("mcpstore.monitor", {})).toMatchObject({ held: false, owner: null, ownerName: null, busy: false, windowId: null, activities: [] });
  await expect(engine.handle("mcpstore.monitor", { agentId: "not-a-monitor-parameter" })).rejects.toBeDefined();
});
