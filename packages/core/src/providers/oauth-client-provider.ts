// MCP-OAUTH slice 2: the persistence adapter the MCP SDK's `auth()`/transport auth machinery
// drives (client/auth.js's `OAuthClientProvider` interface). Two very different durability
// classes live behind this one object, per the security spec:
//   - access+refresh tokens AND the DCR client_id/secret: durable, KEYCHAIN ONLY, one JSON
//     blob at the server's `auth.keychainRef` (never config, never logs -- D0).
//   - the PKCE code_verifier and the issued `state`: TRANSIENT, in-memory fields on this
//     instance ONLY, never persisted, never logged. A provider instance lives for exactly one
//     oauth.start..callback flow (constructed fresh in McpStoreOAuthFlow.start, discarded after)
//     so "transient" here really does mean "gone the moment the flow ends or the daemon
//     restarts" -- the same discipline PendingOAuthStore documents for accounts.oauth_start.
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Keychain } from "../keychain.js";
import { mcpStoreAuthService } from "../keychain.js";

// The keychain payload shape at auth.keychainRef for an oauth-kind mcpstore server. Distinct
// from bearer's "raw secret string" payload (McpStoreHttpAuthSchema's `kind` discriminant is
// exactly what keeps the two from ever being confused at the call site).
type KeychainOAuthPayload = {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  // MCP-AUTH-STATUS: epoch ms of the saveTokens() that wrote `tokens`. OAuthTokens carries
  // `expires_in` (a DURATION) but no issue time, so without this stamp there is no way to tell
  // a token minted a minute ago from one minted last month. Additive: load() tolerates its
  // absence, which is exactly what every grant minted before this field looks like.
  authorizedAt?: number;
};

// Credentials saved before SDK 1.31 have no issuer. Never infer it from current server
// discovery: that is controlled by the MCP server and could silently bind an old secret
// to an attacker. Withhold legacy/malformed entries until an explicit sign-in replaces
// them; reads leave the keychain intact. The SDK checks bound entries against discovery.
function issuerBound<T extends { issuer?: string }>(credential: T | undefined): T | undefined {
  if (!credential || typeof credential.issuer !== "string" || !credential.issuer.trim()) return undefined;
  try {
    const url = new URL(credential.issuer);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? credential : undefined;
  } catch {
    return undefined;
  }
}

// MCP-AUTH-STATUS: everything the auth-status surface is allowed to know about a stored grant.
// Note what is NOT on this type: access_token, refresh_token, client_secret. This value reaches
// an agent transcript through mcp_store_auth_status, so it carries booleans and timestamps only
// -- never the material itself, and never a prefix/suffix of it.
export type McpStoreOAuthSnapshot = {
  hasTokens: boolean;
  hasRefreshToken: boolean;
  authorizedAt?: number;
  expiresInSeconds?: number;
  scopes?: string[];
};

// Reads the grant at `chimera:mcp:<name>` WITHOUT constructing a provider or touching the
// network -- the store page asks this for every installed server on every open.
export async function readMcpStoreOAuthSnapshot(keychain: Keychain, serverName: string): Promise<McpStoreOAuthSnapshot> {
  let payload: KeychainOAuthPayload = {};
  try {
    const raw = await keychain.get(mcpStoreAuthService(serverName));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") payload = parsed as KeychainOAuthPayload;
    }
  } catch {
    // A missing or corrupt keychain item reads as "nothing stored" -- the same forgiving
    // treatment load() gives it. An auth-status probe must never throw; a server whose
    // keychain entry is unreadable simply shows as never-authorized.
    return { hasTokens: false, hasRefreshToken: false };
  }
  const tokens = issuerBound(payload.tokens);
  if (!tokens?.access_token) return { hasTokens: false, hasRefreshToken: false };
  const scope = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : undefined;
  return {
    hasTokens: true,
    hasRefreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0,
    ...(typeof payload.authorizedAt === "number" ? { authorizedAt: payload.authorizedAt } : {}),
    ...(typeof tokens.expires_in === "number" ? { expiresInSeconds: tokens.expires_in } : {}),
    ...(scope?.length ? { scopes: scope } : {}),
  };
}

export class KeychainOAuthClientProvider implements OAuthClientProvider {
  private codeVerifierValue: string | undefined;
  private issuedStateValue: string | undefined;
  private capturedAuthorizeUrl: string | undefined;

  constructor(
    private readonly serverName: string,
    private readonly keychain: Keychain,
    private readonly redirectUrlValue: string,
    private readonly scopesList: string[] | undefined,
  ) {}

  get redirectUrl(): string {
    return this.redirectUrlValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrlValue],
      client_name: "chimera",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scopesList?.length ? { scope: this.scopesList.join(" ") } : {}),
    };
  }

  // Read back by the orchestrator (McpStoreOAuthFlow) purely for state validation on the
  // loopback callback -- the SDK itself never reads this back through the interface.
  get issuedState(): string | undefined {
    return this.issuedStateValue;
  }

  // Read back by the orchestrator to hand the browser-facing URL to the RPC caller (the SDK
  // calls redirectToAuthorization expecting it to open a browser; chimera's daemon has none,
  // so it captures the URL here instead and returns it over RPC for the UI to open).
  get authorizeUrl(): string | undefined {
    return this.capturedAuthorizeUrl;
  }

  state(): string {
    this.issuedStateValue = randomUUID();
    return this.issuedStateValue;
  }

  private async load(): Promise<KeychainOAuthPayload> {
    const raw = await this.keychain.get(mcpStoreAuthService(this.serverName));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as KeychainOAuthPayload) : {};
    } catch {
      return {};   // a corrupt keychain item is treated as "nothing stored yet" (never throws)
    }
  }

  private async persist(patch: KeychainOAuthPayload): Promise<void> {
    const current = await this.load();
    await this.keychain.set(mcpStoreAuthService(this.serverName), JSON.stringify({ ...current, ...patch }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return issuerBound((await this.load()).tokens);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // MCP-AUTH-STATUS: stamped on EVERY save, which includes the SDK's silent refresh path --
    // so `authorizedAt` means "these tokens are this fresh", not "the human clicked this long
    // ago". That is the value the status surface actually wants.
    await this.persist({ tokens, authorizedAt: Date.now() });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return issuerBound((await this.load()).clientInfo);
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.persist({ clientInfo: clientInformation });
  }

  // MCP-AUTH-STATUS: drop the cached DCR registration so the SDK registers a fresh client.
  // Needed because a registration is bound to the redirect_uri it was created with, while every
  // flow binds a NEW loopback port -- see McpStoreOAuthFlow.start for the full story.
  // Deliberately NOT `persist({ clientInfo: undefined })`: persist() spreads over the loaded
  // payload, and an explicit undefined would be dropped by JSON.stringify rather than
  // overwriting the stored value, silently leaving the stale registration in place. Tokens are
  // preserved -- this discards the client identity, never the grant.
  async clearClientInformation(): Promise<void> {
    const { clientInfo: _dropped, ...rest } = await this.load();
    await this.keychain.set(mcpStoreAuthService(this.serverName), JSON.stringify(rest));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("no pending PKCE code verifier for this oauth flow");
    return this.codeVerifierValue;
  }

  // The daemon has no user agent of its own -- capture the URL for the RPC caller (the UI)
  // to open, instead of trying to launch a browser server-side.
  redirectToAuthorization(authorizationUrl: URL): void {
    this.capturedAuthorizeUrl = authorizationUrl.toString();
  }
}
