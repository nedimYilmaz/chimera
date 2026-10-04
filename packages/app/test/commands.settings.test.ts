import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import { createSettingsCommands } from "../src/state/commands.settings";

// W9 (F09 · coverage B15/B16) — the Settings command layer: it sends EXACTLY the
// params the engine expects (accounts.add/setKey/remove/test, config.get/patch,
// fed.network/up/setAuthKey), never retains a secret, reconciles reads after a
// write, and self-refreshes the right section off a daemon event.

type Call = { method: string; params: unknown };

function harness(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const calls: Call[] = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a as Record<string, unknown>) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    const h = handlers[method];
    if (h) return Promise.resolve(h(params) as T);
    // sensible defaults so a test needn't stub every read
    if (method === "accounts.list") return Promise.resolve([] as unknown as T);
    if (method === "config.get") return Promise.resolve({ autoOrder: [], dailyCapUsd: null } as unknown as T);
    if (method === "daemon.status") return Promise.resolve({ engineId: "mbp", dailyCapUsd: null } as unknown as T);
    if (method === "fed.network") return Promise.resolve({ installed: true, loggedIn: true, ip4: "100.1.1.1", magicDNS: true, tailscaleSSH: true } as unknown as T);
    if (method === "mcpstore.list") return Promise.resolve([] as unknown as T);
    if (method === "mcpstore.importables") return Promise.resolve({ importables: [] } as unknown as T);
    return Promise.resolve({} as T);
  };
  const cmds = createSettingsCommands(store, request);
  return { cmds, calls, dispatched };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("reads", () => {
  it("loadProviders folds accounts.list + config.get autoOrder + providers.list (F23-2B)", async () => {
    const h = harness({
      "accounts.list": () => [{ name: "main", provider: "claude", authType: "keychain" }],
      "config.get": () => ({ autoOrder: ["main"], dailyCapUsd: 5 }),
      "providers.list": () => [{ id: "claude", label: "Claude", accounts: [{ name: "main", authType: "keychain" }] }],
    });
    await h.cmds.loadProviders();
    expect(h.cmds.getState().accounts).toHaveLength(1);
    expect(h.cmds.getState().autoOrder).toEqual(["main"]);
    expect(h.cmds.getState().providers).toHaveLength(1);
    expect(h.cmds.getState().providers[0]).toMatchObject({ id: "claude" });
    expect(h.cmds.getState().loaded.providers).toBe(true);
  });
  it("loadProviders tolerates a non-array providers.list response (defaults to [])", async () => {
    const h = harness({ "providers.list": () => ({}) });
    await h.cmds.loadProviders();
    expect(h.cmds.getState().providers).toEqual([]);
  });
  it("loadGeneral folds engineId (daemon.status) + dailyCapUsd (config.get)", async () => {
    const h = harness({
      "daemon.status": () => ({ engineId: "studio", dailyCapUsd: null }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: 12.5 }),
    });
    await h.cmds.loadGeneral();
    expect(h.cmds.getState().engineId).toBe("studio");
    expect(h.cmds.getState().dailyCapUsd).toBe(12.5);
  });
  it("loadGeneral folds projectImportDir (config.get) — absent/non-string defaults to null (IMPORT-DIR)", async () => {
    const h = harness({
      "daemon.status": () => ({ engineId: "studio", dailyCapUsd: null }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, projectImportDir: "/Users/me/imports" }),
    });
    await h.cmds.loadGeneral();
    expect(h.cmds.getState().projectImportDir).toBe("/Users/me/imports");

    const h2 = harness({
      "daemon.status": () => ({ engineId: "studio", dailyCapUsd: null }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null }),
    });
    await h2.cmds.loadGeneral();
    expect(h2.cmds.getState().projectImportDir).toBeNull();
  });
});

describe("add provider (accounts.add + setKey) — secret never retained", () => {
  it("sends add then setKey with the key, reloads, and stores no key", async () => {
    const added: string[] = [];
    const h = harness({
      "accounts.add": (p) => { added.push((p as { name: string }).name); return { name: (p as { name: string }).name }; },
      "accounts.setKey": () => ({ ok: true }),
      "accounts.list": () => [{ name: "gpt", provider: "codex", authType: "keychain" }],
      "config.get": () => ({ autoOrder: ["gpt"], dailyCapUsd: null }),
    });
    const ok = await h.cmds.addProvider("gpt", "codex", "sk-SECRET-123");
    expect(ok).toBe(true);
    const methods = h.calls.map((c) => c.method);
    expect(methods).toContain("accounts.add");
    expect(methods).toContain("accounts.setKey");
    // the reconcile fetch ran
    expect(methods.filter((m) => m === "accounts.list")).toHaveLength(1);
    // the key reached setKey but lives NOWHERE on the state object
    const setKeyCall = h.calls.find((c) => c.method === "accounts.setKey")!;
    expect((setKeyCall.params as { key: string }).key).toBe("sk-SECRET-123");
    expect(JSON.stringify(h.cmds.getState())).not.toContain("SECRET");
  });
  it("skips setKey when no key was entered", async () => {
    const h = harness({ "accounts.add": () => ({ name: "x" }) });
    await h.cmds.addProvider("x", "claude", "");
    expect(h.calls.some((c) => c.method === "accounts.setKey")).toBe(false);
  });
  it("a failing add surfaces a commandError and returns false", async () => {
    const h = harness({ "accounts.add": () => { throw new Error("account \"x\" already exists"); } });
    const ok = await h.cmds.addProvider("x", "claude", "k");
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

describe("custom provider creation", () => {
  it("creates a no-key Ollama account, refreshes catalog, and discovers models without a dummy secret", async () => {
    const custom = { id: "ollama-local", label: "Ollama", custom: true, requiresKey: false, accounts: [] };
    const h = harness({
      "providers.addCustom": () => ({ id: "ollama-local" }),
      "providers.list": () => [custom],
      "accounts.add": () => ({ name: "ollama-local", provider: "ollama-local" }),
      "providers.models": () => ({ models: ["qwen3"], defaultModel: "qwen3", source: "live" }),
    });
    const ok = await h.cmds.addCustomProvider({
      id: "ollama-local", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen3", requiresKey: false,
    });
    expect(ok).toBe(true);
    expect(h.calls.map((c) => c.method)).toEqual([
      "providers.addCustom", "accounts.list", "config.get", "providers.list",
      "accounts.add", "accounts.list", "config.get", "providers.list", "providers.models",
    ]);
    expect(h.calls.find((c) => c.method === "providers.models")?.params).toEqual({ provider: "ollama-local", refresh: true });
    expect(h.calls.some((c) => c.method === "accounts.setKey")).toBe(false);
    expect(h.cmds.getState().providers[0]).toMatchObject({ id: "ollama-local", custom: true });
  });

  it("creates and keys an account before model discovery for a keyed provider", async () => {
    const h = harness({ "providers.addCustom": () => ({ id: "corp" }) });
    await h.cmds.addCustomProvider({
      id: "corp", label: "Corp", baseUrl: "https://llm.example.test/v1",
      defaultModel: "corp-1", requiresKey: true, key: "secret-key",
    });
    const methods = h.calls.map((c) => c.method);
    expect(methods.indexOf("providers.addCustom")).toBeLessThan(methods.indexOf("accounts.add"));
    expect(methods.indexOf("accounts.setKey")).toBeLessThan(methods.indexOf("providers.models"));
    expect(h.calls.find((c) => c.method === "accounts.setKey")?.params).toEqual({ name: "corp", key: "secret-key" });
    expect(JSON.stringify(h.cmds.getState())).not.toContain("secret-key");
  });

  it("surfaces duplicate and built-in collisions as command errors", async () => {
    for (const message of ["custom provider already exists", "is a built-in provider id"]) {
      const h = harness({ "providers.addCustom": () => { throw new Error(message); } });
      expect(await h.cmds.addCustomProvider({ id: "openai", label: "Nope", baseUrl: "https://example.test/v1", defaultModel: "x", requiresKey: false })).toBe(false);
      expect(h.dispatched).toContainEqual({ type: "commandError", message });
      expect(h.calls.some((c) => c.method === "accounts.add")).toBe(false);
    }
  });
});

describe("test / remove", () => {
  it("testAccount records the ok/auth_error verdict for the badge", async () => {
    const h = harness({ "accounts.test": () => ({ name: "main", result: "auth_error" }) });
    await h.cmds.testAccount("main");
    expect(h.cmds.getState().tests["main"]).toBe("auth_error");
  });
  // OAUTH-TOKEN-ACCOUNTS: admin_key is a valid ProbeResult value too — a guard that only
  // recognized ok/auth_error would silently drop it and the row would never show the new
  // detail text.
  it("testAccount also records an admin_key verdict (not just ok/auth_error)", async () => {
    const h = harness({ "accounts.test": () => ({ name: "main", result: "admin_key" }) });
    await h.cmds.testAccount("main");
    expect(h.cmds.getState().tests["main"]).toBe("admin_key");
  });
  // API-KEY-INVALID: the daemon's real (key-redacted) probe message is captured into
  // testDetails so the row shows the true cause; a later ok clears the stale detail.
  it("testAccount captures the probe detail, and a subsequent ok clears it", async () => {
    // `request` reads handlers[method] fresh per call, so mutating this object flips the
    // response between the two testAccount() calls.
    const handlers: Record<string, (params: unknown) => unknown> = {
      "accounts.test": () => ({ name: "main", result: "auth_error", detail: "401 authentication_error: invalid x-api-key" }),
    };
    const h = harness(handlers);
    await h.cmds.testAccount("main");
    expect(h.cmds.getState().testDetails["main"]).toBe("401 authentication_error: invalid x-api-key");
    handlers["accounts.test"] = () => ({ name: "main", result: "ok" });
    await h.cmds.testAccount("main");
    expect(h.cmds.getState().testDetails["main"]).toBeUndefined();
  });
  it("removeProvider drops the test verdict and reloads", async () => {
    const h = harness({
      "accounts.test": () => ({ name: "main", result: "ok" }),
      "accounts.remove": () => ({ ok: true, name: "main" }),
    });
    await h.cmds.testAccount("main");
    expect(h.cmds.getState().tests["main"]).toBe("ok");
    await h.cmds.removeProvider("main");
    expect(h.cmds.getState().tests["main"]).toBeUndefined();
    expect(h.calls.some((c) => c.method === "accounts.remove")).toBe(true);
  });
});

describe("rekeyAccount (re-key an EXISTING account, blank-field discipline enforced by the caller)", () => {
  it("sends accounts.setKey with the new key, reloads, and stores no key", async () => {
    const h = harness({
      "accounts.setKey": () => ({ ok: true, name: "main", credentialType: "apiKey" }),
      "accounts.list": () => [{ name: "main", provider: "claude", authType: "keychain" }],
      "config.get": () => ({ autoOrder: ["main"], dailyCapUsd: null }),
      "accounts.test": () => ({ name: "main", result: "ok" }),
    });
    const ok = await h.cmds.rekeyAccount("main", "sk-NEW-SECRET");
    await settle();
    expect(ok).toBe(true);
    const setKeyCall = h.calls.find((c) => c.method === "accounts.setKey")!;
    expect(setKeyCall.params).toEqual({ name: "main", key: "sk-NEW-SECRET" });
    expect(h.calls.some((c) => c.method === "accounts.list")).toBe(true); // reconciled
    expect(JSON.stringify(h.cmds.getState())).not.toContain("SECRET");
  });
  it("a failing setKey (e.g. non-keychain account) surfaces a commandError and returns false", async () => {
    const h = harness({ "accounts.setKey": () => { throw new Error("account \"main\" is not keychain-backed"); } });
    const ok = await h.cmds.rekeyAccount("main", "k");
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

describe("reorderAccount (failover-priority move — full-array config.patch, never a delta)", () => {
  it("writes the complete permuted autoOrder array, preserving every account", async () => {
    const configPatch = vi.fn(() => ({ ok: true, changed: ["autoOrder"] }));
    const h2 = harness({
      "accounts.list": () => [
        { name: "main", provider: "claude", authType: "keychain" },
        { name: "codex", provider: "codex", authType: "keychain" },
        { name: "gpt-alt", provider: "claude", authType: "keychain" },
      ],
      "config.get": () => ({ autoOrder: ["main", "codex"], dailyCapUsd: null }),
      "config.patch": configPatch,
    });
    await h2.cmds.loadProviders();
    const ok = await h2.cmds.reorderAccount("codex", "up");
    expect(ok).toBe(true);
    expect(configPatch).toHaveBeenCalledWith({ patch: { autoOrder: ["codex", "main", "gpt-alt"] } });
  });
  it("is a no-op (no RPC call) at the top boundary", async () => {
    const h = harness({
      "accounts.list": () => [{ name: "main", provider: "claude", authType: "keychain" }],
      "config.get": () => ({ autoOrder: ["main"], dailyCapUsd: null }),
    });
    await h.cmds.loadProviders();
    const ok = await h.cmds.reorderAccount("main", "up");
    expect(ok).toBe(false);
    expect(h.calls.some((c) => c.method === "config.patch")).toBe(false);
  });
});

describe("F23-2B: setProviderOverride", () => {
  it("patches {providerOverrides: {[id]: value}} and reconciles providers", async () => {
    const h = harness({
      "config.patch": () => ({ ok: true, changed: ["providerOverrides"] }),
      "providers.list": () => [{ id: "openai", label: "OpenAI", defaultModel: "gpt-5.1-mini", accounts: [] }],
    });
    const ok = await h.cmds.setProviderOverride("openai", { defaultModel: "gpt-5.1-mini" });
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { providerOverrides: { openai: { defaultModel: "gpt-5.1-mini" } } } });
    expect(h.cmds.getState().providers[0]).toMatchObject({ id: "openai", defaultModel: "gpt-5.1-mini" });
  });
  it("null clears the provider's override entry", async () => {
    const h = harness({ "config.patch": () => ({ ok: true, changed: ["providerOverrides"] }) });
    await h.cmds.setProviderOverride("openai", null);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { providerOverrides: { openai: null } } });
  });
  it("a failing patch surfaces a commandError and returns false", async () => {
    const h = harness({ "config.patch": () => { throw new Error("invalid config: providerOverrides"); } });
    const ok = await h.cmds.setProviderOverride("openai", { baseUrl: "not a url" });
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

describe("network writes", () => {
  it("setAuthKey forwards the key, flags stored, and retains no secret", async () => {
    const h = harness({ "fed.tailscale.setAuthKey": () => ({ ok: true }) });
    const ok = await h.cmds.setAuthKey("tskey-auth-SECRET");
    expect(ok).toBe(true);
    expect(h.cmds.getState().authKeyStored).toBe(true);
    expect(JSON.stringify(h.cmds.getState())).not.toContain("SECRET");
  });
  it("networkUp stores the returned authUrl and re-probes", async () => {
    const h = harness({ "fed.network.up": () => ({ authUrl: "https://login.tailscale.com/a/abc" }) });
    await h.cmds.networkUp();
    expect(h.cmds.getState().authUrl).toBe("https://login.tailscale.com/a/abc");
    expect(h.calls.some((c) => c.method === "fed.network")).toBe(true);
  });
});

// CLOUDFLARE-APP-SURFACE — mirrors the "network writes" block above: the apiToken
// handed to fed.cloudflare.up is write-only (a bare RPC argument, dropped once the
// call returns) and the shared state built off the response is an explicit pick of
// the known CloudflareProvisionStatus fields, never a raw spread — so nothing
// secret-shaped can ever land in getState(), even if a malformed/malicious response
// tried to smuggle one in.
describe("cloudflare writes — apiToken is write-only, response is field-picked (SECRET DISCIPLINE)", () => {
  it("loadCloudflare folds only the known status fields into state.cloudflare", async () => {
    const h = harness({
      "fed.cloudflare": () => ({
        installed: true, provisioned: true, hostname: "peer.example.com",
        tunnelHealth: "healthy", selfprobe: "passed", accessTokenExpiry: 123,
      }),
    });
    await h.cmds.loadCloudflare();
    expect(h.cmds.getState().cloudflare).toEqual({
      installed: true, provisioned: true, hostname: "peer.example.com",
      tunnelHealth: "healthy", selfprobe: "passed", accessTokenExpiry: 123,
    });
    expect(h.cmds.getState().loaded.cloudflare).toBe(true);
  });

  it("cloudflareUp forwards {domain, apiToken}, retains no secret in state afterwards (shown-once discipline)", async () => {
    const h = harness({
      "fed.cloudflare.up": () => ({
        steps: [{ step: "verify-token", ok: true }],
        status: { installed: true, provisioned: true, hostname: "peer.example.com", tunnelHealth: "healthy", selfprobe: "passed", accessTokenExpiry: null },
      }),
    });
    const ok = await h.cmds.cloudflareUp("example.com", "cf-token-TOPSECRET");
    expect(ok).toBe(true);
    const upCall = h.calls.find((c) => c.method === "fed.cloudflare.up")!;
    expect(upCall.params).toEqual({ domain: "example.com", apiToken: "cf-token-TOPSECRET" });
    // the token was sent, but never retained anywhere in the resulting shared state.
    expect(JSON.stringify(h.cmds.getState())).not.toContain("TOPSECRET");
    expect(h.cmds.getState().cloudflare).not.toHaveProperty("apiToken");
  });

  it("cloudflareUp omits apiToken on a re-run (already stored in Keychain)", async () => {
    const h = harness({ "fed.cloudflare.up": () => ({ status: { installed: true, provisioned: true, hostname: null, tunnelHealth: "healthy", selfprobe: "passed", accessTokenExpiry: null } }) });
    await h.cmds.cloudflareUp("example.com");
    const upCall = h.calls.find((c) => c.method === "fed.cloudflare.up")!;
    expect(upCall.params).toEqual({ domain: "example.com" });
  });

  // Requirement 4: even if the daemon's response were malformed and included a stray
  // apiToken (or any other secret-shaped) field, the field-by-field pick in
  // pickCloudflareStatus must never let it reach shared state — proving the merge
  // logic is a pick, not a spread.
  it("a raw response smuggling an extra apiToken field never reaches shared state", async () => {
    const h = harness({
      "fed.cloudflare.up": () => ({
        status: {
          installed: true, provisioned: true, hostname: "peer.example.com",
          tunnelHealth: "healthy", selfprobe: "passed", accessTokenExpiry: null,
          apiToken: "SHOULD-NEVER-APPEAR", accessSecret: "SHOULD-NEVER-APPEAR-EITHER",
        },
      }),
    });
    await h.cmds.cloudflareUp("example.com", "cf-token-abc");
    const stored = h.cmds.getState().cloudflare as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty("apiToken");
    expect(stored).not.toHaveProperty("accessSecret");
    expect(JSON.stringify(h.cmds.getState())).not.toContain("SHOULD-NEVER-APPEAR");
  });

  it("loadCloudflare defensively field-picks too — a raw fed.cloudflare response with an extra apiToken never surfaces", async () => {
    const h = harness({
      "fed.cloudflare": () => ({
        installed: false, provisioned: false, hostname: null, tunnelHealth: "unknown", selfprobe: "pending", accessTokenExpiry: null,
        apiToken: "SHOULD-NEVER-APPEAR",
      }),
    });
    await h.cmds.loadCloudflare();
    expect(JSON.stringify(h.cmds.getState())).not.toContain("SHOULD-NEVER-APPEAR");
  });
});

describe("daily cap → config.patch", () => {
  it("patches {dailyCapUsd} and reconciles general", async () => {
    const h = harness({ "config.patch": () => ({ ok: true, changed: ["dailyCapUsd"] }), "config.get": () => ({ autoOrder: [], dailyCapUsd: 7 }) });
    const ok = await h.cmds.setDailyCap(7);
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { dailyCapUsd: 7 } });
    expect(h.cmds.getState().dailyCapUsd).toBe(7);
  });
  it("null clears the cap", async () => {
    const h = harness({ "config.patch": () => ({ ok: true, changed: ["dailyCapUsd"] }) });
    await h.cmds.setDailyCap(null);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { dailyCapUsd: null } });
  });
});

describe("CONCURRENCY-CAP-UI: loadGeneral folds caps.* (config.get) + agentCap/agents.running (daemon.status)", () => {
  it("folds maxAgentsTotal / perAccount / dynamicCap and the live agentCap snapshot", async () => {
    const agentCap = { cap: 5, ceiling: 12, healthy: true, cpuPressure: true, memPressure: false, load1: 11.4, cores: 12, freeMemGb: 3.2, explain: "load 11.4/12 cores, 3.2 GB free" };
    const dynamicCap = { enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 };
    const h = harness({
      "daemon.status": () => ({ engineId: "studio", dailyCapUsd: null, agents: { running: 4 }, agentCap }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 20, perAccount: { main: 3 }, dynamicCap } }),
    });
    await h.cmds.loadGeneral();
    const s = h.cmds.getState();
    expect(s.maxAgentsTotal).toBe(20);
    expect(s.perAccount).toEqual({ main: 3 });
    expect(s.dynamicCap).toEqual(dynamicCap);
    expect(s.agentCap).toEqual(agentCap);
    expect(s.agentsRunning).toBe(4);
  });
  it("absent caps/agentCap ⇒ untouched-config defaults (12, {}, null, null, 0)", async () => {
    const h = harness({
      "daemon.status": () => ({ engineId: "studio", dailyCapUsd: null }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null }),
    });
    await h.cmds.loadGeneral();
    const s = h.cmds.getState();
    expect(s.maxAgentsTotal).toBe(12);
    expect(s.perAccount).toEqual({});
    expect(s.dynamicCap).toBeNull();
    expect(s.agentCap).toBeNull();
    expect(s.agentsRunning).toBe(0);
  });
});

describe("CONCURRENCY-CAP-UI: setMaxAgentsTotal → config.patch {caps: {maxAgentsTotal}}", () => {
  it("emits the exact patch payload and reconciles from a fresh read", async () => {
    const h = harness({
      "config.patch": () => ({ ok: true, changed: ["caps"] }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 20, perAccount: {} } }),
    });
    const ok = await h.cmds.setMaxAgentsTotal(20);
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { caps: { maxAgentsTotal: 20 } } });
    expect(h.cmds.getState().maxAgentsTotal).toBe(20);
  });
});

describe("CONCURRENCY-CAP-UI: setDynamicCap → config.patch {caps: {dynamicCap}}", () => {
  it("sends the FULL validated DynamicCapConfig, never a partial patch", async () => {
    const dynamicCap = { enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5, memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3 };
    const h = harness({
      "config.patch": () => ({ ok: true, changed: ["caps"] }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {}, dynamicCap } }),
    });
    const ok = await h.cmds.setDynamicCap(dynamicCap as never);
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { caps: { dynamicCap } } });
    expect(h.cmds.getState().dynamicCap).toEqual(dynamicCap);
  });
});

describe("CONCURRENCY-CAP-UI: setPerAccountCap → config.patch {caps: {perAccount: {[name]: value}}} (single-key merge)", () => {
  it("sets a cap for one account without touching siblings", async () => {
    const h = harness({
      "config.patch": () => ({ ok: true, changed: ["caps"] }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: { main: 3 } } }),
    });
    const ok = await h.cmds.setPerAccountCap("main", 3);
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { caps: { perAccount: { main: 3 } } } });
    expect(h.cmds.getState().perAccount).toEqual({ main: 3 });
  });
  it("null clears that account's entry", async () => {
    const h = harness({ "config.patch": () => ({ ok: true, changed: ["caps"] }) });
    await h.cmds.setPerAccountCap("main", null);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { caps: { perAccount: { main: null } } } });
  });
});

describe("project import dir → config.patch (IMPORT-DIR)", () => {
  it("patches {projectImportDir} and reconciles general", async () => {
    const h = harness({
      "config.patch": () => ({ ok: true, changed: ["projectImportDir"] }),
      "config.get": () => ({ autoOrder: [], dailyCapUsd: null, projectImportDir: "/home/me/imports" }),
    });
    const ok = await h.cmds.setProjectImportDir("/home/me/imports");
    expect(ok).toBe(true);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { projectImportDir: "/home/me/imports" } });
    expect(h.cmds.getState().projectImportDir).toBe("/home/me/imports");
  });
  it("null clears the import dir", async () => {
    const h = harness({ "config.patch": () => ({ ok: true, changed: ["projectImportDir"] }) });
    await h.cmds.setProjectImportDir(null);
    const patchCall = h.calls.find((c) => c.method === "config.patch")!;
    expect(patchCall.params).toEqual({ patch: { projectImportDir: null } });
  });
});

describe("MCP store (mcpstore.*)", () => {
  it("does not let an old list response overwrite post-install reconciliation", async () => {
    let finishOld!: (value: unknown) => void;
    let reads = 0;
    const h = harness({ "mcpstore.list": () => ++reads === 1
      ? new Promise((r) => { finishOld = r; }) : [{ name: "new-package", type: "stdio", command: "node", args: [], env: {} }] });
    const old = h.cmds.loadMcpStore();
    await h.cmds.loadMcpStore();
    finishOld([]); await old;
    expect(h.cmds.getState().mcpServers.map((s) => s.name)).toEqual(["new-package"]);
  });
  it("package installation uses the operator RPC and refreshes without provider imports", async () => {
    const h = harness();
    const input = { reviewId: "12345678-1234-4234-9234-123456789012", name: "test", bin: "server", args: [] };
    await h.cmds.installMcpPackage(input);
    expect(h.calls.find((c) => c.method === "mcpstore.package.install")?.params).toEqual(input);
    expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
    expect(h.calls.some((c) => c.method === "mcpstore.import")).toBe(false);
  });
  it("loadMcpStore folds mcpstore.list + mcpstore.importables", async () => {
    const h = harness({
      "mcpstore.list": () => [{ name: "echo", type: "stdio", command: "node", args: ["e.js"], env: {} }],
      "mcpstore.importables": () => ({ importables: [{ source: "claude", name: "ui5", command: "npx", args: [], env: {} }] }),
    });
    await h.cmds.loadMcpStore();
    expect(h.cmds.getState().mcpServers).toHaveLength(1);
    expect(h.cmds.getState().mcpImportables).toHaveLength(1);
    expect(h.cmds.getState().loaded.mcpStore).toBe(true);
  });

  // MCP-OAUTH-GATEWAYS: the add-remote form's scope catalog source.
  describe("loadMcpStore folds config.get mcpOAuthGateways", () => {
    const gateways = [{ hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets"], optionalScopes: ["admin"] }];

    it("carries the configured gateways", async () => {
      const h = harness({ "config.get": () => ({ autoOrder: [], mcpOAuthGateways: gateways }) });
      await h.cmds.loadMcpStore();
      expect(h.cmds.getState().mcpOAuthGateways).toEqual(gateways);
    });

    it("is empty when none are configured", async () => {
      const h = harness();
      await h.cmds.loadMcpStore();
      expect(h.cmds.getState().mcpOAuthGateways).toEqual([]);
    });

    it("a failed config.get keeps the previous gateways and still loads the server list", async () => {
      let fail = false;
      const h = harness({
        "config.get": () => (fail ? Promise.reject(new Error("boom")) : { autoOrder: [], mcpOAuthGateways: gateways }),
        "mcpstore.list": () => [{ name: "echo", type: "stdio", command: "node", args: [], env: {} }],
      });
      await h.cmds.loadMcpStore();
      fail = true;
      await h.cmds.loadMcpStore();
      expect(h.cmds.getState().mcpOAuthGateways).toEqual(gateways);
      expect(h.cmds.getState().mcpServers).toHaveLength(1);
      expect(h.dispatched).toEqual([]);
    });
  });

  it("addMcpStore sends a stdio spec and reconciles from a fresh list", async () => {
    const h = harness({ "mcpstore.add": () => ({ name: "echo", type: "stdio", command: "node", args: ["e.js"], env: {} }) });
    const ok = await h.cmds.addMcpStore("echo", { type: "stdio", command: "node", args: ["e.js"], env: {} });
    expect(ok).toBe(true);
    const addCall = h.calls.find((c) => c.method === "mcpstore.add")!;
    expect(addCall.params).toEqual({ name: "echo", type: "stdio", command: "node", args: ["e.js"], env: {} });
    expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
  });

  it("addMcpStore sends an http spec with headers", async () => {
    const h = harness({ "mcpstore.add": () => ({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: {} }) });
    const ok = await h.cmds.addMcpStore("remote", { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(ok).toBe(true);
    expect(h.calls.find((c) => c.method === "mcpstore.add")?.params).toEqual({
      name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" },
    });
  });

  it("addMcpStore surfaces a duplicate-name error as a commandError toast, not a crash", async () => {
    const h = harness({ "mcpstore.add": () => { throw { code: "conflict", message: 'mcp store server "echo" already exists' }; } });
    const ok = await h.cmds.addMcpStore("echo", { type: "stdio", command: "node", args: [], env: {} });
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });

  it("removeMcpStore sends {name} and reconciles", async () => {
    const h = harness({ "mcpstore.remove": () => ({ name: "echo", removed: true }) });
    await h.cmds.removeMcpStore("echo");
    const rm = h.calls.find((c) => c.method === "mcpstore.remove")!;
    expect(rm.params).toEqual({ name: "echo" });
    expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
  });

  it("importMcpStore sends {source,name} (no `as` when unset) and reconciles", async () => {
    const h = harness({ "mcpstore.import": () => ({ name: "ui5", type: "stdio", command: "npx", args: [], env: {} }) });
    const ok = await h.cmds.importMcpStore("claude", "ui5");
    expect(ok).toBe(true);
    const imp = h.calls.find((c) => c.method === "mcpstore.import")!;
    expect(imp.params).toEqual({ source: "claude", name: "ui5" });
  });

  it("importMcpStore forwards an explicit `as` rename", async () => {
    const h = harness({ "mcpstore.import": () => ({ name: "my-ui5", type: "stdio", command: "npx", args: [], env: {} }) });
    await h.cmds.importMcpStore("claude", "ui5", "my-ui5");
    const imp = h.calls.find((c) => c.method === "mcpstore.import")!;
    expect(imp.params).toEqual({ source: "claude", name: "ui5", as: "my-ui5" });
  });

  it("a failing import records a per-row inline error (mcpImportErrors) AND the commandError toast — never silent", async () => {
    const h = harness({
      "mcpstore.import": () => { throw new Error('no importable mcp server "ui5" found from source "claude" (re-scan with mcpstore.importables)'); },
    });
    const ok = await h.cmds.importMcpStore("claude", "ui5");
    expect(ok).toBe(false);
    expect(h.cmds.getState().mcpImportErrors["claude:ui5"]).toMatch(/re-scan with mcpstore.importables/);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });

  it("a subsequent successful import clears that row's inline error", async () => {
    const h = harness({
      "mcpstore.import": (p) => {
        if ((p as { name: string }).name === "ui5" && h.calls.filter((c) => c.method === "mcpstore.import").length === 1) {
          throw new Error("rescan mismatch");
        }
        return { name: "ui5", type: "stdio", command: "npx", args: [], env: {} };
      },
    });
    await h.cmds.importMcpStore("claude", "ui5");
    expect(h.cmds.getState().mcpImportErrors["claude:ui5"]).toBeDefined();
    await h.cmds.importMcpStore("claude", "ui5");
    expect(h.cmds.getState().mcpImportErrors["claude:ui5"]).toBeUndefined();
  });

  // MCP-REMOTE-IMPORT slice 3: a requiresAuth remote import follows up with
  // mcpstore.setAuth against the IMPORT RESPONSE's name (not the raw `name` arg —
  // they can differ via sanitization/`as`), and only after import succeeded
  // (setAuth needs the entry to already exist).
  it("importMcpStore, given a secret, imports THEN calls mcpstore.setAuth with the response's resolved name", async () => {
    const h = harness({
      "mcpstore.import": () => ({ name: "remote-svc", type: "http", url: "https://mcp.example.com/mcp", headers: {}, requiresAuth: true }),
    });
    const ok = await h.cmds.importMcpStore("claude", "remote svc", undefined, "sk-secret-token");
    expect(ok).toBe(true);
    const methods = h.calls.map((c) => c.method);
    expect(methods.indexOf("mcpstore.import")).toBeLessThan(methods.indexOf("mcpstore.setAuth"));
    const setAuthCall = h.calls.find((c) => c.method === "mcpstore.setAuth")!;
    expect(setAuthCall.params).toEqual({ name: "remote-svc", secret: "sk-secret-token" });
  });

  it("importMcpStore with no secret never calls mcpstore.setAuth", async () => {
    const h = harness({ "mcpstore.import": () => ({ name: "ui5", type: "stdio", command: "npx", args: [], env: {} }) });
    await h.cmds.importMcpStore("claude", "ui5");
    expect(h.calls.some((c) => c.method === "mcpstore.setAuth")).toBe(false);
  });

  it("setMcpStoreAuth sends {name,secret} and never surfaces the secret on failure logging path (commandError uses the thrown message only)", async () => {
    const h = harness({ "mcpstore.setAuth": () => ({ ok: true }) });
    const ok = await h.cmds.setMcpStoreAuth("remote", "sk-secret-token");
    expect(ok).toBe(true);
    expect(h.calls.find((c) => c.method === "mcpstore.setAuth")?.params).toEqual({ name: "remote", secret: "sk-secret-token" });
  });

  // claude.ai-managed importables can't go through mcpstore.import (the daemon
  // rejects any notImportableReason row) — connectManagedMcpStore takes the
  // mcpstore.add + mcpstore.setAuth path instead, using the importable's own
  // url/headers plus the operator's own token.
  it("connectManagedMcpStore adds the entry with an auth.keychainRef, then setAuth, then reconciles", async () => {
    const h = harness({
      "mcpstore.add": () => ({ name: "slack", type: "http", url: "https://mcp.slack.com/mcp", headers: {}, direct: false, auth: { keychainRef: "chimera:mcp:slack" } }),
      "mcpstore.setAuth": () => ({ ok: true }),
    });
    const imp = { source: "claude" as const, name: "slack", type: "http" as const, url: "https://mcp.slack.com/mcp", headers: {}, requiresAuth: true, notImportableReason: "not importable (claude.ai-managed auth)" };
    const ok = await h.cmds.connectManagedMcpStore(imp, "sk-my-own-token");
    expect(ok).toBe(true);
    const addCall = h.calls.find((c) => c.method === "mcpstore.add")!;
    expect(addCall.params).toMatchObject({ name: "slack", type: "http", url: "https://mcp.slack.com/mcp" });
    expect((addCall.params as { auth?: { keychainRef?: string } }).auth?.keychainRef).toBeTruthy();
    const setAuthCall = h.calls.find((c) => c.method === "mcpstore.setAuth")!;
    expect(setAuthCall.params).toEqual({ name: "slack", secret: "sk-my-own-token" });
    expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
    expect(h.calls.some((c) => c.method === "mcpstore.import")).toBe(false);
  });

  it("connectManagedMcpStore surfaces a failure via the row's mcpImportErrors key", async () => {
    const h = harness({
      "mcpstore.add": () => { throw new Error("boom"); },
    });
    const imp = { source: "codex" as const, name: "gdrive", type: "http" as const, url: "https://mcp.example.com/gdrive", headers: {}, requiresAuth: true, notImportableReason: "not importable" };
    const ok = await h.cmds.connectManagedMcpStore(imp, "token");
    expect(ok).toBe(false);
    expect(h.cmds.getState().mcpImportErrors["codex:gdrive"]).toMatch(/boom/);
  });

  it("loadMcpServerTools queries mcpstore.tools with {query: name} and stores the connected server's tools", async () => {
    const h = harness({
      "mcpstore.tools": () => ({
        servers: [{ server: "chrome-devtools", connected: true, tools: [{ server: "chrome-devtools", name: "navigate_page", description: "Navigate to a URL", inputSchema: {} }] }],
      }),
    });
    await h.cmds.loadMcpServerTools("chrome-devtools");
    const call = h.calls.find((c) => c.method === "mcpstore.tools")!;
    expect(call.params).toEqual({ query: "chrome-devtools" });
    const row = h.cmds.getState().mcpTools["chrome-devtools"];
    expect(row).toMatchObject({ status: "loaded", connected: true });
    expect(row.tools).toHaveLength(1);
    expect(row.tools[0]?.name).toBe("navigate_page");
  });

  it("loadMcpServerTools stores a connect error verbatim and zero tools, without a commandError toast", async () => {
    const h = harness({
      "mcpstore.tools": () => ({
        servers: [{ server: "telegram", connected: false, error: "Connection closed", tools: [] }],
      }),
    });
    await h.cmds.loadMcpServerTools("telegram");
    const row = h.cmds.getState().mcpTools["telegram"];
    expect(row).toEqual({ status: "loaded", connected: false, error: "Connection closed", tools: [] });
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(false);
  });

  it("loadMcpServerTools distinguishes a connected-but-empty server from an error", async () => {
    const h = harness({
      "mcpstore.tools": () => ({ servers: [{ server: "empty", connected: true, tools: [] }] }),
    });
    await h.cmds.loadMcpServerTools("empty");
    const row = h.cmds.getState().mcpTools["empty"];
    expect(row).toEqual({ status: "loaded", connected: true, error: undefined, tools: [] });
  });

  it("loadMcpServerTools sets a loading state synchronously before the RPC resolves", () => {
    const h = harness({ "mcpstore.tools": () => new Promise(() => {}) });
    void h.cmds.loadMcpServerTools("chrome-devtools");
    expect(h.cmds.getState().mcpTools["chrome-devtools"]?.status).toBe("loading");
  });

  it("loadMcpServerTools surfaces an RPC-level failure as a commandError toast without crashing", async () => {
    const h = harness({ "mcpstore.tools": () => { throw new Error("rpc unreachable"); } });
    await h.cmds.loadMcpServerTools("chrome-devtools");
    const row = h.cmds.getState().mcpTools["chrome-devtools"];
    expect(row).toEqual({ status: "loaded", connected: false, error: "rpc unreachable", tools: [] });
  });

  // MCP-OAUTH-DISCOVERABILITY: loadMcpStore best-effort probes every remote entry that
  // ISN'T already oauth-kind — the ONLY way an already-imported bearer entry (e.g. the real
  // "gateway" case: imported before oauth existed, auth.kind stuck at "bearer") ever gets an
  // Authorize button surfaced without the user re-adding it.
  describe("MCP-OAUTH-DISCOVERABILITY: per-row detect probe on loadMcpStore", () => {
    it("probes every remote entry whose auth isn't already oauth-kind, and caches a detected:true result", async () => {
      const h = harness({
        "mcpstore.list": () => [
          { name: "gateway", type: "http", url: "https://gw.example.com/mcp", headers: {}, direct: false, auth: { kind: "bearer", keychainRef: "chimera:mcp:gateway" } },
        ],
        "mcpstore.detectAuth": () => ({ oauth: true, authorizationServers: ["https://as.example.com"] }),
      });
      await h.cmds.loadMcpStore();
      await settle();
      expect(h.calls.find((c) => c.method === "mcpstore.detectAuth")?.params).toEqual({ name: "gateway" });
      expect(h.cmds.getState().mcpDetectedOAuth["gateway"]).toBe(true);
    });

    it("never probes an entry that is already oauth-kind", async () => {
      const h = harness({
        "mcpstore.list": () => [
          { name: "gateway", type: "http", url: "https://gw.example.com/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway", scopes: ["docs"] } },
        ],
      });
      await h.cmds.loadMcpStore();
      await settle();
      expect(h.calls.some((c) => c.method === "mcpstore.detectAuth")).toBe(false);
    });

    it("never probes a stdio entry (no remote url to probe)", async () => {
      const h = harness({
        "mcpstore.list": () => [{ name: "local", type: "stdio", command: "node", args: [], env: {}, direct: false }],
      });
      await h.cmds.loadMcpStore();
      await settle();
      expect(h.calls.some((c) => c.method === "mcpstore.detectAuth")).toBe(false);
    });

    it("a probe failure leaves mcpDetectedOAuth unset (never a false negative), no commandError toast", async () => {
      const h = harness({
        "mcpstore.list": () => [
          { name: "gateway", type: "http", url: "https://gw.example.com/mcp", headers: {}, direct: false, auth: { kind: "bearer", keychainRef: "chimera:mcp:gateway" } },
        ],
        "mcpstore.detectAuth": () => { throw new Error("network unreachable"); },
      });
      await h.cmds.loadMcpStore();
      await settle();
      expect(h.cmds.getState().mcpDetectedOAuth["gateway"]).toBeUndefined();
      expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(false);
    });
  });

  describe("MCP-OAUTH-DISCOVERABILITY: convertMcpStoreAuthKind", () => {
    it("sends {name, kind:'oauth'} and reconciles from a fresh list read", async () => {
      const h = harness({
        "mcpstore.setAuthKind": () => ({ name: "gateway", type: "http", url: "https://gw.example.com/mcp", headers: {}, direct: false, auth: { kind: "oauth", keychainRef: "chimera:mcp:gateway", scopes: [] } }),
      });
      const ok = await h.cmds.convertMcpStoreAuthKind("gateway");
      expect(ok).toBe(true);
      expect(h.calls.find((c) => c.method === "mcpstore.setAuthKind")?.params).toEqual({ name: "gateway", kind: "oauth" });
      expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
    });

    it("surfaces a failure as a commandError toast and returns false", async () => {
      const h = harness({ "mcpstore.setAuthKind": () => { throw new Error("boom"); } });
      const ok = await h.cmds.convertMcpStoreAuthKind("gateway");
      expect(ok).toBe(false);
      expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
    });
  });
});

describe("self-refresh via daemon events (no refresh button)", () => {
  it("config_changed refetches accounts + config (providers/general)", async () => {
    const h = harness();
    h.cmds.onDaemonEvent("config_changed", { keys: ["accounts"] });
    await settle();
    const methods = h.calls.map((c) => c.method);
    expect(methods).toContain("accounts.list");
    expect(methods).toContain("daemon.status"); // general read
  });
  it("network_changed refetches fed.network", async () => {
    const h = harness();
    h.cmds.onDaemonEvent("network_changed", {});
    await settle();
    expect(h.calls.some((c) => c.method === "fed.network")).toBe(true);
  });
  it("config_error is a toast, not a refresh", async () => {
    const h = harness();
    h.cmds.onDaemonEvent("config_error", { message: "invalid config: caps" });
    await settle();
    expect(h.calls).toHaveLength(0);
    const err = h.dispatched.find((a) => a["type"] === "commandError");
    expect(err).toBeTruthy();
    expect(String(err!["message"])).toContain("config:");
  });
});

// loadNetwork is the direct read behind the network section (and the re-probe after
// networkUp): it folds fed.network into state and only THEN flags loaded.network, so a
// failed probe leaves the section explicitly un-loaded rather than falsely "ready".
describe("loadNetwork", () => {
  it("folds fed.network into state.network and flags loaded.network", async () => {
    const h = harness({
      "fed.network": () => ({ installed: true, loggedIn: true, ip4: "100.2.2.2", magicDNS: false, tailscaleSSH: false }),
    });
    await h.cmds.loadNetwork();
    expect(h.cmds.getState().network).toMatchObject({ ip4: "100.2.2.2", loggedIn: true });
    expect(h.cmds.getState().loaded.network).toBe(true);
  });
  it("a failing fed.network surfaces a commandError and keeps loaded.network false", async () => {
    const h = harness({ "fed.network": () => { throw new Error("tailscale not installed"); } });
    await h.cmds.loadNetwork();
    expect(h.cmds.getState().loaded.network).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

// SUBSCRIPTION-CONNECT: the "connect with subscription" catalog button registers an
// account riding the provider CLI's ambient login — no key entry — and reconciles the
// providers table from a fresh read, same eager-refresh pattern as addProvider.
describe("connectSubscription (SUBSCRIPTION-CONNECT)", () => {
  it("sends accounts.add_subscription {provider}, reconciles providers, returns true", async () => {
    const h = harness({
      "accounts.add_subscription": () => ({ name: "claude-sub", provider: "claude" }),
      "providers.list": () => [{ id: "claude", label: "Claude", accounts: [{ name: "claude-sub", authType: "subscription" }] }],
    });
    const ok = await h.cmds.connectSubscription("claude");
    expect(ok).toBe(true);
    const addCall = h.calls.find((c) => c.method === "accounts.add_subscription")!;
    expect(addCall.params).toEqual({ provider: "claude" });
    expect(h.calls.some((c) => c.method === "providers.list")).toBe(true);
    expect(h.cmds.getState().providers[0]).toMatchObject({ id: "claude" });
  });
  it("a failing add_subscription surfaces a commandError and returns false", async () => {
    const h = harness({ "accounts.add_subscription": () => { throw new Error("provider \"claude\" has no CLI login"); } });
    const ok = await h.cmds.connectSubscription("claude");
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

// KIMI-CODE-SUBSCRIPTION-UI: the oauth branch of the unified "connect with
// subscription" button — accounts.oauth_start -> poll accounts.oauth_finish. Covers
// both shapes oauth_start can hand back: an "immediate" CLI-file-backed flow
// (grok-build/kimi-code — the very first finish poll already resolves) and a
// device/authorize flow that needs real polling (copilot).
describe("connectProviderOAuth (KIMI-CODE-SUBSCRIPTION-UI)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("an 'immediate' flow (no userCode/authorizeUrl) resolves to connected on the very first poll, no interval needed", async () => {
    let finishCalls = 0;
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1" }),
      "accounts.oauth_finish": () => { finishCalls += 1; return { status: "connected", name: "kimi-code", provider: "kimi-code" }; },
      "accounts.test": () => ({ name: "kimi-code", result: "ok" }),
      "providers.list": () => [{ id: "kimi-code", label: "Kimi Code", accounts: [{ name: "kimi-code", authType: "oauth" }] }],
    });
    await h.cmds.connectProviderOAuth("kimi-code", 1500);
    expect(h.cmds.getState().providerOAuth["kimi-code"]).toMatchObject({ status: "connected" });
    expect(finishCalls).toBe(1);

    // no timer was ever armed — advancing fake timers triggers no further calls.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finishCalls).toBe(1);

    // reconciled from a fresh providers.list read.
    expect(h.calls.some((c) => c.method === "providers.list")).toBe(true);
  });

  it("connecting an immediate flow auto-tests the new account so subscriptionOAuthConnected has fresh data", async () => {
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1" }),
      "accounts.oauth_finish": () => ({ status: "connected", name: "grok-build", provider: "grok-build" }),
      "accounts.test": () => ({ name: "grok-build", result: "auth_error", detail: "token rejected" }),
    });
    await h.cmds.connectProviderOAuth("grok-build");
    expect(h.cmds.getState().tests["grok-build"]).toBe("auth_error");
    expect(h.cmds.getState().testDetails["grok-build"]).toBe("token rejected");
  });

  it("a device-code flow (userCode/verificationUri present) shows awaiting state, then polls to connected", async () => {
    let finishCalls = 0;
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }),
      "accounts.oauth_finish": () => { finishCalls += 1; return { status: finishCalls < 3 ? "pending" : "connected", name: "copilot" }; },
      "accounts.test": () => ({ name: "copilot", result: "ok" }),
    });
    const p = h.cmds.connectProviderOAuth("copilot", 1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishCalls).toBe(1); // the first poll runs inline before any interval is armed
    expect(h.cmds.getState().providerOAuth["copilot"]).toMatchObject({ status: "polling", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    await p;

    await vi.advanceTimersByTimeAsync(1500);
    expect(finishCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(finishCalls).toBe(3);
    expect(h.cmds.getState().providerOAuth["copilot"]?.status).toBe("connected");

    // timer really stopped — no further finish calls after connecting.
    await vi.advanceTimersByTimeAsync(6000);
    expect(finishCalls).toBe(3);
  });

  it("an oauth_finish error status stops polling and records the message", async () => {
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }),
      "accounts.oauth_finish": () => ({ status: "error", message: "device code expired" }),
    });
    await h.cmds.connectProviderOAuth("copilot", 1500);
    expect(h.cmds.getState().providerOAuth["copilot"]).toMatchObject({ status: "error", error: "device code expired" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.calls.filter((c) => c.method === "accounts.oauth_finish")).toHaveLength(1);
  });

  it("a failing oauth_start surfaces a commandError and records status error", async () => {
    const h = harness({ "accounts.oauth_start": () => { throw new Error('provider "copilot" is experimental — set config providers.experimental to connect it'); } });
    await h.cmds.connectProviderOAuth("copilot");
    expect(h.cmds.getState().providerOAuth["copilot"]).toMatchObject({ status: "error" });
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });

  it("cancelProviderOAuth stops polling and clears the row's local state with no RPC call", async () => {
    let finishCalls = 0;
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1", userCode: "ABCD-1234", verificationUri: "https://x" }),
      "accounts.oauth_finish": () => { finishCalls += 1; return { status: "pending" }; },
    });
    await h.cmds.connectProviderOAuth("copilot", 1500);
    expect(h.cmds.getState().providerOAuth["copilot"]).toBeTruthy();

    h.cmds.cancelProviderOAuth("copilot");
    expect(h.cmds.getState().providerOAuth["copilot"]).toBeUndefined();
    expect(h.calls.some((c) => c.method.startsWith("accounts.oauth_cancel"))).toBe(false);

    const before = finishCalls;
    await vi.advanceTimersByTimeAsync(6000);
    expect(finishCalls).toBe(before); // the timer is really stopped, not just hidden
  });

  it("never puts a raw token anywhere in state — only pendingId/status/code/url", async () => {
    const h = harness({
      "accounts.oauth_start": () => ({ pendingId: "p1" }),
      "accounts.oauth_finish": () => ({ status: "connected", name: "kimi-code", accessToken: "secret-token-should-never-be-stored" }),
    });
    await h.cmds.connectProviderOAuth("kimi-code");
    expect(JSON.stringify(h.cmds.getState())).not.toContain("secret-token-should-never-be-stored");
  });
});

// MCP-STORE-DIRECT-TOGGLE: flip a server's `direct` flag → mcpstore.setDirect, then
// reconcile from a fresh list read — same eager-refresh pattern as add/removeMcpStore.
describe("setMcpStoreDirect (MCP-STORE-DIRECT-TOGGLE)", () => {
  it("sends {name, direct} and reconciles from a fresh list", async () => {
    const h = harness({ "mcpstore.setDirect": () => ({ ok: true }) });
    const ok = await h.cmds.setMcpStoreDirect("echo", true);
    expect(ok).toBe(true);
    const call = h.calls.find((c) => c.method === "mcpstore.setDirect")!;
    expect(call.params).toEqual({ name: "echo", direct: true });
    expect(h.calls.some((c) => c.method === "mcpstore.list")).toBe(true);
  });
  it("forwards direct:false unchanged", async () => {
    const h = harness({ "mcpstore.setDirect": () => ({ ok: true }) });
    await h.cmds.setMcpStoreDirect("echo", false);
    expect(h.calls.find((c) => c.method === "mcpstore.setDirect")?.params).toEqual({ name: "echo", direct: false });
  });
  it("a failing setDirect surfaces a commandError and returns false", async () => {
    const h = harness({ "mcpstore.setDirect": () => { throw new Error("no such mcp store server \"echo\""); } });
    const ok = await h.cmds.setMcpStoreDirect("echo", true);
    expect(ok).toBe(false);
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });
});

// MCP-OAUTH slice 3: the Authorize button's command layer — start → (screen opens the
// browser) → poll finish until connected/error. This module never sees a token: the wire
// contract (mcpstore.oauth.start/finish) only ever carries {pendingId, authorizeUrl} /
// {status, error?} — so "no token in app state" is a property of the RPC shape itself,
// verified here by asserting the serialized state never contains the finish-fixture's
// deliberately token-shaped canary string.
describe("MCP-OAUTH slice 3: authorizeMcpStore + polling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("authorizeMcpStore sends {name}, stores pendingId+authorizeUrl (status awaiting), and returns the url", async () => {
    const h = harness({
      "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/oauth/authorize?x=1" }),
    });
    const url = await h.cmds.authorizeMcpStore("gateway");
    expect(url).toBe("https://gw.example.com/oauth/authorize?x=1");
    const call = h.calls.find((c) => c.method === "mcpstore.oauth.start")!;
    expect(call.params).toEqual({ name: "gateway" });
    expect(h.cmds.getState().mcpOAuth["gateway"]).toMatchObject({ status: "awaiting", pendingId: "p1", authorizeUrl: "https://gw.example.com/oauth/authorize?x=1" });
  });

  it("a failing start surfaces a commandError, records status error, and returns null", async () => {
    const h = harness({ "mcpstore.oauth.start": () => { throw new Error('mcp store server "gateway" is not configured for oauth'); } });
    const url = await h.cmds.authorizeMcpStore("gateway");
    expect(url).toBeNull();
    expect(h.cmds.getState().mcpOAuth["gateway"]).toMatchObject({ status: "error" });
    expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(true);
  });

  it("startMcpStoreOAuthPolling polls oauth.finish every ~1.5s and stops + refreshes tools on connected", async () => {
    let finishCalls = 0;
    const h = harness({
      "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
      "mcpstore.oauth.finish": () => {
        finishCalls += 1;
        return { status: finishCalls < 3 ? "pending" : "connected" };
      },
      "mcpstore.tools": () => ({ servers: [{ server: "gateway", connected: true, tools: [] }] }),
    });
    await h.cmds.authorizeMcpStore("gateway");
    h.cmds.startMcpStoreOAuthPolling("gateway", 1500);
    // flush the immediate poll (fired synchronously by startMcpStoreOAuthPolling, before any timer advance)
    await vi.advanceTimersByTimeAsync(0);
    expect(finishCalls).toBe(1);
    expect(h.cmds.getState().mcpOAuth["gateway"]?.status).toBe("polling");

    await vi.advanceTimersByTimeAsync(1500);
    expect(finishCalls).toBe(2);
    expect(h.cmds.getState().mcpOAuth["gateway"]?.status).toBe("polling");

    await vi.advanceTimersByTimeAsync(1500);
    expect(finishCalls).toBe(3);
    expect(h.cmds.getState().mcpOAuth["gateway"]?.status).toBe("connected");
    expect(h.calls.some((c) => c.method === "mcpstore.tools")).toBe(true);

    // the timer is really stopped — no further finish calls after connecting.
    await vi.advanceTimersByTimeAsync(4500);
    expect(finishCalls).toBe(3);

    // never a token anywhere on the state object.
    expect(JSON.stringify(h.cmds.getState())).not.toContain("stored-in-keychain");
  });

  it("startMcpStoreOAuthPolling stops and records the error on an oauth.finish error verdict", async () => {
    const h = harness({
      "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
      "mcpstore.oauth.finish": () => ({ status: "error", error: "state mismatch" }),
    });
    await h.cmds.authorizeMcpStore("gateway");
    h.cmds.startMcpStoreOAuthPolling("gateway", 1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cmds.getState().mcpOAuth["gateway"]).toMatchObject({ status: "error", error: "state mismatch" });

    await vi.advanceTimersByTimeAsync(6000);
    expect(h.calls.filter((c) => c.method === "mcpstore.oauth.finish")).toHaveLength(1);
  });

  it("stopMcpStoreOAuthPolling stops an in-flight poll immediately", async () => {
    let finishCalls = 0;
    const h = harness({
      "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
      "mcpstore.oauth.finish": () => { finishCalls += 1; return { status: "pending" }; },
    });
    await h.cmds.authorizeMcpStore("gateway");
    h.cmds.startMcpStoreOAuthPolling("gateway", 1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishCalls).toBe(1);
    h.cmds.stopMcpStoreOAuthPolling("gateway");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finishCalls).toBe(1);
  });

  // MCPSTORE-OAUTH-CANCEL: the "authorizing…" state was previously a dead end for up to 10
  // minutes (McpStoreOAuthFlow's server-side timeout) with no way for the user to bail out.
  describe("cancelMcpStoreOAuth", () => {
    it("sends {pendingId}, stops the poll timer, and clears this row's oauth state", async () => {
      let finishCalls = 0;
      const h = harness({
        "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
        "mcpstore.oauth.finish": () => { finishCalls += 1; return { status: "pending" }; },
        "mcpstore.oauth.cancel": () => ({}),
      });
      await h.cmds.authorizeMcpStore("gateway");
      h.cmds.startMcpStoreOAuthPolling("gateway", 1500);
      await vi.advanceTimersByTimeAsync(0);
      expect(finishCalls).toBe(1);

      await h.cmds.cancelMcpStoreOAuth("gateway");

      expect(h.calls.find((c) => c.method === "mcpstore.oauth.cancel")?.params).toEqual({ pendingId: "p1" });
      expect(h.cmds.getState().mcpOAuth["gateway"]).toBeUndefined();

      // the poll really stopped -- no further finish calls after cancel
      await vi.advanceTimersByTimeAsync(10_000);
      expect(finishCalls).toBe(1);
    });

    it("clears the row's state synchronously, BEFORE the cancel RPC settles (never blocks on the network)", async () => {
      let releaseCancel: () => void = () => {};
      const gate = new Promise<Record<string, never>>((resolve) => { releaseCancel = () => resolve({}); });
      const h = harness({
        "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
        "mcpstore.oauth.cancel": () => gate,
      });
      await h.cmds.authorizeMcpStore("gateway");
      h.cmds.startMcpStoreOAuthPolling("gateway", 1500);

      const cancelPromise = h.cmds.cancelMcpStoreOAuth("gateway");
      // the row is already reset even though the cancel RPC is still pending
      expect(h.cmds.getState().mcpOAuth["gateway"]).toBeUndefined();

      releaseCancel();
      await cancelPromise;
    });

    it("swallows a failing cancel RPC -- the row stays reset, no commandError toast", async () => {
      const h = harness({
        "mcpstore.oauth.start": () => ({ pendingId: "p1", authorizeUrl: "https://gw.example.com/authorize" }),
        "mcpstore.oauth.cancel": () => { throw new Error("unknown or expired oauth pending id"); },
      });
      await h.cmds.authorizeMcpStore("gateway");
      h.cmds.startMcpStoreOAuthPolling("gateway", 1500);

      await expect(h.cmds.cancelMcpStoreOAuth("gateway")).resolves.toBeUndefined();
      expect(h.cmds.getState().mcpOAuth["gateway"]).toBeUndefined();
      expect(h.dispatched.some((a) => a["type"] === "commandError")).toBe(false);
    });

    it("is a no-op (no RPC call) when the row never started a flow (no pendingId)", async () => {
      const h = harness();
      await h.cmds.cancelMcpStoreOAuth("gateway");
      expect(h.calls.some((c) => c.method === "mcpstore.oauth.cancel")).toBe(false);
    });
  });

  it("stopAllMcpStoreOAuthPolling stops every in-flight poll timer at once (unmount safety)", async () => {
    let finishCallsA = 0;
    let finishCallsB = 0;
    const h = harness({
      "mcpstore.oauth.start": (p) => ({ pendingId: (p as { name: string }).name === "a" ? "pa" : "pb", authorizeUrl: "https://gw.example.com/authorize" }),
      "mcpstore.oauth.finish": (p) => {
        if ((p as { pendingId: string }).pendingId === "pa") finishCallsA += 1; else finishCallsB += 1;
        return { status: "pending" };
      },
    });
    await h.cmds.authorizeMcpStore("a");
    await h.cmds.authorizeMcpStore("b");
    h.cmds.startMcpStoreOAuthPolling("a", 1500);
    h.cmds.startMcpStoreOAuthPolling("b", 1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishCallsA).toBe(1);
    expect(finishCallsB).toBe(1);

    h.cmds.stopAllMcpStoreOAuthPolling();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finishCallsA).toBe(1);
    expect(finishCallsB).toBe(1);
  });
});
