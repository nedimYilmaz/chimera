import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpStoreImageSchema, type McpStoreCallResult, type McpStoreMonitor, McpStoreEntrySchema, type McpStoreAuthStatus, type McpStoreEntry, type McpStoreHttpAuth, type McpStoreServerSpec, type McpStoreToolInfo } from "@chimera/protocol";
import { toolResultText, wrapUntrustedToolResult } from "./backends/tool-result.js";
import { scanForInjectionPatterns } from "./mcp-imports.js";
import { managedProcessEnv } from "./mcp-packages.js";
import { desktopHostGuidance, isBuiltInDesktopEntry } from "./computer-use.js";
import { mcpStoreAuthService, type Keychain } from "./keychain.js";
import { KeychainOAuthClientProvider, readMcpStoreOAuthSnapshot } from "./providers/oauth-client-provider.js";

// MCP-STORE P1/P2: a chimera-level MCP registry. Install a server ONCE (mcpstore.add) and
// every agent on every provider can discover/call it via chimera's mcp_store_tools/
// mcp_store_call meta-tools. Shared servers reuse one daemon-hosted connection; stateful
// computer-use servers opt into agent isolation or exclusive ownership. Connections are
// lazily opened on first use and torn down after IDLE_MS of no calls. This is the SAME
// @modelcontextprotocol/sdk Client/StdioClientTransport pair backends/generic-mcp.ts's
// McpHost uses for a per-agent-spawn MCP client -- here the client instead lives for the
// daemon's lifetime, with scope chosen by the operator at registration.

export class UnknownMcpStoreServerError extends Error { code = "protocol" as const; name = "UnknownMcpStoreServerError"; }
export class DuplicateMcpStoreServerError extends Error { code = "conflict" as const; name = "DuplicateMcpStoreServerError"; }
export class McpStoreProvenanceError extends Error { code = "protocol" as const; name = "McpStoreProvenanceError"; }

// Key order differs between add()'s spread and a schema re-parse, so a no-op reconcile must compare
// canonical (sorted-key) JSON or it would rewrite an unchanged file on every restart.
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
      : value;
export const specJson = (spec: McpStoreServerSpec): string => JSON.stringify(canonical(spec));

// ---------- registry: persisted CRUD ----------
// Deliberately its own file ($CHIMERA_HOME/mcpstore.json), same discipline as
// plugins.json/toolpolicy.json -- config.json stays user-owned/daemon-read-only.
export class McpStoreRegistry {
  private servers = new Map<string, McpStoreServerSpec>();
  private file: string;

  constructor(readonly directory: string) {
    const dir = directory;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "mcpstore.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
        for (const [name, spec] of Object.entries(raw)) {
          const parsed = McpStoreEntrySchema.parse({ name, ...(spec as object) });
          const { name: _name, ...parsedSpec } = parsed;
          this.servers.set(name, parsedSpec);
        }
      } catch (err) {
        // Fail fast (teams.json/plugins.json discipline): a silently-dropped entry would
        // just look like a missing install, but a silently CORRUPTED one could resurrect a
        // stale command -- surface loudly instead.
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
  }

  private save(next = this.servers): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const obj = Object.fromEntries(next);
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.file);
    this.servers = next;
  }

  // The ONLY writer that may stamp `builtIn` (see add()). Daemon-internal: the built-in
  // reconciler edits a draft copy; every resulting entry is re-validated and the file is written
  // once, and only when the persisted form actually changed, so a restart is byte-idempotent.
  reconcile(mutate: (draft: Map<string, McpStoreServerSpec>) => void): boolean {
    const draft = new Map(this.servers);
    mutate(draft);
    const next = new Map<string, McpStoreServerSpec>();
    for (const [name, spec] of draft) {
      const { name: _name, ...parsed } = McpStoreEntrySchema.parse({ name, ...spec });
      next.set(name, parsed);
    }
    const same = next.size === this.servers.size && [...next].every(([name, spec]) => {
      const current = this.servers.get(name);
      return current !== undefined && specJson(current) === specJson(spec);
    });
    if (same) return false;
    this.save(next);
    return true;
  }

  list(): McpStoreEntry[] {
    return [...this.servers.entries()]
      .map(([name, spec]) => ({ name, ...spec }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpStoreServerSpec | undefined {
    return this.servers.get(name);
  }

  has(name: string): boolean {
    return this.servers.has(name);
  }

  add(entry: McpStoreEntry): McpStoreEntry {
    entry = McpStoreEntrySchema.parse(entry);
    // `builtIn` is the daemon's own provenance stamp. Every caller of add() (RPC, import,
    // proposals, the package installer) is outside that trust boundary, so none may claim it.
    if (entry.type === "stdio" && entry.builtIn) throw new McpStoreProvenanceError(`mcp store server "${entry.name}" cannot claim built-in provenance`);
    if (this.servers.has(entry.name)) throw new DuplicateMcpStoreServerError(`mcp store server "${entry.name}" already exists`);
    const { name, ...rest } = entry;
    // Preserve legacy defaults while validating the entire entry at the persistence
    // boundary, including direct internal callers and managed installer records.
    const spec = { ...rest, direct: rest.direct ?? false, enabled: rest.enabled ?? true, trust: rest.trust ?? "full" };
    this.save(new Map(this.servers).set(name, spec));
    return { name, ...spec };
  }

  remove(name: string): { name: string; removed: boolean } {
    const next = new Map(this.servers);
    const removed = next.delete(name);
    if (removed) this.save(next);
    return { name, removed };
  }

  // MCP-STORE-DIRECT-TOGGLE: flips a registered server's `direct` flag. The chimera MCP
  // grant's native-tool synthesis (mcp-server-factory.ts) reads this on every spawn.
  setDirect(name: string, direct: boolean): McpStoreEntry {
    const spec = this.servers.get(name);
    if (!spec) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);
    this.save(new Map(this.servers).set(name, { ...spec, direct }));
    return { name, ...this.servers.get(name)! };
  }

  // MCP-OAUTH-DISCOVERABILITY: retrofits an existing http entry's `auth` (the Authorize
  // button's "detected-OAuth bearer entry" convert-then-authorize path — see engine.ts's
  // mcpstore.setAuthKind). Same persisted-write shape as setDirect.
  setAuthKind(name: string, auth: McpStoreHttpAuth): McpStoreEntry {
    const spec = this.servers.get(name);
    if (!spec) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);
    if (spec.type !== "http") throw new McpStoreAuthError(`mcp store server "${name}" is type "${spec.type}", which has no remote auth to set`);
    this.save(new Map(this.servers).set(name, { ...spec, auth }));
    return { name, ...this.servers.get(name)! };
  }

  // TRUST-TIER: flips a registered server's `trust` tier. Same shape as setDirect -- pure
  // metadata write, never tears down or reconnects the live connection (trust is read fresh
  // from the registry at CALL time by the gate, never cached on the Connection itself).
  setTrust(name: string, trust: "full" | "untrusted"): McpStoreEntry {
    const spec = this.servers.get(name);
    if (!spec) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);
    this.save(new Map(this.servers).set(name, { ...spec, trust }));
    return { name, ...this.servers.get(name)! };
  }

  // MCPSTORE-LIFECYCLE-UI: flips a registered server's `enabled` flag -- a temporary off
  // switch, NOT an uninstall. Credentials/spec stay intact; McpStoreConnectionManager refuses
  // to connect a disabled server (see UnknownMcpStoreServerError sibling below) and
  // mcp-server-factory.ts's direct-tool synthesis skips it regardless of `direct`.
  setEnabled(name: string, enabled: boolean): McpStoreEntry {
    const spec = this.servers.get(name);
    if (!spec) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);
    this.save(new Map(this.servers).set(name, { ...spec, enabled }));
    return { name, ...this.servers.get(name)! };
  }
}

// ---------- connection manager: lazy-connect, cache, idle-teardown ----------
export type TimerFn = (fn: () => void, ms: number) => unknown;
export type ClearTimerFn = (h: unknown) => void;

const DEFAULT_IDLE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

type Connection = { client: Client; tools: McpStoreToolInfo[]; idleTimer: unknown; active: number; workdir?: string };

function fullEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, extra);
  return env;
}

function isStreamableHttpRejection(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
  return (typeof code === "number" && code >= 400 && code < 500)
    || /\b(4\d\d|405)\b/.test(err instanceof Error ? err.message : String(err));
}

export class McpStoreAuthError extends Error { code = "protocol" as const; name = "McpStoreAuthError"; }
export class McpStoreConnectionError extends Error { code = "connection" as const; name = "McpStoreConnectionError"; }
// MCPSTORE-LIFECYCLE-UI: thrown by ensure() for a disabled entry -- a disabled server must
// never be connected, so this fires before connectTransport is ever reached.
export class McpStoreDisabledError extends Error { code = "protocol" as const; name = "McpStoreDisabledError"; }

// MCP-REMOTE-IMPORT slice 2: resolve a store server's http auth secret from the Keychain
// (never from mcpstore.json — the registry only ever holds the keychainRef pointer). Thrown
// message deliberately names only the server, never the keychainRef or any secret material.
async function resolveAuthSecret(name: string, keychain: Keychain): Promise<string> {
  const secret = await keychain.get(mcpStoreAuthService(name));
  if (!secret) {
    throw new McpStoreAuthError(`mcp store server "${name}" requires auth but no keychain secret is set — call mcpstore.setAuth first`);
  }
  return secret;
}

// A connect failure must NEVER let the secret escape via the thrown message — the underlying
// SDK/fetch error is discarded wholesale (not attached as `cause` either, since it may carry
// the outgoing Headers/Request) and any accidental substring match of the resolved secret in
// what IS surfaced gets redacted as defense in depth.
function sanitizeConnectError(name: string, err: unknown, secret: string | null): McpStoreConnectionError {
  let message = err instanceof Error ? err.message : String(err);
  if (secret) message = message.split(secret).join("[redacted]");
  return new McpStoreConnectionError(`mcp store server "${name}" connection failed: ${message}`);
}

function authHeaders(baseHeaders: Record<string, string>, auth: McpStoreHttpAuth | undefined, secret: string | null): Record<string, string> {
  if (!auth || !secret) return baseHeaders;
  const header = auth.header ?? "Authorization";
  const scheme = auth.scheme ?? "Bearer";
  return { ...baseHeaders, [header]: `${scheme} ${secret}` };
}

// MCP-OAUTH slice 2: the connect-time redirect_uri for an oauth-kind server's authProvider.
// A tool-call connect only ever REUSES tokens already minted by mcpstore.oauth.start/finish's
// real loopback flow -- clientInformation()/tokens() come straight back out of the keychain, so
// the SDK never needs to build a fresh authorize URL here. This placeholder is never dereferenced
// unless that assumption breaks (e.g. a revoked/never-completed grant), in which case connect
// correctly fails with an auth error instead of hanging on a redirect nothing is listening on --
// the UI's recovery path is the same either way: re-run mcpstore.oauth.start.
const OAUTH_CONNECT_REDIRECT_URL = "http://127.0.0.1:0/callback";

async function connectTransport(client: Client, name: string, spec: McpStoreServerSpec, keychain: Keychain, storeDirectory?: string, workingDirectory?: string): Promise<Client> {
  if (spec.type === "stdio") {
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args,
      env: spec.managed ? { ...managedProcessEnv(), ...spec.env } : fullEnv(spec.env),
      ...(workingDirectory ? { cwd: workingDirectory } : spec.managed && storeDirectory ? { cwd: join(storeDirectory, "mcp-packages", spec.managed.id) } : {}),
    });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }

  const url = new URL(spec.url);

  // MCP-OAUTH slice 2: an oauth-kind server authenticates via the SDK's own authProvider
  // machinery (reactive access-token refresh included) instead of chimera's static header
  // injection -- NO manual Authorization header is ever built for this kind.
  if (spec.auth?.kind === "oauth") {
    const provider = new KeychainOAuthClientProvider(name, keychain, OAUTH_CONNECT_REDIRECT_URL, spec.auth.scopes);
    const requestInit = Object.keys(spec.headers).length ? { headers: spec.headers } : undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit }), { timeout: CONNECT_TIMEOUT_MS });
      return client;
    } catch (err) {
      if (!isStreamableHttpRejection(err)) throw sanitizeConnectError(name, err, null);
      await client.close().catch(() => {});
      const fallbackClient = new Client({ name: "chimera-mcp-store", version: "0.1.0" });
      try {
        await fallbackClient.connect(new SSEClientTransport(url, { authProvider: provider, requestInit }), { timeout: CONNECT_TIMEOUT_MS });
        return fallbackClient;
      } catch (err2) {
        await fallbackClient.close().catch(() => {});
        throw sanitizeConnectError(name, err2, null);
      }
    }
  }

  const secret = spec.auth ? await resolveAuthSecret(name, keychain) : null;
  const headers = authHeaders(spec.headers, spec.auth, secret);
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }), { timeout: CONNECT_TIMEOUT_MS });
    return client;
  } catch (err) {
    if (!isStreamableHttpRejection(err)) throw sanitizeConnectError(name, err, secret);
    await client.close().catch(() => {});
    const fallbackClient = new Client({ name: "chimera-mcp-store", version: "0.1.0" });
    try {
      await fallbackClient.connect(new SSEClientTransport(url, { requestInit }), { timeout: CONNECT_TIMEOUT_MS });
      return fallbackClient;
    } catch (err2) {
      await fallbackClient.close().catch(() => {});
      throw sanitizeConnectError(name, err2, secret);
    }
  }
}

// MCP-AUTH-STATUS: was a connect rejected because the CREDENTIAL is bad, as opposed to the
// host being down / the url wrong / the server erroring? Only the first kind is grounds for
// telling a human "re-authorize"; the rest would be a false alarm that sends them through a
// browser flow to fix a DNS problem.
//
// Kept separate from isStreamableHttpRejection above, which asks a different question ("is this
// a 4xx worth retrying over SSE?") and deliberately treats the whole 4xx range alike. 403 is
// excluded on purpose: a valid token that lacks a scope is an authorization failure, not an
// authentication one, and re-running the grant with the same scopes would change nothing.
function isAuthRejection(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code === 401) return true;
  const name = err instanceof Error ? err.name : "";
  if (name === "UnauthorizedError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|\bunauthorized\b|\binvalid_token\b|\binvalid_grant\b/i.test(message);
}

// The built-in `chimera-desktop` entry is only a stdio proxy to a service the Chimera app owns, so
// "Connection closed" there says nothing about WHY. When the app's own files prove a cause
// (desktopHostGuidance), say it and keep the SDK text; otherwise return undefined and let the
// caller surface the original error untouched. Our own lifecycle errors ("stopped while
// connecting") are never re-explained, and a mid-call failure is only annotated when the SDK
// reported a closed connection (-32000), not for a tool timeout or a server-side tool error.
function desktopFailureNote(name: string, spec: McpStoreServerSpec | undefined, home: string, err: unknown, midCall: boolean): string | undefined {
  if (!spec || err instanceof McpStoreConnectionError || !isBuiltInDesktopEntry(name, spec, home)) return undefined;
  if (midCall && (err as { code?: unknown } | null)?.code !== -32000) return undefined;
  const guidance = desktopHostGuidance(home, process.platform, spec.type === "stdio" && spec.builtIn ? spec.command : undefined);
  if (guidance === undefined) return undefined;
  const raw = (err as { message?: unknown } | null)?.message;
  return `${guidance} (underlying: ${typeof raw === "string" ? raw : String(err)})`;
}

// The last real connect attempt against a server. Runtime-only, deliberately NOT persisted:
// it is an OBSERVATION this daemon made, and a stale one restored from disk after a restart
// would assert something the daemon has not actually checked.
type ConnectOutcome = { ok: boolean; auth: boolean; at: number };

export class McpStoreConnectionManager {
  private desktopActivities: McpStoreMonitor["activities"] = [];
  private desktopActivitySeq = 0;
  private desktopTarget: { owner: string | null; windowId: number | null } | null = null;

  monitor(): McpStoreMonitor {
    const spec = this.registry.get("chimera-desktop");
    const lease = spec && spec.enabled !== false ? this.session("chimera-desktop", "status") : { held: false, owner: null, busy: false };
    return { held: lease.held, owner: lease.owner, busy: lease.busy,
      windowId: lease.held && this.desktopTarget?.owner === lease.owner ? this.desktopTarget.windowId : null,
      desktop: lease.held && this.desktopTarget?.owner === lease.owner && this.desktopTarget.windowId === null,
      activities: this.desktopActivities.map(a => ({ ...a })) };
  }

  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<Connection>>();
  private closing = new Map<string, Promise<void>>();
  private leases = new Map<string, { owner: string | null; expiresAt: number; active: boolean }>();
  private outcomes = new Map<string, ConnectOutcome>();
  private registry: McpStoreRegistry;
  private keychain: Keychain;
  private idleMs: number;
  private setTimer: TimerFn;
  private clearTimer: ClearTimerFn;

  constructor(registry: McpStoreRegistry, keychain: Keychain, opts: { idleMs?: number; setTimer?: TimerFn; clearTimer?: ClearTimerFn } = {}) {
    this.registry = registry;
    this.keychain = keychain;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  // Connects (or reuses) the named server's connection, resetting its idle clock. Concurrent
  // callers for the SAME not-yet-connected server share one in-flight connect (no duplicate
  // child processes racing each other).
  private connectionKey(name: string, principal?: string | null): string {
    return this.registry.get(name)?.sessionMode === "agent" && principal !== undefined
      ? `${name}\0${principal === null ? "operator" : `agent:${principal}`}` : name;
  }

  // A lease spans observation, reasoning and action, not just one click. Calls renew it;
  // an abandoned owner expires after five minutes, but never during an in-flight action.
  session(name: string, action: "status" | "acquire" | "release", principal: string | null = null) {
    const spec = this.registry.get(name);
    if (!spec || spec.enabled === false) throw new McpStoreConnectionError(`mcp store server "${name}" is unavailable`);
    const mode = spec.sessionMode ?? "shared";
    let lease = this.leases.get(name);
    if (lease && !lease.active && lease.expiresAt <= Date.now()) { this.leases.delete(name); lease = undefined; }
    if (action !== "status" && mode !== "exclusive") throw new McpStoreConnectionError(`server "${name}" does not use an exclusive session`);
    if (action !== "status" && lease && (lease.owner !== principal || lease.active)) {
      throw new McpStoreConnectionError(`server "${name}" is busy; wait for its owner to release the session`);
    }
    if (name === "chimera-desktop" && (action === "release" || !lease)) this.desktopTarget = null;
    if (action === "acquire") {
      lease = { owner: principal, expiresAt: Date.now() + DEFAULT_IDLE_MS, active: false };
      this.leases.set(name, lease);
    }
    if (action === "release") { this.leases.delete(name); lease = undefined; }
    return { server: name, mode, held: !!lease, owner: lease?.owner ?? null, expiresAt: lease?.expiresAt ?? null, busy: lease?.active ?? false };
  }

  private async ensure(name: string, principal?: string | null): Promise<Connection> {
    const key = this.connectionKey(name, principal);
    const spec = this.registry.get(name);
    if (!spec) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);
    if (spec.enabled === false) throw new McpStoreDisabledError(`mcp store server "${name}" is disabled`);
    if (this.closing.has(name)) throw new McpStoreConnectionError(`mcp store server "${name}" is stopping`);
    const existing = this.connections.get(key);
    if (existing) {
      this.bumpIdle(key, existing);
      return existing;
    }
    const inFlight = this.connecting.get(key);
    if (inFlight) return inFlight;

    // MCPSTORE-LIFECYCLE-UI: a disabled server is never connected -- fail BEFORE
    // connectTransport touches the network/child process, same fail-fast spirit as the
    // unknown-server check above.

    const connectPromise = (async () => {
      let client = new Client({ name: "chimera-mcp-store", version: "0.1.0" });
      let workdir: string | undefined;
      try {
      if (spec.sessionMode === "agent" && spec.type === "stdio") {
        const sessions = join(this.registry.directory, "mcp-sessions");
        mkdirSync(sessions, { recursive: true, mode: 0o700 });
        workdir = mkdtempSync(join(sessions, `${name}-`));
      }
      client = await connectTransport(client, name, spec, this.keychain, this.registry.directory, workdir);
      if (this.closing.has(name) || this.registry.get(name)?.enabled === false || !this.registry.has(name)) throw new McpStoreConnectionError(`mcp store server "${name}" stopped while connecting`);
      const { tools } = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
      if (this.closing.has(name) || this.registry.get(name)?.enabled === false || !this.registry.has(name)) throw new McpStoreConnectionError(`mcp store server "${name}" stopped while discovering tools`);
      const conn: Connection = {
        client,
        tools: tools.map((t) => {
          // TRUST-TIER: captured HERE, at discovery, from the MCP spec's standard tool
          // annotation -- never re-derived per call. `readOnlyHint` is deliberately left
          // absent (not coerced to `false`) unless the server advertised an actual boolean --
          // the gate (broker.decideMcpStoreCall) is what fails closed on absence, not this cast.
          const rawAnnotations = (t as { annotations?: unknown }).annotations;
          const rawHint = rawAnnotations && typeof rawAnnotations === "object"
            ? (rawAnnotations as Record<string, unknown>)["readOnlyHint"] : undefined;
          const readOnlyHint = typeof rawHint === "boolean" ? rawHint : undefined;
          // INJECTION-DESCRIPTION-SCAN: warn-only, daemon-log-only (never surfaced back through
          // the same channel the attacker's text flows through, and never blocks/alters
          // discovery or the toolset) -- see mcp-imports.ts's scanForInjectionPatterns doc for
          // why this lives here (the real "at import" text -- a live tool description -- only
          // exists once a server is actually connected, which is HERE, not in the static
          // local-config file scan mcp-imports.ts's own scan() does).
          const hits = scanForInjectionPatterns(t.description ?? "");
          if (hits.length > 0) {
            console.warn(
              `[mcp store] server "${name}" tool "${t.name}" description matched injection pattern(s) `
              + `${hits.join(", ")} -- not blocked (warn-only), review before granting this server "direct" access`,
            );
          }
          return {
            server: name, name: t.name, description: (t.description ?? "") + (spec.sessionMode === "exclusive"
              ? " Shared desktop: acquire control before observing; release via chimera_call(mcp_store_session, {server, action: release}) when finished. If busy or the lease expired, take a fresh snapshot before acting."
              : spec.sessionMode === "agent" ? " This agent has an isolated browser connection; idle sessions may close after five minutes." : ""),
            inputSchema: t.inputSchema as Record<string, unknown>,
            ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
          };
        }),
        idleTimer: null, active: 0, ...(workdir ? { workdir } : {}),
      };
      this.connections.set(key, conn);
      // The SDK rejects in-flight calls on disconnect, but does not evict our cache.
      // Reconnect on the NEXT request; replaying a click/write could duplicate it.
      client.onclose = () => {
        if (this.connections.get(key) !== conn) return;
        this.connections.delete(key);
        if (conn.idleTimer !== null) this.clearTimer(conn.idleTimer);
        if (conn.workdir) {
          try { rmSync(conn.workdir, { recursive: true, force: true }); }
          catch { console.warn(`[mcp store] could not remove disconnected session directory for "${name}"`); }
        }
      };
      this.bumpIdle(key, conn);
      return conn;
      } catch (error) {
        await client.close().catch(() => {});
        if (workdir) rmSync(workdir, { recursive: true, force: true });
        const note = desktopFailureNote(name, spec, this.registry.directory, error, false);
        throw note ? new McpStoreConnectionError(`mcp store server "${name}" is unavailable: ${note}`) : error;
      }
    })();
    this.connecting.set(key, connectPromise);
    try {
      const conn = await connectPromise;
      // MCP-AUTH-STATUS: the ONLY place a real "this server's credential works" observation is
      // made. Concurrent callers awaiting the same in-flight promise all write the same verdict,
      // so the duplicate writes are idempotent rather than racy. Failures that fired BEFORE
      // connectPromise existed (unknown/disabled server) are deliberately not recorded here --
      // neither says anything about auth.
      this.outcomes.set(name, { ok: true, auth: false, at: Date.now() });
      return conn;
    } catch (err) {
      this.outcomes.set(name, { ok: false, auth: isAuthRejection(err), at: Date.now() });
      throw err;
    } finally {
      this.connecting.delete(key);
    }
  }

  // MCP-AUTH-STATUS: forget what this daemon observed about a server's credential. Called when
  // the credential is REPLACED or the server is removed, both of which make the old verdict a
  // statement about something that no longer exists. An oauth grant self-heals via its
  // authorizedAt stamp (see authStatus); a bearer secret has no timestamp, so this is the only
  // way its verdict can be retired.
  clearOutcome(name: string): void {
    this.outcomes.delete(name);
  }

  // MCP-AUTH-STATUS: one row per registered server (or just `name`), assembled from the
  // keychain + this daemon's connect observations, with NO network access -- see
  // McpStoreAuthStateSchema in @chimera/protocol for why the states are shaped this way.
  async authStatus(name?: string): Promise<McpStoreAuthStatus[]> {
    const entries = name
      ? (this.registry.get(name) ? [{ name, spec: this.registry.get(name)! }] : [])
      : this.registry.list().map((e) => { const { name: n, ...spec } = e; return { name: n, spec: spec as McpStoreServerSpec }; });
    if (name && entries.length === 0) throw new UnknownMcpStoreServerError(`unknown mcp store server "${name}"`);

    const out: McpStoreAuthStatus[] = [];
    for (const { name: serverName, spec } of entries) {
      const outcome = this.outcomes.get(serverName);
      const lastCheckedAt = outcome ? { lastCheckedAt: outcome.at } : {};

      if (spec.type !== "http" || !spec.auth) {
        out.push({ name: serverName, state: "none", detail: "no authorization configured", ...lastCheckedAt });
        continue;
      }
      if (spec.auth.kind !== "oauth") {
        // A static bearer token has no expiry chimera can see. The one thing that IS
        // observable is a connect that came back 401 -- that means the token was revoked or
        // rotated, and the fix is re-entering it in the UI, not an oauth flow.
        // A bearer secret carries no timestamp, so a REPLACED token cannot be detected the way
        // a re-minted oauth grant can below -- engine.ts's mcpstore.setAuth/remove call
        // clearOutcome() instead, otherwise a freshly-entered token would keep showing the old
        // token's rejection until something happened to connect again.
        const revoked = outcome && !outcome.ok && outcome.auth;
        out.push({
          name: serverName,
          state: revoked ? "needs-reauth" : "bearer",
          detail: revoked ? "the stored token was rejected — replace it in the store settings" : "static token (no expiry chimera can observe)",
          ...lastCheckedAt,
        });
        continue;
      }

      const snap = await readMcpStoreOAuthSnapshot(this.keychain, serverName);
      const common = {
        ...lastCheckedAt,
        ...(snap.authorizedAt !== undefined ? { authorizedAt: snap.authorizedAt } : {}),
        ...(snap.scopes ? { scopes: snap.scopes } : {}),
      };
      if (!snap.hasTokens) {
        out.push({ name: serverName, state: "never", detail: "never authorized — run the Authorize flow once", ...common });
        continue;
      }
      // A rejection is only evidence about the credential that was PRESENTED. Once a newer
      // grant has been written (authorizedAt > the failure), the failure describes tokens that
      // no longer exist -- and since a re-authorize is exactly what the needs-reauth chip asks
      // for, treating it as current would leave the chip red for the action that just fixed it,
      // until something happened to connect again.
      const failureIsStale = outcome !== undefined && snap.authorizedAt !== undefined && snap.authorizedAt > outcome.at;
      if (outcome && !outcome.ok && outcome.auth && !failureIsStale) {
        out.push({ name: serverName, state: "needs-reauth", detail: "the last connection was rejected — the grant was revoked or expired", ...common });
        continue;
      }
      // Past expiry with nothing left to refresh WITH is the one case where chimera can call a
      // token dead without having tried it. With a refresh_token present the SDK renews it on
      // the next connect, so an expired access token is unremarkable and stays `authorized`.
      if (!snap.hasRefreshToken && snap.authorizedAt !== undefined && snap.expiresInSeconds !== undefined
          && Date.now() > snap.authorizedAt + snap.expiresInSeconds * 1000) {
        out.push({ name: serverName, state: "needs-reauth", detail: "the access token expired and the grant has no refresh token", ...common });
        continue;
      }
      out.push({
        name: serverName,
        state: "authorized",
        detail: outcome?.ok ? "authorized — last connection succeeded" : "authorized — not re-checked since the daemon started",
        ...common,
      });
    }
    return out;
  }

  private bumpIdle(name: string, conn: Connection): void {
    if (this.connections.get(name) !== conn) return;
    if (conn.idleTimer !== null) this.clearTimer(conn.idleTimer);
    conn.idleTimer = this.setTimer(() => {
      if (conn.active > 0) this.bumpIdle(name, conn);
      else void this.teardown(name);
    }, this.idleMs);
  }

  private async teardown(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    if (conn.idleTimer !== null) this.clearTimer(conn.idleTimer);
    await conn.client.close().catch(() => {});
    if (conn.workdir) rmSync(conn.workdir, { recursive: true, force: true });
  }

  // mcpstore.tools: every (or query-matched) registered server's live tool list. A server
  // that fails to connect/list contributes an `error` row instead of throwing -- one broken
  // MCP install never hides the rest of the store from a caller.
  async tools(query?: string, servers?: string[]): Promise<Array<{ server: string; connected: boolean; error?: string; tools: McpStoreToolInfo[] }>> {
    const out: Array<{ server: string; connected: boolean; error?: string; tools: McpStoreToolInfo[] }> = [];
    // MCP-STORE-DIRECT-TOGGLE: an explicit `servers` filter narrows the SCAN itself (not just
    // the output) — a non-direct server must never get connected just to synthesize direct tools.
    const wanted = servers ? new Set(servers) : null;
    for (const entry of this.registry.list()) {
      if (wanted && !wanted.has(entry.name)) continue;
      // MCPSTORE-LIFECYCLE-UI: a disabled server is fully omitted from mcp_store_tools'
      // discovery output -- not even an error row -- so it is genuinely invisible to agents,
      // not just unconnectable.
      if (entry.enabled === false) continue;
      try {
        const conn = await this.ensure(entry.name);
        out.push({ server: entry.name, connected: true, tools: conn.tools });
      } catch (err) {
        out.push({ server: entry.name, connected: false, error: (err as Error).message, tools: [] });
      }
    }
    if (!query) return out;
    const q = query.toLowerCase();
    return out
      .map((row) => row.server.toLowerCase().includes(q) ? row : ({ ...row, tools: row.tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) }))
      .filter((row) => row.server.toLowerCase().includes(q) || row.tools.length > 0);
  }

  // mcpstore.call: proxy one tool invocation. Never throws out of the caller's turn -- a
  // connect/call failure becomes a normal {isError:true} tool result.
  //
  // TRUST-TIER: `gate`, when given, runs AFTER ensure() (so it sees real discovery-captured
  // readOnlyHint from conn.tools, never a guess) and BEFORE the actual callTool -- the tool
  // dispatch itself never proceeds past a `gate` that resolves `allow:false`. `gate` is optional
  // (undefined ⇒ unconditional allow, byte-identical to pre-trust-tier behavior) so every
  // existing test/caller that doesn't wire one keeps working unchanged.
  async call(
    server: string, tool: string, args: Record<string, unknown>,
    gate?: (info: { server: string; tool: string; trust: "full" | "untrusted"; readOnlyHint: boolean | undefined }) => Promise<{ allow: boolean; reason?: string }>,
    principal: string | null = null,
  ): Promise<McpStoreCallResult> {
    const activity: McpStoreMonitor["activities"][number] | undefined = server === "chimera-desktop"
      ? { id: ++this.desktopActivitySeq, ts: Date.now(), agentId: principal, tool: tool.slice(0, 120), state: "waiting" } : undefined;
    if (activity) this.desktopActivities = [...this.desktopActivities.slice(-39), activity];
    const key = this.connectionKey(server, principal);
    let conn: Connection;
    try {
      conn = await this.ensure(server, principal);
    } catch (err) {
      if (activity) activity.state = "failed";
      return { text: (err as Error).message, isError: true };
    }
    let lease: { owner: string | null; expiresAt: number; active: boolean } | undefined;
    // Human approval can outlast the idle timer. Reserve the connection through
    // that wait without taking exclusive desktop ownership before approval.
    conn.active++;
    try {
      if (gate) {
        const spec = this.registry.get(server);
        const toolInfo = conn.tools.find((t) => t.name === tool);
        const { allow, reason } = await gate({ server, tool, trust: spec?.trust ?? "full", readOnlyHint: toolInfo?.readOnlyHint });
        if (!allow) return { text: reason ?? `mcp store call to "${server}__${tool}" was denied`, isError: true };
      }
      if (this.connections.get(key) !== conn || this.closing.has(server) || this.registry.get(server)?.enabled === false || !this.registry.has(server)) {
        return { text: `mcp store server "${server}" disconnected or stopped before the tool could run; observe again before retrying`, isError: true };
      }
      if (this.registry.get(server)?.sessionMode === "exclusive") {
        this.session(server, "acquire", principal);
        lease = this.leases.get(server)!;
        lease.active = true;
      }
      if (activity) activity.state = "running";
      const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      if (activity) {
        activity.state = result["isError"] === true ? "failed" : "succeeded";
        const structured = result["structuredContent"] as Record<string, unknown> | undefined;
        const target = args["target"] as Record<string, unknown> | undefined;
        const windowId = structured?.["window_id"] ?? args["window_id"] ?? target?.["window_id"];
        if (activity.state === "succeeded" && (tool === "get_desktop_state" || target?.["kind"] === "desktop" || args["scope"] === "desktop")) {
          this.desktopTarget = { owner: principal, windowId: null };
        } else if (activity.state === "succeeded" && Number.isSafeInteger(windowId) && (windowId as number) > 0 && (windowId as number) <= 0xffffffff) {
          this.desktopTarget = { owner: principal, windowId: windowId as number };
        }
      }
      let text = toolResultText(result["content"]);
      const rawStructured = result["structuredContent"];
      let structuredContent: Record<string, unknown> | undefined;
      let structuredOmitted = false;
      if (rawStructured && typeof rawStructured === "object" && !Array.isArray(rawStructured)) {
        const encoded = JSON.stringify(rawStructured);
        if (encoded.length <= 256 * 1024) {
          structuredContent = rawStructured as Record<string, unknown>;
          // Some SDKs only expose content[] to the model. Capture IDs and target metadata
          // must remain visible there as well as to clients consuming structuredContent.
          text += `\nStructured result:\n${encoded}`;
        } else structuredOmitted = true;
      }
      const images: NonNullable<McpStoreCallResult["images"]> = [];
      let bytes = 0;
      let omitted = false;
      for (const block of Array.isArray(result["content"]) ? result["content"] : []) {
        if (block?.type !== "image") continue;
        const parsed = McpStoreImageSchema.safeParse({ type: block.type, data: block.data, mimeType: block.mimeType });
        if (!parsed.success || images.length >= 8 || bytes + parsed.data.data.length > 8 * 1024 * 1024) { omitted = true; continue; }
        images.push(parsed.data); bytes += parsed.data.data.length;
      }
      // Keep screenshots as MCP image blocks all the way to Claude/Codex; the bounded text
      // summary remains available to existing RPC/UI consumers. Never truncate image bytes.
      return {
        text: wrapUntrustedToolResult(text !== "" ? text : "(no output)") + (omitted ? "\n[Image omitted: unsupported format or size limit; request a smaller screenshot.]" : "")
          + (structuredOmitted ? "\n[Structured result omitted: size limit; request a smaller snapshot.]" : ""),
        ...(images.length ? { images } : {}),
        ...(structuredContent ? { structuredContent } : {}),
        ...(result["isError"] === true || omitted || structuredOmitted ? { isError: true } : {}),
      };
    } catch (err) {
      const note = desktopFailureNote(server, this.registry.get(server), this.registry.directory, err, true);
      return { text: `mcp store tool "${server}__${tool}" failed: ${note ?? (err as Error).message}`, isError: true };
    } finally {
      if (activity && (activity.state === "waiting" || activity.state === "running")) activity.state = "failed";
      conn.active--;
      if (lease) { lease.active = false; lease.expiresAt = Date.now() + DEFAULT_IDLE_MS; }
      this.bumpIdle(key, conn);
    }
  }

  // Torn down at daemon shutdown / removeServer -- never left as a dangling child process.
  async closeServer(name: string): Promise<void> {
    const existing = this.closing.get(name);
    if (existing) return existing;
    const matches = (key: string) => key === name || key.startsWith(`${name}\0`);
    const pending = [...this.connecting].filter(([key]) => matches(key)).map(([, value]) => value);
    const tearDownAll = async () => {
      await Promise.all([...this.connections.keys()].filter(matches).map(key => this.teardown(key)));
    };
    const closing = Promise.resolve().then(async () => {
      await tearDownAll();
      await Promise.allSettled(pending);
      await tearDownAll();
      this.leases.delete(name);
    });
    this.closing.set(name, closing);
    try { await closing; }
    finally { this.closing.delete(name); }
  }

  async closeAll(): Promise<void> {
    const names = new Set([...this.connections.keys(), ...this.connecting.keys(), ...this.closing.keys()].map(key => key.split("\0")[0]!));
    await Promise.all([...names].map(name => this.closeServer(name)));
  }
}
