import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain, accountService } from "@chimera/core/keychain";
import { RealAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { CredentialResolver } from "@chimera/core/credentials";

// OAUTH-TOKEN-ACCOUNTS bug repro: a "claude-pers" account persisted BEFORE the
// classification feature existed (auth.type=keychain, injectAs=ANTHROPIC_API_KEY,
// no credentialType field on disk — the pre-feature shape). Re-setting its key to
// an sk-ant-oat01 OAuth token via accounts.setKey must classify it oauth end-to-end:
// accounts.test must probe it with Bearer + anthropic-beta oauth headers (NOT the
// x-api-key probe), and the persisted auth must carry injectAs=CLAUDE_CODE_OAUTH_TOKEN
// so a spawn resolves CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chm-oauth-existing-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      // pre-existing account, created BEFORE OAUTH-TOKEN-ACCOUNTS — no credentialType.
      { name: "claude-pers", provider: "claude", auth: { type: "keychain", service: "chimera:claude-pers", injectAs: "ANTHROPIC_API_KEY" } },
    ],
    autoOrder: ["main", "claude-pers"],
    dailyCapUsd: 5,
  }, null, 2));
  return home;
}

describe("OAUTH-TOKEN-ACCOUNTS regression: re-keying a pre-existing api-key account with an oauth token", () => {
  it("classifies live, probes with Bearer + anthropic-beta oauth headers, and persists CLAUDE_CODE_OAUTH_TOKEN as injectAs", async () => {
    const home = makeHome();
    const keychain = new InMemoryKeychain();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain, accountProber: new RealAccountProber(fetchImpl as unknown as typeof fetch) });

    const setResult = (await engine.handle("accounts.setKey", { name: "claude-pers", key: "sk-ant-oat01-realtoken" })) as any;
    expect(setResult).toEqual({ ok: true, name: "claude-pers", credentialType: "oauthToken" });

    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    const acct = ui.accounts.find((a: any) => a.name === "claude-pers");
    expect(acct.auth.injectAs).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(acct.auth.credentialType).toBe("oauthToken");

    const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
    expect(testResult).toEqual({ name: "claude-pers", result: "ok", httpStatus: 200, credentialType: "oauthToken" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-ant-oat01-realtoken", "anthropic-beta": "oauth-2025-04-20" });

    // Spawn-time: CredentialResolver must resolve to CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_API_KEY.
    const fakeExec = vi.fn(async () => ({ stdout: "sk-ant-oat01-realtoken\n", code: 0 }));
    const resolver = new CredentialResolver(fakeExec);
    const resolved = await resolver.resolve({ type: "keychain", service: accountService("claude-pers"), injectAs: acct.auth.injectAs, credentialType: acct.auth.credentialType });
    expect(resolved).toEqual({ envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-realtoken" });
  });

  // CLASSIFY-ON-TEST: the actual reported bug — no accounts.setKey call happens in this
  // scenario at all. The keychain secret is ALREADY an oauth token (e.g. stored by a daemon
  // build that predates OAUTH-TOKEN-ACCOUNTS, or drifted out of sync with config any other
  // way); only account.auth.credentialType is stale (absent, from the pre-feature shape).
  // Before the CLASSIFY-ON-TEST fix, accounts.test trusted that stale field and x-api-key
  // probed a token that isn't x-api-key-shaped at all, permanently misreporting "invalid".
  it("accounts.test re-derives classification from the CURRENT key even when account.auth.credentialType was never set — no setKey call required", async () => {
    const home = makeHome();
    const keychain = new InMemoryKeychain();
    await keychain.set(accountService("claude-pers"), "sk-ant-oat01-realtoken");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain, accountProber: new RealAccountProber(fetchImpl as unknown as typeof fetch) });

    const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
    expect(testResult).toEqual({ name: "claude-pers", result: "ok", httpStatus: 200, credentialType: "oauthToken" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-ant-oat01-realtoken" });

    // Self-heals: the drifted classification is now persisted, so the next boot/list is correct too.
    const ui = JSON.parse(readFileSync(join(home, "config.d", "ui.json"), "utf8"));
    const acct = ui.accounts.find((a: any) => a.name === "claude-pers");
    expect(acct.auth.injectAs).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(acct.auth.credentialType).toBe("oauthToken");
  });

  it("a plain api key with a stale-absent credentialType stays byte-identical — no config write, no credentialType echoed", async () => {
    const home = makeHome();
    const keychain = new InMemoryKeychain();
    await keychain.set(accountService("claude-pers"), "sk-ant-api03-plainkey");
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "" }) as any);
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain, accountProber: new RealAccountProber(fetchImpl) });

    const testResult = (await engine.handle("accounts.test", { name: "claude-pers" })) as any;
    expect(testResult).toEqual({ name: "claude-pers", result: "ok", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
