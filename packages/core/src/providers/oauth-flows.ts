// F23-2A: the real subscription OAuth flows that sit behind accounts.oauth_start/oauth_finish.
// F23-0D built the seam (OAuthTokenStore + TokenRefresher registry); this is what actually
// talks to a provider's auth endpoints. Two flows ship:
//  - GitHub Copilot: device-code flow (github.com/login/device/code -> poll
//    github.com/login/oauth/access_token -> exchange for a short-lived Copilot token).
//  - xAI Grok Build: NOT a flow we can drive ourselves — xAI hasn't published a client_id
//    or token endpoint for third parties (research doc §E/§G: "client_id/token-path NOT
//    public"). Instead this reads the credentials the OFFICIAL Grok CLI already wrote to
//    disk after its own login.
// Both a provider's `start()` and its TokenRefresher are careful to never let a raw token
// reach a thrown Error message verbatim without going through redact() first (D0: never log
// tokens) — see redactSecrets() below.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderProfile } from "@chimera/protocol";
import { redact } from "../credentials.js";
import type { OAuthTokenJson, TokenRefresher } from "./oauth.js";
import type { PendingOAuthStore } from "./pending-oauth.js";

export type OAuthStartResult =
  | { kind: "device"; userCode: string; verificationUri: string }
  | { kind: "authorize"; authorizeUrl: string }
  | { kind: "immediate" };   // credentials were already resolved synchronously (e.g. read from disk)

export interface OAuthFlow {
  readonly provider: string;
  // Called once per accounts.oauth_start. MUST NOT throw after it has scheduled background
  // work that could itself resolve/fail the pending record — throw only for a synchronous,
  // pre-flight failure (bad request, missing local creds); the caller deletes the pending
  // record in that case.
  start(pending: PendingOAuthStore, pendingId: string): Promise<OAuthStartResult>;
  // Only implemented by authorize-code (PKCE) flows, where oauth_finish's pasted `code` is
  // the thing that actually completes the exchange. Device/immediate flows omit this.
  continueWithCode?(pending: PendingOAuthStore, pendingId: string, code: string): Promise<void>;
}

function redactSecrets(err: unknown, secrets: string[]): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message, secrets);
}

// ---------- GitHub Copilot (device-code) ----------

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type CopilotTokenResponse = { token: string; expires_at: number };

export async function exchangeCopilotToken(ghuToken: string, fetchFn: typeof fetch = fetch): Promise<{ token: string; expiresAt: number }> {
  const res = await fetchFn("https://api.github.com/copilot_internal/v2/token", {
    headers: { authorization: `token ${ghuToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(redact(`copilot token exchange failed (HTTP ${res.status})`, [ghuToken]));
  const body = (await res.json()) as CopilotTokenResponse;
  if (!body.token) throw new Error("copilot token exchange returned no token");
  return { token: body.token, expiresAt: body.expires_at * 1000 };
}

export type CopilotFlowDeps = {
  clientId: string;
  scopes: string[];
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CopilotOAuthFlow implements OAuthFlow {
  readonly provider = "copilot";

  constructor(private deps: CopilotFlowDeps) {}

  async start(pending: PendingOAuthStore, pendingId: string): Promise<OAuthStartResult> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const res = await fetchFn("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.deps.clientId, scope: this.deps.scopes.join(" ") }),
    });
    if (!res.ok) throw new Error(`device code request failed (HTTP ${res.status})`);
    const data = (await res.json()) as DeviceCodeResponse;
    if (!data.device_code || !data.user_code) throw new Error("device code response missing device_code/user_code");

    // Fire-and-forget: the daemon polls server-side (never the caller's RPC connection).
    // A rejection here is caught and stored on the pending record as a "error" state — never
    // rethrown into the void (which would surface as an unhandled rejection).
    void this.pollAndExchange(pending, pendingId, data).catch((err: unknown) => {
      pending.fail(pendingId, redactSecrets(err, [data.device_code]));
    });

    return { kind: "device", userCode: data.user_code, verificationUri: data.verification_uri };
  }

  private async pollAndExchange(pending: PendingOAuthStore, pendingId: string, data: DeviceCodeResponse): Promise<void> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const sleep = this.deps.sleepFn ?? defaultSleep;
    const deadline = Date.now() + data.expires_in * 1000;
    let intervalMs = Math.max(1, data.interval) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const res = await fetchFn("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.deps.clientId,
          device_code: data.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };

      if (body.access_token) {
        const copilot = await exchangeCopilotToken(body.access_token, fetchFn);
        const token: OAuthTokenJson = {
          accessToken: copilot.token,
          // the long-lived ghu_ token is what re-mints a fresh (short-lived) Copilot token —
          // stored as refreshToken so OAuthTokenStore.getValid's existing refresh path works
          // unmodified (F23-0D never assumed a classic refresh_token grant here).
          refreshToken: body.access_token,
          expiresAt: copilot.expiresAt,
        };
        pending.resolve(pendingId, token);
        return;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") { intervalMs += 5000; continue; }
      throw new Error(`device flow failed: ${body.error ?? "unknown error"}`);
    }
    throw new Error("device code expired before the user authorized it");
  }
}

export class CopilotTokenRefresher implements TokenRefresher {
  constructor(private fetchFn: typeof fetch = fetch) {}

  async refresh(token: OAuthTokenJson, _profile: ProviderProfile): Promise<OAuthTokenJson> {
    if (!token.refreshToken) throw new Error("no stored GitHub token to re-mint a Copilot token from");
    const copilot = await exchangeCopilotToken(token.refreshToken, this.fetchFn);
    return { ...token, accessToken: copilot.token, expiresAt: copilot.expiresAt };
  }
}

// ---------- xAI Grok Build (external-CLI credentials) ----------
//
// xAI has not published a client_id or token endpoint for third parties (research doc §E/§G:
// "client_id/token-path NOT public"), so chimera cannot drive its own OAuth exchange here. The
// official Grok CLI already performs that login and writes the result to ~/.grok/auth.json —
// this flow just reads it. There is nothing to poll: either the file is there and valid
// (resolved immediately) or it isn't (a clear "go install + log in" error, no pendingId retained).
type GrokAuthFile = { access_token?: string; refresh_token?: string; expires_at?: number };

export type GrokCliFlowDeps = {
  authFilePath?: string;                                // test seam; default ~/.grok/auth.json
  readFile?: (path: string) => Promise<string>;         // test seam
};

function defaultGrokAuthPath(deps: GrokCliFlowDeps): string {
  return deps.authFilePath ?? join(homedir(), ".grok", "auth.json");
}

async function readGrokAuthFile(deps: GrokCliFlowDeps): Promise<GrokAuthFile> {
  const path = defaultGrokAuthPath(deps);
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    throw new Error(
      `Grok Build credentials not found at ${path} — install the official Grok CLI, run its login `
      + `flow (SuperGrok Heavy subscription required), then retry connecting this provider.`,
    );
  }
  let parsed: GrokAuthFile;
  try {
    parsed = JSON.parse(raw) as GrokAuthFile;
  } catch {
    throw new Error(`${path} is not valid JSON — log in again via the official Grok CLI.`);
  }
  if (!parsed.access_token) {
    throw new Error(`${path} has no access_token — log in again via the official Grok CLI.`);
  }
  return parsed;
}

export class GrokCliOAuthFlow implements OAuthFlow {
  readonly provider = "grok-build";

  constructor(private deps: GrokCliFlowDeps = {}) {}

  async start(pending: PendingOAuthStore, pendingId: string): Promise<OAuthStartResult> {
    const parsed = await readGrokAuthFile(this.deps);
    const token: OAuthTokenJson = {
      accessToken: parsed.access_token!,
      refreshToken: parsed.refresh_token,
      expiresAt: parsed.expires_at,
      accountMeta: { source: "grok-cli", authFilePath: defaultGrokAuthPath(this.deps) },
    };
    pending.resolve(pendingId, token);
    return { kind: "immediate" };
  }
}

export class GrokCliTokenRefresher implements TokenRefresher {
  constructor(private deps: GrokCliFlowDeps = {}) {}

  // The official CLI owns its own refresh cycle and rewrites auth.json in place — chimera's
  // "refresh" is just re-reading the file. If it can't be read (CLI uninstalled/logged out
  // since connecting), the stale token is returned as-is; the caller's downstream request is
  // what actually surfaces that as an error (same contract as OAuthTokenStore.getValid's
  // "no refresher"/"no refreshToken" cases).
  async refresh(token: OAuthTokenJson, _profile: ProviderProfile): Promise<OAuthTokenJson> {
    try {
      const parsed = await readGrokAuthFile(this.deps);
      return {
        accessToken: parsed.access_token!,
        refreshToken: parsed.refresh_token,
        expiresAt: parsed.expires_at,
        accountMeta: token.accountMeta,
      };
    } catch {
      return token;
    }
  }
}
