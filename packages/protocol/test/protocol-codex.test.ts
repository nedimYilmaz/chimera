import { describe, it, expect } from "vitest";
import { AccountAuthSchema, ChimeraConfigSchema } from "@chimera/protocol";

describe("codex account auth extensions", () => {
  it("accepts homeDir on every auth variant (spec §6: CODEX_HOME isolation)", () => {
    expect(AccountAuthSchema.parse({ type: "subscription", homeDir: "/Users/me/.codex-acct2" }))
      .toEqual({ type: "subscription", homeDir: "/Users/me/.codex-acct2" });
    expect(AccountAuthSchema.parse({
      type: "env", var: "MY_KEY", injectAs: "CODEX_API_KEY", homeDir: "/tmp/cx",
    }).homeDir).toBe("/tmp/cx");
    expect(AccountAuthSchema.parse({
      type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN", homeDir: "/tmp/cl",
    }).homeDir).toBe("/tmp/cl");
    expect(AccountAuthSchema.parse({
      type: "command", run: "op read op://k", injectAs: "OPENAI_API_KEY", homeDir: "/tmp/cx2",
    }).homeDir).toBe("/tmp/cx2");
  });

  it("homeDir stays optional and rejects empty strings", () => {
    expect(AccountAuthSchema.parse({ type: "subscription" })).toEqual({ type: "subscription" });
    expect(() => AccountAuthSchema.parse({ type: "subscription", homeDir: "" })).toThrow();
  });

  // SUBSCRIPTION-CONNECT: "default-login" was renamed to "subscription" — a preprocess
  // step migrates the legacy literal so every config written before the rename (e.g. the
  // "main" claude account) keeps parsing byte-identically, just already migrated.
  it("migrates the legacy default-login literal to subscription", () => {
    expect(AccountAuthSchema.parse({ type: "default-login" })).toEqual({ type: "subscription" });
    expect(AccountAuthSchema.parse({ type: "default-login", homeDir: "/Users/me/.codex" }))
      .toEqual({ type: "subscription", homeDir: "/Users/me/.codex" });
  });

  it("migrates default-login inside a full ChimeraConfig parse (old config.json shape)", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "default-login" } }],
      autoOrder: ["main"],
    });
    expect(cfg.accounts[0]!.auth).toEqual({ type: "subscription" });
  });

  it("parses the spec §6 phase-4 codex account examples", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "codex", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } },
        { name: "codex-sub", provider: "codex", auth: { type: "subscription", homeDir: "/Users/me/.codex-sub" } },
      ],
      autoOrder: ["main", "codex"],
    });
    expect(cfg.accounts[2]!.auth).toEqual({ type: "subscription", homeDir: "/Users/me/.codex-sub" });
  });

  it("still rejects inline secret values on auth objects", () => {
    expect(() => AccountAuthSchema.parse({
      type: "env", var: "K", injectAs: "CODEX_API_KEY", value: "sk-live",
    })).toThrow();
  });

  // ---------- additional edge-case coverage beyond the brief's examples ----------

  it("accepts the InjectAs enum's new CODEX_API_KEY member on keychain and command arms too", () => {
    expect(AccountAuthSchema.parse({ type: "keychain", service: "svc", injectAs: "CODEX_API_KEY" }).injectAs)
      .toBe("CODEX_API_KEY");
    expect(AccountAuthSchema.parse({ type: "command", run: "op read op://k", injectAs: "CODEX_API_KEY" }).injectAs)
      .toBe("CODEX_API_KEY");
  });

  it("rejects homeDir on the keychain/env/command arms when empty (boundary: min(1) on every arm, not just subscription)", () => {
    expect.assertions(3);
    expect(() => AccountAuthSchema.parse({
      type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN", homeDir: "",
    })).toThrow();
    expect(() => AccountAuthSchema.parse({
      type: "env", var: "K", injectAs: "OPENAI_API_KEY", homeDir: "",
    })).toThrow();
    expect(() => AccountAuthSchema.parse({
      type: "command", run: "op read op://k", injectAs: "OPENAI_API_KEY", homeDir: "",
    })).toThrow();
  });

  it("omitting homeDir still parses on every non-subscription arm (optional, not required)", () => {
    expect(AccountAuthSchema.parse({ type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" }))
      .toEqual({ type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" });
    expect(AccountAuthSchema.parse({ type: "env", var: "K", injectAs: "OPENAI_API_KEY" }))
      .toEqual({ type: "env", var: "K", injectAs: "OPENAI_API_KEY" });
    expect(AccountAuthSchema.parse({ type: "command", run: "op read op://k", injectAs: "OPENAI_API_KEY" }))
      .toEqual({ type: "command", run: "op read op://k", injectAs: "OPENAI_API_KEY" });
  });

  it("rejects an unknown key alongside homeDir (arms stay .strict())", () => {
    expect.assertions(1);
    expect(() => AccountAuthSchema.parse({
      type: "subscription", homeDir: "/tmp/x", extra: "nope",
    })).toThrow();
  });

  it("rejects a non-string homeDir (wrong type, not just empty)", () => {
    expect.assertions(1);
    expect(() => AccountAuthSchema.parse({ type: "subscription", homeDir: 123 })).toThrow();
  });

  // F23-0D: injectAs widened from a closed enum (the 5 claude/codex-specific names) to any
  // non-empty string — the F23-0D provider catalog assigns each provider its own env var
  // (XAI_API_KEY, DEEPSEEK_API_KEY, ...), none of which fit the old fixed set. This test's
  // premise (a previously-unrecognized name is rejected) is superseded; it now asserts the
  // new contract: any non-empty injectAs parses, only an empty one is rejected.
  it("accepts a non-claude/codex injectAs value now that the enum is widened (F23-0D)", () => {
    expect(AccountAuthSchema.parse({
      type: "env", var: "K", injectAs: "XAI_API_KEY", homeDir: "/tmp/ok",
    }).injectAs).toBe("XAI_API_KEY");
  });

  it("still rejects an empty injectAs value (min(1) survives the widening)", () => {
    expect.assertions(1);
    expect(() => AccountAuthSchema.parse({
      type: "env", var: "K", injectAs: "", homeDir: "/tmp/ok",
    })).toThrow();
  });

  it("still rejects a value secret on the keychain/command arms even with homeDir set", () => {
    expect.assertions(2);
    expect(() => AccountAuthSchema.parse({
      type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN", homeDir: "/tmp/x", value: "sk-live",
    })).toThrow();
    expect(() => AccountAuthSchema.parse({
      type: "command", run: "op read op://k", injectAs: "OPENAI_API_KEY", homeDir: "/tmp/x", value: "sk-live",
    })).toThrow();
  });
});
