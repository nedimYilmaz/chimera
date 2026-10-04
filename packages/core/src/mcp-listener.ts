import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createChimeraMcpServer, type ChimeraMcpDispatch } from "@chimera/protocol/mcp-server-factory";
import type { ChimeraMcpCtx, McpListenerStatus } from "@chimera/protocol";
import type { AuditAppendInput } from "./audit-ledger.js";

// F49: the by-construction half of the loopback contract. This is a module constant and NOT a
// parameter, a config field or an env lookup, because the only way to guarantee a listener never
// answers off-box is to make the alternative unrepresentable. The post-listen assertion in
// ensureListening() is the second half: if the OS ever hands us a different address we close and
// refuse rather than serve. Grep guards in the F49 plan enforce that this literal appears here once.
const BIND_HOST = "127.0.0.1";

// A tool call is JSON, not an upload. Anything larger is a bug or an attack; either way we would
// rather answer 413 than buffer it.
const MAX_BODY_BYTES = 1_048_576;

const GRANT_PATH = /^\/mcp\/([0-9a-f-]{36})$/;

export type McpListenerGrant = {
  url: string;
  /** Memory-only bearer. Never persisted, never logged, never placed in an audit detail. */
  token: string;
  revoke(): void;
};

export type LoopbackMcpListenerOptions = {
  enabled: boolean;
  dispatch: ChimeraMcpDispatch;
  audit?: (input: AuditAppendInput) => void;
  // F49.QA-FIX2 (finding: rejected clients existed only as an audit-ledger append, so no
  // surface — app/TUI/agent — could ever see one). Fired alongside `audit` at the exact same
  // AC-10 boundary (401 + both rebinding 403s), never at the pre-gate 404/405s.
  emit?: (data: { grantId: string; agentId: string | null; reason: string }) => void;
  now?: () => number;
  /** Test seam for the "OS bound us somewhere else" path; never a host/port knob. */
  createServerImpl?: (handler: http.RequestListener) => http.Server;
};

type GrantRecord = {
  // The raw token is deliberately NOT kept: the comparison is digest-vs-digest anyway, so the
  // only long-lived copy of the secret is the one the caller handed to the child process.
  tokenDigest: Buffer;
  // A grant owns an IDENTITY, not a live MCP server — the server is rebuilt per request
  // (see handleRequest), so this ctx is the whole of what the grant carries between calls.
  ctx: ChimeraMcpCtx;
  agentId: string;
  provider: string;
  since: number;
};

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * A loopback-only, token-authenticated HTTP front end for the same MCP tool table the stdio
 * server exposes — built for ACP backends (kimi) that can only talk HTTP MCP.
 *
 * The socket exists only while at least one grant does: it binds on the first grant and closes
 * on the last revoke, so a daemon with no HTTP-capable agents has no inbound surface at all.
 */
export class LoopbackMcpListener {
  private enabled: boolean;
  private readonly grants = new Map<string, GrantRecord>();
  // A revoked id is not an UNKNOWN id: replaying its token must read as "no longer authorised"
  // (401 + an audit record), not as a 404 that hides the attempt.
  private readonly revoked = new Set<string>();
  // Bounded so a long-lived daemon spawning many short-lived (e.g. kimi) agents doesn't grow this
  // set forever (~100 B/id). Evicting the oldest id once we're over the cap degrades a replay from
  // 401 ("no longer authorised", with its audit record) to 404 ("never existed") — acceptable only
  // because by the time eviction happens the grant is long dead and the audit trail already has it.
  private static readonly MAX_REVOKED = 1000;
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private binding: Promise<void> | null = null;
  private teardown: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LoopbackMcpListenerOptions) {
    this.enabled = opts.enabled;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private audit(input: AuditAppendInput): void {
    this.opts.audit?.(input);
  }

  async grant(ctx: ChimeraMcpCtx & { agentId: string; provider: string }): Promise<McpListenerGrant | null> {
    if (!this.enabled) return null;
    await this.ensureListening();
    const grantId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.grants.set(grantId, {
      tokenDigest: digest(token),
      ctx,
      agentId: ctx.agentId,
      provider: ctx.provider,
      since: this.now(),
    });
    this.audit({
      agentId: ctx.agentId,
      action: "mcp_listener_grant",
      resource: `mcp-listener:${grantId}`,
      decision: "allow",
      reason: "loopback mcp grant minted for spawn",
      detail: { provider: ctx.provider, depth: ctx.depth, port: this.port },
    });
    return {
      url: `http://${BIND_HOST}:${this.port}/mcp/${grantId}`,
      token,
      revoke: () => { this.revoke(grantId); },
    };
  }

  private async ensureListening(): Promise<void> {
    if (this.httpServer) return;
    if (this.binding) return this.binding;
    this.binding = (async () => {
      const handler: http.RequestListener = (req, res) => {
        void this.handleRequest(req, res);
      };
      const server = this.opts.createServerImpl ? this.opts.createServerImpl(handler) : http.createServer(handler);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: BIND_HOST, port: 0 }, () => { resolve(); });
      });
      const addr = server.address();
      if (typeof addr === "string" || addr === null || addr.address !== BIND_HOST) {
        const got = typeof addr === "string" ? addr : addr === null ? "nothing" : `${addr.address}:${addr.port}`;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error(`loopback mcp listener refused to bind: got ${got}`);
      }
      this.httpServer = server;
      this.port = addr.port;
    })().finally(() => { this.binding = null; });
    return this.binding;
  }

  // Every rejection is a bare status line with no body: a listener that explains WHY it said no is
  // an oracle. Order matters — cheap shape checks first, secret comparison last.
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const deny = (status: number): void => {
      req.resume();   // drain, so the peer can read the response instead of hitting EPIPE mid-write
      res.writeHead(status, { connection: "close" });
      res.end();
    };
    try {
      await this.route(req, res, deny);
    } catch {
      // An inbound socket must never be able to take the daemon down: the server callback can only
      // `void` this promise, so an unhandled rejection here would be a process-level crash.
      if (res.headersSent) res.destroy();
      else deny(500);
    }
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deny: (status: number) => void,
  ): Promise<void> {
    // Stateless mode has no GET SSE stream, and revoke() is the only teardown — so DELETE is not
    // a thing either. The SDK client tolerates a 405 on its optional GET probe.
    if (req.method !== "POST") return deny(405);

    const match = GRANT_PATH.exec((req.url ?? "").split("?")[0] ?? "");
    const grantId = match?.[1];
    if (!grantId) return deny(404);
    const record = this.grants.get(grantId);
    if (!record && !this.revoked.has(grantId)) return deny(404);   // routing, not a secret

    // AUDIT BOUNDARY. Everything from here down names a grantId the caller had to know, so the
    // random UUID bounds how fast anyone can write to the ledger. The 405/404 checks ABOVE are
    // deliberately silent for exactly that reason: they answer unauthenticated strangers, so
    // auditing them would hand any same-UID process a ledger-flood primitive — which is a worse
    // outcome than the missing record. The 400/413 checks below sit past a *valid* token and are
    // client malformation, not a security event.
    // DNS-rebinding defence: a browser-originated request always carries Origin, and a legitimate
    // local MCP client never does. Host must name the socket we actually bound. Both are the
    // rebinding attack itself, so both leave a record — with no attacker-controlled header value
    // in it, since the ledger detail must never become a place an attacker can write text.
    if (req.headers.origin !== undefined) {
      this.auditReject(grantId, record, "origin header present (browser or dns-rebinding attempt)");
      return deny(403);
    }
    const host = req.headers.host;
    if (host !== `${BIND_HOST}:${this.port}` && host !== `localhost:${this.port}`) {
      this.auditReject(grantId, record, "host header does not name the loopback socket");
      return deny(403);
    }

    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const ok = record !== undefined && presented !== undefined
      && timingSafeEqual(digest(presented), record.tokenDigest);
    if (!ok) {
      this.auditReject(grantId, record, record ? "bearer token rejected" : "bearer presented for a revoked grant");
      return deny(401);
    }

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return deny(413);

    let size = 0;
    const chunks: Buffer[] = [];
    let oversize = false;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) { oversize = true; break; }
        chunks.push(buf);
      }
    } catch {
      return deny(400);
    }
    if (oversize) return deny(413);

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return deny(400);
    }

    // ONE SERVER + TRANSPORT PER REQUEST, not per grant: since SDK 1.30.0 a transport built with
    // `sessionIdGenerator: undefined` sets `_hasHandledRequest` and THROWS on its second request
    // ("Stateless transport cannot be reused across requests"), because a shared stateless
    // transport collides JSON-RPC ids between callers. Reconnecting one long-lived McpServer to a
    // fresh transport is not a fix either — Protocol.connect swaps the single `_transport`, so two
    // concurrent POSTs on the same grant would answer down each other's socket. The grant's
    // identity lives in `record.ctx`, which is all the per-request build needs.
    const server = await createChimeraMcpServer(this.opts.dispatch, record.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // parsedBody short-circuits the transport's own body read, so consuming the stream above is
      // safe; in enableJsonResponse mode this resolves only once the response has been written.
      await transport.handleRequest(req, res, parsed);
    } finally {
      await server.close().catch(() => {});
    }
  }

  // One shape for every past-the-UUID-gate rejection (401 and both 403s), so AC-10's forensic
  // record cannot drift apart per branch. `reason` is a fixed string chosen by the caller, never
  // interpolated from a header: the ledger is read back as fact and must not carry attacker text.
  private auditReject(grantId: string, record: GrantRecord | undefined, reason: string): void {
    const agentId = record?.agentId ?? null;
    this.audit({
      agentId,
      action: "mcp_listener_grant",
      resource: `mcp-listener:${grantId}`,
      decision: "deny",
      reason,
      detail: { revoked: record === undefined },
    });
    // Same fixed-string reason, same agentId, same token/attacker-header-free shape as the
    // audit append above — this is the ONLY way any surface (app/TUI/agent) can ever observe
    // a rejection; the ledger alone reaches nothing.
    this.opts.emit?.({ grantId, agentId, reason });
  }

  private revoke(grantId: string): void {
    const record = this.grants.get(grantId);
    if (!record) return;   // idempotent: kill() and the child-exit handler both call this
    this.grants.delete(grantId);
    this.revoked.add(grantId);
    if (this.revoked.size > LoopbackMcpListener.MAX_REVOKED) {
      const oldest = this.revoked.values().next().value;
      if (oldest !== undefined) this.revoked.delete(oldest);
    }
    this.audit({
      agentId: record.agentId,
      action: "mcp_listener_grant",
      resource: `mcp-listener:${grantId}`,
      decision: "recorded",
      reason: "loopback mcp grant revoked (agent ended)",
      detail: { provider: record.provider },
    });
    if (this.grants.size === 0) this.closeSocket();
  }

  private closeSocket(): void {
    const server = this.httpServer;
    this.httpServer = null;
    this.port = null;
    if (!server) return;
    this.teardown = this.teardown.then(() => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }));
  }

  /** The live half of the config flip: `mcpListener.enabled: true -> false` takes effect at once. */
  async disable(): Promise<void> {
    this.enabled = false;
    for (const grantId of [...this.grants.keys()]) this.revoke(grantId);
    this.revoked.clear();
    this.closeSocket();
    await this.teardown;
  }

  /** Synchronous by contract — the settings screen polls this every few seconds. */
  status(): McpListenerStatus {
    return {
      enabled: this.enabled,
      listening: this.httpServer !== null,
      address: this.port === null ? null : `${BIND_HOST}:${this.port}`,
      grants: [...this.grants.values()].map((g) => ({
        agentId: g.agentId,
        provider: g.provider,
        since: g.since,
      })),
    };
  }

  async close(): Promise<void> {
    await this.disable();
  }
}
