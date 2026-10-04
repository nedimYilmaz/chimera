import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChimeraConfigSchema, DEFAULT_COMPACTION_THRESHOLD, type AccountAuth, type AccountConfig, type ChimeraConfig } from "@chimera/protocol";
import type { CompactionThresholdSource } from "./backend.js";
import type { Keychain } from "./keychain.js";
import type { OAuthTokenStore } from "./providers/oauth.js";

export class ConfigError extends Error {
  code = "protocol" as const;
  name = "ConfigError";
}

export function loadConfig(home: string): ChimeraConfig {
  const file = join(home, "config.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // a syntactically-malformed config.json is a PARSE failure, not a read
    // failure — mislabeling it "cannot read" is misleading for the operator
    // fixing the file (it read fine; the JSON in it is broken).
    throw new ConfigError(`cannot parse ${file}: ${(e as Error).message}`);
  }
  const parsed = ChimeraConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const names = new Set(parsed.data.accounts.map((a) => a.name));
  // reject duplicate account names: byName (get/capFor) would keep only the
  // last, while list() shows both — a silent list()/get() inconsistency
  if (names.size !== parsed.data.accounts.length) {
    throw new ConfigError(`duplicate account name in config (account names must be unique)`);
  }
  for (const n of parsed.data.autoOrder) {
    if (!names.has(n)) throw new ConfigError(`autoOrder references unknown account "${n}"`);
  }
  return parsed.data;
}

// ACCOUNT-KEY-PRESENCE: accounts.list previously carried only {name, provider, authType} —
// no RPC ever reported whether a keychain/env/command/oauth account's secret was actually
// STORED, so a freshly-restarted UI (nothing tested yet this session) always showed
// "missing" until the operator pressed `t`. This checks PRESENCE only (a boolean), never
// the secret value itself — D0's write-only invariant is unaffected. Cheap by design: a
// single keychain/oauth-store lookup or an env-var read, never a network probe or a command
// execution (a "command" auth's `run` is schema-required non-empty, so its presence is
// structural — actually invoking it here would be a live probe, not a presence check).
export async function accountHasKey(
  auth: AccountAuth,
  keychain: Pick<Keychain, "get">,
  oauthStore?: Pick<OAuthTokenStore, "load">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  switch (auth.type) {
    case "subscription":
      return false; // no stored secret; keyBadge treats subscription as "set" before ever consulting hasKey
    case "env":
      return !!env[auth.var]?.trim();
    case "keychain":
      return (await keychain.get(auth.service)) !== null;
    case "command":
      return auth.run.trim() !== "";
    case "oauth":
      return oauthStore ? (await oauthStore.load(auth.tokenRef)) !== null : false;
  }
}

export class AccountRegistry {
  private byName = new Map<string, AccountConfig>();
  constructor(private cfg: ChimeraConfig) {
    for (const a of cfg.accounts) this.byName.set(a.name, a);
  }
  // D7 (hot-reload, coverage C9/C10): swap the registry's config in place when the
  // effective config changes. The supervisor holds THIS same AccountRegistry instance,
  // so the next spawn resolves against the new account set — while running spawns keep
  // the credentials they were launched with (their env was injected at spawn time and is
  // never revisited here). Additive: the constructor path is unchanged.
  reload(cfg: ChimeraConfig): void {
    this.cfg = cfg;
    this.byName = new Map<string, AccountConfig>();
    for (const a of cfg.accounts) this.byName.set(a.name, a);
  }
  get(name: string): AccountConfig {
    const a = this.byName.get(name);
    if (!a) throw new ConfigError(`unknown account "${name}"`);
    return a;
  }
  list() {
    return this.cfg.accounts.map((a) => ({
      name: a.name, provider: a.provider, authType: a.auth.type,
      // OAUTH-TOKEN-ACCOUNTS: only present for a keychain account whose key has been
      // classified (accounts.setKey) — an old/never-classified account omits it, and
      // callers default that to "apiKey" (the historical unconditional behavior).
      ...(a.auth.type === "keychain" && a.auth.credentialType ? { credentialType: a.auth.credentialType } : {}),
      // REMOTE-CONTROL-CAPABILITY: derived statically from auth type, never probed —
      // the provider only permits its claude.ai/code bridge for subscription-authed
      // sessions (verified empirically; oauthToken/apiKey credentials are refused
      // server-side). Additive field: an existing caller that ignores it sees the
      // exact same object shape as before.
      remoteControlCapable: a.auth.type === "subscription",
    }));
  }
  autoOrder(): string[] { return this.cfg.autoOrder; }
  preferredProvider(): string | undefined { return this.cfg.preferredProvider; }
  capFor(name: string): number { return this.cfg.caps.perAccount[name] ?? this.cfg.caps.maxAgentsTotal; }
  maxTotal(): number { return this.cfg.caps.maxAgentsTotal; }
  // WS-OPT (model tiering): the configured cheap model for depth>0 sub-agents, or
  // undefined when unset ⇒ the supervisor stamps nothing and behavior is unchanged.
  subAgentModel(): string | undefined { return this.cfg.caps.subAgentModel; }
  // TOKEN-OPT-P5: the configured fast/cheap model for a given provider, or undefined
  // when unset for that provider ⇒ callers (supervisor.trySwitchToFastModel) no-op.
  fastModelFor(provider: string): string | undefined { return this.cfg.caps.fastModel[provider]; }
  // COMPACTION-THRESHOLD-CONFIG: the effective compaction trigger (tokens) for a spawn on
  // this account/provider pair, or undefined ⇒ native behavior. A per-account override
  // (AccountConfigSchema.compactionThreshold) always wins over the per-provider default
  // (ProviderOverrideSchema.compactionThreshold via providerOverrides); an unknown account
  // name (never called with one — routeAccount always resolves a real name first) falls
  // through to the provider-level value. Since F39, "nothing configured" is no longer
  // automatically native: a provider with a DEFAULT_COMPACTION_THRESHOLD entry (claude) gets
  // that number instead, and only a provider without one still returns undefined — or an operator
  // writes an explicit null at either rung, which means native and stops the chain there.
  compactionThresholdFor(provider: string, accountName: string): number | undefined {
    return this.compactionThresholdWithSource(provider, accountName).value;
  }
  // L1-MEASURE (F39): the same precedence, reporting WHICH rung answered so a compaction event can
  // state what it fired against. This is the ONE implementation — compactionThresholdFor above is a
  // wrapper over it, so the chain can never drift into two copies that disagree.
  compactionThresholdWithSource(provider: string, accountName: string): { value: number | undefined; source: CompactionThresholdSource } {
    // F39.QA-A: an EXPLICIT null at a rung is a value, not an absence — it means "native" and
    // short-circuits. It must NOT fall through to a lower rung, or the fleet default would make
    // native inexpressible and the documented one-line rollback impossible (QA finding M-1).
    const perAccount = this.byName.get(accountName)?.compactionThreshold;
    if (perAccount === null) return { value: undefined, source: "native" };
    if (perAccount !== undefined) return { value: perAccount, source: "account" };
    const perProvider = this.cfg.providerOverrides?.[provider]?.compactionThreshold;
    if (perProvider === null) return { value: undefined, source: "native" };
    if (perProvider !== undefined) return { value: perProvider, source: "provider" };
    // L1-DEFAULT-THRESHOLD (F39): the measured fleet default is the last rung, and it lives HERE
    // rather than in the compactionThresholdFor wrapper on purpose — a `?? DEFAULT` up there
    // would hand back a real number while `source` still said "native", which is exactly the
    // two-copies-that-disagree failure the wrapper exists to prevent.
    const fleetDefault = DEFAULT_COMPACTION_THRESHOLD[provider];
    if (fleetDefault !== undefined) return { value: fleetDefault, source: "default" };
    return { value: undefined, source: "native" };
  }
}
