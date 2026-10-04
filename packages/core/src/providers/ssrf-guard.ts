// SSRF-GUARD: a `fetch` replacement for requests whose destination an UNTRUSTED party chose
// (an agent-proposed MCP server URL, and every hop discovery then follows from it: the
// well-known path, a `resource_metadata` challenge URL, `authorization_servers[0]`, redirects).
//
// WHY a connection-level guard instead of a URL check: validating the hostname and then handing
// the URL to `fetch` re-resolves DNS at connect time, so a rebinding record (public on the
// check, 127.0.0.1 on the connect) walks straight through. Here the hostname is resolved ONCE
// per hop, every returned address is classified, and the socket is opened to the validated
// literal IP -- with SNI/Host still carrying the original hostname so TLS and virtual hosting
// behave. The validated resolution is the connection; there is no second lookup to race.
//
// Redirects are followed by hand (never by the platform) so each `Location` is re-resolved and
// re-validated like any other request. Hops, wall-clock time and body size are all bounded.
//
// Error contract, which the MCP SDK's `fetchWithCorsRetry` forces: it swallows a `TypeError`
// and retries/falls back, so policy decisions (blocked / limit / timeout) MUST NOT be
// TypeErrors -- they have to abort the discovery sequence -- while ordinary network failures are
// reported as `TypeError("fetch failed")`, exactly as global fetch does, so the SDK's own
// root-path fallback keeps working against a flaky public server.
//
// The test seams (`resolver`, `transport`) sit strictly BELOW validation: a resolver can only
// supply addresses, a transport only ever receives an already-validated pinned IP. Neither can
// switch the guard off.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class GuardedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The destination (literal, DNS answer, redirect target, ...) is not a public address. */
export class SsrfBlockedError extends GuardedFetchError {}
/** A redirect / time / body bound was hit, or the request shape is unsupported. */
export class GuardedFetchLimitError extends GuardedFetchError {}

type Cidr4 = readonly [base: string, bits: number, label: string];

// Everything that is not globally routable unicast (IANA special-purpose registry), so a name
// can never be steered at the daemon host, its LAN, a cloud metadata endpoint or a gateway.
const BLOCKED_V4: readonly Cidr4[] = [
  ["0.0.0.0", 8, "unspecified/this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved/broadcast"],
];

function v4ToInt(bytes: ArrayLike<number>): number {
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

function v4Reason(bytes: ArrayLike<number>): string | null {
  const n = v4ToInt(bytes);
  for (const [base, bits, label] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === (v4ToInt(base.split(".").map(Number)) & mask) >>> 0) return label;
  }
  return null;
}

/** 16 bytes for a syntactically valid IPv6 literal, else null. */
function v6Bytes(ip: string): Uint8Array | null {
  // net.isIPv6 ACCEPTS `fe80::1%eth0`; a scoped address has no public meaning, so refuse it here.
  if (ip.includes("%") || !net.isIPv6(ip)) return null;
  let text = ip;
  const out = new Uint8Array(16);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let v4Tail: number[] | null = null;
  if (tail) {
    v4Tail = tail[1]!.split(".").map(Number);
    text = text.slice(0, -tail[1]!.length) + "0:0";
  }
  const [head, rest] = text.includes("::") ? text.split("::", 2) as [string, string] : [text, null];
  const headGroups = head === "" ? [] : head.split(":");
  const restGroups = rest === null || rest === "" ? [] : rest.split(":");
  const groups = rest === null
    ? headGroups
    : [...headGroups, ...new Array<string>(8 - headGroups.length - restGroups.length).fill("0"), ...restGroups];
  if (groups.length !== 8) return null;
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  if (v4Tail) v4Tail.forEach((b, i) => { out[12 + i] = b; });
  return out;
}

/**
 * Why `ip` must not be contacted, or null when it is a public unicast address. Anything that
 * is not a parseable IP is blocked. IPv6 is an ALLOWlist (2000::/3 global unicast minus the
 * special-purpose carve-outs) so an unanticipated range fails closed; the embedded-IPv4 forms
 * (IPv4-mapped, 6to4, NAT64) are classified by the IPv4 they carry, because that is where the
 * packet finally goes.
 */
export function blockedAddressReason(ip: string): string | null {
  if (net.isIPv4(ip)) return v4Reason(ip.split(".").map(Number));
  const b = v6Bytes(ip);
  if (!b) return "not an IP address";

  const zeroUpTo = (end: number): boolean => b.subarray(0, end).every((x) => x === 0);
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) {
    const inner = v4Reason(b.subarray(12));
    return inner ? `IPv4-mapped ${inner}` : null;
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.subarray(4, 12).every((x) => x === 0)) {
    const inner = v4Reason(b.subarray(12));   // DNS64 hands out these for IPv4-only public hosts
    return inner ? `NAT64 ${inner}` : null;
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    const inner = v4Reason(b.subarray(2, 6));
    return inner ? `6to4 ${inner}` : null;
  }
  if ((b[0]! & 0xe0) !== 0x20) return "non-global IPv6 (loopback/link-local/unique-local/multicast/reserved)";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! < 0x02) return "IETF protocol assignments/Teredo";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0) return "documentation";
  return null;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

export type PinnedRequest = {
  url: URL;
  /** The only address the socket may be opened to; already validated as public. */
  pinnedIp: string;
  /** Original hostname -- SNI, certificate identity and the Host header, never a lookup. */
  hostname: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  signal: AbortSignal;
  maxBytes: number;
};
export type RawResponse = { status: number; statusText: string; headers: Array<[string, string]>; body: Uint8Array };
export type Transport = (req: PinnedRequest) => Promise<RawResponse>;

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
// Connect-phase failures only: a dual-stack host whose AAAA is unreachable from here must still
// be reachable over A. Never retried after bytes may have been sent (that would double a POST).
const CONNECT_RETRY_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);
const MAX_ADDRESS_ATTEMPTS = 4;

export const nodeTransport: Transport = (req) => new Promise<RawResponse>((resolve, reject) => {
  if (req.signal.aborted) { reject(req.signal.reason ?? new GuardedFetchLimitError("request aborted")); return; }
  const { url } = req;
  const secure = url.protocol === "https:";
  const bareHost = req.hostname.replace(/^\[|\]$/g, "");
  const options: https.RequestOptions = {
    host: req.pinnedIp,   // an IP literal: node skips DNS entirely
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers: { ...req.headers, host: url.host },
    agent: false,
    // Cert identity is checked against `servername`, not the IP we dialed. SNI must not be an IP.
    ...(secure && net.isIP(bareHost) === 0 ? { servername: bareHost } : {}),
  };
  let settled = false;
  const done = (fn: () => void): void => { if (!settled) { settled = true; req.signal.removeEventListener("abort", onAbort); fn(); } };
  const request = (secure ? https : http).request(options, (res) => {
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > req.maxBytes) {
      request.destroy();
      done(() => reject(new GuardedFetchLimitError(`response body exceeds ${req.maxBytes} bytes`)));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > req.maxBytes) {
        request.destroy();
        done(() => reject(new GuardedFetchLimitError(`response body exceeds ${req.maxBytes} bytes`)));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => done(() => {
      const headers: Array<[string, string]> = [];
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
      resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers, body: Buffer.concat(chunks) });
    }));
    res.on("error", (err) => done(() => reject(err)));
    res.on("close", () => done(() => reject(new Error("connection closed before the response completed"))));
  });
  const onAbort = (): void => {
    request.destroy();
    done(() => reject(req.signal.reason ?? new GuardedFetchLimitError("request aborted")));
  };
  // Registered before anything can destroy the request: a destroy() with no 'error' listener
  // would surface as an uncaught exception.
  request.on("error", (err) => done(() => reject(err)));
  req.signal.addEventListener("abort", onAbort, { once: true });
  request.end(req.body ? Buffer.from(req.body) : undefined);
});

export type GuardedFetchOptions = {
  resolver?: Resolver;
  transport?: Transport;
  /** Wall clock for ONE fetch call, redirect chain included. */
  timeoutMs?: number;
  /** Wall clock for every call made through this fetch instance together. */
  budgetMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
};
/** The seams a test may supply. Deliberately excludes anything that could relax validation. */
export type GuardedFetchSeams = Pick<GuardedFetchOptions, "resolver" | "transport">;

function toBody(body: RequestInit["body"], headers: Headers): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return new TextEncoder().encode(body.toString());
  }
  throw new GuardedFetchLimitError("unsupported request body type");
}

/** Rejects with the signal's reason as soon as it aborts; `dns.lookup` itself is not abortable. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Resolve once and return the validated address list for `url`, or throw SsrfBlockedError.
 * An IP-literal host (incl. `[::ffff:127.0.0.1]`; WHATWG URL has already canonicalised
 * `0x7f.1`/`2130706433` to dotted-decimal) skips DNS and is classified directly.
 */
async function validatedAddresses(url: URL, resolver: Resolver, signal: AbortSignal): Promise<string[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfBlockedError(`blocked scheme ${url.protocol}`);
  if (url.username || url.password) throw new SsrfBlockedError("blocked URL with embedded credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new SsrfBlockedError("blocked empty host");
  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await raceAbort(resolver(host), signal);
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      // A lookup failure is an ordinary network failure (global fetch reports it as this TypeError).
      throw new TypeError("fetch failed", { cause: err });
    }
    if (addresses.length === 0) throw new TypeError("fetch failed", { cause: new Error(`no address for ${host}`) });
  }
  // ANY prohibited answer blocks the request: an attacker-controlled round-robin must not be
  // able to win the one address that matters.
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new SsrfBlockedError(`blocked destination ${host} -> ${address} (${reason})`);
  }
  return addresses;
}

export function createGuardedFetch(opts: GuardedFetchOptions = {}): typeof fetch {
  const resolver = opts.resolver ?? defaultResolver;
  const transport = opts.transport ?? nodeTransport;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const budgetEnd = opts.budgetMs === undefined ? Infinity : performance.now() + opts.budgetMs;

  return async (input, init) => {
    const remaining = budgetEnd - performance.now();
    if (remaining <= 0) throw new GuardedFetchLimitError("discovery time budget exhausted");
    // AbortSignal.timeout() only accepts integers; the budget remainder is fractional.
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, remaining))));
    const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout;

    let current = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = toBody(init?.body, headers);
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");   // we do not inflate
    if (body) headers.set("content-length", String(body.byteLength));

    for (let hop = 0; ; hop++) {
      if (hop > maxRedirects) throw new GuardedFetchLimitError(`more than ${maxRedirects} redirects`);
      const addresses = await validatedAddresses(current, resolver, signal);
      let raw: RawResponse | undefined;
      let lastError: unknown;
      for (const pinnedIp of addresses.slice(0, MAX_ADDRESS_ATTEMPTS)) {
        try {
          raw = await transport({
            url: current, pinnedIp, hostname: current.hostname, method,
            headers: Object.fromEntries(headers), body, signal, maxBytes: maxBodyBytes,
          });
          break;
        } catch (err) {
          if (signal.aborted) throw signal.reason ?? err;
          if (err instanceof GuardedFetchError) throw err;
          lastError = err;
          if (!CONNECT_RETRY_CODES.has((err as NodeJS.ErrnoException | undefined)?.code ?? "")) break;
        }
      }
      if (!raw) throw new TypeError("fetch failed", { cause: lastError });

      const location = raw.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
      if (REDIRECT_STATUS.has(raw.status) && location !== undefined) {
        // A redirected POST would carry its body (auth codes, client secrets) to a host the
        // caller never named. Discovery is GET-only; refuse rather than replay.
        if (method !== "GET" && method !== "HEAD") throw new GuardedFetchLimitError(`refusing to follow a ${raw.status} redirect for ${method}`);
        let next: URL;
        try { next = new URL(location, current); } catch { throw new GuardedFetchLimitError("invalid redirect location"); }
        if (next.origin !== current.origin) {
          headers.delete("authorization"); headers.delete("cookie"); headers.delete("proxy-authorization");
        }
        current = next;
        continue;
      }

      const responseHeaders = new Headers();
      for (const [name, value] of raw.headers) responseHeaders.append(name, value);
      return new Response(NO_BODY_STATUS.has(raw.status) ? null : (raw.body as BodyInit), {
        status: raw.status, statusText: raw.statusText, headers: responseHeaders,
      });
    }
  };
}
