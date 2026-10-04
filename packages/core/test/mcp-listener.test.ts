import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import type { ChimeraMcpCtx } from "@chimera/protocol";
import type { AuditAppendInput } from "../src/audit-ledger.js";
import { LoopbackMcpListener } from "../src/mcp-listener.js";

const LOOPBACK = "127.0.0.1";

type Call = { method: string; params: unknown };

function spyDispatch(calls: Call[]) {
  return async (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    // the factory probes this at connect time; [] means "no direct-store tools".
    if (method === "mcpstore.list") return [];
    return { ok: true };
  };
}

function post(port: number, path: string, opts: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: LOOPBACK, port, path, method: opts.method ?? "POST",
      headers: { "content-type": "application/json", ...opts.headers },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += String(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
// the one request that is valid on a brand-new stateless transport, for the paths that must 200
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});
const ACCEPT = "application/json, text/event-stream";

const listeners: LoopbackMcpListener[] = [];
type RejectedEvent = { grantId: string; agentId: string | null; reason: string };

function makeListener(opts: {
  enabled?: boolean; calls?: Call[]; audits?: AuditAppendInput[]; events?: RejectedEvent[];
  createServerImpl?: ConstructorParameters<typeof LoopbackMcpListener>[0]["createServerImpl"];
} = {}): LoopbackMcpListener {
  const l = new LoopbackMcpListener({
    enabled: opts.enabled ?? true,
    dispatch: spyDispatch(opts.calls ?? []),
    ...(opts.audits ? { audit: (i: AuditAppendInput) => { opts.audits!.push(i); } } : {}),
    ...(opts.events ? { emit: (e: RejectedEvent) => { opts.events!.push(e); } } : {}),
    ...(opts.createServerImpl ? { createServerImpl: opts.createServerImpl } : {}),
  });
  listeners.push(l);
  return l;
}

const CTX: ChimeraMcpCtx & { agentId: string; provider: string } = {
  agentId: "agent-1", provider: "kimi", depth: 1, maxDepthCap: 3,
};

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()!.close().catch(() => {});
});

describe("LoopbackMcpListener", () => {
  it("binds 127.0.0.1 on an OS-assigned port and nothing else", async () => {
    const l = makeListener();
    const grant = await l.grant(CTX);
    expect(grant).not.toBeNull();
    const status = l.status();
    expect(status.listening).toBe(true);
    expect(status.address).toMatch(/^127\.0\.0\.1:\d+$/);
    const port = Number(status.address!.split(":")[1]);
    expect(port).toBeGreaterThan(0);
    expect(grant!.url).toBe(`http://${LOOPBACK}:${port}/mcp/${grant!.url.split("/mcp/")[1]}`);
    // AC-1: no non-loopback interface on this machine answers on that port.
    const external = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (external) {
      await expect(new Promise((resolve, reject) => {
        const s = net.connect({ host: external, port, timeout: 1500 });
        s.on("connect", () => { s.destroy(); resolve("connected"); });
        s.on("timeout", () => { s.destroy(); reject(new Error("timeout")); });
        s.on("error", reject);
      })).rejects.toThrow();
    }
  });

  it("refuses to serve and closes the socket if the bound address is not 127.0.0.1", async () => {
    let closed = false;
    const l = makeListener({
      createServerImpl: (handler) => {
        const real = http.createServer(handler);
        // lie about where we landed — this is exactly the failure the post-listen assert exists for
        real.address = () => ({ address: "192.0.2.7", family: "IPv4", port: 4242 });
        const realClose = real.close.bind(real);
        real.close = ((cb?: (e?: Error) => void) => { closed = true; return realClose(cb); }) as typeof real.close;
        return real;
      },
    });
    await expect(l.grant(CTX)).rejects.toThrow(/refused to bind/);
    expect(closed).toBe(true);
    expect(l.status().listening).toBe(false);
  });

  it("mcp-listener.ts names 127.0.0.1 exactly once and never 0.0.0.0", () => {
    const src = readFileSync(new URL("../src/mcp-listener.ts", import.meta.url), "utf8");
    expect(src.split("\n").filter((line) => line.includes("127.0.0.1")).length).toBe(1);
    expect(src).not.toMatch(/0\.0\.0\.0/);
    expect(src).not.toMatch(/process\.env\[[^\]]*HOST/);
  });

  it("grant() resolves null and binds nothing while disabled", async () => {
    const l = makeListener({ enabled: false });
    expect(await l.grant(CTX)).toBeNull();
    const status = l.status();
    expect(status).toEqual({ enabled: false, listening: false, address: null, grants: [] });
  });

  it("mints a distinct grantId, url and token per grant", async () => {
    const l = makeListener();
    const a = (await l.grant(CTX))!;
    const b = (await l.grant({ ...CTX, agentId: "agent-2" }))!;
    expect(a.url).not.toBe(b.url);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);   // randomBytes(32) base64url
    // one socket serves both grants
    expect(new URL(a.url).port).toBe(new URL(b.url).port);
    expect(l.status().grants.map((g) => g.agentId)).toEqual(["agent-1", "agent-2"]);
  });

  it("rejects a request with no Authorization header", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    expect((await post(Number(u.port), u.pathname, { body: RPC })).status).toBe(401);
  });

  it("rejects a bearer token belonging to another live grant", async () => {
    const l = makeListener();
    const a = (await l.grant(CTX))!;
    const b = (await l.grant({ ...CTX, agentId: "agent-2" }))!;
    const u = new URL(a.url);
    const res = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${b.token}` }, body: RPC,
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request carrying an Origin header", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    const res = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}`, origin: "http://evil.example" }, body: RPC,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a Host header that is not the loopback address", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    const res = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}`, host: `attacker.example:${u.port}` }, body: RPC,
    });
    expect(res.status).toBe(403);
    // localhost with the right port is the one non-numeric spelling that is allowed
    const ok = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}`, host: `localhost:${u.port}`, accept: ACCEPT },
      body: INIT,
    });
    expect(ok.status).toBe(200);
  });

  it("rejects GET and DELETE", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await post(Number(u.port), u.pathname, {
        method, headers: { authorization: `Bearer ${g.token}` },
      });
      expect(res.status).toBe(405);
    }
  });

  it("returns 404 for an unknown grant path and for /.well-known/agent-card.json", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const port = Number(new URL(g.url).port);
    const auth = { authorization: `Bearer ${g.token}` };
    for (const path of [`/mcp/${randomUUID()}`, "/.well-known/agent-card.json", "/mcp", "/", `/mcp/${g.url.split("/mcp/")[1]}/extra`]) {
      expect((await post(port, path, { headers: auth, body: RPC })).status).toBe(404);
    }
  });

  it("rejects a body over the size cap", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1_100_000) } });
    const res = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}` }, body: huge,
    }).catch((e: Error) => ({ status: -1, body: e.message }));
    expect(res.status).toBe(413);
  });

  it("an authenticated client sees exactly the tool names the stdio factory produces for the same ctx", async () => {
    const calls: Call[] = [];
    const l = makeListener({ calls });
    const g = (await l.grant(CTX))!;
    const httpClient = new Client({ name: "t", version: "1" });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(g.url), {
      requestInit: { headers: { Authorization: `Bearer ${g.token}` } },
    }));
    const overHttp = (await httpClient.listTools()).tools.map((t) => t.name).sort();
    await httpClient.close();

    const baseline = new Client({ name: "t", version: "1" });
    const server = await createChimeraMcpServer(spyDispatch([]), CTX);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), baseline.connect(clientSide)]);
    const overStdio = (await baseline.listTools()).tools.map((t) => t.name).sort();
    await baseline.close();

    expect(overHttp).toEqual(overStdio);
    expect(overHttp.length).toBeGreaterThan(0);
  });

  it("identity comes from the token: a spoofed X-Chimera-Agent-Id header changes nothing", async () => {
    const calls: Call[] = [];
    const l = makeListener({ calls });
    const g = (await l.grant(CTX))!;
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(g.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${g.token}`,
          "X-Chimera-Agent-Id": "attacker",
          "CHIMERA_AGENT_ID": "attacker",
        },
      },
    }));
    await client.callTool({ name: "rename_self", arguments: { name: "whatever" } });
    await client.close();
    const rename = calls.find((c) => c.method === "agent.rename");
    expect(rename).toBeDefined();
    expect((rename!.params as { agentId: string }).agentId).toBe("agent-1");
  });

  it("revoke() makes the same token 401 on the same url", async () => {
    const l = makeListener();
    const a = (await l.grant(CTX))!;
    // a second live grant keeps the socket open, so the assertion is about auth, not ECONNREFUSED
    await l.grant({ ...CTX, agentId: "agent-2" });
    const u = new URL(a.url);
    const auth = { authorization: `Bearer ${a.token}`, accept: ACCEPT };
    expect((await post(Number(u.port), u.pathname, { headers: auth, body: INIT })).status).toBe(200);
    a.revoke();
    expect((await post(Number(u.port), u.pathname, { headers: auth, body: INIT })).status).toBe(401);
  });

  it("closes the socket when the last grant is revoked", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    const port = Number(new URL(g.url).port);
    g.revoke();
    expect(l.status().listening).toBe(false);
    expect(l.status().address).toBeNull();
    await l.close();
    await expect(new Promise((resolve, reject) => {
      const s = net.connect({ host: LOOPBACK, port });
      s.on("connect", () => { s.destroy(); resolve("connected"); });
      s.on("error", reject);
    })).rejects.toThrow();
  });

  it("revoke() is idempotent", async () => {
    const audits: AuditAppendInput[] = [];
    const l = makeListener({ audits });
    const g = (await l.grant(CTX))!;
    g.revoke();
    expect(() => { g.revoke(); g.revoke(); }).not.toThrow();
    expect(audits.filter((a) => a.reason.includes("revoked")).length).toBe(1);
  });

  it("audits mint, revoke and rejection, and never writes a token into the ledger detail", async () => {
    const audits: AuditAppendInput[] = [];
    const events: RejectedEvent[] = [];
    const l = makeListener({ audits, events });
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    const grantId = u.pathname.split("/").pop()!;
    await post(Number(u.port), u.pathname, { headers: { authorization: "Bearer wrong" }, body: RPC });
    g.revoke();

    expect(audits.map((a) => a.decision)).toEqual(["allow", "deny", "recorded"]);
    expect(audits.every((a) => a.action === "mcp_listener_grant")).toBe(true);
    expect(audits.every((a) => a.resource.startsWith("mcp-listener:"))).toBe(true);
    expect(audits[0]!.detail).toMatchObject({ provider: "kimi", depth: 1 });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(g.token);
    expect(serialized).not.toContain("wrong");

    // F49.QA-FIX2 (Item 2): the 401 bearer-reject must also surface as an event, not just a
    // ledger append, so a live surface (app/TUI/agent) can observe the rejection.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ grantId, agentId: CTX.agentId, reason: "bearer token rejected" });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(g.token);
    expect(serializedEvents).not.toContain("wrong");
  });

  // AC-10 says "each rejected request" appends a record. The rebinding rejections are the ones
  // that matter forensically — a silent 403 means the attack the threat model claims to defend
  // against leaves no trace at all (QA of F49).
  it("audits both rebinding rejections without echoing an attacker-controlled header", async () => {
    const audits: AuditAppendInput[] = [];
    const events: RejectedEvent[] = [];
    const l = makeListener({ audits, events });
    const g = (await l.grant(CTX))!;
    const u = new URL(g.url);
    const grantId = u.pathname.split("/").pop()!;
    const origin = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}`, origin: "http://evil.example" },
      body: RPC,
    });
    const host = await post(Number(u.port), u.pathname, {
      headers: { authorization: `Bearer ${g.token}`, host: `attacker.example:${u.port}` },
      body: RPC,
    });

    expect([origin.status, host.status]).toEqual([403, 403]);
    const denies = audits.filter((a) => a.decision === "deny");
    expect(denies.length).toBe(2);
    expect(denies.every((a) => a.action === "mcp_listener_grant" && a.agentId === CTX.agentId)).toBe(true);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(g.token);
    expect(serialized).not.toContain("evil.example");
    expect(serialized).not.toContain("attacker.example");

    // F49.QA-FIX2 (Item 2): both rebinding rejections must also surface as events — same
    // token/attacker-header-free shape required of the ledger.
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.grantId === grantId && e.agentId === CTX.agentId)).toBe(true);
    expect(events.map((e) => e.reason)).toEqual([
      "origin header present (browser or dns-rebinding attempt)",
      "host header does not name the loopback socket",
    ]);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain(g.token);
    expect(serializedEvents).not.toContain("evil.example");
    expect(serializedEvents).not.toContain("attacker.example");
  });

  it("disable() revokes every live grant", async () => {
    const l = makeListener();
    const a = (await l.grant(CTX))!;
    await l.grant({ ...CTX, agentId: "agent-2" });
    const port = Number(new URL(a.url).port);
    await l.disable();
    expect(l.status()).toEqual({ enabled: false, listening: false, address: null, grants: [] });
    // and it stays off: a later grant does not re-bind
    expect(await l.grant(CTX)).toBeNull();
    await expect(post(port, new URL(a.url).pathname, {
      headers: { authorization: `Bearer ${a.token}` }, body: RPC,
    })).rejects.toThrow();
  });

  // F49.QA-FIX (Item 1): revoked ids used to accumulate for the whole daemon process lifetime —
  // disable()/close() must actually return the listener to a clean state.
  it("disable() clears the revoked set", async () => {
    const l = makeListener();
    const g = (await l.grant(CTX))!;
    g.revoke();
    expect((l as unknown as { revoked: Set<string> }).revoked.size).toBe(1);
    await l.disable();
    expect((l as unknown as { revoked: Set<string> }).revoked.size).toBe(0);
  });

  // F49.QA-FIX (Item 1): the set is bounded so a long-lived daemon spawning many short-lived
  // (e.g. kimi) agents doesn't grow it forever. Past the bound, the oldest id is evicted —
  // degrading its replay from 401 (revoked, audited) to 404 (unknown) — while recent ids still
  // answer 401.
  it("bounds the revoked set, evicting the oldest id while a recent one still answers 401", async () => {
    const l = makeListener();
    // keep one real grant alive so the socket stays open for the whole test
    const anchor = (await l.grant(CTX))!;
    const port = Number(new URL(anchor.url).port);

    const revokedSet = (l as unknown as { revoked: Set<string> }).revoked;
    const grantsMap = (l as unknown as {
      grants: Map<string, { tokenDigest: Buffer; ctx: unknown; agentId: string; provider: string; since: number }>;
    }).grants;
    const revokeFn = (l as unknown as { revoke: (id: string) => void }).revoke.bind(l);

    const ids = Array.from({ length: 1001 }, () => randomUUID());
    for (const id of ids) {
      grantsMap.set(id, { tokenDigest: Buffer.alloc(32), ctx: CTX, agentId: "agent-x", provider: "kimi", since: 0 });
      revokeFn(id);
    }

    expect(revokedSet.size).toBe(1000);
    const oldest = ids[0]!;
    const recent = ids[ids.length - 1]!;
    expect(revokedSet.has(oldest)).toBe(false);
    expect(revokedSet.has(recent)).toBe(true);

    const oldestRes = await post(port, `/mcp/${oldest}`, { headers: { authorization: "Bearer whatever" }, body: RPC });
    expect(oldestRes.status).toBe(404);
    const recentRes = await post(port, `/mcp/${recent}`, { headers: { authorization: "Bearer whatever" }, body: RPC });
    expect(recentRes.status).toBe(401);
  });
});
