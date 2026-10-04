import { describe, it, expect } from "vitest";
import {
  AccountAuthSchema, AccountConfigSchema, AgentSpecSchema, ChimeraConfigSchema,
  ProviderProfileSchema,
} from "@chimera/protocol";

describe("F23-0A: widened provider enums", () => {
  it("AccountConfigSchema accepts any non-empty provider id, not just claude/codex", () => {
    expect(AccountConfigSchema.parse({
      name: "gpt", provider: "openai", auth: { type: "subscription" },
    }).provider).toBe("openai");
    expect(AccountConfigSchema.parse({
      name: "grok", provider: "xai", auth: { type: "subscription" },
    }).provider).toBe("xai");
  });

  it("AccountConfigSchema still rejects an empty-string provider (min(1) survives the widening)", () => {
    expect(() => AccountConfigSchema.parse({ name: "x", provider: "", auth: { type: "subscription" } })).toThrow();
  });

  it("AccountConfigSchema still defaults provider to \"claude\" when omitted (back-compat)", () => {
    expect(AccountConfigSchema.parse({ name: "main", auth: { type: "subscription" } }).provider).toBe("claude");
  });

  it("AgentSpecSchema.provider accepts any non-empty provider id and stays optional", () => {
    const base = { prompt: "hi", cwd: "/tmp" };
    expect(AgentSpecSchema.parse({ ...base, provider: "gemini" }).provider).toBe("gemini");
    expect(AgentSpecSchema.parse(base).provider).toBeUndefined();
  });

  it("AgentSpecSchema.provider still rejects an empty string", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "hi", cwd: "/tmp", provider: "" })).toThrow();
  });

  it("legacy claude/codex configs still parse byte-identically (round-trip)", () => {
    const raw = {
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "codex", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } },
      ],
      autoOrder: ["main", "codex"],
    };
    const cfg = ChimeraConfigSchema.parse(raw);
    expect(cfg.accounts[0]).toEqual({ name: "main", provider: "claude", auth: { type: "subscription" } });
    expect(cfg.accounts[1]).toEqual({
      name: "codex", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" },
    });
  });
});

describe("F23-0A: oauth auth variant", () => {
  it("parses a minimal oauth auth entry", () => {
    expect(AccountAuthSchema.parse({
      type: "oauth", provider: "anthropic", tokenRef: "chimera-oauth-anthropic-main",
    })).toEqual({ type: "oauth", provider: "anthropic", tokenRef: "chimera-oauth-anthropic-main" });
  });

  it("accepts homeDir on the oauth arm too (parity with every other auth arm)", () => {
    expect(AccountAuthSchema.parse({
      type: "oauth", provider: "openai", tokenRef: "svc-openai", homeDir: "/tmp/oauth-home",
    }).homeDir).toBe("/tmp/oauth-home");
  });

  it("rejects an oauth entry missing provider or tokenRef", () => {
    expect(() => AccountAuthSchema.parse({ type: "oauth", tokenRef: "svc" })).toThrow();
    expect(() => AccountAuthSchema.parse({ type: "oauth", provider: "anthropic" })).toThrow();
  });

  it("rejects empty provider/tokenRef strings on the oauth arm", () => {
    expect(() => AccountAuthSchema.parse({ type: "oauth", provider: "", tokenRef: "svc" })).toThrow();
    expect(() => AccountAuthSchema.parse({ type: "oauth", provider: "anthropic", tokenRef: "" })).toThrow();
  });

  it("rejects an inline secret value on the oauth arm (stays .strict())", () => {
    expect(() => AccountAuthSchema.parse({
      type: "oauth", provider: "anthropic", tokenRef: "svc", value: "sk-live",
    })).toThrow();
  });

  it("an account config can carry an oauth auth entry end-to-end", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "claude-sub", provider: "claude", auth: { type: "oauth", provider: "anthropic", tokenRef: "chimera-oauth-claude-sub" } },
      ],
      autoOrder: ["claude-sub"],
    });
    expect(cfg.accounts[0]!.auth).toEqual({ type: "oauth", provider: "anthropic", tokenRef: "chimera-oauth-claude-sub" });
  });
});

describe("F23-0A: ProviderProfileSchema", () => {
  const base = {
    id: "openai", label: "OpenAI", kind: "openai-compat" as const, baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5", authModes: ["apiKey" as const],
    capabilities: { tools: true, vision: true, streaming: true },
  };

  it("parses a minimal openai-compat profile", () => {
    const parsed = ProviderProfileSchema.parse(base);
    expect(parsed.models).toEqual([]);
    expect(parsed.id).toBe("openai");
  });

  it("parses a full profile with oauth + extraHeaders + tosNote", () => {
    const parsed = ProviderProfileSchema.parse({
      ...base,
      id: "copilot", label: "GitHub Copilot", authModes: ["oauth"],
      oauth: { deviceCodeUrl: "https://github.com/login/device/code", scopes: ["read:user"] },
      extraHeaders: { "Copilot-Integration-Id": "vscode-chat" },
      tosNote: "Third-party use of a Copilot subscription token is against GitHub's ToS.",
      modelsEndpoint: "https://api.githubcopilot.com/models",
      chatPath: "/chat/completions",
      authHeader: "Authorization",
    });
    expect(parsed.oauth?.deviceCodeUrl).toBe("https://github.com/login/device/code");
    expect(parsed.tosNote).toMatch(/ToS/);
  });

  it("rejects an unknown kind", () => {
    expect(() => ProviderProfileSchema.parse({ ...base, kind: "bespoke" })).toThrow();
  });

  it("rejects an empty models[] entry and an empty id", () => {
    expect(() => ProviderProfileSchema.parse({ ...base, id: "" })).toThrow();
    expect(() => ProviderProfileSchema.parse({ ...base, models: [""] })).toThrow();
  });

  it("rejects an unknown top-level key (stays .strict())", () => {
    expect(() => ProviderProfileSchema.parse({ ...base, extra: "nope" })).toThrow();
  });

  it("F23-1B: accepts an optional timeoutMs (e.g. moonshot's documented 2h request timeout)", () => {
    expect(ProviderProfileSchema.parse({ ...base, timeoutMs: 7_200_000 }).timeoutMs).toBe(7_200_000);
    expect(ProviderProfileSchema.parse(base).timeoutMs).toBeUndefined();
  });

  it("F23-1B: rejects a non-positive timeoutMs", () => {
    expect(() => ProviderProfileSchema.parse({ ...base, timeoutMs: 0 })).toThrow();
    expect(() => ProviderProfileSchema.parse({ ...base, timeoutMs: -1 })).toThrow();
  });
});
