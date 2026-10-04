// MCP-AUTH-STATUS: the store page must answer "is this server still authorized?" on a cold
// open, and an agent must be able to tell a dead credential apart from an unreachable host.
// Both read the same McpStoreConnectionManager.authStatus, so this suite pins the state
// machine directly rather than through either UI.
//
// The distinction these tests exist to protect: an EXPIRED ACCESS TOKEN IS NOT DEAD AUTH.
// The SDK refreshes reactively at connect time, so a grant holding a refresh_token stays
// `authorized` no matter how old the access token is. Getting this wrong would paint a red
// chip on every server more than an hour after its last use.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpStoreRegistry, McpStoreConnectionManager } from "../src/mcpstore.js";
import { mcpStoreAuthService } from "../src/keychain.js";
import type { Keychain } from "../src/keychain.js";
import { readMcpStoreOAuthSnapshot } from "../src/providers/oauth-client-provider.js";

class FakeKeychain implements Keychain {
  private store = new Map<string, string>();
  async get(service: string): Promise<string | null> { return this.store.get(service) ?? null; }
  async set(service: string, secret: string): Promise<void> { this.store.set(service, secret); }
  async delete(service: string): Promise<void> { this.store.delete(service); }
  putRaw(service: string, raw: string): void { this.store.set(service, raw); }
}

const HOUR_MS = 3600_000;

function writeStore(dir: string, servers: Record<string, unknown>): void {
  writeFileSync(join(dir, "mcpstore.json"), JSON.stringify(servers, null, 2));
}

function oauthEntry(url = "https://mcp.example.com/mcp", name = "remote") {
  return { type: "http", url, headers: {}, direct: false, enabled: true, trust: "full",
    auth: { kind: "oauth", keychainRef: mcpStoreAuthService(name), scopes: ["read"] } };
}

describe("MCP-AUTH-STATUS: McpStoreConnectionManager.authStatus", () => {
  let dir: string;
  let keychain: FakeKeychain;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chimera-authstatus-"));
    keychain = new FakeKeychain();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manager = (): McpStoreConnectionManager =>
    new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);

  it("reports `none` for a server with nothing to authorize", async () => {
    writeStore(dir, { local: { type: "stdio", command: "echo", args: [], env: {}, direct: false, enabled: true, trust: "full" } });
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("none");
  });

  it("reports `never` for an oauth entry whose keychain holds nothing yet", async () => {
    writeStore(dir, { remote: oauthEntry() });
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("never");
    expect(row?.authorizedAt).toBeUndefined();
  });

  it("reports `authorized` with the granted scopes once tokens are stored", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read write" },
      authorizedAt: Date.now(),
    }));
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("authorized");
    expect(row?.scopes).toEqual(["read", "write"]);
  });

  // THE load-bearing case. A refresh_token means the SDK renews on the next connect, so being
  // hours past `expires_in` is the ordinary steady state -- not a reason to alarm the operator.
  it("keeps a long-expired access token `authorized` while a refresh token remains", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      authorizedAt: Date.now() - 30 * 24 * HOUR_MS,     // a month stale
    }));
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("authorized");
  });

  // The mirror image: with NO refresh_token there is nothing that can renew it, so past
  // expiry really is dead and chimera can say so without having made a request.
  it("reports `needs-reauth` for an expired token with no refresh token", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", expires_in: 3600 },
      authorizedAt: Date.now() - 5 * HOUR_MS,
    }));
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("needs-reauth");
    expect(row?.detail).toMatch(/no refresh token/);
  });

  it("keeps a not-yet-expired refresh-less token `authorized`", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", expires_in: 3600 },
      authorizedAt: Date.now() - 60_000,
    }));
    const [row] = await manager().authStatus();
    expect(row?.state).toBe("authorized");
  });

  // A real 401 observed by ensure() outranks everything the keychain suggests: the tokens are
  // present and unexpired, and the server still said no.
  it("reports `needs-reauth` after a real connect was rejected for auth", async () => {
    writeStore(dir, { remote: oauthEntry("https://127.0.0.1:9/mcp") });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      authorizedAt: Date.now(),
    }));
    const mgr = manager();
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: true, at: Date.now() });
    const [row] = await mgr.authStatus();
    expect(row?.state).toBe("needs-reauth");
    expect(row?.lastCheckedAt).toBeGreaterThan(0);
  });

  // The false-alarm guard: a host that is simply DOWN must not send anyone through a browser
  // flow. Same failed connect, `auth:false`, and the verdict has to stay `authorized`.
  it("does NOT report needs-reauth when a connect failed for non-auth reasons", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      authorizedAt: Date.now(),
    }));
    const mgr = manager();
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: false, at: Date.now() });
    const [row] = await mgr.authStatus();
    expect(row?.state).toBe("authorized");
  });

  it("reports `bearer` for a static-token entry, and needs-reauth only once one is rejected", async () => {
    writeStore(dir, { remote: { type: "http", url: "https://mcp.example.com/mcp", headers: {}, direct: false,
      enabled: true, trust: "full", auth: { kind: "bearer", keychainRef: mcpStoreAuthService("remote") } } });
    const mgr = manager();
    expect((await mgr.authStatus())[0]?.state).toBe("bearer");
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: true, at: Date.now() });
    expect((await mgr.authStatus())[0]?.state).toBe("needs-reauth");
  });

  it("throws for an unknown name but returns every server when name is omitted", async () => {
    writeStore(dir, { a: oauthEntry("https://a.example.com/mcp", "a"), b: oauthEntry("https://b.example.com/mcp", "b") });
    const mgr = manager();
    expect((await mgr.authStatus()).map((r) => r.name)).toEqual(["a", "b"]);
    await expect(mgr.authStatus("nope")).rejects.toThrow(/unknown mcp store server/);
  });

  // The hard contract: this payload reaches an agent transcript via mcp_store_auth_status.
  it("never leaks token material into a status row", async () => {
    writeStore(dir, { remote: oauthEntry() });
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH", expires_in: 3600, scope: "read" },
      clientInfo: { client_id: "cid", client_secret: "SECRET-CLIENT", redirect_uris: ["http://127.0.0.1:0/callback"] },
      authorizedAt: Date.now(),
    }));
    const serialized = JSON.stringify(await manager().authStatus());
    expect(serialized).not.toMatch(/SECRET-/);
  });
});

describe("MCP-AUTH-STATUS: readMcpStoreOAuthSnapshot", () => {
  it("treats a corrupt keychain payload as never-authorized instead of throwing", async () => {
    const keychain = new FakeKeychain();
    keychain.putRaw(mcpStoreAuthService("broken"), "{not json");
    await expect(readMcpStoreOAuthSnapshot(keychain, "broken")).resolves.toEqual({ hasTokens: false, hasRefreshToken: false });
  });

  // Grants minted before `authorizedAt` existed have no stamp; they must read as present-and-
  // usable rather than as an expired token with an unknown issue time.
  it("reports tokens with no authorizedAt stamp as present, with no age", async () => {
    const keychain = new FakeKeychain();
    keychain.putRaw(mcpStoreAuthService("legacy"), JSON.stringify({ tokens: { access_token: "at", expires_in: 3600 } }));
    const snap = await readMcpStoreOAuthSnapshot(keychain, "legacy");
    expect(snap).toMatchObject({ hasTokens: true, hasRefreshToken: false, expiresInSeconds: 3600 });
    expect(snap.authorizedAt).toBeUndefined();
  });
});

// The classifier (isAuthRejection) matches on the error the MCP SDK actually throws, which is
// not something a hand-written regex can be trusted about. This drives a REAL 401 through a
// real transport so the "did auth fail, or is the host down?" split is verified end to end
// rather than assumed -- that split is the whole basis of the needs-reauth chip.
describe("MCP-AUTH-STATUS: classifying a real transport rejection", () => {
  let dir: string;
  let server: import("node:http").Server;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "chimera-authstatus-live-"));
    const { createServer } = await import("node:http");
    server = createServer((_req, res) => { res.writeHead(401, { "content-type": "text/plain" }); res.end("Unauthorized"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a bearer server that answers 401 as needs-reauth", async () => {
    const keychain = new FakeKeychain();
    await keychain.set(mcpStoreAuthService("live"), "a-stale-token");
    writeStore(dir, { live: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {}, direct: false,
      enabled: true, trust: "full", auth: { kind: "bearer", keychainRef: mcpStoreAuthService("live") } } });
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);

    const rows = await mgr.tools();               // swallows the connect error into an `error` row
    expect(rows[0]?.connected).toBe(false);

    const [status] = await mgr.authStatus();
    expect(status?.state).toBe("needs-reauth");
  });

  it("leaves a bearer server whose host is simply unreachable as `bearer`, not needs-reauth", async () => {
    const keychain = new FakeKeychain();
    await keychain.set(mcpStoreAuthService("down"), "a-fine-token");
    // Port 1 on loopback: nothing listens, so this is a connection refusal -- never an auth fact.
    writeStore(dir, { down: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {}, direct: false,
      enabled: true, trust: "full", auth: { kind: "bearer", keychainRef: mcpStoreAuthService("down") } } });
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);

    await mgr.tools();
    const [status] = await mgr.authStatus();
    expect(status?.state).toBe("bearer");
  });
});

// The chip has to CLEAR when the thing it asks for is done. A needs-reauth verdict that
// outlived the re-authorize would tell the operator their fix didn't work, and would tell an
// agent to go ask a human again -- a loop, since connecting is what refreshes the verdict and
// nothing forces a connect.
describe("MCP-AUTH-STATUS: a rejection is only evidence about the credential it rejected", () => {
  let dir: string;
  let keychain: FakeKeychain;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chimera-authstatus-stale-"));
    keychain = new FakeKeychain();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("clears needs-reauth once a NEWER grant is stored, with no reconnect", async () => {
    writeStore(dir, { remote: oauthEntry() });
    const failedAt = Date.now() - 60_000;
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "fresh", refresh_token: "rt", expires_in: 3600 },
      authorizedAt: failedAt + 30_000,          // re-authorized AFTER the rejection
    }));
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: true, at: failedAt });
    expect((await mgr.authStatus())[0]?.state).toBe("authorized");
  });

  it("still reports needs-reauth when the rejection came AFTER the stored grant", async () => {
    writeStore(dir, { remote: oauthEntry() });
    const authorizedAt = Date.now() - 60_000;
    keychain.putRaw(mcpStoreAuthService("remote"), JSON.stringify({
      tokens: { access_token: "stale", refresh_token: "rt", expires_in: 3600 }, authorizedAt,
    }));
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: true, at: authorizedAt + 30_000 });
    expect((await mgr.authStatus())[0]?.state).toBe("needs-reauth");
  });

  // A bearer secret has no timestamp, so the comparison above cannot save it -- clearOutcome
  // is the only way its verdict retires.
  it("clearOutcome retires a bearer server's rejection when its token is replaced", async () => {
    writeStore(dir, { remote: { type: "http", url: "https://mcp.example.com/mcp", headers: {}, direct: false,
      enabled: true, trust: "full", auth: { kind: "bearer", keychainRef: mcpStoreAuthService("remote") } } });
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(dir), keychain);
    (mgr as unknown as { outcomes: Map<string, unknown> }).outcomes
      .set("remote", { ok: false, auth: true, at: Date.now() });
    expect((await mgr.authStatus())[0]?.state).toBe("needs-reauth");
    mgr.clearOutcome("remote");
    expect((await mgr.authStatus())[0]?.state).toBe("bearer");
  });
});
