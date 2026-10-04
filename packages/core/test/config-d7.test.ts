import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import {
  ConfigStore, ConfigWatcher, jsonMergePatch, redactConfig, loadEffectiveConfig, scrubSecretShapes,
} from "@chimera/core/configstore";
import { InMemoryKeychain, accountService } from "@chimera/core/keychain";
import { FakeAccountProber, type ProbeResult } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { CONFIG_PATCH_NULL } from "@chimera/protocol";
import type { NormalizedEvent } from "@chimera/protocol";

// Short /tmp home (UDS 104-byte limit is moot here — no sockets — but keep the discipline).
function makeHome(config: unknown, overlays?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "chm-d7-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  if (overlays) {
    mkdirSync(join(home, "config.d"), { recursive: true });
    for (const [name, body] of Object.entries(overlays)) writeFileSync(join(home, "config.d", name), JSON.stringify(body, null, 2));
  }
  return home;
}

const BASE = {
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  dailyCapUsd: 5,
};

function makeEngine(home: string, opts?: { keychain?: InMemoryKeychain; prober?: FakeAccountProber }) {
  const keychain = opts?.keychain ?? new InMemoryKeychain();
  const prober = opts?.prober ?? new FakeAccountProber("ok");
  const backends = new Map([
    ["claude", new FakeAgentBackend([], "claude")],
    ["codex", new FakeAgentBackend([], "codex")],
  ]);
  const engine = new Engine({ home, backends, keychain, accountProber: prober });
  return { engine, keychain, prober };
}

// ---------------------------------------------------------------------------
// jsonMergePatch (RFC 7396)
// ---------------------------------------------------------------------------
describe("jsonMergePatch", () => {
  it("recursively merges objects", () => {
    expect(jsonMergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 4, e: 5 } })).toEqual({ a: 1, b: { c: 2, d: 4, e: 5 } });
  });
  it("null deletes a key", () => {
    expect(jsonMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });
  it("null deletes a nested key without touching siblings", () => {
    expect(jsonMergePatch({ caps: { maxAgentsTotal: 12, subAgentModel: "x" } }, { caps: { subAgentModel: null } }))
      .toEqual({ caps: { maxAgentsTotal: 12 } });
  });
  it("arrays are values — a patched array wholly replaces (no element merge)", () => {
    expect(jsonMergePatch({ xs: [1, 2, 3] }, { xs: [9] })).toEqual({ xs: [9] });
  });
  it("a scalar/array patch replaces the whole target", () => {
    expect(jsonMergePatch({ a: 1 }, 7)).toBe(7);
    expect(jsonMergePatch({ a: 1 }, null)).toBeNull();
  });

  // EXPLICIT-NULL-ESCAPE: the three states must stay DISTINCT — null deletes, "$null" sets null,
  // an absent key leaves the target alone. Collapsing any two of them is the M-1 bug.
  it("the $null escape SETS a key to null where a real null would delete it", () => {
    expect(jsonMergePatch({ a: 1, b: 2 }, { b: CONFIG_PATCH_NULL })).toEqual({ a: 1, b: null });
    expect(jsonMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(jsonMergePatch({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 });
  });
  it("the escape resolves at any depth, and on a key the target does not have", () => {
    expect(jsonMergePatch({ providerOverrides: { claude: { compactionThreshold: 120_000 } } }, { providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } }))
      .toEqual({ providerOverrides: { claude: { compactionThreshold: null } } });
    expect(jsonMergePatch({}, { providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } }))
      .toEqual({ providerOverrides: { claude: { compactionThreshold: null } } });
  });
  it("the escape is NOT interpreted inside an array or as a whole-target patch", () => {
    expect(jsonMergePatch({ xs: [1] }, { xs: [CONFIG_PATCH_NULL] })).toEqual({ xs: [CONFIG_PATCH_NULL] });
    expect(jsonMergePatch({ a: 1 }, CONFIG_PATCH_NULL)).toBe(CONFIG_PATCH_NULL);
  });
});

// ---------------------------------------------------------------------------
// Overlay precedence + effective load
// ---------------------------------------------------------------------------
describe("config.d overlay precedence", () => {
  it("overlay wins over config.json (precedence overlay > config)", () => {
    const home = makeHome(BASE, { "ui.json": { dailyCapUsd: 10 } });
    expect(loadEffectiveConfig(home).dailyCapUsd).toBe(10);
  });
  it("no overlay ⇒ effective config equals config.json (byte-identical behavior)", () => {
    const home = makeHome(BASE);
    expect(loadEffectiveConfig(home).dailyCapUsd).toBe(5);
  });
  it("multiple overlays apply in lexical order (later file wins)", () => {
    const home = makeHome(BASE, { "00-base.json": { dailyCapUsd: 20 }, "99-top.json": { dailyCapUsd: 30 } });
    expect(loadEffectiveConfig(home).dailyCapUsd).toBe(30);
  });
  it("an overlay null-deletes a base key", () => {
    const home = makeHome(BASE, { "ui.json": { dailyCapUsd: null } });
    expect(loadEffectiveConfig(home).dailyCapUsd).toBeUndefined();
  });
  it("a nested overlay merges without clobbering base siblings", () => {
    const home = makeHome({ ...BASE, caps: { maxAgentsTotal: 12, perAccount: { main: 3 } } }, { "ui.json": { caps: { maxAgentsTotal: 20 } } });
    const cfg = loadEffectiveConfig(home);
    expect(cfg.caps.maxAgentsTotal).toBe(20);
    expect(cfg.caps.perAccount).toEqual({ main: 3 });
  });
});

// ---------------------------------------------------------------------------
// ONBOARDING-PROVIDER: fresh install, no config.json at all yet
// ---------------------------------------------------------------------------
describe("fresh $CHIMERA_HOME with no config.json", () => {
  it("loadEffectiveConfig parses to an all-defaults config instead of throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d7-fresh-"));   // dir exists, no config.json written
    const cfg = loadEffectiveConfig(home);
    expect(cfg.accounts).toEqual([]);
    expect(cfg.autoOrder).toEqual([]);
  });
  it("ConfigStore boots cleanly and Engine constructs against it", async () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d7-fresh-"));
    expect(() => new ConfigStore(home)).not.toThrow();
    const { engine } = makeEngine(home);
    const got = (await engine.handle("config.get", {})) as any;
    expect(got.accounts).toEqual([]);
  });
  it("agent.spawn with zero accounts fails cleanly, not a crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d7-fresh-"));
    const { engine } = makeEngine(home);
    await expect(engine.handle("agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none" } })).rejects.toMatchObject({
      code: "protocol",
      message: expect.stringContaining("no accounts configured"),
    });
  });
});

// ---------------------------------------------------------------------------
// redactConfig
// ---------------------------------------------------------------------------
describe("redactConfig", () => {
  it("redacts a command-auth run string (the only inline-secret channel) but keeps presence", () => {
    const cfg = {
      accounts: [{ name: "c", provider: "claude", auth: { type: "command", run: "echo sk-livesecretAAAA", injectAs: "ANTHROPIC_API_KEY" } }],
    };
    const red = redactConfig(cfg) as typeof cfg;
    expect(red.accounts[0]!.auth.run).toBe("REDACTED");
    expect(JSON.stringify(red)).not.toContain("sk-livesecret");
  });
  it("leaves reference-shaped fields (service, injectAs, publicKey, credentialType) readable", () => {
    const red = redactConfig({
      auth: { service: "chimera:main", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" },
      publicKey: "AAAApub",
    }) as Record<string, any>;
    expect(red.auth.service).toBe("chimera:main");
    expect(red.publicKey).toBe("AAAApub");
    // OAUTH-TOKEN-ACCOUNTS: credentialType is a classification TAG ("apiKey"/"oauthToken"/
    // "adminKey"), never a secret value — it must NOT get caught by the "credential"
    // substring in SECRET_KEY_RE, or the UI's credential-type column would always read
    // "REDACTED".
    expect(red.auth.credentialType).toBe("oauthToken");
  });
  it("does not mutate the input", () => {
    const input = { auth: { run: "sk-secret" } };
    redactConfig(input);
    expect(input.auth.run).toBe("sk-secret");
  });
  it("catches credential-WORD fields (refreshToken/clientSecret/privateKey) via the substring matcher", () => {
    const red = redactConfig({ refreshToken: "sk-live1", clientSecret: "sk-live2", privateKey: "sk-live3" }) as Record<string, any>;
    expect(red.refreshToken).toBe("REDACTED");
    expect(red.clientSecret).toBe("REDACTED");
    expect(red.privateKey).toBe("REDACTED");
  });
});

describe("scrubSecretShapes", () => {
  it("strips sk-/tskey- shaped substrings from free text", () => {
    expect(scrubSecretShapes("bad key sk-livesecretABCDEF here")).not.toContain("sk-livesecret");
    expect(scrubSecretShapes("tskey-abcdef123456 rejected")).not.toContain("tskey-abcdef");
  });
});

// ---------------------------------------------------------------------------
// ConfigStore.patch — validated write to config.d/ui.json
// ---------------------------------------------------------------------------
describe("ConfigStore.patch", () => {
  it("writes to config.d/ui.json and never touches config.json", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    const before = readFileSync(join(home, "config.json"), "utf8");
    const { changed } = store.patch({ dailyCapUsd: 42 });
    expect(changed).toEqual(["dailyCapUsd"]);
    expect(store.current().dailyCapUsd).toBe(42);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before); // config.json untouched
    expect(JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"))).toEqual({ dailyCapUsd: 42 });
  });
  it("an invalid patch throws and writes nothing (old config stays)", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    expect(() => store.patch({ autoOrder: ["ghost"] })).toThrow(/unknown account|invalid config/i);
    expect(store.current().autoOrder).toEqual(["main"]);
    expect(existsSync(join(home, "config.d", "ui.json"))).toBe(false);
  });
  it("null-delete via patch removes a base key", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    store.patch({ dailyCapUsd: null });
    expect(store.current().dailyCapUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// globalTeam (PLAN-PROJECT-CONDUCTOR-ROUTING P2-T1) — storage + get/patch round-trip only,
// no resolver behavior here (that's P2-T2).
// ---------------------------------------------------------------------------
describe("config.globalTeam", () => {
  it("defaults to null when unset", () => {
    const home = makeHome(BASE);
    expect(loadEffectiveConfig(home).globalTeam).toBeNull();
  });
  it("config.get round-trips a configured value, unredacted (not a secret-shaped key)", () => {
    const home = makeHome({ ...BASE, globalTeam: "team-global" });
    const store = new ConfigStore(home);
    expect(store.current().globalTeam).toBe("team-global");
    expect((store.redacted() as { globalTeam: string }).globalTeam).toBe("team-global");
  });
  it("config.patch sets globalTeam and it round-trips through the store", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    const { changed } = store.patch({ globalTeam: "team-global" });
    expect(changed).toEqual(["globalTeam"]);
    expect(store.current().globalTeam).toBe("team-global");
    expect(JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"))).toEqual({ globalTeam: "team-global" });
  });
  it("config.patch tolerates a globalTeam naming a team that does not (yet) exist", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    expect(() => store.patch({ globalTeam: "does-not-exist-yet" })).not.toThrow();
    expect(store.current().globalTeam).toBe("does-not-exist-yet");
  });
  it("null-delete via patch resets globalTeam to unset (default null)", () => {
    const home = makeHome({ ...BASE, globalTeam: "team-global" });
    const store = new ConfigStore(home);
    store.patch({ globalTeam: null });
    expect(store.current().globalTeam).toBeNull();
  });
  it("rejects an empty-string globalTeam", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    expect(() => store.patch({ globalTeam: "" })).toThrow(/invalid config/i);
  });
});

// ---------------------------------------------------------------------------
// ConfigWatcher — debounce with a fake clock, broken-JSON survival
// ---------------------------------------------------------------------------
describe("ConfigWatcher debounce (fake clock)", () => {
  it("coalesces a burst of change signals into a single onReload", () => {
    const home = makeHome(BASE);
    let pending: Array<{ id: number; fn: () => void }> = [];
    let nextId = 1;
    const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
    const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
    let reloads = 0;
    const w = new ConfigWatcher({ home, onReload: () => { reloads++; }, setTimer, clearTimer, watch: () => ({ close() {} }) });
    w.start();
    w.poke(); w.poke(); w.poke();          // a burst
    expect(pending.length).toBe(1);        // only ONE armed timer (prior ones cleared)
    expect(reloads).toBe(0);               // not fired yet
    pending[0]!.fn();                       // debounce elapses
    expect(reloads).toBe(1);               // single reload
    w.stop();
  });
});

describe("hot-reload broken-JSON survival", () => {
  it("a broken config.json keeps the OLD config active + emits config_error; never throws", () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const events: NormalizedEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    writeFileSync(join(home, "config.json"), "{ not json ");
    expect(() => engine.reloadConfig()).not.toThrow();
    expect(engine.configStore.current().accounts[0]!.name).toBe("main"); // old config intact
    expect(events.some((e) => e.kind === "config_error")).toBe(true);
    expect(events.some((e) => e.kind === "config_changed")).toBe(false);
  });
  it("a valid config.json edit diff-applies + emits config_changed {keys}", () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const events: NormalizedEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...BASE, dailyCapUsd: 99 }));
    engine.reloadConfig();
    expect(engine.configStore.current().dailyCapUsd).toBe(99);
    const changed = events.find((e) => e.kind === "config_changed");
    expect(changed?.data.keys).toEqual(["dailyCapUsd"]);
  });
  it("a no-op reload emits nothing", () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const events: NormalizedEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    engine.reloadConfig();
    expect(events.filter((e) => e.kind === "config_changed" || e.kind === "config_error")).toEqual([]);
  });
  it("a broken OVERLAY file also survives (old config stays)", () => {
    const home = makeHome(BASE, { "ui.json": { dailyCapUsd: 7 } });
    const { engine } = makeEngine(home);
    expect(engine.configStore.current().dailyCapUsd).toBe(7);
    writeFileSync(join(home, "config.d", "ui.json"), "}{ broken");
    engine.reloadConfig();
    expect(engine.configStore.current().dailyCapUsd).toBe(7); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Engine RPCs: config.get / config.patch / accounts.*
// ---------------------------------------------------------------------------
describe("config.get RPC (redacted effective config)", () => {
  it("returns the effective merged config with credential values redacted", async () => {
    const home = makeHome({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cmd", provider: "claude", auth: { type: "command", run: "echo sk-livesecretXYZ", injectAs: "ANTHROPIC_API_KEY" } },
      ],
      autoOrder: ["main", "cmd"],
    }, { "ui.json": { dailyCapUsd: 12 } });
    const { engine } = makeEngine(home);
    const got = (await engine.handle("config.get", {})) as any;
    expect(got.dailyCapUsd).toBe(12);                               // overlay merged in
    expect(got.accounts[1].auth.run).toBe("REDACTED");              // secret redacted
    expect(JSON.stringify(got)).not.toContain("sk-livesecret");     // presence visible, value gone
    expect(got.accounts[1].auth.injectAs).toBe("ANTHROPIC_API_KEY"); // reference field intact
  });
});

describe("config.patch RPC", () => {
  it("applies live: daemon.status reflects the new dailyCap, config.json untouched", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const res = (await engine.handle("config.patch", { patch: { dailyCapUsd: 25 } })) as any;
    expect(res.ok).toBe(true);
    expect(res.changed).toEqual(["dailyCapUsd"]);
    const status = (await engine.handle("daemon.status", {})) as any;
    expect(status.dailyCapUsd).toBe(25);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).dailyCapUsd).toBe(5); // user file untouched
  });
  it("an invalid patch errors and writes nothing", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("config.patch", { patch: { accounts: [] } })).rejects.toMatchObject({ code: "protocol" });
    expect(existsSync(join(home, "config.d", "ui.json"))).toBe(false);
  });
  // EXPLICIT-NULL-ESCAPE (M-1): the bug was reported through the RPC, so assert the whole path —
  // the token must survive params parsing (ConfigPatchParams keeps `patch` unknown), resolve to a
  // real null in the merge, and come back out of config.get as null rather than as the token.
  it("the \"$null\" escape SETS a key to null end-to-end, where a plain null deletes it", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const res = (await engine.handle("config.patch", { patch: { providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } } })) as any;
    expect(res.ok).toBe(true);
    const got = (await engine.handle("config.get", {})) as any;
    expect(got.providerOverrides.claude.compactionThreshold).toBeNull();

    await engine.handle("config.patch", { patch: { providerOverrides: { claude: { compactionThreshold: null } } } });
    const cleared = (await engine.handle("config.get", {})) as any;
    expect(cleared.providerOverrides.claude?.compactionThreshold).toBeUndefined();
  });
  it("failoverCooldownMinutes hot-reloads the LIVE CooldownTracker window (no daemon restart)", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    expect(engine.cooldowns.windowMs).toBe(30 * 60_000);                 // boot-time default
    const res = (await engine.handle("config.patch", { patch: { failoverCooldownMinutes: 1 } })) as any;
    expect(res).toEqual({ ok: true, changed: ["failoverCooldownMinutes"] });
    expect(engine.cooldowns.windowMs).toBe(60_000);                      // window refreshed in place
  });
  it("a config.json edit of failoverCooldownMinutes also refreshes the tracker + emits config_changed", () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const events: NormalizedEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...BASE, failoverCooldownMinutes: 5 }));
    engine.reloadConfig();
    expect(engine.cooldowns.windowMs).toBe(5 * 60_000);
    expect(events.find((e) => e.kind === "config_changed")?.data.keys).toEqual(["failoverCooldownMinutes"]);
  });
});

describe("accounts CRUD (fake keychain)", () => {
  it("add → setKey → test → remove, keys only in the keychain, never in config", async () => {
    const home = makeHome(BASE);
    const keychain = new InMemoryKeychain();
    const { engine } = makeEngine(home, { keychain, prober: new FakeAccountProber("ok") });

    // add
    const added = (await engine.handle("accounts.add", { name: "openai", provider: "codex" })) as any;
    expect(added).toEqual({ name: "openai", provider: "codex" });
    const list = (await engine.handle("accounts.list", {})) as any[];
    expect(list.map((a) => a.name)).toContain("openai");
    // config.json untouched; overlay carries the account WITHOUT a key
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).accounts).toHaveLength(1);
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    expect(ui.accounts.find((a: any) => a.name === "openai").auth.service).toBe("chimera:openai");

    // setKey → keychain only
    await engine.handle("accounts.setKey", { name: "openai", key: "sk-liveOPENAIsecret" });
    expect(keychain.has(accountService("openai"))).toBe(true);
    expect(await keychain.get(accountService("openai"))).toBe("sk-liveOPENAIsecret");
    expect(readFileSync(join(home, "config.d", "ui.json"), "utf8")).not.toContain("sk-live");
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("sk-live");

    // test → ok
    expect((await engine.handle("accounts.test", { name: "openai" })) as any).toEqual({ name: "openai", result: "ok" });

    // remove → gone from config + keychain
    await engine.handle("accounts.remove", { name: "openai" });
    expect(((await engine.handle("accounts.list", {})) as any[]).map((a) => a.name)).not.toContain("openai");
    expect(keychain.has(accountService("openai"))).toBe(false);
  });

  it("accounts.test returns auth_error when the prober rejects the key", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home, { prober: new FakeAccountProber("auth_error") });
    await engine.handle("accounts.add", { name: "openai", provider: "codex" });
    await engine.handle("accounts.setKey", { name: "openai", key: "sk-bad" });
    expect((await engine.handle("accounts.test", { name: "openai" })) as any).toEqual({ name: "openai", result: "auth_error" });
  });

  it("adding a duplicate account is a conflict", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("accounts.add", { name: "main", provider: "claude" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("setKey/test on an unknown account errors", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("accounts.setKey", { name: "ghost", key: "x" })).rejects.toMatchObject({ code: "protocol" });
    await expect(engine.handle("accounts.test", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("setKey on a NON-keychain account (subscription) is rejected — no orphaned keychain item", async () => {
    const home = makeHome(BASE);   // "main" is a subscription account seeded in config.json
    const keychain = new InMemoryKeychain();
    const { engine } = makeEngine(home, { keychain });
    await expect(engine.handle("accounts.setKey", { name: "main", key: "sk-orphan" }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(keychain.has(accountService("main"))).toBe(false);   // nothing written
  });

  // F23-0D: accounts.add/accounts.test accept any F23-0D catalog provider, not just claude/codex.
  it("accounts.add accepts a non-claude/codex F23-0D catalog provider and injects its catalog envVar", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const added = (await engine.handle("accounts.add", { name: "grok", provider: "xai" })) as any;
    expect(added).toEqual({ name: "grok", provider: "xai" });
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    expect(ui.accounts.find((a: any) => a.name === "grok").auth.injectAs).toBe("XAI_API_KEY");
  });

  it("accounts.add rejects a provider absent from the F23-0D catalog with a clean protocol error", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("accounts.add", { name: "ghost-provider", provider: "not-a-real-provider" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("accounts.test best-effort-passes an unrecognized provider's ping (no provider-specific probe wired yet)", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home, { prober: new FakeAccountProber("ok") });
    await engine.handle("accounts.add", { name: "grok", provider: "xai" });
    await engine.handle("accounts.setKey", { name: "grok", key: "sk-xai-live" });
    expect((await engine.handle("accounts.test", { name: "grok" })) as any).toEqual({ name: "grok", result: "ok" });
  });

  // OAUTH-TOKEN-ACCOUNTS: a pasted sk-ant-oat01 token is a Claude Code OAuth token
  // (from `claude setup-token`), not a plain x-api-key-shaped ANTHROPIC_API_KEY —
  // accounts.setKey must classify it and persist the RIGHT injectAs so spawn-time
  // credential resolution actually uses it (backends/claude.ts's AUTH_VARS).
  describe("OAUTH-TOKEN-ACCOUNTS: keychain credential classification", () => {
    it("classifies a Claude Code OAuth token, persists CLAUDE_CODE_OAUTH_TOKEN as injectAs, and surfaces credentialType everywhere", async () => {
      const home = makeHome(BASE);
      const { engine } = makeEngine(home, { prober: new FakeAccountProber("ok") });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });

      const setResult = (await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-oat01-abcXYZ" })) as any;
      expect(setResult).toEqual({ ok: true, name: "claude-pers", credentialType: "oauthToken" });

      const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
      const acct = ui.accounts.find((a: any) => a.name === "claude-pers");
      expect(acct.auth.injectAs).toBe("CLAUDE_CODE_OAUTH_TOKEN");
      expect(acct.auth.credentialType).toBe("oauthToken");

      // accounts.list surfaces the classification (for the UI's credential-type column).
      const list = (await engine.handle("accounts.list", {})) as any[];
      expect(list.find((a) => a.name === "claude-pers").credentialType).toBe("oauthToken");

      // config.get must NOT redact credentialType — it's a classification tag, not a secret.
      const redacted = (await engine.handle("config.get", {})) as any;
      expect(redacted.accounts.find((a: any) => a.name === "claude-pers").auth.credentialType).toBe("oauthToken");

      // accounts.test threads credentialType into the prober and echoes it back —
      // a real ok/auth_error now, same as any other credential type.
      const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
      expect(testResult).toEqual({ name: "claude-pers", result: "ok", credentialType: "oauthToken" });
    });

    it("classifies an Admin API key as adminKey and returns an explicit warning instead of a bare success", async () => {
      const home = makeHome(BASE);
      const { engine } = makeEngine(home, { prober: new FakeAccountProber("admin_key") });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });

      const setResult = (await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-admin-abcXYZ" })) as any;
      expect(setResult.credentialType).toBe("adminKey");
      expect(setResult.warning).toMatch(/cannot call the Messages API/i);

      const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
      expect(testResult).toEqual({ name: "claude-pers", result: "admin_key", credentialType: "adminKey" });
    });

    it("trims leading/trailing whitespace BEFORE storing and classifying (trim-on-set)", async () => {
      const home = makeHome(BASE);
      const keychain = new InMemoryKeychain();
      const { engine } = makeEngine(home, { keychain, prober: new FakeAccountProber("ok") });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });

      const setResult = (await engine.handle("accounts.setKey", { name: "claude-pers", key: "  sk-ant-oat01-abcXYZ \n" })) as any;
      expect(setResult.credentialType).toBe("oauthToken");   // untrimmed input would NOT match the sk-ant-oat01 prefix test
      expect(await keychain.get(accountService("claude-pers"))).toBe("sk-ant-oat01-abcXYZ");   // stored trimmed, not raw

      const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
      expect(ui.accounts.find((a: any) => a.name === "claude-pers").auth.injectAs).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("rejects a whitespace-only key with a clean protocol error (nothing stored)", async () => {
      const home = makeHome(BASE);
      const keychain = new InMemoryKeychain();
      const { engine } = makeEngine(home, { keychain });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });
      await expect(engine.handle("accounts.setKey", { name: "claude-pers", key: "   " }))
        .rejects.toMatchObject({ code: "protocol" });
      expect(keychain.has(accountService("claude-pers"))).toBe(false);
    });

    it("a plain api key stays byte-identical to pre-classification behavior — no credentialType persisted, no extra field on accounts.test", async () => {
      const home = makeHome(BASE);
      const { engine } = makeEngine(home, { prober: new FakeAccountProber("ok") });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });
      const setResult = (await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-api03-abcXYZ" })) as any;
      expect(setResult).toEqual({ ok: true, name: "claude-pers", credentialType: "apiKey" });

      const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
      const acct = ui.accounts.find((a: any) => a.name === "claude-pers");
      expect(acct.auth.injectAs).toBe("ANTHROPIC_API_KEY");
      expect(acct.auth.credentialType).toBeUndefined();       // no config churn for the ordinary case

      expect((await engine.handle("accounts.test", { name: "claude-pers" })) as any).toEqual({ name: "claude-pers", result: "ok" });
    });

    it("reverting an oauth-token account back to a plain api key re-patches injectAs to ANTHROPIC_API_KEY", async () => {
      const home = makeHome(BASE);
      const { engine } = makeEngine(home, { prober: new FakeAccountProber("ok") });
      await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });
      await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-oat01-first" });
      await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-api03-second" });

      const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
      const acct = ui.accounts.find((a: any) => a.name === "claude-pers");
      expect(acct.auth.injectAs).toBe("ANTHROPIC_API_KEY");
      expect(acct.auth.credentialType).toBe("apiKey");
    });
  });
});

// API-KEY-INVALID: accounts.test must surface the REAL cause (http status + provider
// message) instead of a bare "invalid", and must trim a legacy newline-suffixed key on read.
describe("API-KEY-INVALID: accounts.test detail surfacing + defensive trim-on-read", () => {
  it("echoes the prober's httpStatus + key-redacted detail so the UI can show the real error", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home, {
      prober: new FakeAccountProber({ result: "auth_error", httpStatus: 401, detail: "authentication_error: invalid x-api-key" }),
    });
    await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });
    await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-api03-bad" });
    const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
    expect(testResult).toEqual({ name: "claude-pers", result: "auth_error", httpStatus: 401, detail: "authentication_error: invalid x-api-key" });
  });

  it("trims a legacy key stored WITH a trailing newline before probing (defensive trim-on-read)", async () => {
    const home = makeHome(BASE);
    const keychain = new InMemoryKeychain();
    let seenKey: string | null | undefined;
    const prober = new FakeAccountProber((opts) => { seenKey = opts.key; return "ok"; });
    const { engine } = makeEngine(home, { keychain, prober });
    await engine.handle("accounts.add", { name: "claude-pers", provider: "claude" });
    // Simulate a key written by an OLDER daemon (pre trim-on-set): a trailing newline that
    // would fail the provider's literal x-api-key header match if probed verbatim.
    await keychain.set(accountService("claude-pers"), "sk-ant-api03-legacy\n");
    await engine.handle("accounts.test", { name: "claude-pers" });
    expect(seenKey).toBe("sk-ant-api03-legacy");
  });
});

// SUBSCRIPTION-CONNECT: accounts.add_subscription creates a subscription account riding the
// provider CLI's own ambient login — only claude/codex (agentic-sdk) support it.
describe("accounts.add_subscription (CLI-subscription accounts)", () => {
  it("creates a subscription account for codex with a resolved CODEX_HOME homeDir", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const added = (await engine.handle("accounts.add_subscription", { provider: "codex" })) as any;
    expect(added).toEqual({ name: "codex", provider: "codex" });
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    const account = ui.accounts.find((a: any) => a.name === "codex");
    expect(account.auth.type).toBe("subscription");
    expect(account.auth.homeDir).toMatch(/\.codex$/);
  });

  it("creates a subscription account for claude with no explicit homeDir (rides the SDK default)", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const added = (await engine.handle("accounts.add_subscription", { provider: "claude" })) as any;
    expect(added).toEqual({ name: "claude", provider: "claude" });
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    const account = ui.accounts.find((a: any) => a.name === "claude");
    expect(account.auth).toEqual({ type: "subscription" });
  });

  it("rejects a non-agentic-sdk provider (no CLI login to ride)", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("accounts.add_subscription", { provider: "xai" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects an unknown provider", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await expect(engine.handle("accounts.add_subscription", { provider: "not-a-real-provider" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a duplicate derived name as a conflict", async () => {
    const home = makeHome(BASE);   // "main" is already claude/subscription, but named "main" not "claude"
    const { engine } = makeEngine(home);
    await engine.handle("accounts.add_subscription", { provider: "claude" });
    await expect(engine.handle("accounts.add_subscription", { provider: "claude" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  // KIMI-BACKEND S4: S0's spike (docs/superpowers/specs/2026-07-28-kimi-backend-s0-findings.md
  // §a) REFUTED the real CLI honoring any config-root override the SDK can deliver, so kimi
  // rides the SAME "no explicit homeDir" shape as claude — never the codex CODEX_HOME shape —
  // and gets a dedicated single-account guard instead (§7).
  it("creates a subscription account for kimi with no explicit homeDir (S0(a) REFUTED — no working config-root override)", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    const added = (await engine.handle("accounts.add_subscription", { provider: "kimi" })) as any;
    expect(added).toEqual({ name: "kimi", provider: "kimi" });
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    const account = ui.accounts.find((a: any) => a.name === "kimi");
    expect(account.auth).toEqual({ type: "subscription" });
  });

  it("rejects a second kimi subscription account with an explanatory (not generic) message — never silently aliases the ambient ~/.kimi-code identity", async () => {
    const home = makeHome(BASE);
    const { engine } = makeEngine(home);
    await engine.handle("accounts.add_subscription", { provider: "kimi" });
    await expect(engine.handle("accounts.add_subscription", { provider: "kimi" }))
      .rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("single global ambient"),
      });
    // Still exactly one kimi account on disk — the rejected call must not have written anything.
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    expect(ui.accounts.filter((a: any) => a.provider === "kimi")).toHaveLength(1);
  });
});

// SUBSCRIPTION-CONNECT: legacy configs on disk still say "default-login" (every config
// written before this rename). AccountAuthSchema's preprocess step migrates the literal to
// "subscription" IN MEMORY on every load; ConfigStore additionally self-heals the ON-DISK
// value once at boot by writing the migrated accounts array into the ui.json overlay.
describe("legacy default-login → subscription migration", () => {
  const LEGACY_BASE = {
    accounts: [{ name: "main", provider: "claude", auth: { type: "default-login" } }],
    autoOrder: ["main"],
    dailyCapUsd: 5,
  };

  it("loadEffectiveConfig migrates a legacy default-login account to subscription", () => {
    const home = makeHome(LEGACY_BASE);
    const cfg = loadEffectiveConfig(home);
    expect(cfg.accounts[0]!.auth).toEqual({ type: "subscription" });
  });

  it("a legacy codex default-login account with homeDir migrates and keeps homeDir", () => {
    const home = makeHome({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "default-login" } },
        { name: "codex", provider: "codex", auth: { type: "default-login", homeDir: "/tmp/fake-codex-home" } },
      ],
      autoOrder: ["main", "codex"],
      dailyCapUsd: 5,
    });
    const cfg = loadEffectiveConfig(home);
    const codex = cfg.accounts.find((a) => a.name === "codex")!;
    expect(codex.auth).toEqual({ type: "subscription", homeDir: "/tmp/fake-codex-home" });
  });

  it("ConfigStore self-heals a legacy config by persisting the migration into the ui.json overlay", () => {
    const home = makeHome(LEGACY_BASE);
    // config.json on disk still says "default-login" before ConfigStore ever loads it.
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain("default-login");

    const store = new ConfigStore(home);
    expect(store.current().accounts[0]!.auth).toEqual({ type: "subscription" });

    // The migration was persisted into the overlay (config.json itself is never touched).
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    expect(ui.accounts[0].auth).toEqual({ type: "subscription" });
    expect(readFileSync(join(home, "config.json"), "utf8")).toContain("default-login"); // untouched

    // A fresh ConfigStore reload now reads "subscription" straight off disk (overlay wins).
    const reloaded = new ConfigStore(home);
    expect(reloaded.current().accounts[0]!.auth).toEqual({ type: "subscription" });
  });

  it("a config with no legacy accounts never writes an overlay (no-op self-heal)", () => {
    const home = makeHome(BASE); // BASE already uses "subscription"
    new ConfigStore(home);
    expect(existsSync(join(home, "config.d", "ui.json"))).toBe(false);
  });

  it("accounts.list reports the migrated account as authType subscription, not default-login", async () => {
    const home = makeHome(LEGACY_BASE);
    const { engine } = makeEngine(home);
    const list = (await engine.handle("accounts.list", {})) as any[];
    expect(list.find((a) => a.name === "main").authType).toBe("subscription");
  });
});

// ---------------------------------------------------------------------------
// Redaction sweep: NO secret in ANY response the D7 methods can produce
// ---------------------------------------------------------------------------
describe("redaction sweep — no secret in any D7 RPC response", () => {
  it("serializes every D7 response and asserts /sk-|tskey-|token/ never matches a credential value", async () => {
    const SECRET = "sk-liveSWEEPsecret1234567890";
    const TS = "tskey-liveSWEEPauth1234567890";
    const home = makeHome({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cmd", provider: "claude", auth: { type: "command", run: `printf ${SECRET}`, injectAs: "ANTHROPIC_API_KEY" } },
      ],
      autoOrder: ["main", "cmd"],
    });
    const keychain = new InMemoryKeychain();
    const { engine } = makeEngine(home, { keychain, prober: new FakeAccountProber("auth_error") });

    const responses: unknown[] = [];
    const capture = async (method: string, params: unknown) => {
      try { responses.push(await engine.handle(method, params)); }
      catch (e) { responses.push(e); } // error responses count too
    };

    await capture("config.get", {});
    await capture("config.patch", { patch: { dailyCapUsd: 3 } });
    await capture("config.patch", { patch: { accounts: [] } });        // invalid → error path
    await capture("accounts.add", { name: "openai", provider: "codex" });
    await capture("accounts.setKey", { name: "openai", key: SECRET });  // secret in params, never in response
    await capture("accounts.setKey", { name: "openai", key: TS });
    await capture("accounts.test", { name: "openai" });
    await capture("config.get", {});                                    // after the key exists
    await capture("accounts.remove", { name: "openai" });

    const blob = JSON.stringify(responses);
    expect(blob).not.toMatch(/sk-|tskey-|token/);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(TS);
  });
});

// ---------------------------------------------------------------------------
// EXPLICIT-NULL-ESCAPE end to end (QA finding M-1)
// ---------------------------------------------------------------------------
describe("config.patch explicit-null escape", () => {
  it("survives the write and a FRESH load as a real null", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    store.patch({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
    // The escape is stored VERBATIM in ui.json: the overlay is re-applied as a merge patch on
    // every load, so a real null on disk here would delete the key instead of setting it.
    expect(JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8")))
      .toEqual({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
    expect(store.current().providerOverrides?.["claude"]?.compactionThreshold).toBeNull();
    expect(new ConfigStore(home).current().providerOverrides?.["claude"]?.compactionThreshold).toBeNull();
    expect(loadEffectiveConfig(home).providerOverrides?.["claude"]?.compactionThreshold).toBeNull();
  });

  it("a plain null still DELETES the key — even a value the BASE config set", () => {
    const home = makeHome({ ...BASE, providerOverrides: { claude: { compactionThreshold: 120_000 } } });
    const store = new ConfigStore(home);
    store.patch({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
    expect(store.current().providerOverrides?.["claude"]?.compactionThreshold).toBeNull();
    // Unchanged RFC 7396 behaviour, and exactly why the escape had to exist: the null is applied
    // to the MERGED config, so it drops the base's 120_000 too and leaves "no opinion" (resolution
    // then lands on DEFAULT_COMPACTION_THRESHOLD) rather than the explicit null that means native.
    store.patch({ providerOverrides: { claude: { compactionThreshold: null } } });
    const claude = new ConfigStore(home).current().providerOverrides?.["claude"];
    expect(claude).toBeDefined();
    expect(claude?.compactionThreshold).toBeUndefined();
  });

  it("a later real value supersedes the escape", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    store.patch({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } });
    store.patch({ providerOverrides: { claude: { compactionThreshold: 90_000 } } });
    expect(new ConfigStore(home).current().providerOverrides?.["claude"]?.compactionThreshold).toBe(90_000);
  });

  it("on a non-nullable key it fails validation and writes NOTHING", () => {
    const home = makeHome(BASE);
    const store = new ConfigStore(home);
    expect(() => store.patch({ dailyCapUsd: CONFIG_PATCH_NULL })).toThrow();
    expect(existsSync(join(home, "config.d", "ui.json"))).toBe(false);
    expect(store.current().dailyCapUsd).toBe(5);
  });
});
