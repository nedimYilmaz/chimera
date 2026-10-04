// SSRF-GUARD: the connection-level fetch guard behind MCP OAuth discovery. Everything runs on a
// fake resolver + a recording transport (the seams sit BELOW validation), plus a loopback
// fixture for the production `nodeTransport` -- no test ever resolves a real name or touches a
// real internal address.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import {
  blockedAddressReason,
  createGuardedFetch,
  GuardedFetchLimitError,
  nodeTransport,
  SsrfBlockedError,
  type PinnedRequest,
  type RawResponse,
  type Transport,
} from "@chimera/core/providers/ssrf-guard";

afterEach(() => { vi.restoreAllMocks(); });

function reply(status: number, headers: Record<string, string> = {}, body = ""): RawResponse {
  return { status, statusText: "", headers: Object.entries(headers), body: new TextEncoder().encode(body) };
}

/** Records every request the guard let through to the wire. */
function recorder(handler: (req: PinnedRequest, n: number) => RawResponse | Promise<RawResponse>) {
  const calls: PinnedRequest[] = [];
  const transport: Transport = async (req) => { calls.push(req); return handler(req, calls.length); };
  return { transport, calls };
}

const publicDns = (answer = "8.8.8.8") => vi.fn(async () => [answer]);

describe("blockedAddressReason", () => {
  const blocked = [
    // IPv4 special-purpose
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    // IPv6 non-global and the embedded-IPv4 forms that would land on a prohibited v4
    "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::",
    "fe80::1", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "2001:1::1", "3fff::1",
    // not an address at all / scoped
    "garbage", "", "1.2.3", "256.1.1.1", "localhost", "fe80::1%eth0", "2606:4700::1%eth0",
  ];
  it.each(blocked)("blocks %j", (ip) => {
    expect(blockedAddressReason(ip)).toEqual(expect.any(String));
  });

  const allowed = [
    "8.8.8.8", "1.1.1.1", "9.9.9.9", "11.0.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "172.15.0.1", "172.32.0.1",
    "192.169.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255",
    "2606:4700::1", "2001:4860:4860::8888", "2a00:1450::1",
    "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::",
  ];
  it.each(allowed)("allows %j", (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
});

describe("createGuardedFetch: destination validation", () => {
  it.each([
    "http://127.0.0.1/", "http://127.0.0.1:8080/mcp", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://0x7f.1/", "http://2130706433/", "http://017700000001/",
    "http://10.0.0.5:8080/", "http://192.168.1.1/", "http://224.0.0.1/", "http://[fd00::1]/", "http://[fe80::1]/",
  ])("a literal %s never reaches the resolver or the wire", async (url) => {
    const resolver = publicDns();
    const { transport, calls } = recorder(() => reply(200));
    const guarded = createGuardedFetch({ resolver, transport });
    await expect(guarded(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(resolver).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a loopback answer", ["127.0.0.1"]],
    ["a link-local answer", ["169.254.169.254"]],
    ["an IPv4-mapped loopback answer", ["::ffff:127.0.0.1"]],
    ["a mixed round-robin where ANY answer is private", ["8.8.8.8", "10.0.0.1"]],
    ["a mixed round-robin with the private answer first", ["192.168.0.10", "8.8.8.8"]],
    ["an unparsable answer", ["not-an-ip"]],
  ])("a name resolving to %s is blocked before any connection", async (_label, answers) => {
    const { transport, calls } = recorder(() => reply(200));
    const guarded = createGuardedFetch({ resolver: async () => answers, transport });
    await expect(guarded("https://evil.example/mcp")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(0);
  });

  it.each(["ftp://8.8.8.8/x", "file:///etc/passwd", "gopher://8.8.8.8/"])("refuses non-http scheme %s", async (url) => {
    const { transport, calls } = recorder(() => reply(200));
    await expect(createGuardedFetch({ resolver: publicDns(), transport })(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a URL with embedded credentials", async () => {
    const { transport, calls } = recorder(() => reply(200));
    await expect(createGuardedFetch({ resolver: publicDns(), transport })("https://user:pw@public.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("a public destination goes through, pinned to the validated address with the original hostname", async () => {
    const resolver = publicDns("1.1.1.1");
    const { transport, calls } = recorder(() => reply(200, { "content-type": "application/json" }, '{"ok":true}'));
    const res = await createGuardedFetch({ resolver, transport })("https://api.example/mcp?x=1", { headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pinnedIp: "1.1.1.1", hostname: "api.example", method: "GET" });
    expect(calls[0]!.url.href).toBe("https://api.example/mcp?x=1");
    expect(calls[0]!.headers).toMatchObject({ accept: "application/json", "accept-encoding": "identity" });
  });

  it("a lookup failure is an ordinary network failure (TypeError), not a policy abort", async () => {
    const { transport, calls } = recorder(() => reply(200));
    const guarded = createGuardedFetch({ resolver: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); }, transport });
    await expect(guarded("https://nope.example/")).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("createGuardedFetch: DNS rebinding / TOCTOU", () => {
  it("resolves ONCE per hop and connects to that very answer, even if the name later points at loopback", async () => {
    // First answer public, every later answer loopback -- the classic rebinding record.
    const resolver = vi.fn<(h: string) => Promise<string[]>>()
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValue(["127.0.0.1"]);
    const { transport, calls } = recorder(() => reply(200, {}, "ok"));
    const res = await createGuardedFetch({ resolver, transport })("https://rebind.example/mcp");
    expect(await res.text()).toBe("ok");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.pinnedIp)).toEqual(["8.8.8.8"]);
  });

  it("re-validates a redirect hop with its own resolution: a hop that rebinds to loopback is blocked", async () => {
    const answers: Record<string, string[]> = { "first.example": ["8.8.8.8"], "second.example": ["127.0.0.1"] };
    const resolver = vi.fn(async (h: string) => answers[h]!);
    const { transport, calls } = recorder(() => reply(302, { location: "https://second.example/x" }));
    await expect(createGuardedFetch({ resolver, transport })("https://first.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(1);
    expect(calls.map((c) => c.pinnedIp)).toEqual(["8.8.8.8"]);
  });
});

describe("createGuardedFetch: redirects", () => {
  it("follows a safe public -> public redirect (relative Location included) to the final response", async () => {
    const answers: Record<string, string> = { "a.example": "8.8.8.8", "b.example": "1.1.1.1" };
    const resolver = vi.fn(async (h: string) => [answers[h]!]);
    const { transport, calls } = recorder((req) => {
      if (req.url.hostname === "a.example" && req.url.pathname === "/start") return reply(301, { location: "/moved" });
      if (req.url.hostname === "a.example") return reply(302, { location: "https://b.example/final" });
      return reply(200, {}, "final");
    });
    const res = await createGuardedFetch({ resolver, transport })("https://a.example/start");
    expect(await res.text()).toBe("final");
    expect(calls.map((c) => [c.url.hostname, c.url.pathname, c.pinnedIp])).toEqual([
      ["a.example", "/start", "8.8.8.8"],
      ["a.example", "/moved", "8.8.8.8"],
      ["b.example", "/final", "1.1.1.1"],
    ]);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:9/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "file:///etc/passwd",
  ])("a redirect to %s is blocked and the destination is never contacted", async (target) => {
    const { transport, calls } = recorder(() => reply(302, { location: target }));
    await expect(createGuardedFetch({ resolver: publicDns(), transport })("https://public.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hostname).toBe("public.example");
  });

  it("a redirect to a hostname that resolves private is blocked", async () => {
    const resolver = vi.fn(async (h: string) => (h === "internal.example" ? ["10.1.2.3"] : ["8.8.8.8"]));
    const { transport, calls } = recorder(() => reply(307, { location: "https://internal.example/admin" }));
    await expect(createGuardedFetch({ resolver, transport })("https://public.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(1);
  });

  it("caps the redirect chain (5 hops by default) with a non-TypeError limit error", async () => {
    const { transport, calls } = recorder((_req, n) => reply(302, { location: `/hop${n}` }));
    const failure = await createGuardedFetch({ resolver: publicDns(), transport })("https://loop.example/").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GuardedFetchLimitError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(6);   // the original + 5 followed redirects
  });

  it("refuses to follow a redirect for a POST (the body would be replayed to a host nobody named)", async () => {
    const { transport, calls } = recorder(() => reply(307, { location: "https://other.example/token" }));
    await expect(createGuardedFetch({ resolver: publicDns(), transport })("https://as.example/token", { method: "POST", body: new URLSearchParams({ code: "secret" }) }))
      .rejects.toBeInstanceOf(GuardedFetchLimitError);
    expect(calls).toHaveLength(1);
  });

  it("drops credentials on a cross-origin redirect but keeps them same-origin", async () => {
    const seen: Array<Record<string, string>> = [];
    const { transport } = recorder((req, n) => {
      seen.push(req.headers);
      if (n === 1) return reply(302, { location: "/same-origin" });
      if (n === 2) return reply(302, { location: "https://elsewhere.example/x" });
      return reply(200);
    });
    await createGuardedFetch({ resolver: publicDns(), transport })("https://origin.example/", {
      headers: { authorization: "Bearer t", cookie: "a=b", accept: "*/*" },
    });
    expect(seen[1]).toMatchObject({ authorization: "Bearer t", cookie: "a=b" });
    expect(seen[2]).not.toHaveProperty("authorization");
    expect(seen[2]).not.toHaveProperty("cookie");
    expect(seen[2]).toMatchObject({ accept: "*/*" });
  });

  it("returns a 3xx without Location as-is", async () => {
    const { transport } = recorder(() => reply(304));
    const res = await createGuardedFetch({ resolver: publicDns(), transport })("https://api.example/");
    expect(res.status).toBe(304);
  });
});

describe("createGuardedFetch: failure classes", () => {
  it("a wire failure surfaces as TypeError('fetch failed') with the cause, like global fetch", async () => {
    const boom = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const { transport, calls } = recorder(() => { throw boom; });
    const failure = await createGuardedFetch({ resolver: async () => ["8.8.8.8", "1.1.1.1"], transport })("https://flaky.example/").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("fetch failed");
    expect((failure as Error).cause).toBe(boom);
    expect(calls).toHaveLength(1);   // ECONNRESET is not a connect-phase code: no second address
  });

  it("falls back to the next validated address only on a connect-phase failure", async () => {
    const { transport, calls } = recorder((req) => {
      if (req.pinnedIp === "8.8.8.8") throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return reply(200, {}, "via-v4");
    });
    const res = await createGuardedFetch({ resolver: async () => ["8.8.8.8", "1.1.1.1"], transport })("https://dual.example/");
    expect(await res.text()).toBe("via-v4");
    expect(calls.map((c) => c.pinnedIp)).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("a policy error raised by the transport is propagated untouched (never wrapped into a retryable TypeError)", async () => {
    const limit = new GuardedFetchLimitError("response body exceeds 1 bytes");
    const { transport } = recorder(() => { throw limit; });
    await expect(createGuardedFetch({ resolver: publicDns(), transport })("https://big.example/")).rejects.toBe(limit);
  });

  it("times out a stalled request with a non-TypeError", async () => {
    const transport: Transport = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
    const failure = await createGuardedFetch({ resolver: publicDns(), transport, timeoutMs: 20 })("https://slow.example/").catch((e: unknown) => e);
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(TypeError);
    expect((failure as Error).name).toBe("TimeoutError");
  });

  it("times out a hung DNS lookup too (dns.lookup itself cannot be aborted)", async () => {
    const { transport, calls } = recorder(() => reply(200));
    const failure = await createGuardedFetch({ resolver: () => new Promise<string[]>(() => {}), transport, timeoutMs: 20 })("https://hung.example/").catch((e: unknown) => e);
    expect((failure as Error).name).toBe("TimeoutError");
    expect(calls).toHaveLength(0);
  });

  it("honours a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const transport: Transport = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
    const pending = createGuardedFetch({ resolver: publicDns(), transport, timeoutMs: 5_000 })("https://slow.example/", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("an exhausted overall budget refuses further requests without touching DNS or the wire", async () => {
    const resolver = publicDns();
    const { transport, calls } = recorder(() => reply(200));
    const guarded = createGuardedFetch({ resolver, transport, budgetMs: 15 });
    await guarded("https://api.example/one");
    await new Promise((r) => setTimeout(r, 40));
    const failure = await guarded("https://api.example/two").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GuardedFetchLimitError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe("createGuardedFetch: request shape and resolution edge cases", () => {
  it.each([
    ["ReadableStream", () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } })],
    ["Blob", () => new Blob(["x"])],
    ["FormData", () => { const f = new FormData(); f.set("k", "v"); return f; }],
  ])("refuses a %s body as a non-retryable limit error before DNS or the wire", async (_label, make) => {
    const resolver = publicDns();
    const { transport, calls } = recorder(() => reply(200));
    const failure = await createGuardedFetch({ resolver, transport })("https://api.example/token", { method: "POST", body: make() }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GuardedFetchLimitError);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(resolver).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("an empty DNS answer is an ordinary fetch failure naming the host, with no wire call", async () => {
    const { transport, calls } = recorder(() => reply(200));
    const failure = await createGuardedFetch({ resolver: async () => [], transport })("https://ghost.example/").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("fetch failed");
    expect(((failure as Error).cause as Error).message).toContain("no address for ghost.example");
    expect(calls).toHaveLength(0);
  });

  it("an unparsable redirect Location aborts with a limit error after one wire call", async () => {
    const { transport, calls } = recorder(() => reply(302, { location: "http://[" }));
    const failure = await createGuardedFetch({ resolver: publicDns(), transport })("https://api.example/start").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GuardedFetchLimitError);
    expect((failure as Error).message).toBe("invalid redirect location");
    expect(calls).toHaveLength(1);
  });
});

describe("nodeTransport (production wire)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    const s = createServer(handler);
    server = s;
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
    return (s.address() as AddressInfo).port;
  }

  const wire = (port: number, extra: Partial<PinnedRequest> = {}): PinnedRequest => ({
    url: new URL(`http://oauth.example:${port}/p?q=1`),
    pinnedIp: "127.0.0.1",
    hostname: "oauth.example",
    method: "GET",
    headers: {},
    body: undefined,
    signal: AbortSignal.timeout(5_000),
    maxBytes: 1024,
    ...extra,
  });

  it("dials the pinned IP while sending the ORIGINAL hostname as Host", async () => {
    let seen: { host?: string; url?: string; encoding?: string } = {};
    const port = await listen((req, res) => {
      seen = { host: req.headers.host, url: req.url, encoding: String(req.headers["accept-encoding"]) };
      res.writeHead(200, { "content-type": "text/plain", "x-multi": "1" }).end("hello");
    });
    const raw = await nodeTransport(wire(port, { headers: { "accept-encoding": "identity" } }));
    expect(seen).toEqual({ host: `oauth.example:${port}`, url: "/p?q=1", encoding: "identity" });
    expect(raw.status).toBe(200);
    expect(Buffer.from(raw.body).toString()).toBe("hello");
    expect(raw.headers.find(([k]) => k.toLowerCase() === "x-multi")?.[1]).toBe("1");
  });

  it("sends a request body", async () => {
    let got = "";
    const port = await listen((req, res) => {
      req.on("data", (c: Buffer) => { got += c.toString(); });
      req.on("end", () => res.writeHead(200).end("done"));
    });
    await nodeTransport(wire(port, { method: "POST", body: new TextEncoder().encode("grant_type=x"), headers: { "content-length": "12" } }));
    expect(got).toBe("grant_type=x");
  });

  it("rejects a declared Content-Length over the cap without buffering it", async () => {
    const port = await listen((_req, res) => { res.writeHead(200, { "content-length": "999999" }); res.write("x"); });
    await expect(nodeTransport(wire(port))).rejects.toBeInstanceOf(GuardedFetchLimitError);
  });

  it("rejects a chunked stream that grows past the cap", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);   // no content-length -> chunked
      const timer = setInterval(() => res.write("y".repeat(512)), 5);
      res.on("close", () => clearInterval(timer));
    });
    await expect(nodeTransport(wire(port))).rejects.toBeInstanceOf(GuardedFetchLimitError);
  });

  it("aborts a stalled response with the signal's reason", async () => {
    const port = await listen(() => { /* never answers */ });
    const failure = await nodeTransport(wire(port, { signal: AbortSignal.timeout(30) })).catch((e: unknown) => e);
    expect((failure as Error).name).toBe("TimeoutError");
  });

  it("rejects without connecting when the signal is already aborted", async () => {
    let hits = 0;
    const port = await listen((_req, res) => { hits++; res.end(); });
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(nodeTransport(wire(port, { signal: controller.signal }))).rejects.toThrow("already");
    expect(hits).toBe(0);
  });

  it("surfaces a refused connection with its errno code (so the guard can try the next address)", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const failure = await nodeTransport(wire(port)).catch((e: unknown) => e);
    expect((failure as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });

  it("https: connects to the pinned IP but verifies the certificate / SNI against the hostname", async () => {
    let captured: https.RequestOptions | undefined;
    vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions) => {
      captured = options;
      throw new Error("captured");
    }) as unknown as typeof https.request);
    await expect(nodeTransport(wire(443, { url: new URL("https://api.example/mcp"), hostname: "api.example", pinnedIp: "8.8.8.8" }))).rejects.toThrow("captured");
    expect(captured).toMatchObject({ host: "8.8.8.8", port: 443, servername: "api.example", agent: false, path: "/mcp" });
    expect((captured!.headers as Record<string, string>).host).toBe("api.example");
  });

  it("https to an IP literal sends no SNI (an IP is not a valid server name)", async () => {
    let captured: https.RequestOptions | undefined;
    vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions) => {
      captured = options;
      throw new Error("captured");
    }) as unknown as typeof https.request);
    await expect(nodeTransport(wire(443, { url: new URL("https://8.8.8.8/mcp"), hostname: "8.8.8.8", pinnedIp: "8.8.8.8" }))).rejects.toThrow("captured");
    expect(captured).not.toHaveProperty("servername");
  });
});
