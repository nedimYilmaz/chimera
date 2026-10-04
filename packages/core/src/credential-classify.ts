import type { CredentialType } from "@chimera/protocol";

// OAUTH-TOKEN-ACCOUNTS: classify a pasted secret by its Anthropic key-prefix shape so
// accounts.setKey can pick the RIGHT injectAs env var instead of always assuming an
// x-api-key-shaped ANTHROPIC_API_KEY. Only "claude" carries these prefix conventions —
// every other provider's key is opaque to us, so it stays a plain apiKey injected as
// that provider's own catalog envVar (byte-identical to the pre-existing behavior).
export interface ClassifiedCredential {
  credentialType: CredentialType;
  injectAs: string;
  /** Present only for a credential we know in advance cannot work (adminKey). */
  warning?: string;
}

const ADMIN_KEY_WARNING =
  "this looks like an Anthropic Admin API key (sk-ant-admin...) — it can manage the " +
  "organization/workspace but cannot call the Messages API, so agents on this account " +
  "will fail to authenticate. Use a standard API key (sk-ant-api03-...) or a Claude Code " +
  "OAuth token (sk-ant-oat01-..., from `claude setup-token`) instead.";

export function classifyCredential(provider: string, trimmedKey: string, fallbackInjectAs: string): ClassifiedCredential {
  if (provider !== "claude") return { credentialType: "apiKey", injectAs: fallbackInjectAs };
  if (trimmedKey.startsWith("sk-ant-admin")) return { credentialType: "adminKey", injectAs: fallbackInjectAs, warning: ADMIN_KEY_WARNING };
  if (trimmedKey.startsWith("sk-ant-oat01")) return { credentialType: "oauthToken", injectAs: "CLAUDE_CODE_OAUTH_TOKEN" };
  return { credentialType: "apiKey", injectAs: "ANTHROPIC_API_KEY" };
}
