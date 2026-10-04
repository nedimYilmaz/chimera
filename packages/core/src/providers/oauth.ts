// F23-0D (D4): the subscription-token store. Loads/saves the token JSON at rest in the
// Keychain (NEVER config, NEVER logs — D0), and refreshes it shortly before it expires.
// TokenRefresher implementations are per-provider and largely EMPTY here by design — the
// design doc is explicit that FAZ-2A fills in the real device-code/PKCE refresh exchanges
// (GitHub Copilot, Google Code Assist, xAI Grok Build); this task only builds the seam
// (registry + refresh-window logic) so those can be dropped in without touching the store.
import type { Keychain } from "../keychain.js";
import type { ProviderProfile } from "@chimera/protocol";

export type OAuthTokenJson = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;       // epoch ms; absent = treated as never-expiring (e.g. a long-lived PAT)
  accountMeta?: Record<string, unknown>;
};

export interface TokenRefresher {
  refresh(token: OAuthTokenJson, profile: ProviderProfile): Promise<OAuthTokenJson>;
}

// D4: refresh when less than 5 minutes remain on the access token.
export const REFRESH_WINDOW_MS = 5 * 60_000;

export class OAuthTokenStore {
  private refreshers = new Map<string, TokenRefresher>();

  constructor(private keychain: Keychain, refreshers?: Map<string, TokenRefresher>) {
    if (refreshers) this.refreshers = new Map(refreshers);
  }

  registerRefresher(provider: string, refresher: TokenRefresher): void {
    this.refreshers.set(provider, refresher);
  }

  // tokenRef IS the keychain service name (AccountAuthSchema's oauth arm: "tokenRef: the
  // keychain SERVICE NAME holding the token JSON") — never a secret itself.
  async load(tokenRef: string): Promise<OAuthTokenJson | null> {
    const raw = await this.keychain.get(tokenRef);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as OAuthTokenJson).accessToken !== "string") return null;
      return parsed as OAuthTokenJson;
    } catch {
      return null;   // a corrupt keychain item is treated as "no token" (never throws)
    }
  }

  async save(tokenRef: string, token: OAuthTokenJson): Promise<void> {
    await this.keychain.set(tokenRef, JSON.stringify(token));
  }

  async delete(tokenRef: string): Promise<void> {
    await this.keychain.delete(tokenRef);
  }

  // The credential-resolution entry point (D4): load → refresh-if-expiring(<5min) → return.
  // A refreshed token is persisted back before being returned, so the next call reuses it
  // instead of refreshing again. Returns null when no token is stored (caller decides how
  // to surface that as a clean error). Never throws on missing/absent refresh capability —
  // a token past its expiresAt with no refresher (or no refreshToken) is returned AS-IS;
  // the caller's downstream request is what actually discovers it's stale.
  async getValid(tokenRef: string, provider: string, profile: ProviderProfile): Promise<OAuthTokenJson | null> {
    const token = await this.load(tokenRef);
    if (!token) return null;
    const expiring = token.expiresAt !== undefined && token.expiresAt - Date.now() < REFRESH_WINDOW_MS;
    if (!expiring || !token.refreshToken) return token;
    const refresher = this.refreshers.get(provider);
    if (!refresher) return token;
    const refreshed = await refresher.refresh(token, profile);
    await this.save(tokenRef, refreshed);
    return refreshed;
  }
}
