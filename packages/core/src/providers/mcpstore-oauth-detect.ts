// MCP-OAUTH-DISCOVERABILITY: read-only, no-secret probe for whether a remote MCP server is
// OAuth 2.1 -- used both to auto-default a fresh import/add to auth.kind:"oauth" (engine.ts's
// mcpstore.add/mcpstore.import) and to retrofit an Authorize button onto an already-installed
// bearer entry the app never knew was OAuth (mcpstore.detectAuth, driving the app's per-row
// detect-probe + convert-then-authorize flow).
//
// Two independent signals, either one is conclusive:
//  1. RFC 9728 OAuth 2.0 Protected Resource Metadata at `<origin>/.well-known/
//     oauth-protected-resource` resolving a non-empty `authorization_servers` list.
//  2. A bare GET to the server URL returning 401 with a `WWW-Authenticate: Bearer
//     resource_metadata="..."` header pointing at a protected-resource metadata document
//     that itself resolves an authorization server (some servers only expose the metadata
//     via the challenge, not the well-known path directly).
//
// SECURITY: every request here is an unauthenticated GET against public metadata -- no
// secret is read, sent, or required; a probe failure (network error, 404, malformed JSON)
// is always treated as inconclusive ("not detected as oauth"), never thrown out to the
// caller -- a broken/unreachable server must never block a plain mcpstore.add/import.
//
// SSRF: the URL is attacker-influenced (an agent can propose any http server via
// mcp_store_add), and so is every URL the discovery then chases (resource_metadata, the
// authorization server, redirects). So ALL of it goes through providers/ssrf-guard.ts's fetch:
// public unicast destinations only, resolved once and pinned for the connection, redirects
// re-validated per hop, bounded in hops/time/body. A blocked hop is just an inconclusive probe,
// which keeps a localhost/LAN proposal storable (disabled) without the daemon ever touching it.
// There is deliberately no parameter to hand in a raw `fetch` -- that was the bypass.
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { createGuardedFetch, type GuardedFetchSeams } from "./ssrf-guard.js";

export type McpOAuthDetectResult = {
  oauth: boolean;
  authorizationServers?: string[];
  scopesSupported?: string[];
};

const DETECT_TIMEOUT_MS = 5_000;
// Discovery makes up to ~6 sequential requests; without an overall cap a slow-loris origin
// could hold an add/import for 6 x the per-request timeout.
const DETECT_BUDGET_MS = 15_000;

async function resolveFromResourceMetadata(
  url: string,
  resourceMetadataUrl: string | undefined,
  fetchFn: typeof fetch,
): Promise<McpOAuthDetectResult | null> {
  const metadata = await discoverOAuthProtectedResourceMetadata(
    url,
    resourceMetadataUrl ? { resourceMetadataUrl } : {},
    fetchFn,
  );
  const authorizationServers = metadata.authorization_servers ?? [];
  if (authorizationServers.length === 0) return null;
  let scopesSupported = metadata.scopes_supported;
  try {
    const asMetadata = await discoverAuthorizationServerMetadata(authorizationServers[0]!, { fetchFn });
    if (asMetadata?.scopes_supported) scopesSupported = asMetadata.scopes_supported;
  } catch {
    // AS metadata is supplementary (scope list only) -- a protected-resource hit that
    // resolves an authorization server is already conclusive evidence of OAuth on its own.
  }
  return { oauth: true, authorizationServers, scopesSupported };
}

/** `seams` are test doubles BELOW the guard (DNS answers / wire transport); they cannot relax it. */
export async function detectMcpStoreOAuth(url: string, seams: GuardedFetchSeams = {}): Promise<McpOAuthDetectResult> {
  const fetchFn = createGuardedFetch({ ...seams, timeoutMs: DETECT_TIMEOUT_MS, budgetMs: DETECT_BUDGET_MS });
  try {
    const direct = await resolveFromResourceMetadata(url, undefined, fetchFn);
    if (direct) return direct;
  } catch {
    // RFC9728 well-known not present at the origin -- fall through to the 401-challenge probe.
  }

  try {
    const res = await fetchFn(url, { method: "GET" });
    if (res.status === 401) {
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(res);
      if (resourceMetadataUrl) {
        const viaChallenge = await resolveFromResourceMetadata(url, resourceMetadataUrl.toString(), fetchFn);
        if (viaChallenge) return viaChallenge;
      }
    }
  } catch {
    // network error on the bare probe -- inconclusive, not evidence either way.
  }

  return { oauth: false };
}
