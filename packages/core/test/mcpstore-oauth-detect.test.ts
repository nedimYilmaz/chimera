// MCP-OAUTH-DISCOVERABILITY + SSRF: detectMcpStoreOAuth's probe logic (RFC9728 well-known, the
// 401 WWW-Authenticate fallback, the "plain server" negative case) AND the guarantee that an
// attacker-influenced URL can never make the daemon touch a non-public destination.
//
// Everything runs against an in-memory "virtual internet": a fake resolver (name -> addresses)
// and a recording transport (the wire). Both are seams BELOW the guard, so validation still runs
// in production code on every request; each test asserts which addresses the wire was actually
// asked to dial. No real DNS, no real metadata endpoint, no real internal address is contacted.
import { describe, it, expect, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { detectMcpStoreOAuth } from "@chimera/core/providers/mcpstore-oauth-detect";
import { nodeTransport, type PinnedRequest, type RawResponse, type Transport } from "@chimera/core/providers/ssrf-guard";

type Site = (path: string, req: PinnedRequest) => RawResponse | undefined;

const json = (body: unknown, status = 200): RawResponse => ({
  status, statusText: "", headers: [["content-type", "application/json"]], body: new TextEncoder().encode(JSON.stringify(body)),
});
const text = (status: number, body = "", headers: Record<string, string> = {}): RawResponse => ({
  status, statusText: "", headers: Object.entries(headers), body: new TextEncoder().encode(body),
});

/** Names -> addresses, hosts -> handlers. An unknown path is a 404; an unknown name fails to resolve. */
function internet(dns: Record<string, string[]>, sites: Record<string, Site>) {
  const wire: Array<{ host: string; pinnedIp: string; path: string; method: string }> = [];
  const resolved: string[] = [];
  const resolver = vi.fn(async (host: string) => {
    resolved.push(host);
    const answers = dns[host];
    if (!answers) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answers;
  });
  const transport: Transport = async (req) => {
    wire.push({ host: req.url.hostname, pinnedIp: req.pinnedIp, path: req.url.pathname, method: req.method });
    const site = sites[req.url.hostname];
    if (!site) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    return site(req.url.pathname, req) ?? text(404, "not found");
  };
  return { seams: { resolver, transport }, wire, resolved, resolver };
}

const PRIVATE_IPS = new Set(["127.0.0.1", "169.254.169.254", "10.0.0.9", "10.1.2.3", "192.168.1.1", "0.0.0.0", "::1"]);
const dialedPrivate = (wire: Array<{ host: string; pinnedIp: string }>) =>
  wire.filter((w) => PRIVATE_IPS.has(w.pinnedIp) || PRIVATE_IPS.has(w.host) || w.host === "[::1]");

const AS_DOC = (issuer: string, extra: Record<string, unknown> = {}) => ({
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"], ...extra,
});

describe("detectMcpStoreOAuth: discovery", () => {
  it("detects OAuth via RFC9728 protected-resource metadata at the well-known path", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"], "as.example": ["1.1.1.1"] }, {
      "mcp.example": (path) => path.startsWith("/.well-known/oauth-protected-resource")
        ? json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://as.example"] }) : undefined,
      "as.example": (path) => path === "/.well-known/oauth-authorization-server"
        ? json(AS_DOC("https://as.example", { scopes_supported: ["read", "write"] })) : undefined,
    });
    const result = await detectMcpStoreOAuth("https://mcp.example/mcp", net.seams);
    expect(result).toEqual({ oauth: true, authorizationServers: ["https://as.example"], scopesSupported: ["read", "write"] });
    // Every request was pinned to the public answer for ITS OWN host.
    expect(new Set(net.wire.map((w) => `${w.host}=${w.pinnedIp}`))).toEqual(new Set(["mcp.example=8.8.8.8", "as.example=1.1.1.1"]));
  });

  it("detects OAuth via a 401 WWW-Authenticate challenge when the well-known path 404s", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"] }, {
      "mcp.example": (path) => {
        if (path === "/.well-known/oauth-protected-resource-metadata") return json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] });
        if (path === "/.well-known/oauth-authorization-server") return json(AS_DOC("https://mcp.example"));
        if (path === "/mcp") return text(401, "{}", { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource-metadata"' });
        return undefined;   // the RFC9728 direct probe 404s, forcing the 401-challenge path
      },
    });
    const result = await detectMcpStoreOAuth("https://mcp.example/mcp", net.seams);
    expect(result.oauth).toBe(true);
    expect(result.authorizationServers).toEqual(["https://mcp.example"]);
  });

  it("follows a safe public -> public redirect while discovering", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"], "meta.example": ["9.9.9.9"], "as.example": ["1.1.1.1"] }, {
      "mcp.example": (path) => path.startsWith("/.well-known/oauth-protected-resource") ? text(302, "", { location: "https://meta.example/prm" }) : undefined,
      "meta.example": (path) => path === "/prm" ? json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://as.example"] }) : undefined,
      "as.example": (path) => path === "/.well-known/oauth-authorization-server" ? json(AS_DOC("https://as.example")) : undefined,
    });
    const result = await detectMcpStoreOAuth("https://mcp.example/mcp", net.seams);
    expect(result.oauth).toBe(true);
    expect(net.wire.some((w) => w.host === "meta.example" && w.pinnedIp === "9.9.9.9")).toBe(true);
  });

  it("a plain server with neither signal is not detected as oauth", async () => {
    const net = internet({ "plain.example": ["8.8.8.8"] }, { "plain.example": (path) => path === "/mcp" ? text(200, "ok") : undefined });
    await expect(detectMcpStoreOAuth("https://plain.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
  });

  it("an unreachable server is inconclusive (oauth:false), never throws", async () => {
    const net = internet({ "down.example": ["8.8.8.8"] }, {});
    await expect(detectMcpStoreOAuth("https://down.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
  });

  it("an unresolvable name is inconclusive too", async () => {
    const net = internet({}, {});
    await expect(detectMcpStoreOAuth("https://nowhere.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
  });
});

describe("detectMcpStoreOAuth: SSRF", () => {
  it.each([
    "http://127.0.0.1:8080/mcp", "http://localhost-literal.invalid@127.0.0.1/mcp", "http://169.254.169.254/latest/meta-data/", "http://[::1]/mcp",
    "http://[::ffff:127.0.0.1]/mcp", "http://[::ffff:a9fe:a9fe]/mcp", "http://10.0.0.5/mcp", "http://192.168.1.1/mcp", "http://0.0.0.0/mcp",
    "http://224.0.0.1/mcp", "http://0x7f.1/mcp", "http://2130706433/mcp", "http://[fd00::1]/mcp", "http://[fe80::1]/mcp",
  ])("a private literal %s is inconclusive and never reaches DNS or the wire", async (url) => {
    const net = internet({}, {});
    await expect(detectMcpStoreOAuth(url, net.seams)).resolves.toEqual({ oauth: false });
    expect(net.resolver).not.toHaveBeenCalled();
    expect(net.wire).toEqual([]);
  });

  it.each([
    ["a loopback answer", ["127.0.0.1"]],
    ["a link-local answer", ["169.254.169.254"]],
    ["an IPv4-mapped loopback answer", ["::ffff:127.0.0.1"]],
    ["a round-robin with ONE private answer", ["8.8.8.8", "10.0.0.9"]],
  ])("a public-looking name resolving to %s never reaches the wire", async (_label, answers) => {
    const net = internet({ "rebind.example": answers }, { "rebind.example": () => json({ authorization_servers: ["https://x.example"] }) });
    await expect(detectMcpStoreOAuth("https://rebind.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(net.wire).toEqual([]);
  });

  it("a redirect to the cloud metadata address is never followed", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"] }, {
      "mcp.example": (path) => path.startsWith("/.well-known/") ? text(302, "", { location: "http://169.254.169.254/latest/meta-data/" }) : text(200, "ok"),
    });
    await expect(detectMcpStoreOAuth("https://mcp.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(net.wire.length).toBeGreaterThan(0);
    expect(dialedPrivate(net.wire)).toEqual([]);
  });

  it("a redirect to a name that resolves into the private range is never dialed", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"], "internal.example": ["10.0.0.9"] }, {
      "mcp.example": (path) => path.startsWith("/.well-known/") ? text(301, "", { location: "https://internal.example/prm" }) : text(200, "ok"),
      "internal.example": () => json({ authorization_servers: ["https://internal.example"] }),
    });
    await expect(detectMcpStoreOAuth("https://mcp.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(net.wire.every((w) => w.host === "mcp.example")).toBe(true);
    expect(dialedPrivate(net.wire)).toEqual([]);
  });

  it("a redirect loop ends inconclusively instead of hanging", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"] }, { "mcp.example": () => text(302, "", { location: "/again" }) });
    await expect(detectMcpStoreOAuth("https://mcp.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(net.wire.length).toBeLessThanOrEqual(6 * 3);   // 5 hops per fetch, a handful of fetches, then give up
  });

  it("a resource_metadata URL in the 401 challenge that points at a private literal is never fetched", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"] }, {
      "mcp.example": (path) => path === "/mcp"
        ? text(401, "{}", { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1:9999/prm"' })
        : undefined,
    });
    await expect(detectMcpStoreOAuth("https://mcp.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(dialedPrivate(net.wire)).toEqual([]);
  });

  it("a resource_metadata URL that resolves private is never dialed either", async () => {
    const net = internet({ "mcp.example": ["8.8.8.8"], "meta.example": ["192.168.1.1"] }, {
      "mcp.example": (path) => path === "/mcp"
        ? text(401, "{}", { "www-authenticate": 'Bearer resource_metadata="https://meta.example/prm"' })
        : undefined,
      "meta.example": () => json({ authorization_servers: ["https://as.example"] }),
    });
    await expect(detectMcpStoreOAuth("https://mcp.example/mcp", net.seams)).resolves.toEqual({ oauth: false });
    expect(net.wire.some((w) => w.host === "meta.example")).toBe(false);
  });

  it.each([
    ["a private literal", "http://169.254.169.254", {}],
    ["a name resolving private", "https://as.internal.example", { "as.internal.example": ["10.1.2.3"] }],
  ])("a protected-resource document advertising %s as the authorization server: still evidence of OAuth, but the AS is never contacted", async (_label, as, extraDns) => {
    const net = internet({ "mcp.example": ["8.8.8.8"], ...extraDns }, {
      "mcp.example": (path) => path.startsWith("/.well-known/oauth-protected-resource")
        ? json({ resource: "https://mcp.example/mcp", authorization_servers: [as], scopes_supported: ["from-prm"] }) : undefined,
      // If the guard failed, these would answer from "inside the network".
      "169.254.169.254": () => json(AS_DOC("http://169.254.169.254", { scopes_supported: ["leaked"] })),
      "as.internal.example": () => json(AS_DOC("https://as.internal.example", { scopes_supported: ["leaked"] })),
    });
    const result = await detectMcpStoreOAuth("https://mcp.example/mcp", net.seams);
    expect(result).toEqual({ oauth: true, authorizationServers: [as], scopesSupported: ["from-prm"] });
    expect(net.wire.every((w) => w.host === "mcp.example")).toBe(true);
    expect(dialedPrivate(net.wire)).toEqual([]);
  });

  describe("the guard cannot be bypassed through the test seams or the public signature", () => {
    it("a resolver answering loopback leaves the transport unused, even though it was injected", async () => {
      const transport = vi.fn<Transport>(async () => json({}));
      await expect(detectMcpStoreOAuth("https://anything.example/mcp", { resolver: async () => ["127.0.0.1"], transport })).resolves.toEqual({ oauth: false });
      expect(transport).not.toHaveBeenCalled();
    });

    it("a raw fetch handed in as the second argument is ignored (the old bypass), and the production path blocks loopback", async () => {
      let hits = 0;
      const server: Server = createServer((_req, res) => { hits++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ authorization_servers: ["http://127.0.0.1"] })); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      const rawFetch = vi.fn(fetch);
      try {
        // Production resolver + production transport: the only thing standing between this call and a
        // reachable loopback listener is the guard.
        const result = await detectMcpStoreOAuth(`http://127.0.0.1:${port}/mcp`, rawFetch as never);
        expect(result).toEqual({ oauth: false });
        expect(hits).toBe(0);
        expect(rawFetch).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
      }
    });
  });
});

describe("detectMcpStoreOAuth: production transport", () => {
  it("dials the validated address while the server still sees the ORIGINAL Host", async () => {
    const hosts: string[] = [];
    let origin = "";
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hosts.push(String(req.headers.host));
      const path = new URL(req.url ?? "/", "http://x").pathname;
      res.writeHead(200, { "content-type": "application/json" });
      if (path.startsWith("/.well-known/oauth-protected-resource")) res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
      else if (path === "/.well-known/oauth-authorization-server") res.end(JSON.stringify(AS_DOC(origin, { scopes_supported: ["a"] })));
      else res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    origin = `http://oauth.example:${port}`;
    // DNS says "public" (so validation passes); only the test's transport redirects the dial to the
    // local fixture. nodeTransport itself is the production implementation.
    const dialed: string[] = [];
    const seams = {
      resolver: async () => ["8.8.8.8"],
      transport: ((req) => { dialed.push(req.pinnedIp); return nodeTransport({ ...req, pinnedIp: "127.0.0.1" }); }) as Transport,
    };
    try {
      const result = await detectMcpStoreOAuth(`${origin}/mcp`, seams);
      expect(result).toEqual({ oauth: true, authorizationServers: [origin], scopesSupported: ["a"] });
      expect(dialed.every((ip) => ip === "8.8.8.8")).toBe(true);
      expect(hosts.length).toBeGreaterThan(0);
      expect(new Set(hosts)).toEqual(new Set([`oauth.example:${port}`]));
    } finally {
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    }
  });
});
