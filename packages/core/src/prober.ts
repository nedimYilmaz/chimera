// D7 (accounts.test): a minimal "is this key accepted" probe, behind an injectable seam.
// The real impl is best-effort (a cheap key-validating request when a live key is present);
// tests inject a fake so no network call and no real key are ever needed. Returns a
// ProbeOutcome carrying the classification plus — on a definite auth rejection — the HTTP
// status and a KEY-REDACTED provider error message (D0: never the key itself, never an
// un-redacted body).
import { findProvider } from "./providers/catalog.js";
import { redact } from "./credentials.js";
import type { CredentialType, ProviderProfile } from "@chimera/protocol";

// OAUTH-TOKEN-ACCOUNTS: admin_key is decided BEFORE any network call — an sk-ant-admin
// key is KNOWN in advance to be unable to call the Messages API (it's a different API
// surface entirely), so reporting it as a live-probed auth_error would be misleading
// (the key IS valid, just for the wrong purpose); admin_key names the real problem.
//
// OAUTH-TOKEN-VALIDATE: an oauthToken (sk-ant-oat01-..., from `claude setup-token`) DOES
// get a live probe now, same as apiKey — it authenticates against the same GET
// /v1/models endpoint, just with Bearer + anthropic-beta oauth headers instead of
// x-api-key (replicating how the Claude Agent SDK itself authenticates a
// CLAUDE_CODE_OAUTH_TOKEN — see the claude case below). Empirically verified against
// the live API: a garbage oauth-shaped bearer token gets back a real 401
// authentication_error ("Invalid bearer token"), not a wrong-endpoint rejection — so
// this is a legitimate validating request for this token shape, not a guess.
// CUSTOM-OPENAI-COMPAT: connection_error is distinct from auth_error — an unreachable local
// host (wrong port, server not started) is a completely different operator fix (start the
// server / fix the URL) than a rejected key, and conflating the two under "ok" (the old
// catch-all for any network failure) hid the failure entirely for a custom provider that
// requires no key.
export type ProbeResult = "ok" | "auth_error" | "admin_key" | "connection_error";

// API-KEY-INVALID: a probe now carries WHY, not just a bare classification, so the accounts
// UI can replace an opaque "invalid" with the real cause. `httpStatus` is present whenever a
// live response came back (undefined for the pre-network admin_key/no-key decisions and for
// a transient network failure); `detail` is a short, KEY-REDACTED, single-line summary of the
// provider's own error body (undefined when there's nothing more specific to say than the
// classification itself).
export interface ProbeOutcome {
  result: ProbeResult;
  httpStatus?: number;
  detail?: string;
}

export interface AccountProber {
  probe(opts: { provider: string; key: string | null; credentialType?: CredentialType; profile?: ProviderProfile }): Promise<ProbeOutcome>;
}

// Best-effort real prober. With no key it can only report auth_error. With a key it makes a
// minimal KEY-VALIDATING request and maps an authentication rejection (401/403) to auth_error;
// anything else — success, other status, or a transient network/DNS failure — is reported "ok"
// (a probe is not a health check; we only flip the badge to invalid on a definite auth
// rejection). Never runs in tests.
export class RealAccountProber implements AccountProber {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  async probe({ provider, key, credentialType, profile }: { provider: string; key: string | null; credentialType?: CredentialType; profile?: ProviderProfile }): Promise<ProbeOutcome> {
    // CUSTOM-OPENAI-COMPAT: a custom provider the operator declared requiresKey:false
    // (e.g. an unauthenticated local Ollama) has no key to check by design — only fall
    // through to the auto auth_error when the resolved profile actually requires one.
    if (!key && profile?.requiresKey !== false) return { result: "auth_error" };
    // OAUTH-TOKEN-ACCOUNTS: an admin key is decided BEFORE any network call — see the
    // type doc comment above for why it can't safely reuse the key probe below (it
    // would falsely reject on the Messages-API surface it was never meant to call).
    if (credentialType === "adminKey") return { result: "admin_key" };
    try {
      // codex/claude always require a key (no requiresKey:false catalog entry exists for
      // either) — the leading !key check above only lets a null key past for a profile that
      // opted out, so this narrows `key` back to `string` for the branches below it.
      if (provider === "codex" && key) {
        const res = await this.fetchImpl("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${key}` },
        });
        return await this.interpret(res, key);
      }
      if (provider === "claude" && key) {
        if (credentialType === "oauthToken") {
          // OAUTH-TOKEN-VALIDATE: same GET /v1/models pure-auth check as the apiKey
          // path below, but with the headers the Claude Agent SDK actually sends for
          // a CLAUDE_CODE_OAUTH_TOKEN — Authorization: Bearer <token> (NOT x-api-key)
          // plus the anthropic-beta: oauth-2025-04-20 flag the SDK attaches whenever
          // it authenticates via an oauth bearer token/tokenCache.
          const res = await this.fetchImpl("https://api.anthropic.com/v1/models", {
            headers: { authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" },
          });
          return await this.interpret(res, key);
        }
        // API-KEY-INVALID: validate the key against GET /v1/models (x-api-key +
        // anthropic-version) — a pure key-auth check with NO model in the request.
        // The old probe POSTed /v1/messages with a hardcoded model, so a key that
        // authenticated fine but lacked access to THAT model came back 403/404 and
        // was misreported as auth_error ("invalid"). /v1/models has no such coupling:
        // a valid key gets 200 regardless of which models it can call.
        const res = await this.fetchImpl("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        });
        return await this.interpret(res, key);
      }
      // F23-2B: every other catalog provider (openai-compat/native) — a 1-token chat-completion
      // ping against the profile's own baseUrl/chatPath/authHeader (the exact shape
      // OpenAICompatChatClient posts, D2), so the badge reflects a REAL auth check instead of
      // an unconditional "ok". A provider absent from the catalog (or with no chat-shaped
      // endpoint, e.g. a future non-chat "native" kind) falls back to the old best-effort "ok".
      // CUSTOM-OPENAI-COMPAT: prefer the caller-resolved effective profile (covers a
      // cfg.customProviders entry) over the built-in-only findProvider lookup.
      const resolved = profile ?? findProvider(provider);
      if (resolved && (resolved.kind === "openai-compat" || resolved.kind === "native")) {
        // CUSTOM-OPENAI-COMPAT: a network-level failure to even REACH this profile's baseUrl
        // (wrong port, server not running) is scoped to its own try/catch and reported as
        // connection_error — distinct from the outer catch's "ok" fallback, which stays for
        // codex/claude to avoid changing their existing tested semantics.
        let res: { status: number; text(): Promise<string> };
        try {
          res = await this.fetchImpl(`${resolved.baseUrl}${resolved.chatPath ?? "/chat/completions"}`, {
            method: "POST",
            headers: {
              ...(key ? { [resolved.authHeader ?? "Authorization"]: `Bearer ${key}` } : {}),
              "content-type": "application/json",
              ...(resolved.extraHeaders ?? {}),
            },
            body: JSON.stringify({ model: resolved.defaultModel, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          });
        } catch (err) {
          return { result: "connection_error", detail: err instanceof Error ? err.message : String(err) };
        }
        return await this.interpret(res, key ?? "");
      }
      return { result: "ok" };
    } catch {
      return { result: "ok" }; // transient/network failure ≠ auth failure
    }
  }

  // Map a live response to an outcome: 401/403 ⇒ auth_error WITH the provider's own
  // (key-redacted) error message so the UI can say "401 authentication_error: invalid
  // x-api-key" instead of a bare "invalid"; every other status ⇒ ok (we never invalidate
  // the badge on a non-auth status). httpStatus rides along on both so the UI has it.
  private async interpret(res: { status: number; text(): Promise<string> }, key: string): Promise<ProbeOutcome> {
    if (res.status === 401 || res.status === 403) {
      const detail = await this.errorSummary(res, key);
      return { result: "auth_error", httpStatus: res.status, ...(detail ? { detail } : {}) };
    }
    return { result: "ok", httpStatus: res.status };
  }

  // Pull a compact, single-line, key-redacted summary out of a provider error body. Handles
  // the common `{error:{type,message}}` JSON shape (Anthropic/OpenAI) and degrades to the raw
  // text for anything else. Redaction is defensive: an error body virtually never echoes the
  // key, but D0 forbids ever risking it.
  private async errorSummary(res: { text(): Promise<string> }, key: string): Promise<string | undefined> {
    let body: string;
    try {
      body = await res.text();
    } catch {
      return undefined;
    }
    if (!body) return undefined;
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown };
      const err = (parsed.error ?? parsed) as { type?: unknown; message?: unknown };
      const type = typeof err.type === "string" ? err.type : undefined;
      const message = typeof err.message === "string" ? err.message : undefined;
      if (message) msg = type ? `${type}: ${message}` : message;
      else if (type) msg = type;
    } catch {
      // non-JSON body (e.g. an HTML gateway page): fall through with the raw text
    }
    msg = redact(msg, [key]).replace(/\s+/g, " ").trim().slice(0, 300);
    return msg || undefined;
  }
}

// Deterministic fake for tests: a fixed result, or a per-call function of the probe input.
// Accepts a bare ProbeResult string (the common case) or a full ProbeOutcome and normalizes
// to a ProbeOutcome, so existing `new FakeAccountProber("ok")` call sites keep working.
export class FakeAccountProber implements AccountProber {
  constructor(
    private result:
      | ProbeResult
      | ProbeOutcome
      | ((opts: { provider: string; key: string | null; credentialType?: CredentialType; profile?: ProviderProfile }) => ProbeResult | ProbeOutcome) = "ok",
  ) {}
  async probe(opts: { provider: string; key: string | null; credentialType?: CredentialType; profile?: ProviderProfile }): Promise<ProbeOutcome> {
    const r = typeof this.result === "function" ? this.result(opts) : this.result;
    return typeof r === "string" ? { result: r } : r;
  }
}
