import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { z } from "zod";
import { OperatorWebPairSchema, OperatorWebSettingsSchema, type OperatorWebSettings, type OperatorWebStatus, type OperatorWebSession, type OperatorWebSnapshot } from "@chimera/protocol";
import { writeFileDurable } from "./durable-write.js";
import { rpcError } from "./rpc-error.js";
import { webRequest } from "./operator-web-scopes.js";

const BIND_HOST = "127.0.0.1";
const MAX_BODY = 1_048_576;
const envelope = z.object({ id: z.string().min(1).max(100), method: z.string().min(1).max(100), params: z.unknown() }).strict();
const digest = (s: string) => createHash("sha256").update(s).digest();
const secret = (bytes: number) => randomBytes(bytes).toString("hex");
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
type Session = OperatorWebSession & { digest: Buffer; csrf: string; origin: string; usedRequestIds: Set<string> };
export type OperatorWebDeps = {
  home: string; bundleDir: string; now?: () => number;
  projectExists(project: string): boolean;
  snapshot(session: OperatorWebSession): Promise<OperatorWebSnapshot>;
  // Must authorize against CURRENT entities on each call, including IDs in params.
  dispatch(session: OperatorWebSession, method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(cb: (agentId: string) => void): () => void;
  visible(session: OperatorWebSession, agentId: string): boolean;
  audit(session: OperatorWebSession, method: string): void;
};
export class OperatorWeb {
  private server: http.Server | null = null;
  private localUrl: string | null = null;
  private settings: OperatorWebSettings;
  private settingsError: string | null = null;
  private sessions = new Map<string, Session>();
  private pairing: { digest: Buffer; project: string; scope: "read" | "control"; expiresAt: number } | null = null;
  private attempts = new Map<string, { at: number; count: number }>();
  private streams = new Set<{ session: Session; response: ServerResponse; close(): void }>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly deps: OperatorWebDeps) {
    this.now = deps.now ?? Date.now;
    this.settings = OperatorWebSettingsSchema.parse({});
    try { this.settings = OperatorWebSettingsSchema.parse(JSON.parse(readFileSync(join(deps.home, "operator-web.json"), "utf8"))); }
    catch (error) {
      // Only a missing file is a fresh install. A downgrade or damaged file must
      // not silently erase transport/expiry settings or enable fallback authority.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.settingsError = "Operator panel settings are unavailable and preserved read-only. Restore a compatible operator-web.json before enabling or saving settings.";
    }
  }
  status(): OperatorWebStatus {
    return { enabled: !!this.server, localUrl: this.localUrl, settings: this.settings, sessions: this.sessionList(),
      bundleAvailable: existsSync(join(this.deps.bundleDir, "operator.html")),
      limitation: this.settingsError ?? "Loopback HTTP development only. Remote use requires your own HTTPS proxy/tunnel; no tunnel is started. Text only; no terminal, files, microphone or spawn." };
  }
  sessionList(): OperatorWebSession[] {
    for (const s of this.sessions.values()) if (!this.valid(s)) this.revoke(s.id);
    return [...this.sessions.values()].map(({ digest: _digest, csrf: _csrf, origin: _origin, usedRequestIds: _used, ...s }) => s);
  }
  pairStart(p: { project: string; allowControl: boolean }) {
    if (!this.server) fail(409, "Enable the panel first");
    if (!this.deps.projectExists(p.project)) fail(403, "Project unavailable");
    const code = secret(16), expiresAt = this.now() + 120_000;
    const scope = p.allowControl ? "control" as const : "read" as const;
    this.pairing = { digest: digest(code), project: p.project, scope, expiresAt };
    return { code, expiresAt, project: p.project, scope };
  }
  revoke(id: string | null): number {
    const ids = id === null ? new Set(this.sessions.keys()) : new Set([id]);
    let count = 0;
    for (const key of ids) if (this.sessions.delete(key)) count++;
    for (const stream of [...this.streams]) if (ids.has(stream.session.id)) stream.close();
    return count;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(work, work); this.lifecycle = next.catch(() => {}); return next;
  }
  enable(): Promise<OperatorWebStatus> { return this.serial(async () => {
    if (this.settingsError) throw rpcError("unsupported", this.settingsError);
    if (this.server) return this.status();
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50; server.maxConnections = 64;
    // WebSockets are not supported; reject upgrades before any auth work.
    server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
    await new Promise<void>((ok, reject) => { server.once("error", reject); server.listen(this.settings.port, BIND_HOST, () => { server.off("error", reject); ok(); }); });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== BIND_HOST) { server.close(); fail(500, "Loopback binding failed"); }
    this.server = server; this.localUrl = `http://${BIND_HOST}:${address.port}`;
    return this.status();
  }); }
  disable(): Promise<OperatorWebStatus> { return this.serial(async () => {
    this.pairing = null; this.revoke(null); const server = this.server; this.server = null; this.localUrl = null;
    if (server) await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); });
    return this.status();
  }); }
  close() { return this.disable(); }
  settingsSet(p: OperatorWebSettings): Promise<OperatorWebStatus> { return this.serial(async () => {
    if (this.settingsError) throw rpcError("unsupported", this.settingsError);
    if (this.server) fail(409, "Disable the panel before changing transport settings");
    this.settings = OperatorWebSettingsSchema.parse(p);
    writeFileDurable(join(this.deps.home, "operator-web.json"), JSON.stringify(this.settings));
    return this.status();
  }); }
  private valid(s: Session) { return this.sessions.has(s.id) && this.now() < s.expiresAt && this.now() - s.lastUsedAt < this.settings.idleMin * 60_000 && this.deps.projectExists(s.project); }
  private origin(req: IncomingMessage): string {
    if (!this.localUrl) return fail(503, "Panel disabled");
    const host = req.headers.host;
    const local = new URL(this.localUrl);
    if (host === local.host) return this.localUrl;
    if (this.settings.publicOrigin && host === new URL(this.settings.publicOrigin).host) return this.settings.publicOrigin;
    return fail(403, "Host is not allowed");
  }
  private cookieName(origin: string) { return origin.startsWith("https:") ? "__Host-chimera_operator" : "chimera_operator_dev"; }
  private auth(req: IncomingMessage, origin: string, touch = true): Session {
    const name = this.cookieName(origin);
    const tokens = (req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
    if (tokens.length !== 1) return fail(401, "Session expired or revoked. Pair again from the desktop.");
    const token = tokens[0]!.slice(name.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return fail(401, "Session expired or revoked. Pair again from the desktop.");
    const hash = digest(token);
    const s = [...this.sessions.values()].find(s => timingSafeEqual(s.digest, hash));
    if (!s || s.origin !== origin || !this.valid(s)) { if (s && !this.valid(s)) this.revoke(s.id); return fail(401, "Session expired or revoked. Pair again from the desktop."); }
    if (touch) s.lastUsedAt = this.now(); return s;
  }
  private mutation(req: IncomingMessage, origin: string, s?: Session) {
    if (req.headers.origin !== origin) fail(403, "Origin is not allowed");
    if (req.headers["sec-fetch-site"] === "cross-site") fail(403, "Cross-site action rejected");
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") fail(415, "Use application/json");
    if (s && req.headers["x-chimera-csrf"] !== s.csrf) fail(403, "CSRF check failed");
  }
  private async body(req: IncomingMessage): Promise<unknown> {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) fail(413, "Request too large");
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, "Request too large"); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(400, "Invalid JSON"); }
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BODY) { res.writeHead(413, { "Content-Type": "application/json" }); res.end('{"error":"Response exceeds panel limit; narrow the request"}'); return; }
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(text);
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    try {
      const origin = this.origin(req);
      if (req.headers.origin && req.headers.origin !== origin) fail(403, "Origin is not allowed");
      const url = new URL(req.url ?? "/", origin);
      if (url.search || url.hash) fail(400, "Query parameters are not supported");
      if (url.pathname === "/pair" && req.method === "POST") {
        this.mutation(req, origin);
        const key = req.socket.remoteAddress ?? "unknown";
        let a = this.attempts.get(key);
        if (!a || this.now() - a.at >= 60_000) { a = { at: this.now(), count: 0 }; this.attempts.set(key, a); }
        if (++a.count > 5) fail(429, "Pairing temporarily locked. Try after one minute.");
        if (this.attempts.size > 128) this.attempts.delete(this.attempts.keys().next().value!);
        const p = OperatorWebPairSchema.parse(await this.body(req));
        const pair = this.pairing;
        if (!pair || this.now() >= pair.expiresAt || !timingSafeEqual(pair.digest, digest(p.code))) fail(401, "Pairing code invalid or expired");
        if (p.scope === "control" && pair.scope !== "control") fail(403, "Control was not approved on the desktop");
        if (!this.deps.projectExists(pair.project)) fail(403, "Project unavailable");
        this.sessionList();
        if (this.sessions.size >= 20) fail(429, "Device session limit reached");
        this.pairing = null;
        const token = secret(32); const csrf = secret(16), now = this.now();
        const s: Session = { id: randomUUID(), deviceLabel: p.deviceLabel, project: pair.project, scope: p.scope, createdAt: now, lastUsedAt: now, expiresAt: now + this.settings.absoluteH * 3_600_000, digest: digest(token), csrf, origin, usedRequestIds: new Set() };
        this.sessions.set(s.id, s);
        res.setHeader("Set-Cookie", `${this.cookieName(origin)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.settings.absoluteH * 3600)}${origin.startsWith("https:") ? "; Secure" : ""}`);
        this.json(res, 200, { csrf, project: s.project, scope: s.scope, expiresAt: s.expiresAt }); return;
      }
      if (url.pathname === "/session" && req.method === "GET") {
        const s = this.auth(req, origin); this.json(res, 200, { csrf: s.csrf, project: s.project, scope: s.scope, expiresAt: s.expiresAt }); return;
      }
      if (url.pathname === "/logout" && req.method === "POST") {
        const s = this.auth(req, origin); this.mutation(req, origin, s); this.revoke(s.id);
        res.setHeader("Set-Cookie", `${this.cookieName(origin)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`);
        this.json(res, 200, { ok: true }); return;
      }
      if (url.pathname === "/snapshot" && req.method === "GET") {
        const s = this.auth(req, origin); const snapshot = await this.deps.snapshot(s);
        if (!this.valid(s)) fail(401, "Session expired or revoked"); this.json(res, 200, snapshot); return;
      }
      if (url.pathname === "/rpc" && req.method === "POST") {
        const s = this.auth(req, origin); this.mutation(req, origin, s);
        const call = envelope.parse(await this.body(req)); const request = webRequest(call.method, call.params);
        if (!this.valid(s)) fail(401, "Session expired or revoked");
        if (request.scope === "control" && s.scope !== "control") fail(403, "Read-only session");
        if (request.scope === "control") {
          if (s.usedRequestIds.has(call.id)) fail(409, "Action request already used; inspect current state before another action");
          if (s.usedRequestIds.size >= 4096) fail(429, "Session action limit reached. Pair a new session.");
          s.usedRequestIds.add(call.id);
        }
        const result = await this.deps.dispatch(s, call.method, request.params as Record<string, unknown>);
        if (request.scope === "control") this.deps.audit(s, call.method);
        if (!this.valid(s)) fail(401, "Session expired or revoked"); this.json(res, 200, { id: call.id, result }); return;
      }
      if (url.pathname === "/events" && req.method === "GET") {
        const s = this.auth(req, origin, false);
        if (this.streams.size >= 16 || [...this.streams].filter(x => x.session.id === s.id).length >= 2) fail(429, "Event stream limit reached");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive" }); res.flushHeaders();
        let off = () => {}, timer: ReturnType<typeof setInterval>, trailing: ReturnType<typeof setTimeout> | undefined; let closed = false;
        const stream = { session: s, response: res, close: () => { if (closed) return; closed = true; off(); clearInterval(timer); clearTimeout(trailing); this.streams.delete(stream); res.end(); } };
        const write = (frame: string) => { if (!this.valid(s) || !res.write(frame) || res.writableLength > 65_536) stream.close(); };
        // Invalidation only: no unfiltered daemon event or private payload enters SSE.
        let last = 0;
        off = this.deps.subscribe(agentId => {
          if (!this.deps.visible(s, agentId)) return;
          const send = () => { trailing = undefined; last = this.now(); write('event: changed\ndata: {}\n\n'); };
          if (this.now() - last >= 250) { clearTimeout(trailing); send(); }
          else if (!trailing) { trailing = setTimeout(send, 250 - (this.now() - last)); trailing.unref(); }
        });
        timer = setInterval(() => write(': heartbeat\n\n'), 1000); timer.unref();
        this.streams.add(stream); req.on("close", stream.close); write(': connected\n\n'); return;
      }
      if (req.method === "GET") { this.asset(url.pathname, res); return; }
      fail(404, "Route unavailable");
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      const e = err as { status?: number; name?: string };
      const status = e.status ?? (e.name === "ZodError" ? 400 : 500);
      // Raw engine/provider errors can contain paths or credentials.
      this.json(res, status, { error: status === 500 ? "Panel request failed" : (err as Error).message });
    }
  }
  private asset(path: string, res: ServerResponse) {
    if (!existsSync(join(this.deps.bundleDir, "operator.html"))) fail(503, "Panel bundle not built. Build the operator app first.");
    let rel: string; try { rel = decodeURIComponent(path === "/" ? "/operator.html" : path); } catch { return fail(400, "Invalid path"); }
    if (rel.includes("\0") || rel.includes("\\")) fail(404, "Asset unavailable");
    const root = realpathSync(this.deps.bundleDir), file = resolve(root, "." + rel);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile() || !realpathSync(file).startsWith(root + sep)) fail(404, "Asset unavailable");
    if (file !== join(root, "operator.html") && !file.startsWith(join(root, "assets") + sep)) fail(404, "Asset unavailable");
    if (statSync(file).size > 8 * MAX_BODY) fail(413, "Asset too large");
    const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)];
    if (!type) fail(404, "Asset unavailable"); res.writeHead(200, { "Content-Type": type }); res.end(readFileSync(file));
  }
}
