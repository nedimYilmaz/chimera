import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain } from "@chimera/core/keychain";
import type { ExecFn } from "@chimera/core/credentials";
import { FakeAccountProber, RealAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { PROVIDERS, findProvider } from "@chimera/core/providers/catalog";

type FetchCodexCliModelsFn = typeof import("@chimera/core/providers/codex-cli-models").fetchCodexCliModels;
type GetClaudeModelsCacheFn = typeof import("@chimera/core/providers/claude-models-cache").getClaudeModelsCache;

// F23-2B (D5/D6): providers.list — the catalog + per-provider connection state the
// Settings UI's Providers section renders. Same makeHome/makeEngine pattern as
// config-d7.test.ts's accounts CRUD suite.
function makeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chm-providers-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  return home;
}

const BASE = {
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "grok-key", provider: "xai", auth: { type: "keychain", service: "chimera:grok-key", injectAs: "XAI_API_KEY" } },
  ],
  autoOrder: ["main", "grok-key"],
};

// SPAWN-FORM-ACCOUNTS: a keychain-type account's credential resolves through
// CredentialResolver (shells out to the real `security` CLI by default, exactly
// like a real agent launch — supervisor tests fake this the same way, see
// test/helpers.ts's `fakeExec`), NOT through the injectable `Keychain` interface
// (`this.keychain`, still used for the unrelated accounts.setKey/test RPCs). A
// fixture keyed by service name stands in for a real keychain here.
function fakeExecFor(serviceKeys: Record<string, string>): ExecFn {
  return async (cmd, args) => {
    if (cmd === "security" && args[0] === "find-generic-password") {
      const service = args[args.indexOf("-s") + 1];
      const key = service ? serviceKeys[service] : undefined;
      return key ? { stdout: `${key}\n`, code: 0 } : { stdout: "", code: 1 };
    }
    return { stdout: "", code: 1 };
  };
}

// DYNAMIC-MODEL-LISTS: every providers.models reply now carries modelDetails — the picker shows
// the provider's own display name next to the id it must SEND. For a layer that only knows ids
// (HTTP /v1/models, the static catalog) the name IS the id.
function detailsOf(ids: readonly string[]) {
  return ids.map((id) => ({ value: id, displayName: id }));
}

function makeEngine(
  home: string, exec?: ExecFn,
  sdkModelSeams?: {
    fetchCodexCliModels?: FetchCodexCliModelsFn;
    probeClaudeModels?: () => Promise<Array<{ value: string; displayName: string; description?: string }>>;
    probeKimiModels?: () => Promise<Array<{ value: string; displayName: string; description?: string }>>;
  },
) {
  const backends = new Map([
    ["claude", new FakeAgentBackend([], "claude")],
    ["codex", new FakeAgentBackend([], "codex")],
  ]);
  return new Engine({
    home, backends, keychain: new InMemoryKeychain(), accountProber: new FakeAccountProber("ok"), exec,
    // DYNAMIC-MODEL-LISTS: both live-session probes default to "learned nothing" here. The real
    // ones start a claude SDK query / spawn the kimi CLI — a unit test asserting the CATALOG
    // fallback must not depend on whether this machine happens to have either installed.
    probeClaudeModels: async () => [],
    probeKimiModels: async () => [],
    ...sdkModelSeams,
  });
}

describe("providers.list RPC", () => {
  it("returns every catalog provider, in catalog order", async () => {
    const engine = makeEngine(makeHome(BASE));
    const rows = (await engine.handle("providers.list", {})) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(PROVIDERS.map((p) => p.id));
  });

  it("shapes each row with catalog fields + connection state", async () => {
    const engine = makeEngine(makeHome(BASE));
    const rows = (await engine.handle("providers.list", {})) as any[];
    const claude = rows.find((r) => r.id === "claude");
    expect(claude).toMatchObject({
      id: "claude", label: "Claude", kind: "agentic-sdk",
      authModes: ["apiKey", "oauth"],
      capabilities: { tools: true, vision: true, streaming: true },
      experimental: false,
      override: null,
    });
    expect(typeof claude.tosNote).toBe("string");
    expect(claude.accounts).toEqual([{ name: "main", authType: "subscription" }]);
  });

  it("lists configured accounts against the right provider row, and [] for a provider with none", async () => {
    const engine = makeEngine(makeHome(BASE));
    const rows = (await engine.handle("providers.list", {})) as any[];
    const xai = rows.find((r) => r.id === "xai");
    expect(xai.accounts).toEqual([{ name: "grok-key", authType: "keychain" }]);
    const deepseek = rows.find((r) => r.id === "deepseek");
    expect(deepseek.accounts).toEqual([]);
  });

  it("marks the copilot catalog entry experimental", async () => {
    const engine = makeEngine(makeHome(BASE));
    const rows = (await engine.handle("providers.list", {})) as any[];
    const copilot = rows.find((r) => r.id === "copilot");
    expect(copilot?.experimental).toBe(true);
  });

  it("echoes a configured providerOverrides entry as the effective baseUrl/defaultModel", async () => {
    const engine = makeEngine(makeHome({
      ...BASE,
      providerOverrides: { xai: { baseUrl: "https://proxy.internal/xai/v1", defaultModel: "grok-4.3" } },
    }));
    const rows = (await engine.handle("providers.list", {})) as any[];
    const xai = rows.find((r) => r.id === "xai");
    expect(xai.baseUrl).toBe("https://proxy.internal/xai/v1");
    expect(xai.defaultModel).toBe("grok-4.3");
    expect(xai.override).toEqual({ baseUrl: "https://proxy.internal/xai/v1", defaultModel: "grok-4.3" });
    // an un-overridden provider keeps its catalog defaults.
    const claude = rows.find((r) => r.id === "claude");
    expect(claude.override).toBeNull();
    expect(claude.baseUrl).toBe("https://api.anthropic.com");
  });

  it("a config.patch providerOverrides write is reflected on the next providers.list read", async () => {
    const engine = makeEngine(makeHome(BASE));
    await engine.handle("config.patch", { patch: { providerOverrides: { openai: { defaultModel: "gpt-5.1-mini" } } } });
    const rows = (await engine.handle("providers.list", {})) as any[];
    expect(rows.find((r) => r.id === "openai").defaultModel).toBe("gpt-5.1-mini");
  });

  // SPAWN-PROVIDER-MODEL: the spawn form's model select reads models/hasLiveModels
  // off this same row.
  it("carries each catalog entry's fallback models[] and a hasLiveModels flag", async () => {
    const engine = makeEngine(makeHome(BASE));
    const rows = (await engine.handle("providers.list", {})) as any[];
    const openai = rows.find((r) => r.id === "openai");
    expect(openai.models).toEqual(findProvider("openai")!.models);
    expect(openai.hasLiveModels).toBe(true);
    // SPAWN-FORM-ACCOUNTS: claude/codex now carry a real fallback list + a live
    // modelsEndpoint (previously models:[] with no endpoint — a single-model stub
    // whenever a live probe couldn't run, e.g. every subscription-only account).
    const claude = rows.find((r) => r.id === "claude");
    expect(claude.models).toEqual(findProvider("claude")!.models);
    expect(claude.models.length).toBeGreaterThan(1);
    expect(claude.hasLiveModels).toBe(true);
  });
});

describe("providers.models RPC", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown provider id", async () => {
    const engine = makeEngine(makeHome(BASE));
    await expect(engine.handle("providers.models", { provider: "not-a-real-provider" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringMatching(/unknown provider/) });
  });

  it("falls back to the catalog list when no account exists for the provider", async () => {
    const engine = makeEngine(makeHome(BASE));
    const res = await engine.handle("providers.models", { provider: "deepseek" }) as { models: string[]; defaultModel: string; source: string };
    expect(res).toEqual({ models: findProvider("deepseek")!.models, defaultModel: "deepseek-v4-pro", source: "catalog", modelDetails: detailsOf(findProvider("deepseek")!.models) });
  });

  // SPAWN-FORM-ACCOUNTS: a `subscription` account resolves to `null` (by design, no
  // key at all — CredentialResolver.resolve's subscription case) rather than
  // throwing, so it falls straight to the catalog fallback list, which is no longer
  // a single-model stub (previously models:[] before catalog.ts carried a real list).
  it("falls back to the catalog's fallback list for a subscription-only account (no resolvable key)", async () => {
    const engine = makeEngine(makeHome(BASE));
    const res = await engine.handle("providers.models", { provider: "claude" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: findProvider("claude")!.models, defaultModel: "claude-opus-4-8", source: "catalog", modelDetails: detailsOf(findProvider("claude")!.models) });
    expect(res.models.length).toBeGreaterThan(1);
  });

  // SPAWN-FORM-ACCOUNTS: with no explicit `account`, every account configured for
  // the provider is tried (not just the first) — a leading subscription account no
  // longer masks a later apiKey/keychain account that COULD serve a live list.
  it("tries every account for the provider in order, not just the first, when no `account` is given", async () => {
    const home = makeHome({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "claude-key", provider: "claude", auth: { type: "keychain", service: "chimera:claude-key", injectAs: "ANTHROPIC_API_KEY" } },
      ],
      autoOrder: ["main", "claude-key"],
    });
    const engine = makeEngine(home, fakeExecFor({ "chimera:claude-key": "sk-ant-live" }));
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe(findProvider("claude")!.modelsEndpoint);
      expect(init?.headers?.["x-api-key"]).toBe("sk-ant-live");
      return { ok: true, json: async () => ({ data: [{ id: "claude-live-1" }] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await engine.handle("providers.models", { provider: "claude" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: ["claude-live-1"], defaultModel: "claude-opus-4-8", source: "live", modelDetails: detailsOf(["claude-live-1"]) });
  });

  it("probes the live modelsEndpoint with the configured account's resolved key, and reports source \"live\"", async () => {
    const engine = makeEngine(makeHome(BASE), fakeExecFor({ "chimera:grok-key": "fake-xai-key" }));
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe(findProvider("xai")!.modelsEndpoint);
      expect(init?.headers?.["Authorization"]).toBe("Bearer fake-xai-key");
      return { ok: true, json: async () => ({ data: [{ id: "grok-live-1" }, { id: "grok-live-2" }] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await engine.handle("providers.models", { provider: "xai" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: ["grok-live-1", "grok-live-2"], defaultModel: "grok-4.5", source: "live", modelDetails: detailsOf(["grok-live-1", "grok-live-2"]) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit `account` param resolves that account's key, and a probe failure falls back to the catalog list", async () => {
    const engine = makeEngine(makeHome(BASE), fakeExecFor({ "chimera:grok-key": "fake-xai-key" }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("simulated network failure"); }));
    const res = await engine.handle("providers.models", { provider: "xai", account: "grok-key" }) as { models: string[]; source: string };
    // fetchProviderModels's own try/catch absorbs the network error -- the RPC never
    // surfaces a probe failure as an error, it just reports "catalog".
    expect(res).toEqual({ models: findProvider("xai")!.models, defaultModel: "grok-4.5", source: "catalog", modelDetails: detailsOf(findProvider("xai")!.models) });
  });

  // SDK-MODEL-LISTS: codex's live source is the CLI's own `codex debug models` dump, tried
  // BEFORE the HTTP modelsEndpoint probe -- this is what makes a subscription-only account
  // (no OPENAI_API_KEY, matching BASE's plain `{type:"subscription"}` shape) get a live list
  // instead of the static catalog fallback. The seam here stands in for the real shell-out
  // (see codex-cli-models.test.ts for that layer's own unit tests).
  it("codex: tries the CLI's live catalog first, ahead of the HTTP probe, for a subscription account", async () => {
    const home = makeHome({
      accounts: [...BASE.accounts, { name: "codex", provider: "codex", auth: { type: "subscription", homeDir: "/tmp/fake-codex-home" } }],
      autoOrder: [...BASE.autoOrder, "codex"],
    });
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const engine = makeEngine(home, undefined, {
      fetchCodexCliModels: async (opts) => {
        seenEnv = opts?.env;
        return [{ value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest frontier agentic coding model." }];
      },
    });
    const res = await engine.handle("providers.models", { provider: "codex" }) as {
      models: string[]; source: string; modelDetails: unknown[];
    };
    expect(res).toEqual({
      models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", source: "live",
      modelDetails: [{ value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest frontier agentic coding model." }],
    });
    expect(seenEnv?.CODEX_HOME).toBe("/tmp/fake-codex-home");
  });

  it("codex: falls back to the catalog list when the CLI seam returns null (binary missing/timeout)", async () => {
    const home = makeHome({
      accounts: [{ name: "codex", provider: "codex", auth: { type: "subscription" } }],
      autoOrder: ["codex"],
    });
    const engine = makeEngine(home, undefined, { fetchCodexCliModels: async () => null });
    const res = await engine.handle("providers.models", { provider: "codex" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: findProvider("codex")!.models, defaultModel: "gpt-5.6-sol", source: "catalog", modelDetails: detailsOf(findProvider("codex")!.models) });
  });

  it("codex: never shells out when no codex account is configured at all", async () => {
    const engine = makeEngine(makeHome(BASE), undefined, {
      fetchCodexCliModels: async () => { throw new Error("should not be called"); },
    });
    const res = await engine.handle("providers.models", { provider: "codex" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: findProvider("codex")!.models, defaultModel: "gpt-5.6-sol", source: "catalog", modelDetails: detailsOf(findProvider("codex")!.models) });
  });

  // DYNAMIC-MODEL-LISTS: claude's live source is the SDK's supportedModels(), reached either as a
  // by-product of a running agent (backends/claude.ts's system/init hook, recorded into the
  // disk-backed cache) or by a deliberate prompt-less probe when nothing is cached yet. A probe
  // that learns nothing ⇒ HTTP layer, then catalog fallback, exactly as before.
  it("claude: returns the SDK model list ahead of the catalog fallback, with ids AND display names", async () => {
    const engine = makeEngine(makeHome(BASE), undefined, {
      probeClaudeModels: async () => [{ value: "claude-sonnet-5", displayName: "Sonnet", description: "fast" }],
    });
    const res = await engine.handle("providers.models", { provider: "claude" }) as {
      models: string[]; source: string; modelDetails: unknown[];
    };
    expect(res).toEqual({
      models: ["claude-sonnet-5"], defaultModel: "claude-opus-4-8", source: "live",
      modelDetails: [{ value: "claude-sonnet-5", displayName: "Sonnet", description: "fast" }],
    });
  });

  it("gemini-native: probes its modelsEndpoint with x-goog-api-key auth and the {models:[{name}]} shape", async () => {
    const home = makeHome({
      accounts: [{ name: "g", provider: "gemini-native", auth: { type: "keychain", service: "chimera:g", injectAs: "GEMINI_API_KEY" } }],
      autoOrder: ["g"],
    });
    const engine = makeEngine(home, fakeExecFor({ "chimera:g": "fake-gemini-key" }));
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe(findProvider("gemini-native")!.modelsEndpoint);
      expect(init?.headers?.["x-goog-api-key"]).toBe("fake-gemini-key");
      expect(init?.headers?.["Authorization"]).toBeUndefined();
      return { ok: true, json: async () => ({ models: [{ name: "models/gemini-3.5-flash" }, { name: "models/gemini-2.5-pro" }] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await engine.handle("providers.models", { provider: "gemini-native" }) as { models: string[]; source: string };
    expect(res).toEqual({ models: ["gemini-3.5-flash", "gemini-2.5-pro"], defaultModel: "gemini-3.5-flash", source: "live", modelDetails: detailsOf(["gemini-3.5-flash", "gemini-2.5-pro"]) });
  });

  it("grok-build: carries a best-effort modelsEndpoint that a probe failure silently falls back from", async () => {
    expect(findProvider("grok-build")!.modelsEndpoint).toBe("https://cli-chat-proxy.grok.com/v1/models");
  });
});

// ACCOUNT-KEY-PRESENCE: accounts.list reports hasKey (a presence BOOLEAN, sourced from
// `this.keychain` — the same InMemoryKeychain seam accounts.setKey/test already use, NOT
// the exec-based CredentialResolver fixture above) so a freshly-restarted UI shows "set"
// for a stored-but-untested key without the operator pressing `t` first.
// CUSTOM-OPENAI-COMPAT: providers.addCustom is the write path for cfg.customProviders — a
// freshly-added entry must show up on providers.list/providers.models/accounts.test through
// the SAME effective-catalog resolution every other RPC uses.
describe("providers.addCustom RPC", () => {
  it("registers a custom provider and reflects it on providers.list", async () => {
    const engine = makeEngine(makeHome(BASE));
    const res = await engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama (local)", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    expect(res).toEqual({ id: "ollama-local" });
    const rows = (await engine.handle("providers.list", {})) as any[];
    const custom = rows.find((r) => r.id === "ollama-local");
    expect(custom).toMatchObject({
      id: "ollama-local", label: "Ollama (local)", kind: "openai-compat",
      baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
  });

  it("falls back to the catalog default model on providers.models when the local host is unreachable", async () => {
    const engine = makeEngine(makeHome(BASE));
    await engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama (local)", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    const res = await engine.handle("providers.models", { provider: "ollama-local" }) as { models: string[]; defaultModel: string; source: string };
    expect(res).toEqual({
      models: ["qwen3.5:9b-mlx"], defaultModel: "qwen3.5:9b-mlx", source: "catalog",
      modelDetails: detailsOf(["qwen3.5:9b-mlx"]),
    });
  });

  it("discovers models without a credential when requiresKey is false", async () => {
    const engine = makeEngine(makeHome(BASE));
    await engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3.5:9b-mlx" }, { id: "qwen3.5:27b" }] }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

    const res = await engine.handle("providers.models", { provider: "ollama-local" }) as { models: string[]; source: string };

    expect(res).toMatchObject({ models: ["qwen3.5:9b-mlx", "qwen3.5:27b"], source: "live" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3333/v1/models", expect.objectContaining({ headers: {} }));
  });

  it("rejects a built-in-id collision", async () => {
    const engine = makeEngine(makeHome(BASE));
    await expect(engine.handle("providers.addCustom", {
      id: "openai", label: "fake openai", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "x",
    })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/built-in provider id/) });
  });

  it("rejects a duplicate custom id", async () => {
    const engine = makeEngine(makeHome(BASE));
    await engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    await expect(engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama 2", baseUrl: "http://127.0.0.1:4444/v1", defaultModel: "y",
    })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already exists/) });
  });

  it("does not write any key — requiresKey defaults false and no secret field exists", async () => {
    const engine = makeEngine(makeHome(BASE));
    await engine.handle("providers.addCustom", {
      id: "ollama-local", label: "Ollama", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    });
    const rows = (await engine.handle("providers.list", {})) as any[];
    const custom = rows.find((r) => r.id === "ollama-local");
    expect(custom.requiresKey).toBe(false);
    expect(JSON.stringify(custom)).not.toMatch(/"apiKey":"|"key":/);
  });

  it("accounts.test honors the effective custom-provider profile: reports connection_error for an unreachable baseUrl", async () => {
    const home = makeHome({
      ...BASE,
      customProviders: { "ollama-local": { label: "Ollama", baseUrl: "http://127.0.0.1:1/v1", defaultModel: "qwen3.5:9b-mlx", requiresKey: false } },
      accounts: [...BASE.accounts, { name: "ollama", provider: "ollama-local", auth: { type: "keychain", service: "chimera:ollama", injectAs: "OLLAMA_API_KEY" } }],
      autoOrder: [...BASE.autoOrder, "ollama"],
    });
    const backends = new Map([
      ["claude", new FakeAgentBackend([], "claude")],
      ["codex", new FakeAgentBackend([], "codex")],
    ]);
    const engine = new Engine({
      home, backends, keychain: new InMemoryKeychain(),
      accountProber: new RealAccountProber(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); }),
    });
    const res = await engine.handle("accounts.test", { name: "ollama" }) as { result: string };
    expect(res.result).toBe("connection_error");
  });
});

describe("accounts.list RPC — hasKey (ACCOUNT-KEY-PRESENCE)", () => {
  it("reports hasKey true for a keychain account with a stored key, false for one without — and never leaks the value", async () => {
    const home = makeHome(BASE); // grok-key is auth.type=keychain, service "chimera:grok-key"
    const keychain = new InMemoryKeychain({ "chimera:grok-key": "sk-real-secret-value" });
    const engine = new Engine({
      home,
      backends: new Map([["claude", new FakeAgentBackend([], "claude")]]),
      keychain, accountProber: new FakeAccountProber("ok"),
    });
    const rows = (await engine.handle("accounts.list", {})) as Array<{ name: string; hasKey?: boolean }>;
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("main")).toMatchObject({ authType: "subscription", hasKey: false }); // subscription: no stored secret
    expect(byName.get("grok-key")).toMatchObject({ authType: "keychain", hasKey: true });
    // the secret value never appears anywhere in the response
    expect(JSON.stringify(rows)).not.toContain("sk-real-secret-value");
  });

  it("reports hasKey false for a keychain account with no stored key", async () => {
    const home = makeHome(BASE);
    const engine = new Engine({
      home,
      backends: new Map([["claude", new FakeAgentBackend([], "claude")]]),
      keychain: new InMemoryKeychain(), // empty — nothing stored for "chimera:grok-key"
      accountProber: new FakeAccountProber("ok"),
    });
    const rows = (await engine.handle("accounts.list", {})) as Array<{ name: string; hasKey?: boolean }>;
    expect(rows.find((r) => r.name === "grok-key")).toMatchObject({ hasKey: false });
  });
});
