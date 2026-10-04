import { describe, expect, it } from "vitest";
import type { AccountStatus, AgentCapStatus } from "@chimera/ui-state";
import { CONFIG_PATCH_NULL, type McpOAuthGateway, type TailscaleNetworkStatus, type CloudflareProvisionStatus, type DynamicCapConfig } from "@chimera/protocol";
import {
  SETTINGS_SECTIONS,
  stepSection,
  isSettingsSection,
  keyBadge,
  keyBadgeTone,
  keyBadgeLabel,
  credentialTypeLabel,
  probeDetail,
  buildProviderRows,
  buildProviderCatalogRows,
  providerOptionsFor,
  FALLBACK_PROVIDER_OPTIONS,
  parseProviderOverride,
  providerOverridePatch,
  compactionThresholdLabel,
  reorderAutoOrder,
  type ProviderCatalogItem,
  maskKey,
  networkView,
  cloudflareView,
  authKeyBadge,
  parseDailyCap,
  dailyCapPatch,
  fmtDailyCap,
  validateImportDir,
  parseMaxAgentsTotal,
  maxAgentsTotalPatch,
  concurrencyCapView,
  LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS,
  dynamicCapDraft,
  parseDynamicCapDraft,
  dynamicCapPatch,
  parsePerAccountCap,
  perAccountCapPatch,
  parseArgsInput,
  parseEnvInput,
  sectionsForEvent,
  MCP_TOOLS_IDLE,
  mcpToolsRow,
  mcpToolsBadge,
  mcpToolsStatusLine,
  truncateToolDescription,
  mcpOAuthScopeCatalog,
  defaultMcpOAuthScopeSelection,
  resolveMcpOAuthScopes,
  mcpStoreAuthRowView,
  mcpStoreIsEnabled,
  type McpToolsRow,
} from "../src/state/selectors.settings";

// W9 (F09 · coverage B15/B16) — the Settings screen's PURE decision logic:
// badge derivation, masking rules, section routing, and the refresh-on-event
// mapping. Node env, no DOM.

describe("section list + routing", () => {
  it("is the mock's sections in order (W20 · F18 added 'notify'; MCP-STORE added 'mcp'; HOOK-6 added 'hooks'; SECRET-MANAGER added 'secrets')", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(["providers", "network", "tools", "notify", "hooks", "mcp", "secrets", "general"]);
  });
  it("stepSection clamps (never wraps)", () => {
    expect(stepSection("providers", -1)).toBe("providers"); // clamped at the top
    expect(stepSection("providers", 1)).toBe("network");
    expect(stepSection("network", 1)).toBe("tools");
    expect(stepSection("general", 1)).toBe("general");      // clamped at the bottom
    expect(stepSection("general", -1)).toBe("secrets");
  });
  it("isSettingsSection guards unknown strings", () => {
    expect(isSettingsSection("network")).toBe(true);
    expect(isSettingsSection("nope")).toBe(false);
  });
});

describe("keyBadge derivation (write-only key — presence is unverifiable without a test)", () => {
  it("a passing test → set; a failing test → invalid", () => {
    expect(keyBadge({ authType: "keychain", test: "ok" })).toBe("set");
    expect(keyBadge({ authType: "keychain", test: "auth_error" })).toBe("invalid");
  });
  it("authExpired (daemon.status) → invalid regardless of type", () => {
    expect(keyBadge({ authType: "keychain", authExpired: true })).toBe("invalid");
  });
  it("subscription needs no stored key → set", () => {
    expect(keyBadge({ authType: "subscription" })).toBe("set");
  });
  it("an untested keychain/env/command secret is unverified → missing", () => {
    expect(keyBadge({ authType: "keychain" })).toBe("missing");
    expect(keyBadge({ authType: "env" })).toBe("missing");
    expect(keyBadge({})).toBe("missing");
  });
  it("subscription stays set even if a (meaningless) key probe reported auth_error", () => {
    // subscription has no API key to probe — accounts.test now returns ok for it,
    // but even a stale/false auth_error must NOT flip the account the whole system
    // runs on to invalid (the user-reported "main tests as invalid" bug).
    expect(keyBadge({ authType: "subscription", test: "auth_error" })).toBe("set");
    expect(keyBadge({ authType: "subscription", authExpired: true })).toBe("set");
  });
  it("ACCOUNT-KEY-PRESENCE: hasKey true (untested) → set, so a restart never shows a stored key as missing", () => {
    expect(keyBadge({ authType: "keychain", hasKey: true })).toBe("set");
    expect(keyBadge({ authType: "env", hasKey: true })).toBe("set");
  });
  it("ACCOUNT-KEY-PRESENCE: hasKey false (no stored secret) → missing", () => {
    expect(keyBadge({ authType: "keychain", hasKey: false })).toBe("missing");
  });
  it("ACCOUNT-KEY-PRESENCE: a confirmed auth_error still wins over a present-but-untested key", () => {
    expect(keyBadge({ authType: "keychain", hasKey: true, test: "auth_error" })).toBe("invalid");
    expect(keyBadge({ authType: "keychain", hasKey: true, authExpired: true })).toBe("invalid");
  });
  it("tone + label mirror the mock (▪ set green, ✗ red, ◐ untested amber)", () => {
    expect(keyBadgeTone("set")).toBe("success");
    expect(keyBadgeTone("missing")).toBe("danger");
    expect(keyBadgeTone("invalid")).toBe("danger");
    expect(keyBadgeTone("untested")).toBe("warn");
    expect(keyBadgeLabel("set")).toBe("▪ set");
    expect(keyBadgeLabel("missing")).toBe("✗ missing");
    expect(keyBadgeLabel("invalid")).toBe("✗ invalid");
    expect(keyBadgeLabel("untested")).toBe("◐ untested");
  });
});

// OAUTH-TOKEN-ACCOUNTS: an admin-key account must read as invalid WITH an explanation,
// not a bare "✗ invalid". (An oauth-token account now gets a real live probe — see
// OAUTH-TOKEN-VALIDATE — so it reads as ok/invalid exactly like any other credential.)
describe("OAUTH-TOKEN-ACCOUNTS: admin-key badge state + credential detail text", () => {
  it("an admin_key probe result is invalid", () => {
    expect(keyBadge({ authType: "keychain", test: "admin_key" })).toBe("invalid");
  });
  it("subscription still wins over admin_key (never flips the ambient-session account)", () => {
    expect(keyBadge({ authType: "subscription", test: "admin_key" })).toBe("set");
  });
  it("credentialTypeLabel maps each classification to its column text, defaulting undefined to api key", () => {
    expect(credentialTypeLabel("apiKey")).toBe("api key");
    expect(credentialTypeLabel("oauthToken")).toBe("oauth token");
    expect(credentialTypeLabel("adminKey")).toBe("admin key");
    expect(credentialTypeLabel(undefined)).toBe("api key");
  });
  it("probeDetail gives structured text for admin_key/auth_error, null otherwise", () => {
    expect(probeDetail("admin_key")).toMatch(/cannot call the Messages API/i);
    expect(probeDetail("auth_error")).toBe("auth rejected");
    expect(probeDetail("connection_error")).toBe("provider unreachable");
    expect(keyBadge({ test: "connection_error" })).toBe("untested");
    expect(probeDetail("ok")).toBeNull();
    expect(probeDetail(undefined)).toBeNull();
  });
});

describe("buildProviderRows", () => {
  const accounts = [
    { name: "main", provider: "claude", authType: "keychain" },
    { name: "codex", provider: "codex", authType: "keychain" },
    { name: "gpt-alt", provider: "claude", authType: "keychain" },
  ];
  const autoOrder = ["main", "codex"]; // gpt-alt not in the failover order
  const status: AccountStatus[] = [
    { name: "main", provider: "claude", authType: "keychain", cooling: false, coolingUntil: null },
    { name: "codex", provider: "codex", authType: "keychain", cooling: false, coolingUntil: null, authExpired: true },
  ];

  it("orders by autoOrder then trailing accounts, with 1-based failover", () => {
    const rows = buildProviderRows(accounts, autoOrder, status, {});
    expect(rows.map((r) => r.name)).toEqual(["main", "codex", "gpt-alt"]);
    expect(rows.map((r) => r.failover)).toEqual([1, 2, null]);
  });
  it("folds authExpired (status) and test results into the badge", () => {
    const rows = buildProviderRows(accounts, autoOrder, status, { main: "ok" });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("main")!.badge).toBe("set");       // tested ok
    expect(byName.get("codex")!.badge).toBe("invalid");  // status authExpired
    expect(byName.get("gpt-alt")!.badge).toBe("missing"); // untested keychain
  });
  it("spend is the documented '—' (no per-account spend in the surface)", () => {
    const rows = buildProviderRows(accounts, autoOrder, status, {});
    expect(rows.every((r) => r.spendLabel === "—")).toBe(true);
  });
  it("a per-account spendTodayUsd (future field) formats when present", () => {
    const withSpend = [{ name: "main", provider: "claude", authType: "keychain", cooling: false, coolingUntil: null, spendTodayUsd: 2.27 }] as unknown as AccountStatus[];
    const rows = buildProviderRows([{ name: "main", provider: "claude", authType: "keychain" }], ["main"], withSpend, {});
    expect(rows[0]!.spendLabel).toBe("$2.27");
  });
  // OAUTH-TOKEN-ACCOUNTS: credentialType passes through from the account item, and
  // `detail` is derived from the test map — both feed the key column's new content.
  it("threads credentialType through from the account item and derives detail from the test map", () => {
    const withType = [{ name: "claude-pers", provider: "claude", authType: "keychain", credentialType: "oauthToken" as const }];
    const rows = buildProviderRows(withType, ["claude-pers"], [], { "claude-pers": "auth_error" });
    expect(rows[0]!.credentialType).toBe("oauthToken");
    expect(rows[0]!.detail).toBe("auth rejected");
  });
  it("credentialType/detail are undefined/null when nothing is classified/tested", () => {
    const rows = buildProviderRows(accounts, autoOrder, status, {});
    expect(rows[0]!.credentialType).toBeUndefined();
    expect(rows[0]!.detail).toBeNull();
  });
  // API-KEY-INVALID: the daemon's real (key-redacted) probe message overrides the generic
  // per-class label so the row shows the actual cause instead of a flat "auth rejected".
  it("prefers the daemon's real detail over the generic class label when present", () => {
    const withKey = [{ name: "claude-pers", provider: "claude", authType: "keychain" as const }];
    const rows = buildProviderRows(withKey, ["claude-pers"], [], { "claude-pers": "auth_error" }, { "claude-pers": "401 authentication_error: invalid x-api-key" });
    expect(rows[0]!.detail).toBe("401 authentication_error: invalid x-api-key");
  });
});

describe("reorderAutoOrder (pure move-up/down helper — must never add or drop an account)", () => {
  const accounts = [
    { name: "main", provider: "claude", authType: "keychain" },
    { name: "codex", provider: "codex", authType: "keychain" },
    { name: "gpt-alt", provider: "claude", authType: "keychain" },
  ];
  const autoOrder = ["main", "codex"]; // gpt-alt trailing (not in autoOrder)

  it("swaps two adjacent in-autoOrder accounts, preserving the full set", () => {
    const next = reorderAutoOrder(accounts, autoOrder, "codex", "up");
    expect(next).toEqual(["codex", "main", "gpt-alt"]);
    expect(new Set(next)).toEqual(new Set(["main", "codex", "gpt-alt"])); // no add/drop
  });

  it("moving the trailing (not-in-autoOrder) account folds it into the array without losing membership", () => {
    const next = reorderAutoOrder(accounts, autoOrder, "gpt-alt", "up");
    expect(next).toEqual(["main", "gpt-alt", "codex"]);
    expect(new Set(next)).toEqual(new Set(["main", "codex", "gpt-alt"]));
  });

  it("is a no-op at the top/bottom boundary", () => {
    expect(reorderAutoOrder(accounts, autoOrder, "main", "up")).toBeNull();
    expect(reorderAutoOrder(accounts, autoOrder, "gpt-alt", "down")).toBeNull();
  });

  it("is a no-op for an unknown account name", () => {
    expect(reorderAutoOrder(accounts, autoOrder, "nope", "up")).toBeNull();
  });
});

describe("maskKey (write-only field never echoes the secret)", () => {
  it("returns only mask characters, none from the input", () => {
    const secret = "sk-ABCdef123";
    const masked = maskKey(secret.length);
    expect(masked).toBe("•".repeat(secret.length));
    for (const ch of secret) expect(masked.includes(ch)).toBe(false);
  });
  it("bounds a long paste and floors to zero", () => {
    expect(maskKey(999).length).toBe(24);
    expect(maskKey(0)).toBe("");
    expect(maskKey(-5)).toBe("");
  });
});

describe("networkView (fed.network state)", () => {
  it("null → loading placeholders", () => {
    const v = networkView(null);
    expect(v.loaded).toBe(false);
    expect(v.statusLabel).toBe("…");
  });
  it("installed:false → install path (mock)", () => {
    const v = networkView({ installed: false, loggedIn: false, ip4: null, magicDNS: false, tailscaleSSH: false });
    expect(v.statusLabel).toBe("not installed");
    expect(v.statusTone).toBe("danger");
    expect(v.installHint).not.toBeNull();
    // coverage B15: the installed:false path shows an ACTUAL install command + URL
    expect(v.installCmd).toBe("curl -fsSL https://tailscale.com/install.sh | sh");
    expect(v.installUrl).toBe("https://tailscale.com/download");
  });
  it("logged in → connected + ip/magicdns/ssh labels", () => {
    const status: TailscaleNetworkStatus = { installed: true, loggedIn: true, ip4: "100.101.5.12", magicDNS: true, tailscaleSSH: true };
    const v = networkView(status);
    expect(v.statusLabel).toBe("connected");
    expect(v.statusTone).toBe("success");
    expect(v.ip4).toBe("100.101.5.12");
    expect(v.magicDnsLabel).toBe("on");
    expect(v.sshLabel).toBe("tailscale ssh — keyless mode");
  });
  it("installed but logged out → warn", () => {
    const v = networkView({ installed: true, loggedIn: false, ip4: null, magicDNS: false, tailscaleSSH: false });
    expect(v.statusLabel).toBe("logged out");
    expect(v.statusTone).toBe("warn");
    expect(v.sshLabel).toBe("off");
  });
});

describe("cloudflareView (fed.cloudflare state) — CLOUDFLARE-APP-SURFACE", () => {
  const base: CloudflareProvisionStatus = {
    installed: false, provisioned: false, hostname: null,
    tunnelHealth: "unknown", selfprobe: "pending", accessTokenExpiry: null,
  };
  it("unconfigured — never provisioned (installed:false, provisioned:false, no in-flight probe)", () => {
    const v = cloudflareView({ ...base, selfprobe: "passed" as const, installed: false, provisioned: false });
    expect(v.state).toBe("unconfigured");
    expect(v.statusLabel).toBe("not configured");
    expect(v.statusTone).toBe("muted");
    expect(v.hostname).toBeNull();
  });
  it("provisioning — selfprobe pending", () => {
    const v = cloudflareView({ ...base, selfprobe: "pending" });
    expect(v.state).toBe("provisioning");
    expect(v.statusLabel).toBe("provisioning…");
    expect(v.statusTone).toBe("warn");
  });
  it("probe failed — steps ran but verification did not pass, must NOT read as ready", () => {
    const v = cloudflareView({ ...base, installed: true, provisioned: true, selfprobe: "failed", hostname: "peer.example.com" });
    expect(v.state).toBe("probeFailed");
    expect(v.statusLabel).toContain("probe failed");
    expect(v.statusTone).toBe("danger");
    expect(v.state).not.toBe("ready");
  });
  it("ready — installed && provisioned && selfprobe passed, shows the non-secret hostname", () => {
    const v = cloudflareView({ ...base, installed: true, provisioned: true, selfprobe: "passed", hostname: "peer.example.com" });
    expect(v.state).toBe("ready");
    expect(v.statusLabel).toBe("ready");
    expect(v.statusTone).toBe("success");
    expect(v.hostname).toBe("peer.example.com");
  });
  it("null → loading placeholder, same convention as networkView", () => {
    const v = cloudflareView(null);
    expect(v.loaded).toBe(false);
    expect(v.statusLabel).toBe("…");
  });
  it("every named state has a distinct, non-blank label", () => {
    const labels = new Set([
      cloudflareView({ ...base, selfprobe: "passed", installed: false, provisioned: false }).statusLabel,
      cloudflareView({ ...base, selfprobe: "pending" }).statusLabel,
      cloudflareView({ ...base, installed: true, provisioned: true, selfprobe: "failed" }).statusLabel,
      cloudflareView({ ...base, installed: true, provisioned: true, selfprobe: "passed" }).statusLabel,
    ]);
    expect(labels.size).toBe(4);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });
});

describe("authKeyBadge", () => {
  it("reflects only this-session storage (daemon never reports presence)", () => {
    expect(authKeyBadge(true)).toEqual({ label: "▪ set", tone: "success" });
    expect(authKeyBadge(false)).toEqual({ label: "not set", tone: "danger" });
  });
});

describe("daily cap parse / patch / format", () => {
  it("blank / none / '-' clears the cap (null)", () => {
    expect(parseDailyCap("")).toEqual({ ok: true, value: null });
    expect(parseDailyCap("  none ")).toEqual({ ok: true, value: null });
    expect(parseDailyCap("-")).toEqual({ ok: true, value: null });
  });
  it("a positive number (with optional $) sets it", () => {
    expect(parseDailyCap("5")).toEqual({ ok: true, value: 5 });
    expect(parseDailyCap("$12.50")).toEqual({ ok: true, value: 12.5 });
  });
  it("zero / negative / non-numeric are errors (nothing patched)", () => {
    expect(parseDailyCap("0").ok).toBe(false);
    expect(parseDailyCap("-3").ok).toBe(false);
    expect(parseDailyCap("abc").ok).toBe(false);
  });
  it("dailyCapPatch carries null through for the overlay deletion marker", () => {
    expect(dailyCapPatch(null)).toEqual({ dailyCapUsd: null });
    expect(dailyCapPatch(5)).toEqual({ dailyCapUsd: 5 });
  });
  it("fmtDailyCap renders money or 'none'", () => {
    expect(fmtDailyCap(5)).toBe("$5.00");
    expect(fmtDailyCap(null)).toBe("none");
    expect(fmtDailyCap(undefined)).toBe("none");
  });
});

describe("CONCURRENCY-CAP-UI: parseMaxAgentsTotal / maxAgentsTotalPatch", () => {
  it("a positive integer is accepted", () => {
    expect(parseMaxAgentsTotal("20")).toEqual({ ok: true, value: 20 });
  });
  it("blank / zero / negative / non-integer are errors — nothing patched", () => {
    expect(parseMaxAgentsTotal("").ok).toBe(false);
    expect(parseMaxAgentsTotal("0").ok).toBe(false);
    expect(parseMaxAgentsTotal("-3").ok).toBe(false);
    expect(parseMaxAgentsTotal("3.5").ok).toBe(false);
    expect(parseMaxAgentsTotal("abc").ok).toBe(false);
  });
  it("maxAgentsTotalPatch shapes the caps.maxAgentsTotal config.patch payload", () => {
    expect(maxAgentsTotalPatch(20)).toEqual({ caps: { maxAgentsTotal: 20 } });
  });
});

describe("CONCURRENCY-CAP-UI: the 'lowering never stops running agents' statement is a stable exported string", () => {
  it("names the actual semantics (refuses new spawns, never touches running agents)", () => {
    expect(LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS).toMatch(/never stops|never .*pauses/);
    expect(LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS).toMatch(/new spawns/);
  });
});

describe("CONCURRENCY-CAP-UI: concurrencyCapView — the three render states", () => {
  const running = 4;
  it("dynamic off ⇒ narrowing=false, cap===ceiling===maxAgentsTotal, explain=null", () => {
    const v = concurrencyCapView(12, null, null, running);
    expect(v).toEqual({ agentsRunning: 4, dynamicEnabled: false, narrowing: false, cap: 12, ceiling: 12, healthy: true, explain: null });
  });
  it("dynamic on, not narrowing ⇒ cap===ceiling, explain carries the live probe inputs", () => {
    const dynamicCap = { enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 } as DynamicCapConfig;
    const agentCap: AgentCapStatus = { cap: 12, ceiling: 12, healthy: true, cpuPressure: false, memPressure: false, load1: 3, cores: 12, freeMemGb: 10, explain: "load 3.0/12 cores, 10.0 GB free" };
    const v = concurrencyCapView(12, dynamicCap, agentCap, running);
    expect(v.dynamicEnabled).toBe(true);
    expect(v.narrowing).toBe(false);
    expect(v.cap).toBe(12);
    expect(v.ceiling).toBe(12);
    expect(v.explain).toBe("load 3.0/12 cores, 10.0 GB free");
  });
  it("dynamic on, actively narrowing ⇒ cap<ceiling, narrowing=true, explain present", () => {
    const dynamicCap = { enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 } as DynamicCapConfig;
    const agentCap: AgentCapStatus = { cap: 5, ceiling: 12, healthy: true, cpuPressure: true, memPressure: false, load1: 11.4, cores: 12, freeMemGb: 3.2, explain: "load 11.4/12 cores, 3.2 GB free" };
    const v = concurrencyCapView(12, dynamicCap, agentCap, running);
    expect(v.narrowing).toBe(true);
    expect(v.cap).toBe(5);
    expect(v.ceiling).toBe(12);
    expect(v.explain).toBe("load 11.4/12 cores, 3.2 GB free");
  });
  it("dynamic config present but enabled=false renders as the off state (no empty/meaningless dynamic row)", () => {
    const dynamicCap = { enabled: false, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 } as DynamicCapConfig;
    const v = concurrencyCapView(12, dynamicCap, null, running);
    expect(v.dynamicEnabled).toBe(false);
    expect(v.narrowing).toBe(false);
    expect(v.explain).toBeNull();
  });
});

describe("CONCURRENCY-CAP-UI: dynamicCapDraft / parseDynamicCapDraft (validated via the real DynamicCapConfigSchema)", () => {
  it("null config ⇒ draft pre-filled with the schema's own defaults (enabled false)", () => {
    const d = dynamicCapDraft(null);
    expect(d.enabled).toBe(false);
    expect(d.floor).toBe("2");
    expect(d.emaAlpha).toBe("0.3");
  });
  it("an existing config round-trips through the draft", () => {
    const cfg = { enabled: true, floor: 3, cpuHighWatermark: 0.8, cpuLowWatermark: 0.6, cpuCriticalRatio: 1.4, memLowWatermarkGb: 1, memHighWatermarkGb: 3, memCriticalGb: 0.25, emaAlpha: 0.5 } as DynamicCapConfig;
    const d = dynamicCapDraft(cfg);
    expect(d).toEqual({
      enabled: true, floor: "3", cpuHighWatermark: "0.8", cpuLowWatermark: "0.6", cpuCriticalRatio: "1.4",
      memLowWatermarkGb: "1", memHighWatermarkGb: "3", memCriticalGb: "0.25", emaAlpha: "0.5",
    });
  });
  it("a valid draft parses to a full DynamicCapConfig", () => {
    const parsed = parseDynamicCapDraft(dynamicCapDraft(null));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.floor).toBe(2);
  });
  it("a non-numeric field is rejected — nothing patched", () => {
    const draft = dynamicCapDraft(null);
    const parsed = parseDynamicCapDraft({ ...draft, floor: "abc" });
    expect(parsed.ok).toBe(false);
  });
  it("an out-of-schema-range value (emaAlpha > 1) is rejected by the REAL schema constraint", () => {
    const draft = dynamicCapDraft(null);
    const parsed = parseDynamicCapDraft({ ...draft, emaAlpha: "1.5" });
    expect(parsed.ok).toBe(false);
  });
  it("floor=0 (not positive) is rejected", () => {
    const draft = dynamicCapDraft(null);
    const parsed = parseDynamicCapDraft({ ...draft, floor: "0" });
    expect(parsed.ok).toBe(false);
  });
  it("dynamicCapPatch shapes the caps.dynamicCap config.patch payload", () => {
    const cfg = { enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 } as DynamicCapConfig;
    expect(dynamicCapPatch(cfg)).toEqual({ caps: { dynamicCap: cfg } });
    expect(dynamicCapPatch(null)).toEqual({ caps: { dynamicCap: null } });
  });
});

describe("CONCURRENCY-CAP-UI: per-account cap parse / patch", () => {
  it("blank clears (null)", () => {
    expect(parsePerAccountCap("")).toEqual({ ok: true, value: null });
    expect(parsePerAccountCap("  ")).toEqual({ ok: true, value: null });
  });
  it("a positive integer sets it", () => {
    expect(parsePerAccountCap("3")).toEqual({ ok: true, value: 3 });
  });
  it("zero / negative / non-integer are errors", () => {
    expect(parsePerAccountCap("0").ok).toBe(false);
    expect(parsePerAccountCap("-1").ok).toBe(false);
    expect(parsePerAccountCap("1.5").ok).toBe(false);
  });
  it("perAccountCapPatch keys the single account under caps.perAccount — a merge patch never clobbers siblings", () => {
    expect(perAccountCapPatch("main", 3)).toEqual({ caps: { perAccount: { main: 3 } } });
    expect(perAccountCapPatch("main", null)).toEqual({ caps: { perAccount: { main: null } } });
  });
});

describe("ONBOARDING-GATE R1: validateImportDir", () => {
  it("blank clears back to the daemon default (null)", () => {
    expect(validateImportDir("")).toEqual({ ok: true, value: null });
    expect(validateImportDir("   ")).toEqual({ ok: true, value: null });
  });
  it("a POSIX absolute path is accepted verbatim (trimmed)", () => {
    expect(validateImportDir("  /home/me/chimera-projects  ")).toEqual({ ok: true, value: "/home/me/chimera-projects" });
  });
  it("a Windows drive-letter or UNC path is accepted", () => {
    expect(validateImportDir("C:\\Users\\me\\projects").ok).toBe(true);
    expect(validateImportDir("C:/Users/me/projects").ok).toBe(true);
    expect(validateImportDir("\\\\host\\share\\projects").ok).toBe(true);
  });
  it("a relative path is rejected", () => {
    const parsed = validateImportDir("relative/projects");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/absolute/);
  });
});

describe("MCP store add-form field parsing", () => {
  it("parseArgsInput splits on commas and whitespace, dropping blanks", () => {
    expect(parseArgsInput("-y @some/mcp-server")).toEqual(["-y", "@some/mcp-server"]);
    expect(parseArgsInput("a, b,  c")).toEqual(["a", "b", "c"]);
    expect(parseArgsInput("  ")).toEqual([]);
    expect(parseArgsInput("")).toEqual([]);
  });
  it("parseEnvInput parses comma-separated KEY=value pairs", () => {
    expect(parseEnvInput("API_KEY=shh, OTHER=v2")).toEqual({ ok: true, value: { API_KEY: "shh", OTHER: "v2" } });
    expect(parseEnvInput("")).toEqual({ ok: true, value: {} });
  });
  it("parseEnvInput rejects a segment with no '='", () => {
    const result = parseEnvInput("API_KEY=shh, broken");
    expect(result.ok).toBe(false);
  });
});

describe("F23-2B: buildProviderCatalogRows (providers.list view model)", () => {
  const XAI: ProviderCatalogItem = {
    id: "xai", label: "xAI (Grok)", kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.5",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: false },
    tosNote: null, experimental: false, override: null, accounts: [],
  };
  const CLAUDE: ProviderCatalogItem = {
    id: "claude", label: "Claude", kind: "agentic-sdk",
    baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-4-8",
    authModes: ["apiKey", "oauth"], capabilities: { tools: true, vision: true, streaming: true },
    tosNote: "Pro/Max rides the SDK login.", experimental: false, override: null,
    accounts: [{ name: "main", authType: "subscription" }],
  };
  const COPILOT: ProviderCatalogItem = {
    id: "copilot", label: "GitHub Copilot", kind: "openai-compat",
    baseUrl: "https://api.githubcopilot.com", defaultModel: "gpt-5.1",
    authModes: ["oauth"], capabilities: { tools: true, vision: false, streaming: true },
    tosNote: null, experimental: true, override: { baseUrl: "https://proxy/v1" }, accounts: [],
  };
  // KIMI-BACKEND S4: new agentic-sdk catalog entry (spec §5) — proves the subscription
  // button's existing kind:"agentic-sdk" logic lights up for kimi with zero selector changes.
  const KIMI: ProviderCatalogItem = {
    id: "kimi", label: "Kimi (agent SDK)", kind: "agentic-sdk",
    baseUrl: "https://api.kimi.com", defaultModel: "kimi-k3",
    authModes: ["oauth"], capabilities: { tools: true, vision: true, streaming: true },
    tosNote: "Kimi Code subscription access rides the official Kimi Agent SDK / CLI login.",
    experimental: false, override: null, accounts: [],
  };

  it("kimi (agentic-sdk, no api key auth mode): subscription button shows enabled, no api-key path", () => {
    const [row] = buildProviderCatalogRows([KIMI]);
    expect(row).toMatchObject({ supportsApiKey: false, supportsSubscriptionLogin: true, subscriptionLoginConnected: false });
  });

  it("kimi subscriptionLoginConnected flips true once a subscription-typed account exists", () => {
    const connected: ProviderCatalogItem = { ...KIMI, accounts: [{ name: "kimi", authType: "subscription" }] };
    const [row] = buildProviderCatalogRows([connected]);
    expect(row).toMatchObject({ connected: true, subscriptionLoginConnected: true });
  });

  it("maps capabilities into ordered chips (tools/vision/streaming)", () => {
    const [row] = buildProviderCatalogRows([XAI]);
    expect(row!.chips).toEqual([
      { key: "tools", label: "tools", on: true },
      { key: "vision", label: "vision", on: true },
      { key: "streaming", label: "streaming", on: false },
    ]);
  });

  it("connection state: not connected vs. N accounts", () => {
    expect(buildProviderCatalogRows([XAI])[0]).toMatchObject({ connected: false, connectionLabel: "not connected" });
    expect(buildProviderCatalogRows([CLAUDE])[0]).toMatchObject({ connected: true, connectionLabel: "1 account" });
  });

  it("supportsApiKey / supportsSubscription derive from authModes; subscriptionAvailable mirrors supportsSubscription (KIMI-CODE-SUBSCRIPTION-UI: F23-2A shipped, no longer a hardcoded 'coming soon')", () => {
    const [xai, claude, copilot] = buildProviderCatalogRows([XAI, CLAUDE, COPILOT]);
    expect(xai).toMatchObject({ supportsApiKey: true, supportsSubscription: false, subscriptionAvailable: false });
    expect(claude).toMatchObject({ supportsApiKey: true, supportsSubscription: true, subscriptionAvailable: true });
    expect(copilot).toMatchObject({ supportsApiKey: false, supportsSubscription: true, subscriptionAvailable: true });
  });

  it("subscriptionOAuthConnected requires an oauth-typed account AND no failed test probe", () => {
    const noAccount = buildProviderCatalogRows([COPILOT])[0]!;
    expect(noAccount.subscriptionOAuthConnected).toBe(false);

    const withAccount: ProviderCatalogItem = { ...COPILOT, accounts: [{ name: "copilot", authType: "oauth" }] };
    const untested = buildProviderCatalogRows([withAccount])[0]!;
    expect(untested.subscriptionOAuthConnected).toBe(true); // no test yet -> optimistic, matches pre-existing "connected" semantics elsewhere

    const okTested = buildProviderCatalogRows([withAccount], { copilot: "ok" })[0]!;
    expect(okTested.subscriptionOAuthConnected).toBe(true);

    const failedTested = buildProviderCatalogRows([withAccount], { copilot: "auth_error" })[0]!;
    expect(failedTested.subscriptionOAuthConnected).toBe(false);
  });

  it("experimental + overridden pass through", () => {
    const [row] = buildProviderCatalogRows([COPILOT]);
    expect(row).toMatchObject({ experimental: true, overridden: true });
  });

  it("preserves input order (the RPC already returns catalog order)", () => {
    expect(buildProviderCatalogRows([COPILOT, XAI, CLAUDE]).map((r) => r.id)).toEqual(["copilot", "xai", "claude"]);
  });
});

describe("ONBOARDING-PROVIDER: providerOptionsFor", () => {
  it("includes a no-key custom provider in the account and spawn selectors", () => {
    const custom = buildProviderCatalogRows([{
      ...XAI,
      id: "ollama-local",
      label: "Ollama (local)",
      baseUrl: "http://127.0.0.1:3333/v1",
      defaultModel: "qwen3.5:9b-mlx",
      custom: true,
      requiresKey: false,
    }])[0]!;
    expect(custom).toMatchObject({ id: "ollama-local", custom: true, requiresKey: false });
    expect(providerOptionsFor([custom])).toEqual(["ollama-local"]);
  });
  const XAI: ProviderCatalogItem = {
    id: "xai", label: "xAI (Grok)", kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.5",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: false },
    tosNote: null, experimental: false, override: null, accounts: [],
  };
  const CLAUDE: ProviderCatalogItem = {
    id: "claude", label: "Claude", kind: "agentic-sdk",
    baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-4-8",
    authModes: ["apiKey", "oauth"], capabilities: { tools: true, vision: true, streaming: true },
    tosNote: null, experimental: false, override: null, accounts: [],
  };
  const COPILOT: ProviderCatalogItem = {
    id: "copilot", label: "GitHub Copilot", kind: "openai-compat",
    baseUrl: "https://api.githubcopilot.com", defaultModel: "gpt-5.1",
    authModes: ["oauth"], capabilities: { tools: true, vision: false, streaming: true },
    tosNote: null, experimental: true, override: null, accounts: [],
  };

  it("includes both apiKey- and subscription-capable providers", () => {
    expect(providerOptionsFor(buildProviderCatalogRows([XAI, CLAUDE]))).toEqual(["xai", "claude"]);
  });
  it("excludes a provider with neither apiKey nor CLI-subscription support, falling back to the built-ins when nothing else qualifies", () => {
    expect(providerOptionsFor(buildProviderCatalogRows([COPILOT]))).toEqual([...FALLBACK_PROVIDER_OPTIONS]);
    expect(providerOptionsFor(buildProviderCatalogRows([COPILOT, XAI]))).toEqual(["xai"]); // xai still qualifies, copilot dropped
  });
  it("falls back to the built-in agentic-sdk ids before the catalog loads", () => {
    expect(providerOptionsFor([])).toEqual([...FALLBACK_PROVIDER_OPTIONS]);
  });
  it("KIMI-BACKEND S4: fallback options include kimi (pre-providers.list dropdown parity)", () => {
    expect(FALLBACK_PROVIDER_OPTIONS).toContain("kimi");
  });
});

describe("F23-2B: parseProviderOverride / providerOverridePatch", () => {
  it("both blank clears the override (null)", () => {
    expect(parseProviderOverride("", "  ")).toBeNull();
  });
  it("trims and keeps only the non-blank fields", () => {
    expect(parseProviderOverride(" https://proxy/v1 ", "")).toEqual({ baseUrl: "https://proxy/v1" });
    expect(parseProviderOverride("", "gpt-5.1-mini")).toEqual({ defaultModel: "gpt-5.1-mini" });
    expect(parseProviderOverride("https://proxy/v1", "gpt-5.1-mini")).toEqual({ baseUrl: "https://proxy/v1", defaultModel: "gpt-5.1-mini" });
  });
  it("providerOverridePatch wraps the value under the provider id", () => {
    expect(providerOverridePatch("openai", { defaultModel: "gpt-5.1-mini" })).toEqual({ providerOverrides: { openai: { defaultModel: "gpt-5.1-mini" } } });
    expect(providerOverridePatch("openai", null)).toEqual({ providerOverrides: { openai: null } });
  });
  // EXPLICIT-NULL-ESCAPE (M-1 fix): the INNER null means "native" and must SURVIVE the overlay,
  // so it goes out as the escape token; the OUTER null means "drop the override" and stays a real
  // null so RFC-7396 deletes the entry. Sending a real inner null was the bug — it deleted the key
  // and resolution fell back to the fleet default.
  it("providerOverridePatch encodes an explicit null compactionThreshold as the escape", () => {
    expect(providerOverridePatch("claude", { compactionThreshold: null })).toEqual({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
  });
  it("providerOverridePatch leaves a numeric or absent threshold alone", () => {
    expect(providerOverridePatch("claude", { compactionThreshold: 90_000 })).toEqual({ providerOverrides: { claude: { compactionThreshold: 90_000 } } });
    expect(providerOverridePatch("claude", { baseUrl: "https://proxy/v1" })).toEqual({ providerOverrides: { claude: { baseUrl: "https://proxy/v1" } } });
  });

  it("the native flag emits the explicit null and ignores the tokens field", () => {
    expect(parseProviderOverride("", "", "90000", true)).toEqual({ compactionThreshold: null });
    expect(parseProviderOverride("", "", "", true)).toEqual({ compactionThreshold: null });
    expect(parseProviderOverride("https://proxy/v1", "", "", true)).toEqual({ baseUrl: "https://proxy/v1", compactionThreshold: null });
  });
  it("native-only round-trips to a patch that SETS native, never one that clears the entry", () => {
    expect(providerOverridePatch("claude", parseProviderOverride("", "", "", true)))
      .toEqual({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
  });
  it("a numeric threshold is unaffected by the flag being off", () => {
    expect(parseProviderOverride("", "", "90000")).toEqual({ compactionThreshold: 90_000 });
    expect(parseProviderOverride("", "", "", false)).toBeNull();
  });
});

// F39.QA-A (finding M-1): "nothing set" stopped meaning native the moment F39 shipped a fleet
// default — the card used to print "native" for it, which was simply false for claude.
describe("F39.QA-A: compactionThresholdLabel", () => {
  it("a number reads as that number", () => {
    expect(compactionThresholdLabel("claude", 90_000)).toBe("90000 tokens");
  });
  it("an explicit null reads as native", () => {
    expect(compactionThresholdLabel("claude", null)).toBe("native (model window)");
  });
  it("absent reads as the provider's fleet default when it has one, and native when it does not", () => {
    expect(compactionThresholdLabel("claude", undefined)).toBe("120000 tokens (fleet default)");
    expect(compactionThresholdLabel("codex", undefined)).toBe("native (model window)");
  });
});

describe("sectionsForEvent (self-refresh mapping — no refresh button)", () => {
  it("config_changed refreshes providers + general (both live in config)", () => {
    expect(sectionsForEvent("config_changed")).toEqual(["providers", "general"]);
  });
  it("network_changed refreshes network + cloudflare (CLOUDFLARE-APP-SURFACE); peer_paired refreshes network only", () => {
    expect(sectionsForEvent("network_changed")).toEqual(["network", "cloudflare"]);
    expect(sectionsForEvent("peer_paired")).toEqual(["network"]);
  });
  it("config_error is NOT a refresh (it is a toast)", () => {
    expect(sectionsForEvent("config_error")).toEqual([]);
  });
  it("unrelated kinds map to nothing", () => {
    expect(sectionsForEvent("tool_call")).toEqual([]);
  });
});

describe("MCP-STORE-TOOLS-UI: per-server tool list view helpers", () => {
  it("mcpToolsRow defaults an unfetched server to idle/empty", () => {
    expect(mcpToolsRow({}, "chrome-devtools")).toEqual(MCP_TOOLS_IDLE);
  });
  it("mcpToolsRow returns the stored row when present", () => {
    const row: McpToolsRow = { status: "loaded", connected: true, tools: [] };
    expect(mcpToolsRow({ "chrome-devtools": row }, "chrome-devtools")).toBe(row);
  });

  it("mcpToolsBadge is null before a row has loaded (idle or loading)", () => {
    expect(mcpToolsBadge(MCP_TOOLS_IDLE)).toBeNull();
    expect(mcpToolsBadge({ status: "loading", connected: false, tools: [] })).toBeNull();
  });
  it("mcpToolsBadge reports the tool count once connected", () => {
    const tool = { server: "s", name: "navigate_page", description: "go", inputSchema: {} };
    expect(mcpToolsBadge({ status: "loaded", connected: true, tools: [tool, tool] })).toBe("2 tools");
  });
  it("mcpToolsBadge reports \"error\" for a failed connect", () => {
    expect(mcpToolsBadge({ status: "loaded", connected: false, error: "Connection closed", tools: [] })).toBe("error");
  });

  it("mcpToolsStatusLine formats a connected server with its tool count", () => {
    const tool = { server: "s", name: "navigate_page", description: "go", inputSchema: {} };
    expect(mcpToolsStatusLine({ status: "loaded", connected: true, tools: [tool] })).toBe("● connected · 1 tools");
  });
  it("mcpToolsStatusLine surfaces the connect error verbatim", () => {
    expect(mcpToolsStatusLine({ status: "loaded", connected: false, error: "Connection closed", tools: [] })).toBe("✗ Connection closed");
  });
  it("mcpToolsStatusLine distinguishes connected-zero-tools from an error", () => {
    expect(mcpToolsStatusLine({ status: "loaded", connected: true, tools: [] })).toBe("● connected · 0 tools");
  });
  it("mcpToolsStatusLine is blank while idle/loading", () => {
    expect(mcpToolsStatusLine(MCP_TOOLS_IDLE)).toBe("");
    expect(mcpToolsStatusLine({ status: "loading", connected: false, tools: [] })).toBe("connecting…");
  });

  it("truncateToolDescription passes short descriptions through unchanged", () => {
    expect(truncateToolDescription("Navigate to a URL")).toBe("Navigate to a URL");
  });
  it("truncateToolDescription collapses whitespace/newlines to one line", () => {
    expect(truncateToolDescription("Navigate\nto  a\turl")).toBe("Navigate to a url");
  });
  it("truncateToolDescription caps long descriptions with an ellipsis", () => {
    const long = "x".repeat(150);
    const out = truncateToolDescription(long, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

// MCPSTORE-LIFECYCLE-UI: the installed-row auth control's view model — showAuthorize must
// be unconditional for every http row (no dependence on the detect probe), the label must
// flip to Re-authorize once connected (not disappear), and the oauth error must surface for
// any authKind, not just an already-oauth-kind row.
describe("MCPSTORE-LIFECYCLE-UI: mcpStoreAuthRowView", () => {
  const idleTools: McpToolsRow = { status: "idle", connected: false, tools: [] };

  it("shows the auth control for a bearer http row with no detect probe involved at all", () => {
    const view = mcpStoreAuthRowView({ type: "http", authKind: "bearer", toolsConnected: false, toolsStatus: idleTools.status });
    expect(view.showAuthorize).toBe(true);
    expect(view.authorizeLabel).toBe("Authorize");
    expect(view.needsConvert).toBe(true);
  });

  it("shows the auth control for a no-auth (auth undefined) http row — e.g. a plain import", () => {
    const view = mcpStoreAuthRowView({ type: "http", authKind: undefined, toolsConnected: false, toolsStatus: "idle" });
    expect(view.showAuthorize).toBe(true);
    expect(view.needsConvert).toBe(true);
  });

  it("never shows the auth control for a stdio row", () => {
    expect(mcpStoreAuthRowView({ type: "stdio", toolsConnected: false, toolsStatus: "idle" }).showAuthorize).toBe(false);
  });

  it("an already oauth-kind row does not need convert", () => {
    expect(mcpStoreAuthRowView({ type: "http", authKind: "oauth", toolsConnected: false, toolsStatus: "idle" }).needsConvert).toBe(false);
  });

  it("labels Re-authorize (not hidden) once the oauth status is connected", () => {
    const view = mcpStoreAuthRowView({ type: "http", authKind: "oauth", oauth: { status: "connected" }, toolsConnected: false, toolsStatus: "idle" });
    expect(view.showAuthorize).toBe(true);
    expect(view.authorizeLabel).toBe("Re-authorize");
    expect(view.connected).toBe(true);
  });

  it("labels Re-authorize once the lazily-loaded tools row confirms connected (no oauth state yet)", () => {
    const view = mcpStoreAuthRowView({ type: "http", authKind: "oauth", toolsConnected: true, toolsStatus: "loaded" });
    expect(view.authorizeLabel).toBe("Re-authorize");
  });

  it("busy while starting, awaiting the browser open, or polling", () => {
    expect(mcpStoreAuthRowView({ type: "http", oauth: { status: "starting" }, toolsConnected: false, toolsStatus: "idle" }).busy).toBe(true);
    expect(mcpStoreAuthRowView({ type: "http", oauth: { status: "awaiting" }, toolsConnected: false, toolsStatus: "idle" }).busy).toBe(true);
    expect(mcpStoreAuthRowView({ type: "http", oauth: { status: "polling" }, toolsConnected: false, toolsStatus: "idle" }).busy).toBe(true);
  });

  it("surfaces the oauth error for a bearer/no-auth row, not just an already-oauth row", () => {
    const view = mcpStoreAuthRowView({ type: "http", authKind: "bearer", oauth: { status: "error", error: "not configured for oauth" }, toolsConnected: false, toolsStatus: "idle" });
    expect(view.errorMessage).toBe("not configured for oauth");
  });

  it("errorMessage is null absent an error status", () => {
    expect(mcpStoreAuthRowView({ type: "http", toolsConnected: false, toolsStatus: "idle" }).errorMessage).toBeNull();
  });
});

describe("MCPSTORE-LIFECYCLE-UI: mcpStoreIsEnabled", () => {
  it("true when enabled is explicitly true, or absent (back-compat default)", () => {
    expect(mcpStoreIsEnabled({ enabled: true })).toBe(true);
    expect(mcpStoreIsEnabled({})).toBe(true);
  });
  it("false only when explicitly false", () => {
    expect(mcpStoreIsEnabled({ enabled: false })).toBe(false);
  });
});

// MCP-OAUTH slice 3: the add-remote form's scope catalog + selection folding.
describe("MCP-OAUTH scope selection", () => {
  // MCP-OAUTH-FOREIGN-SCOPES: the catalog is an operator-configured gateway's downstream scope
  // list (config `mcpOAuthGateways`). It used to be pre-checked for EVERY http server, which is
  // how connecting cloudflare ended up asking a foreign authorization server for the gateway's
  // scope names and coming back Unauthorized. The catalog is now url-aware: only a url on a
  // configured gateway's hosts gets one.
  const GATEWAYS: McpOAuthGateway[] = [
    { hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets", "wiki"], optionalScopes: ["admin"] },
  ];
  const GW_URL = "https://gateway.example.com/mcp";
  const catalog = mcpOAuthScopeCatalog(GW_URL, GATEWAYS);

  it("defaultMcpOAuthScopeSelection checks every default scope and leaves optional ones off, for a gateway url", () => {
    const sel = defaultMcpOAuthScopeSelection(GW_URL, GATEWAYS);
    for (const scope of catalog) {
      expect(sel[scope]).toBe(scope !== "admin");
    }
  });
  it("pre-checks nothing for a foreign server, or before a url is typed", () => {
    for (const sel of [defaultMcpOAuthScopeSelection("https://mcp.cloudflare.com/mcp", GATEWAYS), defaultMcpOAuthScopeSelection(undefined, GATEWAYS)]) {
      expect(Object.values(sel).some(Boolean)).toBe(false);
    }
  });
  it("resolveMcpOAuthScopes folds the checked defaults (catalog order) with no extras", () => {
    expect(resolveMcpOAuthScopes(defaultMcpOAuthScopeSelection(GW_URL, GATEWAYS), "", catalog)).toEqual(["docs", "tickets", "wiki"]);
  });
  it("resolveMcpOAuthScopes appends trimmed, deduped free-text extras", () => {
    const sel = defaultMcpOAuthScopeSelection(GW_URL, GATEWAYS);
    expect(resolveMcpOAuthScopes(sel, " custom-a , custom-b ,, docs ", catalog)).toEqual([
      "docs", "tickets", "wiki", "custom-a", "custom-b",
    ]);
  });
  it("resolveMcpOAuthScopes drops unchecked scopes entirely", () => {
    const sel = defaultMcpOAuthScopeSelection(GW_URL, GATEWAYS);
    sel["wiki"] = false;
    expect(resolveMcpOAuthScopes(sel, "", catalog)).not.toContain("wiki");
  });
});
