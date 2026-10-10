// MCP-OAUTH slice 2: the gate for the real PKCE/DCR loopback flow. Stands up a MOCK
// Authorization Server (RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591
// DCR, authorize + token endpoints) and a mock protected MCP resource that 401s without a
// valid Bearer token -- then drives the actual daemon RPCs (mcpstore.oauth.start/finish) and
// the actual connect path (mcpstore.tools) against them over real HTTP on 127.0.0.1. Nothing
// here mocks the @modelcontextprotocol/sdk itself: the real `auth()` orchestrator, real PKCE
// S256 verification, and a real StreamableHTTPServerTransport/McpServer resource all run.
import { describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain, mcpStoreAuthService } from "@chimera/core/keychain";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// ---------- mock Authorization Server + protected MCP resource ----------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type TokenRequestListener = (grantType: string | null, params: URLSearchParams) => void;

function makeMockOAuthEnvironment(opts: { onTokenRequest?: TokenRequestListener; tokenResponseGate?: () => Promise<void> } = {}) {
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; codeChallenge: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  let baseUrl = "";
  let resourceUrl = "";

  function buildMcpServer(): McpServer {
    const server = new McpServer({ name: "mock-oauth-resource", version: "0.1.0" });
    server.tool("ping", async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
    return server;
  }

  let requestCount = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requestCount++;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: resourceUrl, authorization_servers: [baseUrl] }));
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }));
      return;
    }
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { redirect_uris?: string[] };
      const clientId = `client-${randomUUID()}`;
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: clientId, client_id_issued_at: 0, ...body }));
      return;
    }
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (!clients.has(clientId)) { res.writeHead(400).end("unknown client"); return; }
      const code = `authcode-${randomUUID()}`;
      codes.set(code, { clientId, redirectUri, codeChallenge });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const params = new URLSearchParams((await readBody(req)).toString("utf8"));
      const grantType = params.get("grant_type");
      opts.onTokenRequest?.(grantType, params);
      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const verifier = params.get("code_verifier") ?? "";
        const entry = codes.get(code);
        if (!entry) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" })); return; }
        codes.delete(code);   // one-time use
        const challenge = base64url(createHash("sha256").update(verifier).digest());
        if (challenge !== entry.codeChallenge) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "pkce mismatch" }));
          return;
        }
        // MCPSTORE-OAUTH-CANCEL race test hook: holds the response open so a test can call
        // cancel() while the exchange is genuinely still in flight, then release it.
        if (opts.tokenResponseGate) await opts.tokenResponseGate();
        const accessToken = `at-${randomUUID()}`;
        const refreshToken = `rt-${randomUUID()}`;
        accessTokens.add(accessToken);
        refreshTokens.add(refreshToken);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken }));
        return;
      }
      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token") ?? "";
        if (!refreshTokens.has(refreshToken)) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const accessToken = `at-${randomUUID()}`;
        accessTokens.add(accessToken);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }
    if (url.pathname === "/mcp") {
      const authz = req.headers.authorization;
      const token = typeof authz === "string" && authz.startsWith("Bearer ") ? authz.slice(7) : null;
      if (!token || !accessTokens.has(token)) {
        res.writeHead(401, {
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await buildMcpServer().connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  });

  return {
    async listen(): Promise<{ baseUrl: string; resourceUrl: string }> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock oauth server failed to bind");
      baseUrl = `http://127.0.0.1:${address.port}`;
      resourceUrl = `${baseUrl}/mcp`;
      return { baseUrl, resourceUrl };
    },
    close(): Promise<void> {
      // the MCP client keeps an idle GET/SSE stream open per the streamable-http spec --
      // server.close() alone waits forever for it, so force every live connection shut too.
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    invalidateAccessToken(token: string): void { accessTokens.delete(token); },
    accessTokenCount(): number { return accessTokens.size; },
    requestCount(): number { return requestCount; },
  };
}

// ---------- test harness ----------

function engineOn(home: string, keychain = new InMemoryKeychain(), opts: { setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; timeoutMs?: number } = {}) {
  const fake = new FakeAgentBackend([]);
  const engine = new Engine({
    home, backends: new Map<string, AgentBackend>([["claude", fake]]), keychain,
    mcpStoreOAuthSetTimer: opts.setTimer, mcpStoreOAuthClearTimer: opts.clearTimer, mcpStoreOAuthTimeoutMs: opts.timeoutMs,
  });
  return { engine, keychain };
}

async function pollFinish(engine: Engine, pendingId: string, tries = 200): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const result = (await engine.handle("mcpstore.oauth.finish", { pendingId })) as any;
    if (result.status !== "pending") return result;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("mcpstore.oauth.finish never left status:pending");
}

async function addOAuthServer(engine: Engine, name: string, resourceUrl: string, trust?: "full" | "untrusted"): Promise<void> {
  await engine.handle("mcpstore.add", {
    name, type: "http", url: resourceUrl, ...(trust ? { trust } : {}),
    auth: { kind: "oauth", keychainRef: mcpStoreAuthService(name), scopes: ["read"] },
  });
}

// Drives the "browser": GET the authorizeUrl the daemon handed back (302s to the loopback
// redirect_uri with ?code&state), then GET that redirect — the actual loopback callback hit.
async function driveBrowser(authorizeUrl: string): Promise<Response> {
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  expect(authorizeResponse.status).toBe(302);
  const location = authorizeResponse.headers.get("location");
  if (!location) throw new Error("mock AS did not redirect");
  return fetch(location);
}

describe("MCP-OAUTH slice 2: mcpstore.oauth.start/finish + oauth connect", () => {
  it("full happy path: start -> loopback callback -> finish:connected -> tokens land only in the keychain", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine, keychain } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "remote", resourceUrl);

      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;
      expect(started.pendingId).toBeTruthy();
      expect(started.authorizeUrl).toContain("/oauth/authorize");

      const callbackResponse = await driveBrowser(started.authorizeUrl);
      expect(callbackResponse.status).toBe(200);

      const finished = await pollFinish(engine, started.pendingId);
      expect(finished).toEqual({ status: "connected" });

      // tokens/client info live ONLY in the keychain, under the server's keychainRef
      const stored = await keychain.get(mcpStoreAuthService("remote"));
      expect(stored).toBeTruthy();
      const payload = JSON.parse(stored!);
      expect(payload.tokens.access_token).toMatch(/^at-/);
      expect(payload.clientInfo.client_id).toMatch(/^client-/);

      // finish is one-shot: the pending record is consumed
      await expect(engine.handle("mcpstore.oauth.finish", { pendingId: started.pendingId }))
        .rejects.toMatchObject({ code: "protocol" });
    } finally {
      await mock.close();
    }
  });

  // SSRF: mcp_store_reauth is agent-reachable and reaches mcpstore.oauth.start, so an
  // agent-proposed (untrusted) entry must not make the daemon call loopback/LAN OAuth endpoints.
  it("an untrusted entry's oauth.start never reaches a loopback server (SSRF guard); the listener is released", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "proposed", resourceUrl, "untrusted");

      await expect(engine.handle("mcpstore.oauth.start", { name: "proposed" })).rejects.toMatchObject({
        code: "protocol", message: expect.stringContaining("blocked destination"),
      });
      expect(mock.requestCount()).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it("a trust:full entry (operator-vetted) still runs oauth.start against a local server", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "vetted", resourceUrl, "full");

      const started = (await engine.handle("mcpstore.oauth.start", { name: "vetted" })) as any;
      expect(started.authorizeUrl).toContain("/oauth/authorize");
      expect(mock.requestCount()).toBeGreaterThan(0);
      await engine.handle("mcpstore.oauth.cancel", { pendingId: started.pendingId });
    } finally {
      await mock.close();
    }
  });

  it("connect branch: mcpstore.tools uses the stored oauth tokens via the SDK authProvider (no manual header)", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "remote", resourceUrl);
      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;
      await driveBrowser(started.authorizeUrl);
      await pollFinish(engine, started.pendingId);

      const result = (await engine.handle("mcpstore.tools", { servers: ["remote"] })) as any;
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toMatchObject({ server: "remote", connected: true });
      expect(result.servers[0].tools.some((t: any) => t.name === "ping")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("a 401 (expired access token) triggers a real refresh_token exchange, then connects", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine, keychain } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "remote", resourceUrl);
      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;
      await driveBrowser(started.authorizeUrl);
      await pollFinish(engine, started.pendingId);

      // simulate the stored access token having expired server-side (still has a refresh_token)
      const stored = JSON.parse((await keychain.get(mcpStoreAuthService("remote")))!);
      mock.invalidateAccessToken(stored.tokens.access_token);

      const result = (await engine.handle("mcpstore.tools", { servers: ["remote"] })) as any;
      expect(result.servers[0]).toMatchObject({ server: "remote", connected: true });

      // the refreshed access token replaced the stale one in the keychain
      const restored = JSON.parse((await keychain.get(mcpStoreAuthService("remote")))!);
      expect(restored.tokens.access_token).not.toBe(stored.tokens.access_token);
    } finally {
      await mock.close();
    }
  });

  it("rejects a mismatched state on the loopback callback -- the pending flow stays open for the real one", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      const { engine } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "remote", resourceUrl);
      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;

      const authorizeUrl = new URL(started.authorizeUrl);
      const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
      expect(redirectUri).toContain("127.0.0.1");

      const forged = new URL(redirectUri);
      forged.searchParams.set("code", "forged-code");
      forged.searchParams.set("state", "not-the-real-state");
      const forgedResponse = await fetch(forged.toString());
      expect(forgedResponse.status).toBe(400);

      // the forged hit did NOT resolve or fail the pending record
      const stillPending = (await engine.handle("mcpstore.oauth.finish", { pendingId: started.pendingId })) as any;
      expect(stillPending).toEqual({ status: "pending" });

      // the legitimate browser round trip still completes normally afterward
      const real = await driveBrowser(started.authorizeUrl);
      expect(real.status).toBe(200);
      const finished = await pollFinish(engine, started.pendingId);
      expect(finished).toEqual({ status: "connected" });
    } finally {
      await mock.close();
    }
  });

  it("closes the listener and marks the pending record as error on timeout", async () => {
    const mock = makeMockOAuthEnvironment();
    const { resourceUrl } = await mock.listen();
    try {
      let fireTimeout: (() => void) | undefined;
      const { engine } = engineOn(makeEngineHome(), new InMemoryKeychain(), {
        setTimer: (fn) => { fireTimeout = fn; return 0; },
        clearTimer: () => {},
      });
      await addOAuthServer(engine, "remote", resourceUrl);
      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;
      const redirectUri = new URL(started.authorizeUrl).searchParams.get("redirect_uri")!;

      expect(fireTimeout).toBeTruthy();
      fireTimeout!();
      // fail()/close() run inside an async IIFE -- give the microtask queue a turn
      await new Promise((r) => setTimeout(r, 10));

      const finished = (await engine.handle("mcpstore.oauth.finish", { pendingId: started.pendingId })) as any;
      expect(finished.status).toBe("error");
      expect(finished.error).toContain("timed out");

      // the loopback listener is actually closed -- a request to it now fails to connect
      await expect(fetch(redirectUri)).rejects.toBeTruthy();
    } finally {
      await mock.close();
    }
  });

  describe("MCPSTORE-OAUTH-CANCEL", () => {
    it("cancel before any redirect drops the pending record and closes the listener", async () => {
      const mock = makeMockOAuthEnvironment();
      const { resourceUrl } = await mock.listen();
      try {
        const { engine } = engineOn(makeEngineHome());
        await addOAuthServer(engine, "remote", resourceUrl);
        const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;
        const redirectUri = new URL(started.authorizeUrl).searchParams.get("redirect_uri")!;

        await engine.handle("mcpstore.oauth.cancel", { pendingId: started.pendingId });

        // the pending record is gone -- finish now reports "unknown pending id", not "pending"
        await expect(engine.handle("mcpstore.oauth.finish", { pendingId: started.pendingId }))
          .rejects.toMatchObject({ code: "protocol" });
        // the loopback listener is actually closed -- the browser's redirect can no longer land
        await expect(fetch(redirectUri)).rejects.toBeTruthy();
      } finally {
        await mock.close();
      }
    });

    it("cancel is safe to call twice (second call is a no-op, never throws)", async () => {
      const mock = makeMockOAuthEnvironment();
      const { resourceUrl } = await mock.listen();
      try {
        const { engine } = engineOn(makeEngineHome());
        await addOAuthServer(engine, "remote", resourceUrl);
        const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;

        await engine.handle("mcpstore.oauth.cancel", { pendingId: started.pendingId });
        await expect(engine.handle("mcpstore.oauth.cancel", { pendingId: started.pendingId })).resolves.toEqual({});
      } finally {
        await mock.close();
      }
    });

    it("cancel on an unknown pendingId is a harmless no-op", async () => {
      const { engine } = engineOn(makeEngineHome());
      await expect(engine.handle("mcpstore.oauth.cancel", { pendingId: "never-existed" })).resolves.toEqual({});
    });

    it("cancel racing an in-flight legitimate callback: the exchange still completes and lands in the keychain; cancel's own cleanup only runs after", async () => {
      let releaseToken: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseToken = resolve; });
      let tokenExchangeStarted: () => void = () => {};
      const exchangeStarted = new Promise<void>((resolve) => { tokenExchangeStarted = resolve; });
      const mock = makeMockOAuthEnvironment({ tokenResponseGate: () => {
        tokenExchangeStarted();
        return gate;
      } });
      const { resourceUrl } = await mock.listen();
      const pending: Promise<unknown>[] = [];
      try {
        const { engine, keychain } = engineOn(makeEngineHome());
        await addOAuthServer(engine, "remote", resourceUrl);
        const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;

        // drive the browser's callback hit -- it will hang mid token-exchange until releaseToken()
        const callbackPromise = driveBrowser(started.authorizeUrl);
        pending.push(callbackPromise);
        // A fixed delay can cancel before the callback even connects on a busy CI runner.
        // Wait for the actual exchange so this exercises cancellation of an in-flight request.
        await Promise.race([exchangeStarted, callbackPromise.then(() => {
          throw new Error("OAuth callback completed before reaching the token exchange gate");
        })]);

        let cancelSettled = false;
        const cancelPromise = engine.handle("mcpstore.oauth.cancel", { pendingId: started.pendingId })
          .then(() => { cancelSettled = true; });
        pending.push(cancelPromise);

        // cancel's finalize() awaits listener.close(), which cannot resolve while the
        // in-flight callback's connection is still open -- so cancel must still be pending.
        await new Promise((r) => setTimeout(r, 20));
        expect(cancelSettled).toBe(false);

        releaseToken();
        const [callbackResponse] = await Promise.all([callbackPromise, cancelPromise]);
        expect(callbackResponse.status).toBe(200);
        expect(cancelSettled).toBe(true);

        // the token exchange completed and landed in the keychain regardless of the race --
        // cancel discarded the daemon's bookkeeping AFTER the exchange settled, never mid-way.
        const stored = await keychain.get(mcpStoreAuthService("remote"));
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored!).tokens.access_token).toMatch(/^at-/);

        // but the pending record itself is gone -- cancel's cleanup ran, so a poll now 404s
        // rather than reporting "connected" (the UI already gave up on this pendingId).
        await expect(engine.handle("mcpstore.oauth.finish", { pendingId: started.pendingId }))
          .rejects.toMatchObject({ code: "protocol" });
      } finally {
        releaseToken();
        await Promise.allSettled(pending);
        await mock.close();
      }
    });
  });

  it("never leaks a token, code, verifier, or state into console/log/thrown-error text (canary)", async () => {
    const canaryCode = "canary-code-should-never-leak";
    const mock = makeMockOAuthEnvironment({
      onTokenRequest: (_grantType, params) => {
        // force a token-exchange failure so the error path (the one most likely to echo
        // request internals) actually runs, with a known canary value in play.
        void params;
      },
    });
    const { resourceUrl } = await mock.listen();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { engine } = engineOn(makeEngineHome());
      await addOAuthServer(engine, "remote", resourceUrl);
      const started = (await engine.handle("mcpstore.oauth.start", { name: "remote" })) as any;

      // a bogus code (never issued by the mock AS) drives the token-exchange failure path
      const redirectUri = new URL(started.authorizeUrl).searchParams.get("redirect_uri")!;
      const state = new URL(started.authorizeUrl).searchParams.get("state")!;
      const forged = new URL(redirectUri);
      forged.searchParams.set("code", canaryCode);
      forged.searchParams.set("state", state);
      const response = await fetch(forged.toString());
      expect(response.status).toBe(400);

      const finished = await pollFinish(engine, started.pendingId);
      expect(finished.status).toBe("error");

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat().map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n");
      expect(allLoggedText).not.toContain(canaryCode);
      expect(JSON.stringify(finished)).not.toContain(canaryCode);
    } finally {
      logSpy.mockRestore(); errorSpy.mockRestore(); warnSpy.mockRestore();
      await mock.close();
    }
  });
});
