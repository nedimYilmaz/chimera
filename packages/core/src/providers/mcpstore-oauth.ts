// MCP-OAUTH slice 2: drives the SDK's `auth()` orchestrator (client/auth.js) against a store
// server's OAuth 2.1 (auth-code + PKCE + DCR) endpoints, fronted by an ephemeral loopback
// listener (oauth-loopback.ts) and persisted via KeychainOAuthClientProvider
// (oauth-client-provider.ts). Mirrors accounts.oauth_start/oauth_finish's pending-record shape
// (PendingOAuthStore) so mcpstore.oauth.start/finish in engine.ts follow the exact same
// start-then-poll RPC contract -- see engine.ts's accountsOAuthStart/accountsOAuthFinish.
//
// SECURITY (spec, hard requirements):
//  - tokens/client info: keychain only (KeychainOAuthClientProvider) -- never touch this file.
//  - code_verifier/state: transient, live on the per-flow KeychainOAuthClientProvider instance
//    only -- never persisted, never logged (see that file's header).
//  - a mismatched `state` on the loopback callback is rejected for THAT request only; the
//    listener stays open for the legitimate redirect rather than tearing down the whole flow
//    (a stray/replayed hit on the port is not grounds to fail a still-valid pending exchange).
//  - the listener is ALWAYS closed exactly once -- on success, on a failed exchange, or on the
//    ~10min timeout -- never left dangling.
//  - no token, code, verifier, or state value is ever interpolated into a thrown/stored error
//    message verbatim; `redact()` strips any that do leak into an underlying SDK/fetch error.
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { redact } from "../credentials.js";
import type { Keychain } from "../keychain.js";
import type { McpStoreRegistry } from "../mcpstore.js";
import { KeychainOAuthClientProvider } from "./oauth-client-provider.js";
import { OAuthLoopbackListener } from "./oauth-loopback.js";
import type { PendingOAuthStore } from "./pending-oauth.js";
import { createGuardedFetch, type GuardedFetchSeams } from "./ssrf-guard.js";

// A pending mcpstore oauth record is resolved with this sentinel -- the REAL tokens already
// landed in the keychain via provider.saveTokens() by the time resolve() is called; the
// pending record only needs to answer "connected yes/no" for the oauth.finish poll (unlike
// accounts.oauth_finish, which mints an account FROM the resolved token payload).
const CONNECTED_SENTINEL = { accessToken: "stored-in-keychain" };

const OAUTH_FLOW_TIMEOUT_MS = 10 * 60_000;

export class McpStoreOAuthNotConfiguredError extends Error {
  code = "protocol" as const;
  name = "McpStoreOAuthNotConfiguredError";
}

export type McpStoreOAuthStartResult = { pendingId: string; authorizeUrl: string };

export type McpStoreOAuthFlowOpts = {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  timeoutMs?: number;
  /** Test doubles for the SSRF guard's DNS/wire layer (see ssrf-guard.ts); they cannot relax it. */
  guardSeams?: GuardedFetchSeams;
};

// Per sdkAuth call: discovery (PRM + AS metadata), DCR, then token exchange are sequential.
const GUARDED_REQUEST_TIMEOUT_MS = 10_000;
const GUARDED_BUDGET_MS = 30_000;

export class McpStoreOAuthFlow {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly timeoutMs: number;
  private readonly guardSeams: GuardedFetchSeams;
  // MCPSTORE-OAUTH-CANCEL: pendingId -> that flow's `finalize` (stop timer + close listener,
  // the same closure the timeout branch below uses). Populated for the lifetime of a flow
  // that's still waiting on a browser redirect; removed by finalize() itself so a settled
  // flow (connected/failed/timed out/cancelled) is never double-closed. cancel() is the only
  // external reader.
  private readonly active = new Map<string, () => Promise<void>>();

  constructor(
    private readonly registry: McpStoreRegistry,
    private readonly keychain: Keychain,
    private readonly pending: PendingOAuthStore,
    opts: McpStoreOAuthFlowOpts = {},
  ) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.timeoutMs = opts.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
    this.guardSeams = opts.guardSeams ?? {};
  }

  async start(name: string): Promise<McpStoreOAuthStartResult> {
    const entry = this.registry.get(name);
    if (!entry) throw new McpStoreOAuthNotConfiguredError(`unknown mcp store server "${name}"`);
    if (entry.type !== "http" || !entry.auth || entry.auth.kind !== "oauth") {
      throw new McpStoreOAuthNotConfiguredError(`mcp store server "${name}" is not configured for oauth`);
    }
    const serverUrl = entry.url;
    // SSRF: an agent can reach this via mcp_store_reauth against an entry it proposed itself
    // (always trust:"untrusted"), and the SDK's auth() then chases whatever URLs that server's
    // metadata names -- a public host advertising a private authorization server would make the
    // daemon call into the LAN. So untrusted entries run auth() through the guarded fetch (a
    // fresh one per call: each gets its own time budget). A trust:"full" entry is one the
    // operator vetted/imported, and may legitimately be a local OAuth server, so it keeps the
    // platform fetch -- same stance as the actual (operator-enabled) connection.
    const guardedFetch = (): typeof fetch | undefined => entry.trust === "untrusted"
      ? createGuardedFetch({ ...this.guardSeams, timeoutMs: GUARDED_REQUEST_TIMEOUT_MS, budgetMs: GUARDED_BUDGET_MS })
      : undefined;

    const listener = await OAuthLoopbackListener.start();
    listener.setServerName(name);   // the callback page names the server it just connected
    const provider = new KeychainOAuthClientProvider(name, this.keychain, listener.redirectUrl, entry.auth.scopes);

    // MCP-OAUTH-REDIRECT-DRIFT: a DCR registration is bound to the exact redirect_uri it was
    // created with, but the listener above binds port 0 -- a NEW OS-assigned port every flow.
    // So a cached clientInfo always names a DEAD port from some earlier flow (or the literal
    // ":0" placeholder, when the registration came from connectTransport's OAUTH_CONNECT_
    // REDIRECT_URL rather than a real authorize). Reusing it makes the authorization server
    // reject the request outright -- "redirect_uri is not registered for client" -- which is
    // exactly what Atlassian returns. Lenient servers (Cloudflare, per RFC 8252 §7.3's loopback
    // allowance to ignore the port) accept it anyway, which is why this only bites some hosts.
    //
    // Dropping the registration makes the SDK run DCR again against the live redirect. The cost
    // is one extra public-client registration per authorize on a strict server, which is cheap:
    // these clients are token_endpoint_auth_method "none" and hold no secret worth preserving.
    // Tokens are untouched -- only the client identity is discarded.
    // Read structurally: clientInformation() is typed as OAuthClientInformationMixed, whose
    // narrow arm (client_id only) has no redirect_uris at all. An entry that doesn't record its
    // redirect_uris cannot be shown to match this flow's, so it is discarded too -- re-running
    // DCR is always safe, whereas reusing a registration bound to a dead port is not.
    const cached = await provider.clientInformation() as { redirect_uris?: unknown } | undefined;
    const registered = Array.isArray(cached?.redirect_uris) ? cached.redirect_uris as unknown[] : [];
    if (cached && !registered.includes(listener.redirectUrl)) {
      await provider.clearClientInformation();
    }

    const { id } = this.pending.create(name);

    // `stopTimeout` and `closeListener` are deliberately separate: closeListener AWAITS
    // server.close(), which only resolves once every live connection ends -- calling it from
    // INSIDE the request handler that's still writing its own response would deadlock (the
    // connection can't end until the response is sent, and the response isn't sent until this
    // resolves). onCallback below (which runs inside that live request) only ever stops the
    // timer directly and tells the listener to close ITSELF once ITS OWN response is flushed
    // (LoopbackVerdict.done); closeListener/finalize (awaited close) is only used from the two
    // call sites below that are NOT inside an in-flight loopback request.
    let settled = false;
    let timeoutHandle: unknown;
    const stopTimeout = (): void => {
      if (settled) return;
      settled = true;
      this.clearTimer(timeoutHandle);
    };
    const finalize = async (): Promise<void> => {
      stopTimeout();
      this.active.delete(id);
      await listener.close();
    };
    this.active.set(id, finalize);

    timeoutHandle = this.setTimer(() => {
      void (async () => {
        if (this.pending.get(id)?.state.status === "pending") this.pending.fail(id, "oauth flow timed out");
        await finalize();
      })();
    }, this.timeoutMs);

    listener.onCallback(async ({ code, state }) => {
      if (state !== provider.issuedState) return { accepted: false, done: false };   // this request only -- listener stays open
      stopTimeout();
      try {
        const result = await sdkAuth(provider, { serverUrl, authorizationCode: code, fetchFn: guardedFetch() });
        // `active.delete` only (never `finalize`/listener.close here) -- the listener closes
        // ITSELF once this response is flushed (LoopbackVerdict.done, see oauth-loopback.ts).
        // This just deregisters the flow from cancel() so a cancel racing this exchange can't
        // try to re-close an already self-closing listener once it lands.
        this.active.delete(id);
        if (result === "AUTHORIZED") {
          this.pending.resolve(id, CONNECTED_SENTINEL);
          return { accepted: true, done: true };
        }
        this.pending.fail(id, "oauth exchange did not complete");
        return { accepted: false, done: true };
      } catch (err) {
        this.active.delete(id);
        this.pending.fail(id, redact(err instanceof Error ? err.message : String(err), [code, state]));
        return { accepted: false, done: true };
      }
    });

    let result: string;
    try {
      result = await sdkAuth(provider, { serverUrl, fetchFn: guardedFetch() });
    } catch (err) {
      this.pending.delete(id);
      await finalize();
      const message = err instanceof Error ? err.message : String(err);
      throw new McpStoreOAuthNotConfiguredError(`mcp store server "${name}" oauth start failed: ${message}`);
    }

    if (result !== "REDIRECT" || !provider.authorizeUrl) {
      // An already-valid (or refreshable) token needed no browser trip at all -- resolve
      // immediately; `authorizeUrl` still gets a non-empty value (the schema requires one)
      // even though the caller has nothing to open.
      this.pending.resolve(id, CONNECTED_SENTINEL);
      await finalize();
      return { pendingId: id, authorizeUrl: listener.redirectUrl };
    }

    return { pendingId: id, authorizeUrl: provider.authorizeUrl };
  }

  // MCPSTORE-OAUTH-CANCEL: abandons a still-waiting-on-the-browser flow instead of letting it
  // idle out to `timeoutMs`. Reuses `finalize` -- the SAME stop-timer-then-close-listener path
  // the timeout branch above uses -- so there is still exactly one way this flow's listener
  // ever gets closed. A no-op (never throws) for an unknown/already-settled pendingId: `active`
  // only holds entries for flows still waiting on a redirect, so a flow that already
  // connected/failed/timed out/was cancelled has nothing left to tear down.
  //
  // RACE PRECEDENCE (cancel vs. a redirect that's already in flight): `active.delete` happens
  // synchronously up front, so a SECOND concurrent cancel() call is always a no-op. But if the
  // browser's callback request is mid-exchange when this runs, `finalize`'s `listener.close()`
  // cannot resolve until that request's connection ends (Node's `server.close()` semantics --
  // stop accepting new connections, wait for live ones to finish) -- which only happens after
  // the callback has already called `pending.resolve`/`pending.fail` and the listener has
  // flushed its response. So an in-flight legitimate exchange always completes (and its token,
  // if any, is already durably in the keychain via provider.saveTokens() before that point) --
  // cancel only ever discards the daemon's bookkeeping *after* the exchange settles, never
  // half-way through it.
  async cancel(pendingId: string): Promise<void> {
    const finalize = this.active.get(pendingId);
    if (!finalize) {
      this.pending.delete(pendingId);   // defensive -- e.g. an immediate-resolve flow's brief window before finalize() runs
      return;
    }
    await finalize();
    this.pending.delete(pendingId);
  }
}
