// W9 (F09 · coverage B15/B16) — Settings command layer + the screen's own local
// store. Same shape discipline as commands.host.ts / commands.system.ts: a PURE
// factory over injected deps (store + request) with NO ../rpc/bridge import, so
// every transition is unit-testable against a stub request; the screen binds the
// singleton with appStore + rpcCall via getSettingsCommands. RPC failures surface
// through the existing commandError action (the Toast's danger channel), never a
// crash.
//
// SECRET DISCIPLINE (F09): API keys and tailscale auth keys are WRITE-ONLY. They
// are handed to addProvider/setAuthKey as bare arguments, forwarded to the RPC,
// and NEVER retained — this store holds no key field, no selector reads one back,
// and config.get is redacted daemon-side. The component clears its local draft on
// submit; nothing here can echo a secret.
import type { UiStore, AgentCapStatus } from "@chimera/ui-state";
import type { McpPackageReview, McpPackageInstall } from "@chimera/protocol";
import type { DynamicCapConfig, TailscaleNetworkStatus, CloudflareProvisionStatus, McpListenerStatus, McpOAuthGateway, McpStoreAuthStatus, McpStoreEntry, McpStoreImportable, McpStoreServerSpec, McpStoreToolInfo } from "@chimera/protocol";
import {
  type AccountListItem,
  type McpToolsRow,
  type ProbeResult,
  type ProviderCatalogItem,
  type SettingsRefresh,
  type SettingsSection,
  mcpAuthKeychainRef,
  maxAgentsTotalPatch,
  dynamicCapPatch,
  perAccountCapPatch,
  providerOverridePatch,
  reorderAutoOrder,
  sanitizeMcpStoreImportName,
  sectionsForEvent,
} from "./selectors.settings";

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type SettingsState = {
  section: SettingsSection;
  // providers & accounts (accounts.list + config.get)
  accounts: readonly AccountListItem[];
  autoOrder: readonly string[];
  preferredProvider?: string;
  /** F23-2B: the full catalog + connection state (providers.list), for the
   * Providers section's catalog cards (capability chips / tosNote / actions). */
  providers: readonly ProviderCatalogItem[];
  /** latest accounts.test result per account (the `t` ping), for the badge. */
  tests: Readonly<Record<string, ProbeResult>>;
  // API-KEY-INVALID: the daemon's key-redacted probe message per account (accounts.test's
  // `detail`), shown on the row in place of a generic "auth rejected". Parallel to `tests`.
  testDetails: Readonly<Record<string, string>>;
  // general (daemon.status engineId + config.get dailyCapUsd / projectImportDir)
  engineId: string | null;
  dailyCapUsd: number | null;
  /** IMPORT-DIR: config.projectImportDir — the base dir project.import clones
   * git sources under. null = unset (daemon falls back to $CHIMERA_HOME/projects). */
  projectImportDir: string | null;
  // CONCURRENCY-CAP-UI: caps.maxAgentsTotal (config.get) — the static ceiling.
  // Seeded to the schema default (12) so a pre-load render shows a real number,
  // not 0/undefined; loadGeneral overwrites it with the actual config value.
  maxAgentsTotal: number;
  /** caps.perAccount (config.get) — empty for an untouched config (every account
   * shares maxAgentsTotal). */
  perAccount: Readonly<Record<string, number>>;
  /** caps.dynamicCap (config.get) — null when absent (feature never touched by
   * this config), never a fabricated default object (the form pre-fills its OWN
   * defaults from the schema — see selectors.settings.ts's dynamicCapDraft). */
  dynamicCap: DynamicCapConfig | null;
  /** daemon.status's live agentCap snapshot (DynamicCapTracker.effectiveCap) —
   * null before the first read lands. */
  agentCap: AgentCapStatus | null;
  /** daemon.status's agents.running count — "agents running now" in the concurrency card. */
  agentsRunning: number;
  /** F49.2: daemon.status's read-only mcp-listener passthrough — null before the first
   * read lands, or when the daemon predates the field. Never carries a grant's token. */
  mcpListener: McpListenerStatus | null;
  // network & federation (fed.network / fed.network.up)
  network: TailscaleNetworkStatus | null;
  /** fed.network.up's interactive-login URL for the user to open (null = none). */
  authUrl: string | null;
  /** did THIS session store a tailscale auth key (write-only — the daemon never
   * reports presence). Drives the auth-key row badge only. */
  authKeyStored: boolean;
  // CLOUDFLARE-APP-SURFACE (fed.cloudflare / fed.cloudflare.up): mirrors `network`
  // above. `cloudflare` is ALWAYS built by explicit field-picking (pickCloudflareStatus)
  // from the raw RPC response, never a spread — the apiToken sent to fed.cloudflare.up
  // (and any Access service-token secret the daemon might ever surface) must never land
  // in this shared/subscribable store (SECRET DISCIPLINE, same invariant as core/cloudflare.ts).
  cloudflare: CloudflareProvisionStatus | null;
  // MCP-STORE (mcpstore.list/add/remove/importables/import): installed servers +
  // the local claude/codex scan's importable rows (some carry notImportableReason
  // instead of a command — see McpStoreImportable).
  mcpServers: readonly McpStoreEntry[];
  mcpImportables: readonly McpStoreImportable[];
  /** MCP-STORE-TOOLS-UI: per-server tool list, keyed by server name — populated
   * lazily by loadMcpServerTools() on row expand, NOT for every server up front. */
  mcpTools: Readonly<Record<string, McpToolsRow>>;
  /** per-row import failure (e.g. a rescan mismatch — the entry vanished from the
   * latest scan — or a race where it became installed/not-importable meanwhile),
   * keyed by `${source}:${name}`. Shown INLINE on the row in addition to the
   * global commandError toast; cleared on the next attempt for that row. */
  mcpImportErrors: Readonly<Record<string, string>>;
  /** MCP-OAUTH slice 3: per-server Authorize flow state, keyed by store server
   * name. `pendingId`/`authorizeUrl` are the bare mcpstore.oauth.start response —
   * NEVER a token; the daemon/keychain hold the actual credential and this state
   * is never more than an id + a url the UI already showed the user. */
  mcpOAuth: Readonly<Record<string, McpOAuthState>>;
  /** KIMI-CODE-SUBSCRIPTION-UI: the provider catalog card's unified "connect with
   * subscription" button, oauth branch (copilot/grok-build/any future oauth-mode
   * openai-compat provider) — accounts.oauth_start/oauth_finish poll state, keyed by
   * provider id. Never more than the bare start response + status; the daemon/keychain
   * hold the actual token. */
  providerOAuth: Readonly<Record<string, ProviderOAuthState>>;
  /** MCP-OAUTH-DISCOVERABILITY: per-installed-server detect-probe result (mcpstore.detectAuth
   * by name), keyed by server name — populated best-effort by loadMcpStore for every remote
   * entry whose auth isn't already oauth-kind. Drives the Authorize button's "bearer entry the
   * probe shows is really OAuth" case (McpStoreSection) — absent means not yet probed (or the
   * probe failed), never a false negative. */
  mcpDetectedOAuth: Readonly<Record<string, boolean>>;
  /** MCP-AUTH-STATUS: per-installed-server authorization state (mcpstore.authStatus), keyed by
   * server name. Unlike mcpTools/mcpDetectedOAuth this is fetched EAGERLY with the server list
   * — it is one RPC for the whole store and makes no network calls of its own, so the chips are
   * truthful the moment the page opens instead of only after a row is expanded. */
  mcpAuthStatus: Readonly<Record<string, McpStoreAuthStatus>>;
  /** MCP-OAUTH-GATEWAYS: config.get's `mcpOAuthGateways` — the add-remote form's scope catalog
   * source (see selectors.settings.ts's mcpOAuthScopeCatalog). Empty when none are configured. */
  mcpOAuthGateways: readonly McpOAuthGateway[];
  loaded: { providers: boolean; network: boolean; general: boolean; mcpStore: boolean; cloudflare: boolean };
};

export type McpOAuthStatus = "starting" | "awaiting" | "polling" | "connected" | "error";
export type McpOAuthState = { status: McpOAuthStatus; pendingId?: string; authorizeUrl?: string; error?: string };

export type ProviderOAuthStatus = "starting" | "awaiting" | "polling" | "connected" | "error";
export type ProviderOAuthState = {
  status: ProviderOAuthStatus; pendingId?: string;
  authorizeUrl?: string; userCode?: string; verificationUri?: string; error?: string;
};

const initial: SettingsState = {
  section: "providers",
  accounts: [],
  autoOrder: [],
  providers: [],
  tests: {},
  testDetails: {},
  engineId: null,
  dailyCapUsd: null,
  projectImportDir: null,
  maxAgentsTotal: 12,
  perAccount: {},
  dynamicCap: null,
  agentCap: null,
  agentsRunning: 0,
  mcpListener: null,
  network: null,
  authUrl: null,
  authKeyStored: false,
  cloudflare: null,
  mcpServers: [],
  mcpImportables: [],
  mcpTools: {},
  mcpImportErrors: {},
  mcpOAuth: {},
  providerOAuth: {},
  mcpDetectedOAuth: {},
  mcpAuthStatus: {},
  mcpOAuthGateways: [],
  loaded: { providers: false, network: false, general: false, mcpStore: false, cloudflare: false },
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// config.get returns the REDACTED effective ChimeraConfig — the only fields the
// settings screen reads off it (all non-secret: autoOrder is account names,
// dailyCapUsd is a number, caps is the concurrency-admission block).
type RedactedConfig = {
  preferredProvider?: unknown;
  autoOrder?: unknown; dailyCapUsd?: unknown; projectImportDir?: unknown;
  caps?: { maxAgentsTotal?: unknown; perAccount?: unknown; dynamicCap?: unknown };
  mcpOAuthGateways?: unknown;
};

export type SettingsCommands = ReturnType<typeof createSettingsCommands>;

export function createSettingsCommands(store: UiStore, request: RequestFn) {
  let state: SettingsState = initial;
  const listeners = new Set<() => void>();
  // MCP-OAUTH slice 3: one poll interval per store server name, module-instance-scoped
  // (never persisted/serialized — a raw interval handle has no business in SettingsState).
  const mcpOAuthTimers: Record<string, ReturnType<typeof setInterval>> = {};
  // KIMI-CODE-SUBSCRIPTION-UI: same module-instance-scoped timer map, keyed by provider id.
  const providerOAuthTimers: Record<string, ReturnType<typeof setInterval>> = {};
  const set = (patch: Partial<SettingsState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };

  const fail = (err: unknown): void => {
    store.dispatch({ type: "commandError", message: errMessage(err) });
  };

  // ---- reads --------------------------------------------------------------

  const loadProviders = async (): Promise<void> => {
    try {
      const [accounts, cfg, providers] = await Promise.all([
        request<AccountListItem[]>("accounts.list", {}),
        request<RedactedConfig>("config.get", {}),
        request<ProviderCatalogItem[]>("providers.list", {}),
      ]);
      set({
        accounts: Array.isArray(accounts) ? accounts : [],
        autoOrder: Array.isArray(cfg?.autoOrder) ? (cfg.autoOrder as string[]) : [],
        preferredProvider: typeof cfg?.preferredProvider === "string" ? cfg.preferredProvider : undefined,
        providers: Array.isArray(providers) ? providers : [],
        loaded: { ...state.loaded, providers: true },
      });
    } catch (err) {
      fail(err); // keep the previous rows
    }
  };

  const loadGeneral = async (): Promise<void> => {
    try {
      const [status, cfg] = await Promise.all([
        request<{ engineId?: string; dailyCapUsd?: number | null; agents?: { running?: number }; agentCap?: AgentCapStatus; mcpListener?: McpListenerStatus }>("daemon.status", {}),
        request<RedactedConfig>("config.get", {}),
      ]);
      const cap = typeof cfg?.dailyCapUsd === "number" ? cfg.dailyCapUsd : null;
      const importDir = typeof cfg?.projectImportDir === "string" ? cfg.projectImportDir : null;
      const caps = cfg?.caps;
      const perAccount = caps?.perAccount && typeof caps.perAccount === "object" && !Array.isArray(caps.perAccount)
        ? (caps.perAccount as Record<string, number>)
        : {};
      set({
        engineId: typeof status?.engineId === "string" ? status.engineId : state.engineId,
        dailyCapUsd: cap,
        projectImportDir: importDir,
        maxAgentsTotal: typeof caps?.maxAgentsTotal === "number" ? caps.maxAgentsTotal : state.maxAgentsTotal,
        perAccount,
        // CONCURRENCY-CAP-UI: caps.dynamicCap is server-validated already
        // (ChimeraConfigSchema via DynamicCapConfigSchema) — trusting the shape
        // here mirrors the existing config.hooks read discipline (commands.hooks.ts).
        dynamicCap: (caps?.dynamicCap as DynamicCapConfig | undefined) ?? null,
        agentCap: status?.agentCap ?? null,
        agentsRunning: typeof status?.agents?.running === "number" ? status.agents.running : 0,
        mcpListener: status?.mcpListener ?? null,
        loaded: { ...state.loaded, general: true },
      });
    } catch (err) {
      fail(err);
    }
  };

  const loadNetwork = async (): Promise<void> => {
    try {
      const network = await request<TailscaleNetworkStatus>("fed.network", {});
      set({ network, loaded: { ...state.loaded, network: true } });
    } catch (err) {
      fail(err);
    }
  };

  // CLOUDFLARE-APP-SURFACE: explicit field-by-field pick of the CloudflareProvisionStatus
  // shape off an arbitrary raw response — NEVER a spread. This is the guard that keeps a
  // stray extra key (an apiToken echo, an Access secret, anything else the daemon should
  // never send but a bug or a compromised peer might) from ever reaching shared state.
  const pickCloudflareStatus = (raw: unknown): CloudflareProvisionStatus => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const tunnelHealth = r["tunnelHealth"];
    const selfprobe = r["selfprobe"];
    return {
      installed: r["installed"] === true,
      provisioned: r["provisioned"] === true,
      hostname: typeof r["hostname"] === "string" ? (r["hostname"] as string) : null,
      tunnelHealth: (["inactive", "degraded", "healthy", "down", "unknown"] as const).includes(tunnelHealth as never)
        ? (tunnelHealth as CloudflareProvisionStatus["tunnelHealth"])
        : "unknown",
      selfprobe: (["passed", "failed", "pending"] as const).includes(selfprobe as never)
        ? (selfprobe as CloudflareProvisionStatus["selfprobe"])
        : "pending",
      accessTokenExpiry: typeof r["accessTokenExpiry"] === "number" ? (r["accessTokenExpiry"] as number) : null,
    };
  };

  const loadCloudflare = async (): Promise<void> => {
    try {
      const raw = await request<unknown>("fed.cloudflare", {});
      set({ cloudflare: pickCloudflareStatus(raw), loaded: { ...state.loaded, cloudflare: true } });
    } catch (err) {
      fail(err);
    }
  };

  // ---- provider writes ----------------------------------------------------

  // API-KEY-INVALID: fold a fresh accounts.test `detail` into the testDetails map — set it
  // when present, otherwise DROP any stale detail so a now-ok row doesn't keep an old failure
  // string next to its green badge.
  const applyDetail = (name: string, detail: string | undefined): Record<string, string> => {
    const next = { ...state.testDetails };
    if (detail) next[name] = detail;
    else delete next[name];
    return next;
  };

  /** add-provider form submit: accounts.add (name/provider → config overlay),
   * then — when a key was entered — accounts.setKey (Keychain only). The key is
   * a bare argument here and is dropped the moment the RPC returns; it is never
   * stored. On success the providers table reconciles from a fresh read. */
  const addProvider = async (name: string, provider: string, key: string, testWithoutKey = false): Promise<boolean> => {
    try {
      await request("accounts.add", { name, provider });
      if (key) await request("accounts.setKey", { name, key });
      await loadProviders();
      // clear any stale test verdict (+ its detail) from a prior account of the same name.
      if (state.tests[name] !== undefined || state.testDetails[name] !== undefined) {
        const { [name]: _drop, ...rest } = state.tests;
        const { [name]: _dropDetail, ...restDetails } = state.testDetails;
        set({ tests: rest, testDetails: restDetails });
      }
      // AUTO-TEST after a key was just entered (user report: adding a z.ai key
      // still showed "✗ missing" — the key is write-only, so the badge can only
      // flip via a test; make that automatic instead of requiring a manual `t`).
      // Best-effort: a network hiccup leaves the badge unverified, the manual
      // `t` still exists.
      if (key || testWithoutKey) {
        void request<{ name: string; result: ProbeResult; detail?: string }>("accounts.test", { name })
          .then((res) => {
            // OAUTH-TOKEN-ACCOUNTS: admin_key is a valid ProbeResult value too (see
            // selectors.settings.ts) — a narrower guard here would silently drop it
            // and the row would never show the new detail text.
            if (res && (res.result === "ok" || res.result === "auth_error" || res.result === "admin_key" || res.result === "connection_error")) {
              set({ tests: { ...state.tests, [name]: res.result }, testDetails: applyDetail(name, res.detail) });
            }
          })
          .catch(() => { /* badge stays unverified; `t` retries */ });
      }
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** Register a first-class custom OpenAI-compatible provider. The catalog write lands first so
   * accounts.add can resolve the new id. A no-key provider gets an immediately usable account;
   * a keyed provider only gets one when the operator supplied a key. Finally, a forced model
   * probe warms the same cache used by SpawnCard (and falls back daemon-side when unreachable). */
  const addCustomProvider = async (input: {
    id: string; label: string; baseUrl: string; defaultModel: string; requiresKey: boolean; key?: string;
  }): Promise<boolean> => {
    try {
      const key = input.key?.trim() ?? "";
      await request("providers.addCustom", {
        id: input.id, label: input.label, baseUrl: input.baseUrl,
        defaultModel: input.defaultModel, requiresKey: input.requiresKey,
      });
      await loadProviders();
      if (!input.requiresKey || key) {
        await request("accounts.add", { name: input.id, provider: input.id });
        if (key) await request("accounts.setKey", { name: input.id, key });
        await loadProviders();
      }
      await request("providers.models", { provider: input.id, refresh: true });
      store.dispatch({ type: "notice", message: `${input.label} is available now — no restart required` });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const removeProvider = async (name: string): Promise<void> => {
    try {
      await request("accounts.remove", { name });
      const { [name]: _drop, ...rest } = state.tests;
      const { [name]: _dropDetail, ...restDetails } = state.testDetails;
      set({ tests: rest, testDetails: restDetails });
      await loadProviders();
    } catch (err) {
      fail(err);
    }
  };

  /** `t` on a row — accounts.test (1-token ping) → record ok|auth_error for the
   * badge. A network hiccup surfaces as an error toast and leaves the badge. */
  const testAccount = async (name: string): Promise<void> => {
    try {
      const res = await request<{ name: string; result: ProbeResult; detail?: string }>("accounts.test", { name });
      if (res && (res.result === "ok" || res.result === "auth_error" || res.result === "admin_key" || res.result === "connection_error")) {
        set({ tests: { ...state.tests, [name]: res.result }, testDetails: applyDetail(name, res.detail) });
      }
    } catch (err) {
      fail(err);
    }
  };

  /** Re-key an EXISTING account (row-level, not the add-provider form): a
   * write-only key field, blank = unchanged (the component never submits an
   * empty key — see SettingsScreen's rekey input), forwarded verbatim to
   * accounts.setKey (Keychain-only; the daemon rejects non-keychain
   * accounts). The key is a bare argument and is dropped the instant the RPC
   * returns — no state field here ever holds it. Reconciles + auto-tests on
   * success, same pattern as addProvider's post-key verification. */
  const rekeyAccount = async (name: string, key: string): Promise<boolean> => {
    try {
      await request("accounts.setKey", { name, key });
      await loadProviders();
      void request<{ name: string; result: ProbeResult; detail?: string }>("accounts.test", { name })
        .then((res) => {
          if (res && (res.result === "ok" || res.result === "auth_error" || res.result === "admin_key" || res.result === "connection_error")) {
            set({ tests: { ...state.tests, [name]: res.result }, testDetails: applyDetail(name, res.detail) });
          }
        })
        .catch(() => { /* badge stays unverified; `t` retries */ });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** Move a row up/down in failover priority. Computes the FULL new autoOrder
   * (config.patch does whole-array replace, never a delta — see engine.ts's
   * accounts.add comment) via the pure reorderAutoOrder helper, which mirrors
   * buildProviderRows's own ordering rule so the swap acts on exactly the
   * sequence the table shows, folding a previously-trailing (not-in-autoOrder)
   * account into the array as an expected side effect of reordering it. A
   * no-op move (already at a boundary) returns null and is silently ignored. */
  const reorderAccount = async (name: string, direction: "up" | "down"): Promise<boolean> => {
    const next = reorderAutoOrder(state.accounts, state.autoOrder, name, direction);
    if (!next) return false;
    try {
      await request("config.patch", { patch: { autoOrder: next } });
      await loadProviders();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** F23-2B: the base-URL/default-model override form on a provider catalog card
   * → config.patch({providerOverrides: {[id]: value|null}}) (null clears the
   * entry). Reconciles from a fresh providers.list read on success, same
   * eager-refresh pattern as setDailyCap. */
  const setProviderOverride = async (providerId: string, value: { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null): Promise<boolean> => {
    try {
      await request("config.patch", { patch: providerOverridePatch(providerId, value) });
      await loadProviders();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** SUBSCRIPTION-CONNECT: "connect with subscription" button on a claude/codex catalog
   * card → accounts.add_subscription(provider) — registers a subscription account riding
   * the provider CLI's own ambient login, no key entry needed. Reconciles from a fresh
   * providers.list read on success, same eager-refresh pattern as addProvider. */
  const connectSubscription = async (provider: string): Promise<boolean> => {
    try {
      await request("accounts.add_subscription", { provider });
      await loadProviders();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  // ---- KIMI-CODE-SUBSCRIPTION-UI: provider catalog card's oauth-branch "connect
  // with subscription" (accounts.oauth_start -> poll accounts.oauth_finish) --------

  const setProviderOAuth = (providerId: string, patch: ProviderOAuthState): void => {
    set({ providerOAuth: { ...state.providerOAuth, [providerId]: patch } });
  };

  const stopProviderOAuthPolling = (providerId: string): void => {
    const timer = providerOAuthTimers[providerId];
    if (timer !== undefined) {
      clearInterval(timer);
      delete providerOAuthTimers[providerId];
    }
  };

  /** Unmount safety, same discipline as stopAllMcpStoreOAuthPolling. */
  const stopAllProviderOAuthPolling = (): void => {
    for (const providerId of Object.keys(providerOAuthTimers)) stopProviderOAuthPolling(providerId);
  };

  /** One accounts.oauth_finish poll. "connected" reconciles the account list AND
   * kicks an accounts.test probe (same auto-test pattern as addProvider/rekeyAccount
   * above) so `subscriptionOAuthConnected`'s auth_error check has fresh data instead
   * of staying optimistic forever — a green checkmark should reflect a token that
   * actually authenticates, not just an account row that now exists. */
  const pollProviderOAuthOnce = async (providerId: string): Promise<void> => {
    const pendingId = state.providerOAuth[providerId]?.pendingId;
    if (!pendingId) { stopProviderOAuthPolling(providerId); return; }
    try {
      const res = await request<{ status: "connected" | "pending" | "error"; name?: string; message?: string }>(
        "accounts.oauth_finish", { pendingId },
      );
      if (res.status === "connected") {
        stopProviderOAuthPolling(providerId);
        setProviderOAuth(providerId, { status: "connected" });
        await loadProviders();
        const name = res.name;
        if (name) {
          void request<{ name: string; result: ProbeResult; detail?: string }>("accounts.test", { name })
            .then((probe) => {
              if (probe && (probe.result === "ok" || probe.result === "auth_error" || probe.result === "admin_key" || probe.result === "connection_error")) {
                set({ tests: { ...state.tests, [name]: probe.result }, testDetails: applyDetail(name, probe.detail) });
              }
            })
            .catch(() => { /* badge stays unverified; the row's own `t` still retries */ });
        }
      } else if (res.status === "error") {
        stopProviderOAuthPolling(providerId);
        setProviderOAuth(providerId, { status: "error", error: res.message ?? "oauth connect failed" });
      }
      // "pending": leave the timer running, state stays "polling".
    } catch (err) {
      stopProviderOAuthPolling(providerId);
      setProviderOAuth(providerId, { status: "error", error: errMessage(err) });
    }
  };

  /** Click handler for the oauth branch of the unified "connect with subscription"
   * button. Covers both shapes accounts.oauth_start can hand back: a device/authorize
   * flow (userCode/verificationUri or authorizeUrl to show, then poll) and an
   * "immediate" CLI-file-backed flow (grok-build/kimi-code today — the very first
   * oauth_finish poll already reports connected/error, so this never visibly sits in
   * "awaiting"). */
  const connectProviderOAuth = async (providerId: string, intervalMs = 1500): Promise<void> => {
    stopProviderOAuthPolling(providerId);
    setProviderOAuth(providerId, { status: "starting" });
    try {
      const res = await request<{ pendingId: string; authorizeUrl?: string; userCode?: string; verificationUri?: string }>(
        "accounts.oauth_start", { provider: providerId },
      );
      setProviderOAuth(providerId, {
        status: "awaiting", pendingId: res.pendingId,
        authorizeUrl: res.authorizeUrl, userCode: res.userCode, verificationUri: res.verificationUri,
      });
      await pollProviderOAuthOnce(providerId);
      if (state.providerOAuth[providerId]?.status === "awaiting") {
        setProviderOAuth(providerId, { ...state.providerOAuth[providerId]!, status: "polling" });
        providerOAuthTimers[providerId] = setInterval(() => void pollProviderOAuthOnce(providerId), intervalMs);
      }
    } catch (err) {
      setProviderOAuth(providerId, { status: "error", error: errMessage(err) });
      fail(err);
    }
  };

  /** Cancel click — abandons an in-flight connect. Unlike MCP's oauth.cancel there is
   * no accounts.oauth_cancel RPC (PendingOAuthStore has no server-side cancel — a
   * pending record just self-expires after its 10-minute TTL, see pending-oauth.ts),
   * so this is client-side only: stop polling and drop the row's local state. */
  const cancelProviderOAuth = (providerId: string): void => {
    stopProviderOAuthPolling(providerId);
    const { [providerId]: _dropped, ...rest } = state.providerOAuth;
    set({ providerOAuth: rest });
  };

  // ---- network writes -----------------------------------------------------

  /** masked auth-key entry → fed.tailscale.setAuthKey (Keychain; auto-join on
   * next daemon restart). Write-only: the key is dropped after the RPC. */
  const setAuthKey = async (key: string): Promise<boolean> => {
    try {
      await request("fed.tailscale.setAuthKey", { key });
      set({ authKeyStored: true });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** connect/login → fed.network.up → render the returned authUrl for the user
   * to open. Follows with a network re-probe. */
  const networkUp = async (): Promise<void> => {
    try {
      const res = await request<{ authUrl: string | null }>("fed.network.up", {});
      set({ authUrl: res?.authUrl ?? null });
      await loadNetwork();
    } catch (err) {
      fail(err);
    }
  };

  /** configure/provision click → fed.cloudflare.up {apiToken?, domain}. `apiToken` is a
   * bare argument, write-only (Keychain-side) — never retained here. Only the response's
   * `status` field is folded into state, and ONLY via pickCloudflareStatus's explicit pick
   * (never a raw spread), so nothing shaped like a secret can ride along even if the daemon
   * response were ever malformed. Domain re-runs may omit apiToken (already-stored token). */
  const cloudflareUp = async (domain: string, apiToken?: string): Promise<boolean> => {
    try {
      const params = apiToken ? { domain, apiToken } : { domain };
      const res = await request<{ status?: unknown }>("fed.cloudflare.up", params);
      set({ cloudflare: pickCloudflareStatus(res?.status), loaded: { ...state.loaded, cloudflare: true } });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  // ---- general writes -----------------------------------------------------

  /** dailyCap edit → config.patch {dailyCapUsd} (null clears via the overlay's
   * null-deletion). The config_changed event will also refresh general, but we
   * reconcile eagerly so the field settles even if the event is missed. */
  const setDailyCap = async (value: number | null): Promise<boolean> => {
    try {
      await request("config.patch", { patch: { dailyCapUsd: value } });
      await loadGeneral();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** IMPORT-DIR: project import directory edit → config.patch {projectImportDir}
   * (null clears via the overlay's null-deletion, falling back to
   * $CHIMERA_HOME/projects daemon-side). Same eager-reconcile pattern as setDailyCap. */
  const setProjectImportDir = async (value: string | null): Promise<boolean> => {
    try {
      await request("config.patch", { patch: { projectImportDir: value } });
      await loadGeneral();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** concurrency ceiling edit → config.patch {caps: {maxAgentsTotal}}. Same
   * eager-reconcile pattern as setDailyCap. Validation (positive integer)
   * happens client-side BEFORE this is ever called — see parseMaxAgentsTotal. */
  const setMaxAgentsTotal = async (value: number): Promise<boolean> => {
    try {
      await request("config.patch", { patch: maxAgentsTotalPatch(value) });
      await loadGeneral();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** dynamic-cap form save → config.patch {caps: {dynamicCap}}. The caller
   * always sends the FULL validated DynamicCapConfig (parseDynamicCapDraft's
   * output) — never a partial patch — so a save can never leave a stale field
   * from a previous enable/disable cycle. */
  const setDynamicCap = async (value: DynamicCapConfig): Promise<boolean> => {
    try {
      await request("config.patch", { patch: dynamicCapPatch(value) });
      await loadGeneral();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** per-account cap edit → config.patch {caps: {perAccount: {[name]: value}}}.
   * A single-key patch — config.patch merges into the existing perAccount
   * object (RFC 7396), so this never touches any OTHER account's entry. */
  const setPerAccountCap = async (name: string, value: number | null): Promise<boolean> => {
    try {
      await request("config.patch", { patch: perAccountCapPatch(name, value) });
      await loadGeneral();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  // ---- MCP store (mcpstore.*) ----------------------------------------------

  let mcpStoreLoadGeneration = 0;
  const loadMcpStore = async (): Promise<void> => {
    const generation = ++mcpStoreLoadGeneration;
    try {
      // MCP-AUTH-STATUS: joins the same Promise.all rather than a follow-up round trip —
      // authStatus is keychain+memory only, so it costs no more than list does. `.catch` keeps
      // one failing status probe from blanking the server list, which is the more important half.
      // MCP-OAUTH-GATEWAYS: config.get rides along for the add-remote form's scope catalog; a
      // failed read keeps the previous gateways rather than blanking the server list.
      const [servers, imported, auth, cfg] = await Promise.all([
        request<McpStoreEntry[]>("mcpstore.list", {}),
        request<{ importables: McpStoreImportable[] }>("mcpstore.importables", {}),
        request<{ servers: McpStoreAuthStatus[] }>("mcpstore.authStatus", {}).catch(() => ({ servers: [] })),
        request<RedactedConfig>("config.get", {}).catch(() => null),
      ]);
      // An earlier list request may finish after install/remove's reconciliation.
      // Never resurrect deleted rows or hide the just-installed package with it.
      if (generation !== mcpStoreLoadGeneration) return;
      const list = Array.isArray(servers) ? servers : [];
      set({
        mcpServers: list,
        mcpImportables: Array.isArray(imported?.importables) ? imported.importables : [],
        mcpAuthStatus: Object.fromEntries((auth?.servers ?? []).map((row) => [row.name, row])),
        // Server-validated already (ChimeraConfigSchema) — same trust as caps.dynamicCap above.
        // It survives config.get's redaction only because the value is an array: the key name
        // matches the redactor's /auth/ pattern, which rewrites matching STRING values alone.
        mcpOAuthGateways: cfg === null ? state.mcpOAuthGateways
          : Array.isArray(cfg?.mcpOAuthGateways) ? (cfg.mcpOAuthGateways as McpOAuthGateway[]) : [],
        loaded: { ...state.loaded, mcpStore: true },
      });
      // MCP-OAUTH-DISCOVERABILITY: best-effort, never-awaited per-row detect probe for every
      // remote entry that ISN'T already oauth-kind (an oauth-kind row already shows Authorize
      // — see McpStoreSection — no probe needed). Each independently updates mcpDetectedOAuth
      // as it resolves; loadMcpStore itself must never block on N network round trips.
      for (const s of list) {
        if (s.type === "http" && s.auth?.kind !== "oauth") void detectRowOAuth(s.name);
      }
    } catch (err) {
      if (generation === mcpStoreLoadGeneration) fail(err); // keep the previous rows
    }
  };

  /** MCP-OAUTH-DISCOVERABILITY: read-only, no-secret probe (mcpstore.detectAuth) — used both
   * by the add-remote form (by `url`, before the entry exists — see AddMcpStoreForm) and to
   * retrofit an Authorize button onto an already-installed bearer/no-auth remote row (by
   * `name` — see detectRowOAuth below). Returns null on any probe failure: best-effort, never
   * surfaces a toast — a broken/unreachable server must never block typing or a list load. */
  const detectMcpStoreOAuth = async (opts: { url?: string; name?: string }): Promise<{ oauth: boolean } | null> => {
    try {
      return await request<{ oauth: boolean }>("mcpstore.detectAuth", opts);
    } catch {
      return null;
    }
  };

  /** loadMcpStore's per-row cache populate — see the call site there. */
  const detectRowOAuth = async (name: string): Promise<void> => {
    const entry = state.mcpServers.find((s) => s.name === name);
    const res = await detectMcpStoreOAuth({ name });
    if (res && entry && state.mcpServers.find((s) => s.name === name) === entry) set({ mcpDetectedOAuth: { ...state.mcpDetectedOAuth, [name]: res.oauth } });
  };

  /** add-server form submit: mcpstore.add, then reconcile from a fresh list read
   * (same eager-refresh pattern as addProvider). */
  const addMcpStore = async (name: string, spec: McpStoreServerSpec): Promise<boolean> => {
    try {
      await request("mcpstore.add", { name, ...spec });
      await loadMcpStore();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const removeMcpStore = async (name: string): Promise<void> => {
    try {
      await request("mcpstore.remove", { name });
      await loadMcpStore();
    } catch (err) {
      fail(err);
    }
  };

  // Errors stay with the package form, retaining the reviewed package and user's draft.
  const inspectMcpPackage = (input: { packageName: string; version: string }): Promise<McpPackageReview> =>
    request<McpPackageReview>("mcpstore.package.inspect", input);
  const installMcpPackage = async (input: McpPackageInstall): Promise<void> => {
    await request("mcpstore.package.install", input);
    await loadMcpStore();
  };

  /** MCP-STORE-DIRECT-TOGGLE: flip a server's `direct` flag (mcpstore.setDirect), then
   * reconcile from a fresh list read — same eager-refresh pattern as add/removeMcpStore. */
  const setMcpStoreDirect = async (name: string, direct: boolean): Promise<boolean> => {
    try {
      await request("mcpstore.setDirect", { name, direct });
      await loadMcpStore();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** MCPSTORE-LIFECYCLE-UI: flip a server's `enabled` flag (mcpstore.setEnabled), then
   * reconcile from a fresh list read — same eager-refresh pattern as setMcpStoreDirect.
   * A temporary off switch: credentials/spec survive, unlike removeMcpStore (uninstall). */
  const setMcpStoreEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    try {
      await request("mcpstore.setEnabled", { name, enabled });
      await loadMcpStore();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** TRUST-TIER: flip a server's `trust` tier (mcpstore.setTrust), then reconcile from a
   * fresh list read — same eager-refresh pattern as setMcpStoreDirect/setMcpStoreEnabled.
   * UI/RPC-only (never agent-facing — see mcp-parity.test.ts's exclusion for why an agent
   * flipping its own untrusted server back to "full" would defeat the gate). */
  const setMcpStoreTrust = async (name: string, trust: "full" | "untrusted"): Promise<boolean> => {
    try {
      await request("mcpstore.setTrust", { name, trust });
      await loadMcpStore();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** row-expand fetch: mcpstore.tools({query: name}) lazily connects that server
   * (and, per the RPC's current implementation, every OTHER installed server too —
   * it only filters the OUTPUT by query — but subsequent expands are instant since
   * the daemon caches each connection). Never eager on section load. */
  const loadMcpServerTools = async (name: string): Promise<void> => {
    set({ mcpTools: { ...state.mcpTools, [name]: { status: "loading", connected: false, tools: [] } } });
    try {
      const res = await request<{ servers: Array<{ server: string; connected: boolean; error?: string; tools: McpStoreToolInfo[] }> }>(
        "mcpstore.tools",
        { query: name },
      );
      const row = Array.isArray(res?.servers) ? res.servers.find((s) => s.server === name) : undefined;
      set({
        mcpTools: {
          ...state.mcpTools,
          [name]: row
            ? { status: "loaded", connected: row.connected, error: row.error, tools: row.tools }
            : { status: "loaded", connected: false, error: `no such mcp store server "${name}"`, tools: [] },
        },
      });
    } catch (err) {
      set({ mcpTools: { ...state.mcpTools, [name]: { status: "loaded", connected: false, error: errMessage(err), tools: [] } } });
    }
  };

  /** an importables-row "import" click → mcpstore.import(source, name[, as]). Failure
   * (e.g. a rescan mismatch, or a notImportable entry re-attempted) surfaces on the
   * row itself via mcpImportErrors, in addition to the existing commandError toast —
   * a click must never be silent.
   *
   * MCP-REMOTE-IMPORT slice 3: `secret`, when given, follows a successful import with
   * mcpstore.setAuth against the RESULTING entry name (the import response's `name`,
   * which may differ from `name` via sanitization/`as`) — mcpstore.setAuth requires the
   * entry to already exist, so this can only run import-then-setAuth, never the reverse.
   * Write-only: `secret` is a bare argument, never retained in this store. */
  const importMcpStore = async (source: "claude" | "codex", name: string, as?: string, secret?: string): Promise<boolean> => {
    const key = `${source}:${name}`;
    try {
      const res = await request<{ name?: string }>("mcpstore.import", { source, name, ...(as ? { as } : {}) });
      if (secret && secret.trim() && res?.name) {
        await request("mcpstore.setAuth", { name: res.name, secret: secret.trim() });
      }
      const { [key]: _cleared, ...rest } = state.mcpImportErrors;
      set({ mcpImportErrors: rest });
      await loadMcpStore();
      return true;
    } catch (err) {
      set({ mcpImportErrors: { ...state.mcpImportErrors, [key]: errMessage(err) } });
      fail(err);
      return false;
    }
  };

  /** MCP-REMOTE-IMPORT slice 3: write-only secret entry for an existing http store
   * entry (mcpstore.setAuth → Keychain). Used directly by the store-list rows (an
   * already-installed http server whose auth wasn't set at import time) and as the
   * second half of importMcpStore/connectManagedMcpStore's two-RPC sequence. */
  const setMcpStoreAuth = async (name: string, secret: string): Promise<boolean> => {
    try {
      await request("mcpstore.setAuth", { name, secret });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  /** claude.ai-managed importable rows can never go through mcpstore.import — the
   * daemon rejects any importable carrying `notImportableReason` (their auth lives in
   * the claude.ai session, not on this machine). The row still carries a real
   * url/headers though, so this offers the "bring your own token" path: an ordinary
   * mcpstore.add (wired with an `auth.keychainRef` pointer up front, same as the
   * migrated manual add form) + mcpstore.setAuth. Errors surface the same way as
   * importMcpStore (row-keyed mcpImportErrors + the commandError toast). */
  const connectManagedMcpStore = async (imp: McpStoreImportable, secret: string): Promise<boolean> => {
    const key = `${imp.source}:${imp.name}`;
    if (!imp.url) {
      set({ mcpImportErrors: { ...state.mcpImportErrors, [key]: `"${imp.name}" is missing a url` } });
      return false;
    }
    const name = sanitizeMcpStoreImportName(imp.name);
    try {
      await request("mcpstore.add", {
        name, type: "http", url: imp.url, headers: imp.headers ?? {}, direct: false,
        auth: { keychainRef: mcpAuthKeychainRef(name) },
      });
      const trimmed = secret.trim();
      if (trimmed) await request("mcpstore.setAuth", { name, secret: trimmed });
      const { [key]: _cleared, ...rest } = state.mcpImportErrors;
      set({ mcpImportErrors: rest });
      await loadMcpStore();
      return true;
    } catch (err) {
      set({ mcpImportErrors: { ...state.mcpImportErrors, [key]: errMessage(err) } });
      fail(err);
      return false;
    }
  };

  // MCP-OAUTH-DISCOVERABILITY: retrofits an existing (bearer/no-auth) http entry to
  // auth.kind:"oauth" — the Authorize button's "detected-OAuth bearer entry" convert-then-
  // authorize path (McpStoreSection calls this immediately before authorizeMcpStore). Default
  // scopes (mcpstore.setAuthKind's server-side default) — no scope picker for this path, same
  // "one click" spirit as the rest of the retrofit flow.
  const convertMcpStoreAuthKind = async (name: string): Promise<boolean> => {
    try {
      await request("mcpstore.setAuthKind", { name, kind: "oauth" });
      await loadMcpStore();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  // ---- MCP-OAUTH slice 3: Authorize button (start → open → poll) ----------

  const setMcpOAuth = (name: string, patch: McpOAuthState): void => {
    set({ mcpOAuth: { ...state.mcpOAuth, [name]: patch } });
  };

  const stopMcpStoreOAuthPolling = (name: string): void => {
    const timer = mcpOAuthTimers[name];
    if (timer !== undefined) {
      clearInterval(timer);
      delete mcpOAuthTimers[name];
    }
  };

  /** MCPSTORE-OAUTH-CANCEL: unmount safety — every poll timer this module instance owns,
   * stopped in one shot. Called by the screen when it unmounts mid-flow (navigating away from
   * Settings) so a dead row never keeps ticking in the background. */
  const stopAllMcpStoreOAuthPolling = (): void => {
    for (const name of Object.keys(mcpOAuthTimers)) stopMcpStoreOAuthPolling(name);
  };

  /** Authorize click, part 1: mcpstore.oauth.start(name) → {pendingId, authorizeUrl}.
   * The daemon owns everything token-shaped (PKCE/DCR/keychain) — this state is never
   * more than the bare start response. Returns the authorizeUrl for the SCREEN to open
   * in the system browser (this module stays free of a ../rpc/bridge import — see the
   * header discipline note above); null on failure (fail() already toasted). */
  const authorizeMcpStore = async (name: string): Promise<string | null> => {
    stopMcpStoreOAuthPolling(name);
    setMcpOAuth(name, { status: "starting" });
    try {
      const res = await request<{ pendingId: string; authorizeUrl: string }>("mcpstore.oauth.start", { name });
      setMcpOAuth(name, { status: "awaiting", pendingId: res.pendingId, authorizeUrl: res.authorizeUrl });
      return res.authorizeUrl;
    } catch (err) {
      setMcpOAuth(name, { status: "error", error: errMessage(err) });
      fail(err);
      return null;
    }
  };

  /** One mcpstore.oauth.finish poll — "connected" stops the timer and refreshes that
   * server's tool list (badge flips + the panel shows the newly-reachable tools);
   * "error" stops the timer and surfaces the daemon's message inline; "pending" keeps
   * polling (the loopback listener is still waiting on the browser redirect). */
  const pollMcpStoreOAuthOnce = async (name: string): Promise<void> => {
    const pendingId = state.mcpOAuth[name]?.pendingId;
    if (!pendingId) { stopMcpStoreOAuthPolling(name); return; }
    try {
      const res = await request<{ status: "connected" | "pending" | "error"; error?: string }>(
        "mcpstore.oauth.finish", { pendingId },
      );
      if (res.status === "connected") {
        stopMcpStoreOAuthPolling(name);
        setMcpOAuth(name, { status: "connected" });
        // MCP-AUTH-STATUS: refetch the store so the row's auth chip reflects the grant that
        // just landed. Without this the backend is correct but the screen keeps rendering the
        // pre-authorize verdict — a "needs re-auth" chip surviving the re-auth that fixed it.
        await Promise.all([loadMcpServerTools(name), loadMcpStore()]);
      } else if (res.status === "error") {
        stopMcpStoreOAuthPolling(name);
        setMcpOAuth(name, { status: "error", error: res.error ?? "oauth authorize failed" });
      }
      // "pending": leave the timer running, state stays "polling".
    } catch (err) {
      stopMcpStoreOAuthPolling(name);
      setMcpOAuth(name, { status: "error", error: errMessage(err) });
    }
  };

  /** Authorize click, part 2 — called by the screen right after it opens the
   * authorizeUrl in the system browser. Polls immediately, then every `intervalMs`
   * (~1.5s per the design) until oauth.finish reports connected/error. */
  const startMcpStoreOAuthPolling = (name: string, intervalMs = 1500): void => {
    stopMcpStoreOAuthPolling(name);
    const current = state.mcpOAuth[name];
    if (!current?.pendingId) return;
    setMcpOAuth(name, { ...current, status: "polling" });
    void pollMcpStoreOAuthOnce(name);
    mcpOAuthTimers[name] = setInterval(() => void pollMcpStoreOAuthOnce(name), intervalMs);
  };

  /** Cancel click — abandons an in-flight Authorize. Resets the row to idle FIRST (stop the
   * poll timer, drop this server's mcpOAuth entry so `busy` clears and Authorize re-enables)
   * so the UI recovers immediately regardless of the network — then best-effort tells the
   * daemon to abandon the pending flow (mcpstore.oauth.cancel drops its bookkeeping and closes
   * the loopback listener, see McpStoreOAuthFlow.cancel(), instead of idling out to its
   * 10-minute timeout). The RPC failing (unknown/already-settled pendingId, offline daemon)
   * is not surfaced as an error — the row is already back to Authorize either way. */
  const cancelMcpStoreOAuth = async (name: string): Promise<void> => {
    stopMcpStoreOAuthPolling(name);
    const pendingId = state.mcpOAuth[name]?.pendingId;
    const { [name]: _dropped, ...rest } = state.mcpOAuth;
    set({ mcpOAuth: rest });
    if (pendingId) {
      try { await request("mcpstore.oauth.cancel", { pendingId }); } catch { /* best-effort — row is already reset */ }
    }
  };

  // ---- self-refresh (config_changed / network_changed) --------------------

  const refresh = async (sections: readonly SettingsRefresh[]): Promise<void> => {
    const jobs: Array<Promise<void>> = [];
    if (sections.includes("providers")) jobs.push(loadProviders());
    if (sections.includes("general")) jobs.push(loadGeneral());
    if (sections.includes("network")) jobs.push(loadNetwork());
    if (sections.includes("cloudflare")) jobs.push(loadCloudflare());
    await Promise.all(jobs);
  };

  /** A daemon event landed — refresh the affected section(s). config_error is a
   * toast (the daemon kept the old config), routed here off the event data. */
  const onDaemonEvent = (kind: string, data?: Record<string, unknown>): void => {
    if (kind === "config_error") {
      const msg = typeof data?.["message"] === "string" ? (data["message"] as string) : "config error";
      store.dispatch({ type: "commandError", message: `config: ${msg}` });
      return;
    }
    const sections = sectionsForEvent(kind);
    if (sections.length > 0) void refresh(sections);
  };

  return {
    getState: (): SettingsState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    setSection: (section: SettingsSection): void => set({ section }),
    loadProviders,
    loadGeneral,
    loadNetwork,
    addProvider,
    addCustomProvider,
    removeProvider,
    testAccount,
    rekeyAccount,
    reorderAccount,
    setProviderOverride,
    connectSubscription,
    connectProviderOAuth,
    cancelProviderOAuth,
    stopAllProviderOAuthPolling,
    setAuthKey,
    networkUp,
    loadCloudflare,
    cloudflareUp,
    setDailyCap,
    setProjectImportDir,
    setMaxAgentsTotal,
    setDynamicCap,
    setPerAccountCap,
    loadMcpStore,
    addMcpStore,
    inspectMcpPackage,
    installMcpPackage,
    removeMcpStore,
    setMcpStoreDirect,
    setMcpStoreEnabled,
    setMcpStoreTrust,
    loadMcpServerTools,
    importMcpStore,
    setMcpStoreAuth,
    connectManagedMcpStore,
    detectMcpStoreOAuth,
    convertMcpStoreAuthKind,
    authorizeMcpStore,
    startMcpStoreOAuthPolling,
    stopMcpStoreOAuthPolling,
    stopAllMcpStoreOAuthPolling,
    cancelMcpStoreOAuth,
    refresh,
    onDaemonEvent,
  };
}

// The app-side singleton, bound lazily by the screen with the deps IT imports
// (commands.host.ts pattern) — this module stays free of bridge/store imports so
// tests build their own instance around a stub request.
let singleton: SettingsCommands | null = null;
export function getSettingsCommands(store: UiStore, request: RequestFn): SettingsCommands {
  if (!singleton) singleton = createSettingsCommands(store, request);
  return singleton;
}

/** Read the existing singleton without creating one — for the app overlay
 * lifecycle binder (overlayLifecycle.ts), which needs to react to `section`
 * changes but must not pull the RPC bridge into a module that stays free of
 * it. SettingsScreen.tsx is statically imported by App.tsx, so by the time
 * installAppOverlayLifecycle's effect runs the singleton already exists;
 * null here just means "no section changes to react to yet". */
export function peekSettingsCommands(): SettingsCommands | null {
  return singleton;
}
