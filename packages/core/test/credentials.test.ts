import { describe, it, expect } from "vitest";
import { CredentialResolver, CredentialError, redact } from "@chimera/core/credentials";
import { OAuthTokenStore } from "@chimera/core/providers/oauth";
import { InMemoryKeychain } from "@chimera/core/keychain";

const fakeExec = (table: Record<string, { stdout: string; code: number }>) =>
  async (cmd: string, args: string[]) => table[[cmd, ...args].join(" ")] ?? { stdout: "", code: 1 };

describe("CredentialResolver", () => {
  it("returns null for subscription (inject nothing)", async () => {
    const r = new CredentialResolver(fakeExec({}));
    expect(await r.resolve({ type: "subscription" })).toBeNull();
  });
  it("resolves keychain via security(1)", async () => {
    const r = new CredentialResolver(fakeExec({
      "security find-generic-password -s my-svc -w": { stdout: "tok-123\n", code: 0 },
    }));
    expect(await r.resolve({ type: "keychain", service: "my-svc", injectAs: "ANTHROPIC_AUTH_TOKEN" }))
      .toEqual({ envVar: "ANTHROPIC_AUTH_TOKEN", value: "tok-123" });
  });
  it("resolves command source through sh -c", async () => {
    const r = new CredentialResolver(fakeExec({ "sh -c op read op://k": { stdout: "sk-x\n", code: 0 } }));
    expect(await r.resolve({ type: "command", run: "op read op://k", injectAs: "ANTHROPIC_API_KEY" }))
      .toEqual({ envVar: "ANTHROPIC_API_KEY", value: "sk-x" });
  });
  it("resolves env source from provided env", async () => {
    const r = new CredentialResolver(fakeExec({}), { MY_TOKEN: "abc" } as NodeJS.ProcessEnv);
    expect(await r.resolve({ type: "env", var: "MY_TOKEN", injectAs: "CLAUDE_CODE_OAUTH_TOKEN" }))
      .toEqual({ envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "abc" });
  });
  it("throws CredentialError without leaking the value on failure", async () => {
    const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv);
    await expect(r.resolve({ type: "keychain", service: "missing", injectAs: "ANTHROPIC_API_KEY" }))
      .rejects.toBeInstanceOf(CredentialError);
  });
  it("never includes the resolved value in the thrown message (non-zero exit with stdout present)", async () => {
    // exec returns a non-zero code but non-empty stdout — the message must not echo it
    const r = new CredentialResolver(fakeExec({ "sh -c leaky": { stdout: "sk-super-secret", code: 3 } }));
    await expect(r.resolve({ type: "command", run: "leaky", injectAs: "ANTHROPIC_API_KEY" }))
      .rejects.toThrow(/^(?!.*sk-super-secret).*$/);
  });
  it("rejects a whitespace-only env value (parity with keychain/command)", async () => {
    const r = new CredentialResolver(fakeExec({}), { WS: "   \n" } as NodeJS.ProcessEnv);
    await expect(r.resolve({ type: "env", var: "WS", injectAs: "ANTHROPIC_API_KEY" }))
      .rejects.toBeInstanceOf(CredentialError);
  });
  it("CredentialError instances report their own name (not 'Error') for log readability", async () => {
    expect.assertions(1);
    const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv);
    try {
      await r.resolve({ type: "keychain", service: "missing", injectAs: "ANTHROPIC_API_KEY" });
    } catch (e) {
      expect((e as Error).name).toBe("CredentialError");
    }
  });
  it("F23-0A: oauth with no wired store still throws CredentialError (byte-identical to the original stub)", async () => {
    const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv);
    await expect(r.resolve({ type: "oauth", provider: "anthropic", tokenRef: "svc-anthropic" }))
      .rejects.toBeInstanceOf(CredentialError);
  });

  describe("F23-0D: oauth case, wired to a real OAuthTokenStore", () => {
    const profile = {
      id: "anthropic", label: "Anthropic", kind: "agentic-sdk" as const, baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-opus-4-8", models: [], authModes: ["oauth" as const],
      capabilities: { tools: true, vision: true, streaming: true }, envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    };
    const findProvider = (id: string) => (id === "anthropic" ? profile : undefined);

    it("resolves a stored, non-expiring token to {envVar, value}", async () => {
      const keychain = new InMemoryKeychain({ "svc-anthropic": JSON.stringify({ accessToken: "sk-ant-oat-live" }) });
      const store = new OAuthTokenStore(keychain);
      const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv, { store, findProvider });
      await expect(r.resolve({ type: "oauth", provider: "anthropic", tokenRef: "svc-anthropic" }))
        .resolves.toEqual({ envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-live" });
    });

    it("throws CredentialError when no token is stored for tokenRef", async () => {
      const store = new OAuthTokenStore(new InMemoryKeychain());
      const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv, { store, findProvider });
      await expect(r.resolve({ type: "oauth", provider: "anthropic", tokenRef: "svc-anthropic" }))
        .rejects.toBeInstanceOf(CredentialError);
    });

    it("throws CredentialError for an oauth provider absent from the catalog", async () => {
      const store = new OAuthTokenStore(new InMemoryKeychain());
      const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv, { store, findProvider });
      await expect(r.resolve({ type: "oauth", provider: "not-a-real-provider", tokenRef: "svc-x" }))
        .rejects.toBeInstanceOf(CredentialError);
    });

    it("refreshes a token expiring within 5 minutes and persists the refreshed token", async () => {
      const keychain = new InMemoryKeychain({
        "svc-anthropic": JSON.stringify({ accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() + 60_000 }),
      });
      const store = new OAuthTokenStore(keychain);
      store.registerRefresher("anthropic", {
        refresh: async (token) => ({ accessToken: "fresh", refreshToken: token.refreshToken, expiresAt: Date.now() + 3600_000 }),
      });
      const r = new CredentialResolver(fakeExec({}), {} as NodeJS.ProcessEnv, { store, findProvider });
      await expect(r.resolve({ type: "oauth", provider: "anthropic", tokenRef: "svc-anthropic" }))
        .resolves.toEqual({ envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "fresh" });
      // persisted back — a second resolve reuses the refreshed token without refreshing again
      const stored = JSON.parse((await keychain.get("svc-anthropic"))!);
      expect(stored.accessToken).toBe("fresh");
    });
  });
});

describe("redact", () => {
  it("strips secret values from arbitrary text", () => {
    expect(redact("token tok-123 leaked tok-123", ["tok-123"])).toBe("token [REDACTED] leaked [REDACTED]");
  });
  it("leaves no fragment when one secret is a substring of another (order-independent)", () => {
    // shorter "abc" must not fragment the longer "abcdef123" and leak "def123"
    expect(redact("token abcdef123", ["abc", "abcdef123"])).toBe("token [REDACTED]");
    expect(redact("token abcdef123", ["abcdef123", "abc"])).toBe("token [REDACTED]");
  });
  it("skips empty-string secrets (no per-character [REDACTED] splice)", () => {
    expect(redact("keep me", ["", "me"])).toBe("keep [REDACTED]");
  });
  it("returns the input unchanged when there are no non-empty secrets", () => {
    expect(redact("nothing to redact here", [])).toBe("nothing to redact here");
    expect(redact("nothing to redact here", [""])).toBe("nothing to redact here");
  });
  it("treats secrets as literal text, not regex patterns (metacharacters are escaped)", () => {
    // a literal "." or "*" secret must not act as a wildcard/quantifier and
    // swallow characters that were never part of the actual secret
    expect(redact("keep .* and drop .*", [".*"])).toBe("keep [REDACTED] and drop [REDACTED]");
    expect(redact("price is $5.00 (special)", ["$5.00 (special)"])).toBe("price is [REDACTED]");
  });
  it("hardens against partial-overlap fragment leaks: two secrets that overlap without either containing " +
     "the other redact to a single merged span with NO fragment of either secret surviving, regardless of " +
     "the order they appear in the secrets array", () => {
    // "abcd" and "cdef" share "cd" (positions 2-3) without either containing the
    // other. A naive sequential split/replace (or a single leftmost-match-wins
    // alternation regex) redacts one secret's span and then can no longer find
    // the other secret's now-broken characters, leaking its non-overlapping
    // tail/head as a real fragment (e.g. "[REDACTED]ef" leaks "ef", the suffix
    // of "cdef"). redact() instead collects EVERY matched span from EVERY
    // secret ([0,4) from "abcd", [2,6) from "cdef"), merges the overlapping
    // spans into one ([0,6)), and replaces the merged span once — so "abcdef"
    // collapses entirely to a single "[REDACTED]" with no fragment of either
    // secret left in the output, independent of array order.
    const forward = redact("abcdef", ["abcd", "cdef"]);
    const reversed = redact("abcdef", ["cdef", "abcd"]);
    expect(forward).toBe(reversed);           // order-independent
    expect(forward).toBe("[REDACTED]");       // fully collapsed — nothing survives
    expect(forward).not.toContain("ab");      // prefix fragment of "abcd" is gone
    expect(forward).not.toContain("ef");      // suffix fragment of "cdef" is gone
    expect(forward).not.toContain("cd");      // the shared overlap fragment is gone
  });
});
