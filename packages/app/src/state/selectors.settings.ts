// W9 (F09 · coverage B15/B16) — PURE selectors/formatters for the Settings
// screen. No React, no store, no rpc imports — unit-testable exactly like
// selectors.system.ts. Everything the SettingsScreen renders that involves a
// DECISION (which section, how a key badge is derived, how a masked field is
// displayed, which section a config/network event must refresh) lives here as a
// pure function so the logic is tested in the node env with no DOM.
import { MCP_LISTENER_FOOTNOTE } from "@chimera/ui-state";
import type { AccountStatus, AgentCapStatus } from "@chimera/ui-state";
import type { CredentialType, DynamicCapConfig, McpListenerStatus, McpStoreAuthState, McpStoreImportable, McpStoreToolInfo, TailscaleNetworkStatus, CloudflareProvisionStatus } from "@chimera/protocol";
import { findMcpOAuthGateway, type McpOAuthGateway } from "@chimera/protocol";
import { DynamicCapConfigSchema, DEFAULT_COMPACTION_THRESHOLD, configPatchValue } from "@chimera/protocol";
import { fmtClock, fmtCost } from "./selectors";

// ---------------------------------------------------------------------------
// section list + routing (mock left rail, lines 913-924)
// ---------------------------------------------------------------------------

export type SettingsSection = "providers" | "network" | "tools" | "notify" | "hooks" | "mcp" | "secrets" | "general";

export type SettingsSectionMeta = {
  id: SettingsSection;
  /** Left-rail label (mock copy). */
  label: string;
  /** The right-aligned meta the mock shows on each row (a count/hint). */
  hint: string;
};

/** The section list in mock order (providers & accounts / network & federation /
 * host tools / general). The TopBar strip owns the tab; THIS drives the screen's
 * own left rail + ↑↓ section cursor. */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: "providers", label: "providers & accounts", hint: "accounts · keys" },
  { id: "network", label: "network & federation", hint: "tailscale · peers" },
  { id: "tools", label: "host tools", hint: "mod+d card" },
  { id: "notify", label: "notifications", hint: "rules · channels" },
  { id: "hooks", label: "lifecycle hooks", hint: "on → actions" },
  { id: "mcp", label: "mcp store", hint: "installed · importable" },
  // SECRET-MANAGER: values live in the keychain; this section is the grant table over them.
  { id: "secrets", label: "secrets", hint: "keychain · per-agent grants" },
  { id: "general", label: "general", hint: "engine.id · budget" },
];

const SECTION_ORDER: readonly SettingsSection[] = SETTINGS_SECTIONS.map((s) => s.id);

/** Clamp-stepped section cursor (↑↓ nav). Never wraps — matches the mock's
 * "↑↓ section" hint (a bounded list, not a ring). */
export function stepSection(current: SettingsSection, delta: number): SettingsSection {
  const i = SECTION_ORDER.indexOf(current);
  const next = Math.min(SECTION_ORDER.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
  return SECTION_ORDER[next]!;
}

export function isSettingsSection(v: string): v is SettingsSection {
  return (SECTION_ORDER as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// provider key badge (mock lines 954-957: ▪ set · ✗ missing · ✗ invalid)
// ---------------------------------------------------------------------------

export type KeyBadge = "set" | "missing" | "invalid" | "untested";
// OAUTH-TOKEN-ACCOUNTS: admin_key is decided BEFORE any network probe (see
// core/prober.ts's doc comment) — the key IS valid but for the wrong API surface (an
// Anthropic Admin API key can't call the Messages API), so a live probe would falsely
// reject it as auth_error instead of naming the real problem.
// OAUTH-TOKEN-VALIDATE: an oauthToken account now gets a real live probe too (Bearer +
// anthropic-beta oauth headers against the same endpoint) — ok/auth_error only.
export type ProbeResult = "ok" | "auth_error" | "admin_key" | "connection_error";

/** Derive an account's key badge from the data the daemon actually exposes.
 *
 * The API key is WRITE-ONLY (F09): accounts.setKey stores it in the Keychain and
 * NO RPC ever reads the value back — config.get is redacted, accounts.list carries
 * only name/provider/authType/hasKey. `hasKey` is a PRESENCE boolean the daemon
 * computes from the keychain/env/oauth store (ACCOUNT-KEY-PRESENCE) — it says
 * whether a secret is STORED, never what it is, so a freshly-restarted UI can show
 * "set" for a stored-but-untested key instead of "missing" until `t` is pressed.
 * The badge means "is a usable key present":
 *   invalid  — a test returned auth_error/admin_key, OR daemon.status flags authExpired.
 *   set      — a test returned ok, a secret is present (hasKey), OR the account
 *              needs no stored secret (subscription uses the provider CLI's
 *              ambient session).
 *   missing  — no secret is stored (hasKey is false/absent) and no test has
 *              confirmed one either. */
export function keyBadge(input: { authType?: string; test?: ProbeResult; authExpired?: boolean; hasKey?: boolean }): KeyBadge {
  // subscription needs NO stored secret (ambient provider-CLI session), so a
  // key probe can't meaningfully test it — it is always "set". Checked FIRST so a
  // stale/meaningless auth_error (or an authExpired flag) can never flip the
  // account the whole system runs on to a false "invalid".
  if (input.authType === "subscription") return "set";
  if (input.test === "admin_key") return "invalid";
  if (input.test === "auth_error") return "invalid";
  if (input.test === "connection_error") return "untested";
  if (input.authExpired) return "invalid";
  if (input.test === "ok") return "set";
  if (input.hasKey) return "set";
  return "missing";
}

export type BadgeTone = "success" | "danger" | "warn";

/** ▪ set is green; ◐ untested is amber; ✗ missing / ✗ invalid are red (mock). */
export function keyBadgeTone(badge: KeyBadge): BadgeTone {
  if (badge === "set") return "success";
  if (badge === "untested") return "warn";
  return "danger";
}

/** The glyph + word the row renders ("▪ set", "◐ untested", "✗ missing", "✗ invalid"). */
export function keyBadgeLabel(badge: KeyBadge): string {
  if (badge === "set") return "▪ set";
  if (badge === "untested") return "◐ untested";
  return `✗ ${badge}`;
}

/** "api key" / "oauth token" / "admin key" — the credential-type column text.
 *  Undefined (an old, never-(re)classified keychain account) defaults to "api key",
 *  the historical unconditional assumption. */
export function credentialTypeLabel(t?: CredentialType): string {
  switch (t) {
    case "oauthToken": return "oauth token";
    case "adminKey": return "admin key";
    default: return "api key";
  }
}

/** Structured probe detail replacing a bare "invalid" — null when there's nothing
 *  more specific to say than the badge word itself already conveys. */
export function probeDetail(test?: ProbeResult): string | null {
  switch (test) {
    case "admin_key": return "admin key — cannot call the Messages API";
    case "auth_error": return "auth rejected";
    case "connection_error": return "provider unreachable";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// F23-2B (D5/D6) — the provider catalog view (providers.list RPC): every
// catalog provider, not just configured accounts. Capability chips + tosNote +
// per-provider actions (add key / connect via subscription / base-URL+model
// override / test / remove) live here as pure view-model functions so the
// SettingsScreen component stays a thin renderer, same discipline as the
// account-row builders above.
// ---------------------------------------------------------------------------

/** The providers.list RPC's per-row shape (engine.ts's "providers.list" case). */
export type ProviderCatalogItem = {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  defaultModel: string;
  authModes: readonly string[];
  capabilities: { tools: boolean; vision: boolean; streaming: boolean };
  tosNote: string | null;
  experimental: boolean;
  override: { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null;
  accounts: readonly { name: string; authType: string }[];
  custom?: boolean;
  requiresKey?: boolean;
};

export type CapabilityChip = { key: "tools" | "vision" | "streaming"; label: string; on: boolean };

export type ProviderCatalogRow = {
  id: string;
  label: string;
  kind: string;
  experimental: boolean;
  chips: readonly CapabilityChip[];
  /** true once at least one account is configured for this provider. */
  connected: boolean;
  /** "not connected" · "1 account" · "3 accounts" (mock-style status copy). */
  connectionLabel: string;
  accounts: readonly { name: string; authType: string }[];
  supportsApiKey: boolean;
  custom: boolean;
  requiresKey: boolean;
  supportsSubscription: boolean;
  /** KIMI-CODE-SUBSCRIPTION: accounts.oauth_start/oauth_finish are live RPCs (F23-2A
   * shipped) — this is a real capability flag now, not the old hardcoded-false
   * "coming soon" placeholder. Gated purely on `supportsSubscription` (authModes
   * includes "oauth"); the daemon's own experimental gate (config providers.experimental)
   * still applies server-side for entries like copilot, surfacing as an error toast on
   * connect rather than a client-side disable. */
  subscriptionAvailable: boolean;
  /** SUBSCRIPTION-CONNECT: distinct from `supportsSubscription`/`subscriptionAvailable`
   * above — THOSE gate the F23-2A oauth device-code/CLI-file flow (copilot/grok-build/
   * kimi-code). This gates accounts.add_subscription's CLI-subscription path
   * (claude/codex only, kind "agentic-sdk" — the provider CLI's own ambient login, no
   * device-code exchange). KIMI-CODE-SUBSCRIPTION-UI: the card renders ONE "connect
   * with subscription" affordance per provider — this flag and `subscriptionAvailable`
   * are mutually exclusive per row (a provider is never both agentic-sdk AND
   * openai-compat), so the card picks whichever is true and routes the click through
   * the right RPC (SettingsScreen.tsx), never showing two competing buttons. */
  supportsSubscriptionLogin: boolean;
  /** true once a `subscription`-auth account exists for this provider — drives the
   * "connect with subscription" button's green/connected state for the agentic-sdk path. */
  subscriptionLoginConnected: boolean;
  /** KIMI-CODE-SUBSCRIPTION: the same green/connected state for the oauth path
   * (copilot/grok-build/kimi-code) — true only when an oauth-typed account exists
   * AND its last accounts.test probe (if any) didn't come back auth_error. An account
   * row existing is NOT enough on its own: an oauth flow reads a token from a file an
   * external CLI wrote, which can go stale/expire independently of chimera ever
   * noticing until the next probe or spawn — this must not paint green over that. */
  subscriptionOAuthConnected: boolean;
  tosNote: string | null;
  baseUrl: string;
  defaultModel: string;
  overridden: boolean;
  /** COMPACTION-THRESHOLD-CONFIG: tokens; `null` ⇒ the operator explicitly pinned this
   * provider to its NATIVE compaction; `undefined` ⇒ nothing configured, so the provider's
   * DEFAULT_COMPACTION_THRESHOLD applies if it has one (claude does — see compactionThresholdLabel). */
  compactionThreshold: number | null | undefined;
};

/** Build the catalog-driven provider rows from providers.list, in catalog order
 * (the RPC already returns catalog order — this is a pure passthrough shape,
 * not a re-sort, so it stays trivially testable against a fixture).
 * `tests` (accounts.test results, keyed by account name) is optional — omitted in
 * most call sites' existing fixtures, in which case `subscriptionOAuthConnected`
 * falls back to pure account-presence (the pre-existing, pre-probe-aware
 * behavior) rather than treating "no test yet" as disconnected. */
export function buildProviderCatalogRows(
  providers: readonly ProviderCatalogItem[],
  tests: Readonly<Record<string, ProbeResult>> = {},
): ProviderCatalogRow[] {
  return providers.map((p) => {
    const n = p.accounts.length;
    const oauthAccount = p.accounts.find((a) => a.authType === "oauth");
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      experimental: p.experimental,
      chips: [
        { key: "tools", label: "tools", on: p.capabilities.tools },
        { key: "vision", label: "vision", on: p.capabilities.vision },
        { key: "streaming", label: "streaming", on: p.capabilities.streaming },
      ],
      connected: n > 0,
      connectionLabel: n === 0 ? "not connected" : `${n} account${n === 1 ? "" : "s"}`,
      accounts: p.accounts,
      supportsApiKey: p.authModes.includes("apiKey"),
      custom: p.custom ?? false,
      requiresKey: p.requiresKey ?? true,
      supportsSubscription: p.authModes.includes("oauth"),
      subscriptionAvailable: p.authModes.includes("oauth"),
      supportsSubscriptionLogin: p.kind === "agentic-sdk",
      subscriptionLoginConnected: p.accounts.some((a) => a.authType === "subscription"),
      subscriptionOAuthConnected: oauthAccount !== undefined && tests[oauthAccount.name] !== "auth_error",
      tosNote: p.tosNote,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      overridden: p.override !== null,
      compactionThreshold: p.override?.compactionThreshold,
    };
  });
}

/** Providers before the FIRST providers.list read ever lands (empty catalog).
 * Used only as a placeholder option list — real catalog rows arrive within one
 * daemon round-trip and replace it. */
export const FALLBACK_PROVIDER_OPTIONS = ["claude", "codex", "kimi"] as const;

/** The add-provider form's provider dropdown: every catalog provider that supports
 * SOME connectable auth path (api key or CLI subscription) — not just api-key ones,
 * so agentic-sdk providers stay selectable even before any api-key account exists
 * (ONBOARDING-PROVIDER). Falls back to the two built-in agentic-sdk ids while the
 * catalog hasn't loaded yet. */
export function providerOptionsFor(catalogRows: readonly ProviderCatalogRow[]): string[] {
  const ids = catalogRows.filter((p) => p.supportsApiKey || p.supportsSubscriptionLogin).map((p) => p.id);
  return ids.length > 0 ? ids : [...FALLBACK_PROVIDER_OPTIONS];
}

/** A new connection suggests Codex without mutating existing account routing. */
export function initialProviderFor(options: readonly string[], preferred?: string): string {
  return [preferred, "codex", "openai"].find((id): id is string => !!id && options.includes(id)) ?? options[0] ?? "codex";
}

/** Parse the base-URL/default-model override form into a providers.list-shaped
 * providerOverrides patch. Both blank clears the provider's override entirely
 * (config.patch's RFC-7396 null-deletion, mirrors parseDailyCap/dailyCapPatch's
 * clear-on-blank convention). A blank baseUrl with a non-blank defaultModel (or
 * vice versa) keeps just the one field set — the OTHER field is omitted so a
 * merge-patch write can't accidentally clear a value the operator didn't touch. */
/** COMPACTION-THRESHOLD-CONFIG: `compactionThreshold` is the raw tokens-field text — blank
 * omits the field from the override, which since F39 does NOT mean native: a provider with a
 * DEFAULT_COMPACTION_THRESHOLD entry falls back to that number (compactionThresholdLabel says so
 * in the UI). A non-blank, non-positive-integer value is treated as blank (defensive — the input
 * is `type="number"` so this is a belt/braces guard against a stray paste, not the primary
 * validation). `native` is the "use model native" control: it emits the explicit `null` that
 * means native compaction and IGNORES the tokens field (the two are mutually exclusive), and it
 * makes the override non-empty on its own — returning null here would delete the whole provider
 * entry, which resolves straight back to the fleet default. providerOverridePatch turns that null
 * into the CONFIG_PATCH_NULL escape on the way to config.patch (QA finding M-1). */
export function parseProviderOverride(baseUrl: string, defaultModel: string, compactionThreshold = "", native = false): { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null {
  const b = baseUrl.trim();
  const m = defaultModel.trim();
  const ct = Number(compactionThreshold.trim());
  const hasCt = !native && compactionThreshold.trim() !== "" && Number.isInteger(ct) && ct > 0;
  if (!b && !m && !hasCt && !native) return null;
  return {
    ...(b ? { baseUrl: b } : {}),
    ...(m ? { defaultModel: m } : {}),
    ...(native ? { compactionThreshold: null } : hasCt ? { compactionThreshold: ct } : {}),
  };
}

/** COMPACTION-THRESHOLD-CONFIG: how a catalog row's compaction setting reads in the UI. Three
 * DISTINCT states, because F39 made "nothing set" stop meaning native: an explicit `null` is
 * native; a number is that number; absent falls back to the
 * provider's fleet default when it has one, and only then to native. The old copy called every
 * non-number "native", which was wrong for claude the moment DEFAULT_COMPACTION_THRESHOLD shipped. */
export function compactionThresholdLabel(providerId: string, threshold: number | null | undefined): string {
  if (typeof threshold === "number") return `${threshold} tokens`;
  if (threshold === null) return "native (model window)";
  const dflt = DEFAULT_COMPACTION_THRESHOLD[providerId];
  return dflt !== undefined ? `${dflt} tokens (fleet default)` : "native (model window)";
}

/** The config.patch params for a provider-override edit — a single provider's
 * entry inside the (possibly still-unset) `providerOverrides` map.
 *
 * The two nulls here mean OPPOSITE things and are encoded differently. The OUTER one (`value ===
 * null`, "stop overriding this provider") stays a real null, so RFC-7396 deletes the entry. The
 * INNER `compactionThreshold: null` ("use native compaction") is a value that must SURVIVE the
 * overlay, so it goes out as CONFIG_PATCH_NULL — a real null there would delete the key and
 * resolve back to the fleet default, which was the whole bug (QA finding M-1). */
export function providerOverridePatch(providerId: string, value: { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null): { providerOverrides: Record<string, Record<string, unknown> | null> } {
  if (value === null) return { providerOverrides: { [providerId]: null } };
  const { compactionThreshold, ...rest } = value;
  return {
    providerOverrides: {
      [providerId]: {
        ...rest,
        ...(compactionThreshold !== undefined ? { compactionThreshold: configPatchValue(compactionThreshold) } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// provider rows (accounts.list + config autoOrder + daemon.status + test map)
// ---------------------------------------------------------------------------

export type AccountListItem = { name: string; provider: string; authType?: string; hasKey?: boolean; credentialType?: CredentialType };

export type ProviderRow = {
  name: string;
  provider: string;
  badge: KeyBadge;
  badgeTone: BadgeTone;
  /** 1-based failover position (config autoOrder index), or null when the
   * account is not in the order (mock renders "—"). */
  failover: number | null;
  /** spend-today column — per-account spend is not in the daemon surface yet
   * (the WD ledger is engine-total), so this is the documented "—" unless a
   * status record carries a per-account spendTodayUsd. */
  spendLabel: string;
  /** undefined for a non-keychain account (subscription/env/command/oauth) — those
   * have no accounts.setKey-classified credential. */
  credentialType?: CredentialType;
  /** structured probe detail ("admin key — cannot call the Messages API", "auth
   * rejected"), or null when the badge word already says everything there is to say. */
  detail: string | null;
};

/** Merge the three read sources the mock's table draws from into row views, in
 * config autoOrder (so the row's POSITION is its failover slot, like the
 * AccountsCard). accounts.list is authoritative for membership; autoOrder gives
 * order + failover index; daemon.status supplies authExpired; the test map
 * carries the latest `t` ping result per account. */
export function buildProviderRows(
  accounts: readonly AccountListItem[],
  autoOrder: readonly string[],
  statusAccounts: readonly AccountStatus[],
  tests: Readonly<Record<string, ProbeResult>>,
  // API-KEY-INVALID: the daemon's own key-redacted probe message per account (http status +
  // provider error), when accounts.test returned one. Preferred over the generic per-class
  // probeDetail() string so the row shows the REAL cause ("401 authentication_error: invalid
  // x-api-key") instead of a flat "auth rejected". Absent ⇒ fall back to the class label.
  details: Readonly<Record<string, string>> = {},
): ProviderRow[] {
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const statusByName = new Map(statusAccounts.map((s) => [s.name, s]));
  // Order: autoOrder first (in order), then any account not listed in autoOrder.
  const ordered: string[] = [];
  for (const n of autoOrder) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
  for (const a of accounts) if (!ordered.includes(a.name)) ordered.push(a.name);

  return ordered.map((name) => {
    const acct = byName.get(name)!;
    const status = statusByName.get(name);
    const failIdx = autoOrder.indexOf(name);
    const badge = keyBadge({
      authType: acct.authType,
      ...(tests[name] !== undefined ? { test: tests[name] } : {}),
      ...(status?.authExpired ? { authExpired: true } : {}),
      ...(acct.hasKey !== undefined ? { hasKey: acct.hasKey } : {}),
    });
    return {
      name,
      provider: acct.provider,
      badge,
      badgeTone: keyBadgeTone(badge),
      failover: failIdx >= 0 ? failIdx + 1 : null,
      spendLabel: accountSpend(status),
      credentialType: acct.credentialType,
      detail: details[name] ?? probeDetail(tests[name]),
    };
  });
}

/** Compute the full new `autoOrder` array for a failover-priority move on
 * `name` (swap with its neighbor in the rendered order). Mirrors
 * buildProviderRows's own "autoOrder first, then trailing" ordering rule so
 * the swap operates on exactly the sequence the table shows — an account
 * currently absent from `autoOrder` (trailing, failover === null) is folded
 * into the array by this move, which is the expected effect of the user
 * explicitly reordering it. config.patch does whole-array replace (never a
 * delta), so the caller must send this full result, and every name that was
 * in the visible order must still be present afterward — this function never
 * drops or adds a name, it only permutes. Returns null if the move is a
 * no-op (already at the boundary, or name not present). */
export function reorderAutoOrder(
  accounts: readonly AccountListItem[],
  autoOrder: readonly string[],
  name: string,
  direction: "up" | "down",
): string[] | null {
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const ordered: string[] = [];
  for (const n of autoOrder) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
  for (const a of accounts) if (!ordered.includes(a.name)) ordered.push(a.name);

  const idx = ordered.indexOf(name);
  if (idx < 0) return null;
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= ordered.length) return null;

  const next = [...ordered];
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  return next;
}

function accountSpend(status: AccountStatus | undefined): string {
  const v = (status as unknown as Record<string, unknown> | undefined)?.["spendTodayUsd"];
  return typeof v === "number" ? fmtCost(v) : "—";
}

// ---------------------------------------------------------------------------
// masked write-only key field (mock: "sk-••••••••" · "write-only — never read
// back"). The raw value lives ONLY in the component's local state while typing
// and is handed to accounts.setKey then dropped; it is NEVER put in any store,
// selector, or rendered back. This formatter turns a length into a mask so the
// display can never echo a character of the secret.
// ---------------------------------------------------------------------------

const MASK_CHAR = "•";
const MASK_MAX = 24;

/** Masked display for a write-only key field of `length` chars. Bounded so a
 * long paste doesn't blow the field width. Returns ONLY mask characters —
 * unit-tested to share no character with any real key. */
export function maskKey(length: number): string {
  const n = Math.max(0, Math.min(MASK_MAX, Math.floor(length)));
  return MASK_CHAR.repeat(n);
}

// ---------------------------------------------------------------------------
// network & tailscale view (mock lines 930-934; fed.network state)
// ---------------------------------------------------------------------------

export type NetworkTone = "success" | "warn" | "danger" | "muted";

export type NetworkView = {
  loaded: boolean;
  installed: boolean;
  /** "connected" | "logged out" | "not installed" | "…" (loading). */
  statusLabel: string;
  statusTone: NetworkTone;
  ip4: string | null;
  magicDnsLabel: string;
  /** "tailscale ssh — keyless mode" | "off". */
  sshLabel: string;
  /** The install hint shown on the installed:false path (mock: no binary). */
  installHint: string | null;
  /** The actual install command shown on the installed:false path (coverage B15:
   * "the installed:false path shows … with the install command"). null otherwise. */
  installCmd: string | null;
  /** The install docs URL companion to installCmd. null otherwise. */
  installUrl: string | null;
};

/** Project fed.network state into the tailscale block's view. null (not yet
 * probed) renders the loading state; installed:false renders the install path. */
export function networkView(status: TailscaleNetworkStatus | null): NetworkView {
  if (status === null) {
    return {
      loaded: false, installed: false, statusLabel: "…", statusTone: "muted",
      ip4: null, magicDnsLabel: "…", sshLabel: "…", installHint: null, installCmd: null, installUrl: null,
    };
  }
  if (!status.installed) {
    return {
      loaded: true, installed: false, statusLabel: "not installed", statusTone: "danger",
      ip4: null, magicDnsLabel: "—", sshLabel: "—",
      installHint: "tailscale is not installed on this host — install it to enable federation over the tailnet:",
      installCmd: "curl -fsSL https://tailscale.com/install.sh | sh",
      installUrl: "https://tailscale.com/download",
    };
  }
  return {
    loaded: true,
    installed: true,
    statusLabel: status.loggedIn ? "connected" : "logged out",
    statusTone: status.loggedIn ? "success" : "warn",
    ip4: status.ip4,
    magicDnsLabel: status.magicDNS ? "on" : "off",
    sshLabel: status.tailscaleSSH ? "tailscale ssh — keyless mode" : "off",
    installHint: null, installCmd: null, installUrl: null,
  };
}

// ---------------------------------------------------------------------------
// CLOUDFLARE-APP-SURFACE — the Cloudflare federation block (mirrors networkView
// above; fed.cloudflare / fed.cloudflare.up state). Four distinct, mutually
// exclusive UI states, each with its own label/message (never a blank string
// where a reason belongs): unconfigured, provisioning, probe failed, ready.
// "ready" is gated STRICTLY on selfprobe === "passed" — steps having merely RUN
// is never enough to call it ready (a probe failure must never be shown as ready).
// ---------------------------------------------------------------------------

export type CloudflareUiState = "unconfigured" | "provisioning" | "probeFailed" | "ready";

export type CloudflareView = {
  loaded: boolean;
  state: CloudflareUiState;
  statusLabel: string;
  statusTone: NetworkTone;
  /** non-secret — "my own endpoint" (CloudflareProvisionStatusSchema.hostname),
   * shown once ready. null in every other state. */
  hostname: string | null;
};

/** Project fed.cloudflare state into the settings block's view. null (not yet
 * probed) renders the same "…" loading state networkView uses before its first
 * read lands. */
export function cloudflareView(status: CloudflareProvisionStatus | null): CloudflareView {
  if (status === null) {
    return { loaded: false, state: "unconfigured", statusLabel: "…", statusTone: "muted", hostname: null };
  }
  if (status.selfprobe === "pending") {
    return { loaded: true, state: "provisioning", statusLabel: "provisioning…", statusTone: "warn", hostname: status.hostname };
  }
  if (status.selfprobe === "failed") {
    return {
      loaded: true, state: "probeFailed",
      statusLabel: "probe failed — provisioning ran but verification did not pass",
      statusTone: "danger", hostname: status.hostname,
    };
  }
  if (status.installed && status.provisioned && status.selfprobe === "passed") {
    return { loaded: true, state: "ready", statusLabel: "ready", statusTone: "success", hostname: status.hostname };
  }
  return { loaded: true, state: "unconfigured", statusLabel: "not configured", statusTone: "muted", hostname: null };
}

/** The auth-key row badge. The key is write-only (Keychain only), so we can
 * only reflect whether THIS session stored one — the daemon never reports its
 * presence. false → the mock's neutral "not set". */
export function authKeyBadge(storedThisSession: boolean): { label: string; tone: BadgeTone } {
  return storedThisSession
    ? { label: "▪ set", tone: "success" }
    : { label: "not set", tone: "danger" };
}

// ---------------------------------------------------------------------------
// general — daily cap edit (config.patch {dailyCapUsd}) + engine.id
// ---------------------------------------------------------------------------

export type DailyCapParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** Parse the dailyCap edit field into a config.patch value. Empty / "none" /
 * "-" clears the cap (null → the overlay merge-patch DELETES the key). A
 * positive number sets it. Anything else is a validation error (surfaced inline,
 * nothing is patched). */
export function parseDailyCap(raw: string): DailyCapParse {
  const s = raw.trim().replace(/^\$/, "");
  if (s === "" || s.toLowerCase() === "none" || s === "-") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: "daily cap must be a number (or blank to clear)" };
  if (n <= 0) return { ok: false, error: "daily cap must be greater than 0 (or blank to clear)" };
  return { ok: true, value: n };
}

/** The config.patch params for a dailyCap edit. null deletes the key via the
 * overlay's RFC-7396 null-deletion (composeOverlay keeps the marker). */
export function dailyCapPatch(value: number | null): { dailyCapUsd: number | null } {
  return { dailyCapUsd: value };
}

/** Display form for the current cap ("$5.00" or "none"). */
export function fmtDailyCap(value: number | null | undefined): string {
  return typeof value === "number" ? fmtCost(value) : "none";
}

export type ImportDirParse =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/** ONBOARDING-GATE R1: parse the welcome screen's project-import-dir field.
 * Blank clears back to the daemon default ($CHIMERA_HOME/projects, null in
 * config.patch). A non-blank value must be an absolute path (POSIX "/…" or a
 * Windows drive/UNC form) — a relative path would resolve differently
 * depending on the daemon's own cwd, so it's rejected inline rather than
 * silently patched. */
export function validateImportDir(raw: string): ImportDirParse {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  const absolute = s.startsWith("/") || s.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(s);
  if (!absolute) return { ok: false, error: "project import dir must be an absolute path" };
  return { ok: true, value: s };
}

// ---------------------------------------------------------------------------
// CONCURRENCY-CAP-UI — the typed concurrency control (config.patch caps.*),
// replacing the raw-JSON config_patch escape hatch for this one knob. Three
// pieces: the static ceiling (maxAgentsTotal), the optional resource-aware
// narrowing (dynamicCap), and the optional per-account ceiling (perAccount).
// All three patch under the SAME `caps` object; config.patch is a JSON merge
// patch (RFC 7396) that recurses into nested objects, so a patch of e.g.
// `{caps: {maxAgentsTotal: N}}` merges onto the existing caps object and
// leaves perAccount/dynamicCap untouched (only top-level ARRAYS replace
// wholesale — perAccount/dynamicCap are plain objects, not arrays).
// ---------------------------------------------------------------------------

export type MaxAgentsTotalParse = { ok: true; value: number } | { ok: false; error: string };

/** Parse the concurrency ceiling edit field — mirrors caps.maxAgentsTotal's
 * schema constraint (protocol ChimeraConfigSchema: `z.number().int().positive()`)
 * exactly, so an out-of-range value is rejected client-side and NEVER reaches
 * config.patch (acceptance: a malformed input must never emit a patch). */
export function parseMaxAgentsTotal(raw: string): MaxAgentsTotalParse {
  const s = raw.trim();
  if (s === "") return { ok: false, error: "concurrency ceiling is required" };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "concurrency ceiling must be a whole number" };
  if (n <= 0) return { ok: false, error: "concurrency ceiling must be greater than 0" };
  return { ok: true, value: n };
}

/** The config.patch params for a ceiling edit. */
export function maxAgentsTotalPatch(value: number): { caps: { maxAgentsTotal: number } } {
  return { caps: { maxAgentsTotal: value } };
}

// The one-line statement the operator explicitly had to ask for (task brief,
// verbatim complaint: "when I lower it, what happens to open agents?"). Mirrors
// supervisor.ts's own admission-check comment ("a refusal here only prevents
// THIS spawn from being added to that set") in plain language. Exported so the
// rendered copy and its test both read from one source of truth — a later
// refactor can't silently drop the wording without the string changing here too.
export const LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS =
  "Lowering this cap never stops or pauses agents already running — it only refuses new spawns until the fleet drops below the new value.";

/** Live concurrency view — daemon.status's agentCap snapshot (effectiveCap) folded
 * with the static config for the three acceptance-tested render states:
 *   dynamic off              → narrowing=false, cap===ceiling===maxAgentsTotal.
 *   dynamic on, not narrowing → dynamicEnabled=true, narrowing=false, cap===ceiling.
 *   dynamic on, narrowing     → dynamicEnabled=true, narrowing=true, cap<ceiling.
 * `agentCap` is null only before the first daemon.status read has landed. */
export type ConcurrencyCapView = {
  agentsRunning: number;
  dynamicEnabled: boolean;
  narrowing: boolean;
  cap: number;
  ceiling: number;
  healthy: boolean;
  /** live probe inputs ("load 11.4/12 cores, 3.2 GB free") — only meaningful
   * (non-null) while dynamicEnabled, so the off state never renders it. */
  explain: string | null;
};

export function concurrencyCapView(
  maxAgentsTotal: number,
  dynamicCap: DynamicCapConfig | null,
  agentCap: AgentCapStatus | null,
  agentsRunning: number,
): ConcurrencyCapView {
  const dynamicEnabled = dynamicCap?.enabled === true;
  const cap = agentCap?.cap ?? maxAgentsTotal;
  const ceiling = agentCap?.ceiling ?? maxAgentsTotal;
  return {
    agentsRunning,
    dynamicEnabled,
    narrowing: dynamicEnabled && cap < ceiling,
    cap,
    ceiling,
    healthy: agentCap?.healthy ?? true,
    explain: dynamicEnabled ? (agentCap?.explain ?? null) : null,
  };
}

// F49.2: read-only mcp-listener block for NetworkSection (plan §2.9). Never
// carries a grant's token — McpListenerStatus itself has no token field.
export type McpListenerGrantRow = { agentId: string; provider: string; sinceLabel: string };

export type McpListenerView = {
  headline: string;
  rows: readonly McpListenerGrantRow[];
  footnote: string;
};

export function mcpListenerView(status: McpListenerStatus | null, loaded = true): McpListenerView {
  const footnote = MCP_LISTENER_FOOTNOTE;
  // F49.UI: `null` means BOTH "the first daemon.status has not landed yet" and "this daemon
  // predates the field"; the loaded flag separates them, so the pre-load moment never reads
  // as an older-daemon verdict.
  if (!loaded) {
    return { headline: "local MCP listener: loading…", rows: [], footnote };
  }
  if (status === null) {
    return { headline: "local MCP listener: —", rows: [], footnote };
  }
  if (!status.enabled) {
    return {
      headline:
        "local MCP listener: off — kimi agents cannot reach chimera tools (set mcpListener.enabled in config, then restart the daemon)",
      rows: [],
      footnote,
    };
  }
  if (!status.listening) {
    return { headline: "local MCP listener: on · idle — binds only while an agent holds a grant", rows: [], footnote };
  }
  const rows = status.grants.map((g) => ({
    agentId: g.agentId,
    provider: g.provider,
    sinceLabel: fmtClock(g.since),
  }));
  return {
    headline: `local MCP listener: on · ${status.address} · ${status.grants.length} agent(s) connected`,
    rows,
    footnote,
  };
}

// ---------------------------------------------------------------------------
// dynamic cap form (caps.dynamicCap — DynamicCapConfigSchema). Text-field
// drafts for every real schema field (no invented knobs), validated through
// the ACTUAL zod schema (DynamicCapConfigSchema.safeParse) rather than a
// hand-rolled range check duplicated from it — a schema constraint change can
// never silently drift out of sync with this form's validation.
// ---------------------------------------------------------------------------

export type DynamicCapDraft = {
  enabled: boolean;
  floor: string;
  cpuHighWatermark: string;
  cpuLowWatermark: string;
  cpuCriticalRatio: string;
  memLowWatermarkGb: string;
  memHighWatermarkGb: string;
  memCriticalGb: string;
  emaAlpha: string;
};

/** DynamicCapConfigSchema's own defaults ({} parses to every `.default(...)`)
 * — the pre-fill shown when the operator opens the form on an untouched config
 * (caps.dynamicCap absent). Reading the defaults off the schema itself (rather
 * than duplicating the numbers here) means this can never drift from
 * protocol/src/index.ts's DynamicCapConfigSchema. */
const DYNAMIC_CAP_DEFAULTS: DynamicCapConfig = DynamicCapConfigSchema.parse({});

export function dynamicCapDraft(cfg: DynamicCapConfig | null): DynamicCapDraft {
  const d = cfg ?? DYNAMIC_CAP_DEFAULTS;
  return {
    enabled: d.enabled,
    floor: String(d.floor),
    cpuHighWatermark: String(d.cpuHighWatermark),
    cpuLowWatermark: String(d.cpuLowWatermark),
    cpuCriticalRatio: String(d.cpuCriticalRatio),
    memLowWatermarkGb: String(d.memLowWatermarkGb),
    memHighWatermarkGb: String(d.memHighWatermarkGb),
    memCriticalGb: String(d.memCriticalGb),
    emaAlpha: String(d.emaAlpha),
  };
}

export type DynamicCapParse = { ok: true; value: DynamicCapConfig } | { ok: false; error: string };

const DYNAMIC_CAP_NUMERIC_FIELDS = [
  "floor", "cpuHighWatermark", "cpuLowWatermark", "cpuCriticalRatio",
  "memLowWatermarkGb", "memHighWatermarkGb", "memCriticalGb", "emaAlpha",
] as const;

/** Parse the dynamic-cap form into a config.patch-ready value, validated
 * against DynamicCapConfigSchema's real constraints (positive floor, 0-1
 * emaAlpha, nonnegative mem watermarks, ...). A non-numeric field or an
 * out-of-range value is rejected inline; nothing is patched. */
export function parseDynamicCapDraft(draft: DynamicCapDraft): DynamicCapParse {
  const nums: Record<string, number> = {};
  for (const key of DYNAMIC_CAP_NUMERIC_FIELDS) {
    const n = Number(draft[key].trim());
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
    nums[key] = n;
  }
  const parsed = DynamicCapConfigSchema.safeParse({ enabled: draft.enabled, ...nums });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "dynamic cap"}: ${issue.message}` : "invalid dynamic cap config" };
  }
  return { ok: true, value: parsed.data };
}

/** The config.patch params for a dynamic-cap edit. `null` clears the whole
 * block back to absent (RFC-7396 null-deletion) — used by a "reset" action;
 * the form's own save always sends a full DynamicCapConfig object instead. */
export function dynamicCapPatch(value: DynamicCapConfig | null): { caps: { dynamicCap: DynamicCapConfig | null } } {
  return { caps: { dynamicCap: value } };
}

// ---------------------------------------------------------------------------
// per-account caps (caps.perAccount — Record<accountName, positiveInt>).
// Empty by default: every configured account shares the one ceiling above.
// Editable one account at a time; config.patch merges into the existing
// perAccount object (see the header note), so a single-key patch never
// clobbers another account's entry.
// ---------------------------------------------------------------------------

export type PerAccountCapParse = { ok: true; value: number | null } | { ok: false; error: string };

/** Blank clears this account's entry (RFC-7396 null-deletion — falls back to
 * the shared ceiling); a positive integer sets it. Same constraint as
 * maxAgentsTotal (caps.perAccount's value schema is the same `z.number().int().positive()`). */
export function parsePerAccountCap(raw: string): PerAccountCapParse {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "per-account cap must be a whole number (or blank to clear)" };
  if (n <= 0) return { ok: false, error: "per-account cap must be greater than 0 (or blank to clear)" };
  return { ok: true, value: n };
}

export function perAccountCapPatch(name: string, value: number | null): { caps: { perAccount: Record<string, number | null> } } {
  return { caps: { perAccount: { [name]: value } } };
}

// ---------------------------------------------------------------------------
// MCP store add-form field parsing (mcpstore.add's args/env are non-scalar —
// the form takes them as plain text, same "friendly text in, structured RPC
// params out" job parseDailyCap does above).
// ---------------------------------------------------------------------------

/** "a, b c" → ["a", "b", "c"] — comma AND whitespace both split (whichever the
 * user reaches for); blank segments are dropped so trailing separators are inert. */
export function parseArgsInput(raw: string): string[] {
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export type EnvParse = { ok: true; value: Record<string, string> } | { ok: false; error: string };

/** "KEY=value, OTHER=v2" → {KEY:"value", OTHER:"v2"}. A segment with no "="
 * (and no content) is a validation error — surfaced inline, nothing is submitted. */
export function parseEnvInput(raw: string): EnvParse {
  const value: Record<string, string> = {};
  for (const segment of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const eq = segment.indexOf("=");
    if (eq <= 0) return { ok: false, error: `env entry "${segment}" must be KEY=value` };
    value[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// MCP-STORE-TOOLS-UI: per-server tool list state, fetched lazily on row expand
// (mcpstore.tools({query: serverName})) rather than eagerly for every installed
// server on section load — a slow/erroring server shouldn't stall the others.
// ---------------------------------------------------------------------------

export type McpToolsStatus = "idle" | "loading" | "loaded";

export type McpToolsRow = {
  status: McpToolsStatus;
  connected: boolean;
  /** the server's own connect error (e.g. telegram's "Connection closed"), verbatim. */
  error?: string;
  tools: readonly McpStoreToolInfo[];
};

export const MCP_TOOLS_IDLE: McpToolsRow = { status: "idle", connected: false, tools: [] };

/** `state.mcpTools[name]` defaults to "not fetched yet" for a row never expanded. */
export function mcpToolsRow(map: Readonly<Record<string, McpToolsRow>>, name: string): McpToolsRow {
  return map[name] ?? MCP_TOOLS_IDLE;
}

/** Collapsed-row badge — cheap "N tools" hint once a row has been expanded at
 * least once; null (render nothing) before that or while loading. */
export function mcpToolsBadge(row: McpToolsRow): string | null {
  if (row.status !== "loaded") return null;
  return row.connected ? `${row.tools.length} tools` : "error";
}

/** Expanded-panel status line: "● connected · 28 tools" or "✗ <error>",
 * verbatim so the user sees WHY a server (e.g. telegram) has no tools. */
export function mcpToolsStatusLine(row: McpToolsRow): string {
  if (row.status === "loading") return "connecting…";
  if (row.status !== "loaded") return "";
  return row.connected ? `● connected · ${row.tools.length} tools` : `✗ ${row.error ?? "connection failed"}`;
}

/** Single-line, length-capped tool description for the expanded list. */
export function truncateToolDescription(desc: string, max = 100): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// MCPSTORE-LIFECYCLE-UI: the installed-row auth control's view model. The old logic gated
// the Authorize button's very existence on the best-effort mcpstore.detectAuth probe
// succeeding (state.mcpDetectedOAuth) — a probe failure (or an endpoint the probe doesn't
// recognize, e.g. the user's own gateway) meant NO recovery path ever rendered. This helper
// instead shows the control unconditionally for every http row: `showAuthorize` no longer
// depends on the probe at all, only on `type === "http"`. The probe stays as a HINT only
// (the "oauth detected" chip in SettingsScreen — rendered separately, not derived here).
// ---------------------------------------------------------------------------

export type McpStoreAuthRowView = {
  /** unconditional for every http row — no dependence on the detect probe (acceptance
   * criterion 1: discoverability beats cleverness). Always false for a stdio row (no
   * remote auth concept). */
  showAuthorize: boolean;
  /** "Re-authorize" once a connection is confirmed (oauth status OR a loaded+connected
   * tools row) — the OLD behavior hid the button entirely once connected, which meant an
   * expired/revoked/rotated grant had no recovery path (acceptance criterion 3). */
  authorizeLabel: "Authorize" | "Re-authorize";
  connected: boolean;
  busy: boolean;
  /** true when the row's authKind isn't "oauth" yet — mcpstore.oauth.start requires an
   * oauth-kind entry server-side, so the click handler must convert first
   * (mcpstore.setAuthKind) regardless of whether the detect probe ever ran. */
  needsConvert: boolean;
  /** the oauth flow's own error, surfaced for ANY authKind — a bearer/no-auth entry can
   * fail "not configured for oauth" (McpStoreOAuthNotConfiguredError) just as an
   * already-oauth entry can fail mid-flow (acceptance criterion 4). Null when no error. */
  errorMessage: string | null;
};

export function mcpStoreAuthRowView(input: {
  type: "stdio" | "http";
  authKind?: "bearer" | "oauth";
  oauth?: { status: string; error?: string };
  toolsConnected: boolean;
  toolsStatus: McpToolsStatus;
  /** MCP-AUTH-STATUS: the at-rest verdict from mcpstore.authStatus. Both other signals are
   * LIVE-only — a flow that ran this session, or a tools fetch triggered by expanding the row —
   * so before this input a server authorized last week read as not-connected until you poked
   * it, and the button said "Authorize" when it meant "Re-authorize". */
  authState?: McpStoreAuthState;
}): McpStoreAuthRowView {
  const connected = input.oauth?.status === "connected"
    || (input.toolsStatus === "loaded" && input.toolsConnected)
    || input.authState === "authorized";
  const busy = input.oauth?.status === "starting" || input.oauth?.status === "awaiting" || input.oauth?.status === "polling";
  return {
    showAuthorize: input.type === "http",
    authorizeLabel: connected ? "Re-authorize" : "Authorize",
    connected,
    busy,
    needsConvert: input.authKind !== "oauth",
    errorMessage: input.oauth?.status === "error" ? (input.oauth.error ?? "authorize failed") : null,
  };
}

// ---------------------------------------------------------------------------
// MCP-AUTH-STATUS: the per-row auth chip. Pure derivation off one mcpstore.authStatus row so
// the wording/tone live next to the tests rather than inside JSX.
// ---------------------------------------------------------------------------

export type McpAuthChipView = {
  /** null when there is nothing worth saying — an unauthenticated stdio server should not
   * carry a chip explaining that it has no authorization. */
  label: string | null;
  tone: "ok" | "warn" | "faint";
  title: string;
};

/** Relative age of the stored grant, for the chip's tooltip. Coarse on purpose: the exact
 * minute a token was refreshed is noise, "3 days ago" is the part that informs a decision. */
function relativeAge(from: number, now: number): string {
  const secs = Math.max(0, Math.round((now - from) / 1000));
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function mcpAuthChipView(
  status: { state: McpStoreAuthState; detail?: string; authorizedAt?: number } | undefined,
  now: number = Date.now(),
): McpAuthChipView {
  if (!status || status.state === "none") return { label: null, tone: "faint", title: "" };
  const age = status.authorizedAt !== undefined ? ` (${relativeAge(status.authorizedAt, now)})` : "";
  const title = status.detail ?? "";
  switch (status.state) {
    case "authorized":
      return { label: `authorized${age}`, tone: "ok", title };
    case "needs-reauth":
      // The one state that asks for action, so it is the one state that gets the loud tone.
      return { label: "needs re-auth", tone: "warn", title };
    case "never":
      return { label: "not authorized", tone: "faint", title };
    case "bearer":
      return { label: "token", tone: "faint", title };
  }
}

/** `entry.enabled` is additive/optional client-side (an older cached row, or a test
 * fixture, may omit it) — absence means enabled, mirroring the protocol schema's own
 * `.default(true)`. Never a false negative: only an explicit `false` reads as disabled. */
export function mcpStoreIsEnabled(entry: { enabled?: boolean }): boolean {
  return entry.enabled !== false;
}

// ---------------------------------------------------------------------------
// MCP-REMOTE-IMPORT slice 3: importable-row view model. Before this slice EVERY
// http (remote) importable rendered disabled — the old check was bare
// `!imp.command`, which a remote row (no `command`, only `url`) can never
// satisfy. A claude.ai-managed row keeps `notImportableReason` (its auth lives
// in the claude.ai session, not on this machine — mcpstore.import always
// rejects it) but still carries a real url/headers, so the UI offers a
// separate "bring your own token" add path instead of the blocked import.
// ---------------------------------------------------------------------------

export type McpImportableRowView = {
  isRemote: boolean;
  claudeAiManaged: boolean;
  alreadyInstalled: boolean;
  /** true when a successful import should be followed by mcpstore.setAuth. */
  needsAuth: boolean;
  /** the plain "import" action is unavailable (already installed, generic
   * not-importable, or missing its source field) — claude.ai-managed rows are
   * NOT folded in here; they get their own always-available token-entry row. */
  disabled: boolean;
  /** the name this row would occupy in the store (sanitized). Shown when it
   * differs from the source name, so an operator is not surprised by the rename. */
  storeName: string;
  /** what this row actually is, for a transport chip: http vs stdio. */
  transport: "http" | "stdio";
  /** the one detail worth showing next to the name — a url for http, the
   * command (with args) for stdio. Never both; the old table rendered a
   * command column and an args column, which an http row left empty. */
  detail: string;
};

export function mcpImportableRowView(imp: McpStoreImportable, servers: readonly { name: string }[]): McpImportableRowView {
  const isRemote = imp.type === "http";
  const claudeAiManaged = isRemote && imp.notImportableReason !== undefined;
  // Compare against the name the import would ACTUALLY create, not the raw one. mcpstore.import
  // sanitizes (`Mintlify` -> `mintlify`, `openaiDeveloperDocs` -> `openaideveloperdocs`), so a
  // raw-name check said "not installed" for a server that was already in the store — the row
  // stayed enabled and re-importing it just silently overwrote the entry.
  const storeName = sanitizeMcpStoreImportName(imp.name);
  const alreadyInstalled = servers.some((s) => s.name === storeName);
  const needsAuth = isRemote && imp.requiresAuth === true;
  const missingSource = isRemote ? !imp.url : !imp.command;
  const genericNotImportable = !claudeAiManaged && imp.notImportableReason !== undefined;
  const detail = isRemote
    ? (imp.url ?? "—")
    : [imp.command, ...(imp.args ?? [])].filter(Boolean).join(" ") || "—";
  return {
    isRemote, claudeAiManaged, alreadyInstalled, needsAuth,
    disabled: alreadyInstalled || genericNotImportable || missingSource,
    storeName, transport: isRemote ? "http" : "stdio", detail,
  };
}

/** Mirrors core's mcp-imports.ts `sanitizeMcpStoreName` — the "bring your own
 * token" add path builds the store entry name client-side (mcpstore.add, unlike
 * mcpstore.import, does not sanitize its `name` for the caller), so this must
 * stay byte-for-byte in sync with the server-side importable-name shape. */
export function sanitizeMcpStoreImportName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "imported-server";
}

/** The keychain service name an mcp store entry's `auth.keychainRef` points at.
 * NOTE: the daemon (mcpstore.ts resolveAuthSecret) always derives this same
 * string from the server NAME at connect time — the field's actual content is
 * never read back, only its presence gates the auth-injection branch — but a
 * real, matching value keeps the entry self-documenting instead of an opaque
 * placeholder. */
export function mcpAuthKeychainRef(name: string): string {
  return `chimera:mcp:${name}`;
}

// ---------------------------------------------------------------------------
// MCP-OAUTH slice 3: scope selection for an oauth-kind add-remote server. The checkbox catalog is
// an operator-configured gateway's per-downstream scope list (config `mcpOAuthGateways`) — it is
// NOT a generic OAuth scope set, and offering it for a foreign server is what sent Cloudflare
// seven scopes it had never heard of.
//
// MCP-OAUTH-FOREIGN-SCOPES: discovery DOES exist now (mcpstore-oauth-detect.ts reads
// scopes_supported off RFC 8414/9728 metadata; core resolves through protocol's
// resolveDefaultOAuthScopes). So the form shows a catalog ONLY when the url being added is on a
// configured gateway's host — for anything else the operator gets the free-text field, and the
// server's advertised scopes or none at all, rather than a wrong list pre-checked for them. A
// gateway's optionalScopes (e.g. production access) are shown but stay opt-in.
// ---------------------------------------------------------------------------

/** The checkbox catalog for `url`: the matched gateway's defaultScopes then its optionalScopes,
 * deduped, in config order. Empty when no configured gateway matches (or before a url is typed). */
export function mcpOAuthScopeCatalog(url: string | undefined, gateways: readonly McpOAuthGateway[] | undefined): string[] {
  const gateway = url === undefined ? undefined : findMcpOAuthGateway(url, gateways);
  if (!gateway) return [];
  return Array.from(new Set([...gateway.defaultScopes, ...(gateway.optionalScopes ?? [])]));
}

/** Initial checkbox state for mcpOAuthScopeCatalog's list: defaultScopes checked, optionalScopes
 * unchecked. Empty for a url on no configured gateway, and before anything is typed, for the same
 * reason the catalog is: a pre-checked wrong list is worse than an empty one the operator fills
 * in deliberately. */
export function defaultMcpOAuthScopeSelection(url?: string, gateways?: readonly McpOAuthGateway[]): Record<string, boolean> {
  const gateway = url === undefined ? undefined : findMcpOAuthGateway(url, gateways);
  const defaults = new Set(gateway?.defaultScopes ?? []);
  const sel: Record<string, boolean> = {};
  for (const scope of mcpOAuthScopeCatalog(url, gateways)) sel[scope] = defaults.has(scope);
  return sel;
}

/** Folds the checkbox selection (in `catalog` order — only scopes still on screen count) + a
 * free-text comma list into the final `auth.scopes` array — deduped, blank entries dropped. */
export function resolveMcpOAuthScopes(selection: Readonly<Record<string, boolean>>, extraRaw: string, catalog: readonly string[]): string[] {
  const picked = catalog.filter((scope) => selection[scope]);
  const extra = extraRaw.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([...picked, ...extra]));
}

export type ExtractedAuthHeader = { headers: Record<string, string>; secret: string | null; scheme?: string };

/** MCP-REMOTE-IMPORT slice 3 (security fix): the add-remote form's headers field
 * used to persist an "Authorization" entry straight into mcpstore.json in
 * PLAINTEXT (DESIGN-REMOTE-MCP.md). Split that one well-known header out so the
 * caller can route it through mcpstore.setAuth (Keychain) instead — every OTHER
 * header still passes through unchanged, since there's no reliable way to know a
 * custom header name carries a secret. "Bearer <token>" splits into
 * scheme=Bearer (the connect-time default, so omitted)/secret=token; any other
 * "<scheme> <token>" keeps its scheme; a bare value (no space) is taken whole. */
export function extractAuthHeader(headers: Readonly<Record<string, string>>): ExtractedAuthHeader {
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  if (!authKey) return { headers: { ...headers }, secret: null };
  const { [authKey]: raw, ...rest } = headers;
  const trimmed = (raw ?? "").trim();
  const m = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!m) return { headers: rest, secret: trimmed || null };
  return m[1]!.toLowerCase() === "bearer" ? { headers: rest, secret: m[2]! } : { headers: rest, secret: m[2]!, scheme: m[1] };
}

// ---------------------------------------------------------------------------
// self-refresh mapping (F09: "the UI refreshes itself on config_changed — no
// refresh button"). Maps a daemon event kind to the settings sections whose
// read data must be refetched. config_error is NOT here — it is a toast, not a
// refresh (handled by the screen's error channel).
// ---------------------------------------------------------------------------

export type SettingsRefresh = "providers" | "network" | "general" | "cloudflare";

export function sectionsForEvent(kind: string): readonly SettingsRefresh[] {
  switch (kind) {
    // accounts + failover order + dailyCap all live in the config, so a config
    // change refreshes both the providers table and the general section.
    case "config_changed":
      return ["providers", "general"];
    // a network probe change (fed.network / up / auto-join) → the tailscale block.
    case "network_changed":
      return ["network", "cloudflare"];
    // a new peer pinned into the overlay → the (W10) peers list lives in network.
    case "peer_paired":
      return ["network"];
    default:
      return [];
  }
}
