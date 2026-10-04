import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, AccountRegistry, ConfigError, accountHasKey } from "@chimera/core/accounts";
import { DEFAULT_COMPACTION_THRESHOLD } from "@chimera/protocol";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { OAuthTokenStore } from "@chimera/core/providers/oauth";

const CFG = {
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ],
  autoOrder: ["main", "second"],
  caps: { maxAgentsTotal: 5, perAccount: { second: 2 } },
};

function writeCfg(obj: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(obj));
  return home;
}

describe("loadConfig / AccountRegistry", () => {
  it("loads and exposes accounts without auth details", () => {
    const reg = new AccountRegistry(loadConfig(writeCfg(CFG)));
    expect(reg.autoOrder()).toEqual(["main", "second"]);
    expect(reg.get("second").auth.type).toBe("keychain");
    expect(reg.list()).toEqual([
      { name: "main", provider: "claude", authType: "subscription", remoteControlCapable: true },
      { name: "second", provider: "claude", authType: "keychain", remoteControlCapable: false },
    ]);
    expect(reg.capFor("second")).toBe(2);
    expect(reg.capFor("main")).toBe(5);   // falls back to maxAgentsTotal
    expect(reg.maxTotal()).toBe(5);
    expect(reg.subAgentModel()).toBeUndefined();   // WS-OPT: unset ⇒ no tiering override
  });
  it("exposes caps.subAgentModel when configured (WS-OPT model tiering)", () => {
    const reg = new AccountRegistry(loadConfig(writeCfg({
      ...CFG, caps: { maxAgentsTotal: 5, perAccount: {}, subAgentModel: "claude-sonnet-5" },
    })));
    expect(reg.subAgentModel()).toBe("claude-sonnet-5");
  });
  // REMOTE-CONTROL-CAPABILITY: derived statically from auth type — subscription is
  // capable, oauthToken/apiKey (any keychain credentialType) is not, regardless of the
  // classified credentialType label itself.
  it("marks an oauthToken-classified keychain account as remote-control incapable", () => {
    const reg = new AccountRegistry(loadConfig(writeCfg({
      ...CFG,
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "oat", provider: "claude", auth: { type: "keychain", service: "svc2", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" } },
      ],
      autoOrder: ["main", "oat"],
    })));
    expect(reg.list()).toEqual([
      { name: "main", provider: "claude", authType: "subscription", remoteControlCapable: true },
      { name: "oat", provider: "claude", authType: "keychain", credentialType: "oauthToken", remoteControlCapable: false },
    ]);
  });
  it("rejects autoOrder entries that name unknown accounts", () => {
    expect(() => loadConfig(writeCfg({ ...CFG, autoOrder: ["main", "ghost"] }))).toThrow(ConfigError);
  });
  it("rejects malformed config with a typed error", () => {
    expect(() => loadConfig(writeCfg({ accounts: [{ name: "x" }] }))).toThrow(ConfigError); // missing required `auth`
  });
  it("an empty account list is valid (ONBOARDING-PROVIDER: fresh install, no provider connected yet)", () => {
    const reg = new AccountRegistry(loadConfig(writeCfg({ accounts: [] })));
    expect(reg.list()).toEqual([]);
    expect(reg.autoOrder()).toEqual([]);
  });
  it("throws ConfigError when config.json is missing/unreadable, worded as a read failure", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-home-"));   // dir exists, no config.json
    expect(() => loadConfig(home)).toThrow(ConfigError);
    expect(() => loadConfig(home)).toThrow(/cannot read/);
  });
  it("throws ConfigError on syntactically-malformed JSON, worded as a parse failure (not mislabeled 'cannot read')", () => {
    expect.assertions(3);
    const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
    writeFileSync(join(home, "config.json"), "{ not valid json ");
    expect(() => loadConfig(home)).toThrow(ConfigError);
    expect(() => loadConfig(home)).toThrow(/cannot parse/);
    try { loadConfig(home); } catch (e) { expect((e as Error).message).not.toMatch(/cannot read/); }
  });
  it("rejects duplicate account names", () => {
    const dup = { ...CFG, accounts: [CFG.accounts[0], CFG.accounts[0]], autoOrder: ["main"] };
    expect(() => loadConfig(writeCfg(dup))).toThrow(ConfigError);
  });
  it("get() throws ConfigError for an unknown account name", () => {
    const reg = new AccountRegistry(loadConfig(writeCfg(CFG)));
    expect(() => reg.get("ghost")).toThrow(ConfigError);
  });
  it("ConfigError instances report their name (not 'Error') for log readability", () => {
    try { loadConfig(mkdtempSync(join(tmpdir(), "chimera-home-"))); }
    catch (e) { expect((e as Error).name).toBe("ConfigError"); }
  });

  // COMPACTION-THRESHOLD-CONFIG: compactionThresholdFor's precedence — unset ⇒ undefined
  // (native for every backend); a provider-level providerOverrides entry applies to every
  // account on that provider; a per-account override always wins over the provider default.
  describe("compactionThresholdFor", () => {
    // L1-DEFAULT-THRESHOLD (F39): "nothing configured" is no longer native for claude — the
    // measured fleet default answers instead. Every rung above it still wins (the cases below).
    it("falls back to the measured claude fleet default when nothing is configured", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg(CFG)));
      expect(reg.compactionThresholdFor("claude", "main")).toBe(DEFAULT_COMPACTION_THRESHOLD["claude"]);
      expect(reg.compactionThresholdFor("claude", "main")).toBe(120_000);
    });
    it("a provider with no fleet default still returns undefined (native) — the default is claude-only", () => {
      // codex takes the same knob but emits neither usage nor a compaction event, so a default
      // for it would be unmeasurable; kimi hardcodes costUsd 0. Both must stay native.
      const reg = new AccountRegistry(loadConfig(writeCfg(CFG)));
      expect(reg.compactionThresholdFor("codex", "main")).toBeUndefined();
      expect(reg.compactionThresholdFor("kimi", "main")).toBeUndefined();
    });
    it("applies the per-provider providerOverrides value to every account on that provider", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg({
        ...CFG, providerOverrides: { claude: { compactionThreshold: 90_000 } },
      })));
      expect(reg.compactionThresholdFor("claude", "main")).toBe(90_000);
      expect(reg.compactionThresholdFor("claude", "second")).toBe(90_000);
    });
    it("a per-account override wins over the provider-level default", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg({
        ...CFG,
        accounts: [
          { ...CFG.accounts[0], compactionThreshold: 50_000 },
          CFG.accounts[1],
        ],
        providerOverrides: { claude: { compactionThreshold: 90_000 } },
      })));
      expect(reg.compactionThresholdFor("claude", "main")).toBe(50_000);      // account override wins
      expect(reg.compactionThresholdFor("claude", "second")).toBe(90_000);    // falls back to provider default
    });
    // F39 L1-MEASURE: the same precedence, now reporting WHICH rung answered — compactionThresholdFor
    // is a wrapper over this, so the two can never drift apart.
    it("compactionThresholdWithSource names the rung that answered, and never disagrees with compactionThresholdFor", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg({
        ...CFG,
        accounts: [{ ...CFG.accounts[0], compactionThreshold: 50_000 }, CFG.accounts[1]],
        providerOverrides: { claude: { compactionThreshold: 90_000 } },
      })));
      expect(reg.compactionThresholdWithSource("claude", "main")).toEqual({ value: 50_000, source: "account" });
      expect(reg.compactionThresholdWithSource("claude", "second")).toEqual({ value: 90_000, source: "provider" });
      for (const name of ["main", "second"]) {
        expect(reg.compactionThresholdWithSource("claude", name).value).toBe(reg.compactionThresholdFor("claude", name));
      }
    });
    it("reports source 'default' when nothing is configured for claude, and 'native' for a provider with no fleet default", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg(CFG)));
      expect(reg.compactionThresholdWithSource("claude", "main")).toEqual({ value: 120_000, source: "default" });
      expect(reg.compactionThresholdWithSource("codex", "main")).toEqual({ value: undefined, source: "native" });
    });
    // F39.QA-A (finding M-1): an explicit null is the documented rollback to native. It is a VALUE,
    // not an absence — so it must short-circuit rather than fall through to a lower rung's number,
    // otherwise the fleet default makes native inexpressible and the rollback silently no-ops.
    it("an explicit null at the provider rung resolves to native, not to the fleet default", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg({
        ...CFG, providerOverrides: { claude: { compactionThreshold: null } },
      })));
      expect(reg.compactionThresholdWithSource("claude", "main")).toEqual({ value: undefined, source: "native" });
      expect(reg.compactionThresholdFor("claude", "main")).toBeUndefined();
    });
    it("an explicit null at the account rung wins over a provider-level NUMBER and resolves to native", () => {
      const reg = new AccountRegistry(loadConfig(writeCfg({
        ...CFG,
        accounts: [{ ...CFG.accounts[0], compactionThreshold: null }, CFG.accounts[1]],
        providerOverrides: { claude: { compactionThreshold: 90_000 } },
      })));
      expect(reg.compactionThresholdWithSource("claude", "main")).toEqual({ value: undefined, source: "native" });
      expect(reg.compactionThresholdWithSource("claude", "second")).toEqual({ value: 90_000, source: "provider" });
    });
  });
});

// ACCOUNT-KEY-PRESENCE: accountHasKey reports PRESENCE only, never the secret value.
describe("accountHasKey", () => {
  it("keychain: true when a key is stored, false when absent — never returns the value", async () => {
    const kc = new InMemoryKeychain({ svc: "sk-super-secret" });
    const present = await accountHasKey({ type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc);
    expect(present).toBe(true);
    expect(typeof present).toBe("boolean"); // the secret itself is never in the return value
    const absent = await accountHasKey({ type: "keychain", service: "missing-svc", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc);
    expect(absent).toBe(false);
  });
  it("env: true when the var is set and non-empty, false when unset/blank", async () => {
    const kc = new InMemoryKeychain();
    expect(await accountHasKey({ type: "env", var: "MY_KEY", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc, undefined, { MY_KEY: "abc" })).toBe(true);
    expect(await accountHasKey({ type: "env", var: "MY_KEY", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc, undefined, {})).toBe(false);
    expect(await accountHasKey({ type: "env", var: "MY_KEY", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc, undefined, { MY_KEY: "  " })).toBe(false);
  });
  it("command: true (a configured run script is structurally present; never executed to check)", async () => {
    const kc = new InMemoryKeychain();
    expect(await accountHasKey({ type: "command", run: "echo hi", injectAs: "ANTHROPIC_AUTH_TOKEN" }, kc)).toBe(true);
  });
  it("subscription: always false (no stored secret; keyBadge treats it as set separately)", async () => {
    const kc = new InMemoryKeychain();
    expect(await accountHasKey({ type: "subscription" }, kc)).toBe(false);
  });
  it("oauth: true when a token is stored in the given OAuthTokenStore, false otherwise", async () => {
    const kc = new InMemoryKeychain();
    const store = new OAuthTokenStore(kc);
    await store.save("token-ref", { accessToken: "at-secret" });
    expect(await accountHasKey({ type: "oauth", provider: "copilot", tokenRef: "token-ref" }, kc, store)).toBe(true);
    expect(await accountHasKey({ type: "oauth", provider: "copilot", tokenRef: "no-token" }, kc, store)).toBe(false);
    // no store passed: never throws, reports false
    expect(await accountHasKey({ type: "oauth", provider: "copilot", tokenRef: "token-ref" }, kc)).toBe(false);
  });
});
