import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { FakeAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { OAuthFlow, OAuthStartResult } from "@chimera/core/providers/oauth-flows";
import type { PendingOAuthStore } from "@chimera/core/providers/pending-oauth";

function makeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chm-oauth-rpc-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  return home;
}

const BASE = { accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }], autoOrder: ["main"] };

class ImmediateFlow implements OAuthFlow {
  constructor(readonly provider: string, private token = { accessToken: "tok-immediate" }) {}
  async start(pending: PendingOAuthStore, pendingId: string): Promise<OAuthStartResult> {
    pending.resolve(pendingId, this.token);
    return { kind: "immediate" };
  }
}

class DeviceFlow implements OAuthFlow {
  readonly provider = "copilot";
  async start(): Promise<OAuthStartResult> {
    return { kind: "device", userCode: "USER-1234", verificationUri: "https://example.com/device" };
  }
}

class ThrowingFlow implements OAuthFlow {
  readonly provider = "copilot";
  async start(): Promise<OAuthStartResult> {
    throw new Error("preflight boom");
  }
}

function makeEngine(home: string, opts?: { experimental?: boolean; oauthFlows?: Map<string, OAuthFlow> }) {
  const keychain = new InMemoryKeychain();
  const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
  const engine = new Engine({
    home, backends, keychain, accountProber: new FakeAccountProber("ok"),
    oauthFlows: opts?.oauthFlows,
  });
  return { engine, keychain };
}

describe("F23-2A: accounts.oauth_start", () => {
  it("rejects an unknown provider", async () => {
    const { engine } = makeEngine(makeHome(BASE));
    await expect(engine.handle("accounts.oauth_start", { provider: "does-not-exist" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a provider whose authModes don't include oauth", async () => {
    const { engine } = makeEngine(makeHome(BASE));
    await expect(engine.handle("accounts.oauth_start", { provider: "xai" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("gates an experimental provider behind config providers.experimental (default false)", async () => {
    const flows = new Map<string, OAuthFlow>([["copilot", new DeviceFlow()]]);
    const { engine } = makeEngine(makeHome(BASE), { oauthFlows: flows });
    await expect(engine.handle("accounts.oauth_start", { provider: "copilot" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("experimental") });
  });

  it("allows an experimental provider once config.providers.experimental is set", async () => {
    const flows = new Map<string, OAuthFlow>([["copilot", new DeviceFlow()]]);
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const { engine } = makeEngine(home, { oauthFlows: flows });
    const result = (await engine.handle("accounts.oauth_start", { provider: "copilot" })) as any;
    expect(result.pendingId).toBeTruthy();
    expect(result.userCode).toBe("USER-1234");
    expect(result.verificationUri).toBe("https://example.com/device");
    expect(result.tosNote).toContain("Gray area");
  });

  it("rejects when the provider has no oauth flow implemented (empty registry)", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const { engine } = makeEngine(home, { oauthFlows: new Map() });
    await expect(engine.handle("accounts.oauth_start", { provider: "copilot" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("no oauth flow") });
  });

  it("a pre-flight start() failure drops the pending record (oauth_finish then sees it as unknown)", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const flows = new Map<string, OAuthFlow>([["copilot", new ThrowingFlow()]]);
    const { engine } = makeEngine(home, { oauthFlows: flows });
    await expect(engine.handle("accounts.oauth_start", { provider: "copilot" })).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("F23-2A: accounts.oauth_finish", () => {
  it("rejects an unknown pendingId", async () => {
    const { engine } = makeEngine(makeHome(BASE));
    await expect(engine.handle("accounts.oauth_finish", { pendingId: "nope" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("returns status:pending while a device flow hasn't resolved yet", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const flows = new Map<string, OAuthFlow>([["copilot", new DeviceFlow()]]);
    const { engine } = makeEngine(home, { oauthFlows: flows });
    const started = (await engine.handle("accounts.oauth_start", { provider: "copilot" })) as any;
    const finished = (await engine.handle("accounts.oauth_finish", { pendingId: started.pendingId })) as any;
    expect(finished).toEqual({ status: "pending" });
  });

  it("an immediate flow resolves on start(); oauth_finish creates the oauth account and stores the token", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const flows = new Map<string, OAuthFlow>([["grok-build", new ImmediateFlow("grok-build", { accessToken: "grok-tok-1" })]]);
    const { engine, keychain } = makeEngine(home, { oauthFlows: flows });

    const started = (await engine.handle("accounts.oauth_start", { provider: "grok-build" })) as any;
    expect(started.pendingId).toBeTruthy();

    const finished = (await engine.handle("accounts.oauth_finish", { pendingId: started.pendingId })) as any;
    expect(finished).toEqual({ status: "connected", name: "grok-build", provider: "grok-build" });

    const accounts = (await engine.handle("accounts.list", {})) as any[];
    const added = accounts.find((a) => a.name === "grok-build");
    expect(added.provider).toBe("grok-build");

    // the token was persisted under a fresh keychain service — never the raw account name
    const stored = await keychain.get("chimera-oauth:grok-build");
    expect(JSON.parse(stored!)).toEqual({ accessToken: "grok-tok-1" });

    // polling again after the pending record was consumed is a clean error, not a stale replay
    await expect(engine.handle("accounts.oauth_finish", { pendingId: started.pendingId })).rejects.toMatchObject({ code: "protocol" });
  });

  it("dedupes the auto-derived account name across repeated connects of the same provider", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const flows = new Map<string, OAuthFlow>([["grok-build", new ImmediateFlow("grok-build")]]);
    const { engine } = makeEngine(home, { oauthFlows: flows });

    const first = (await engine.handle("accounts.oauth_start", { provider: "grok-build" })) as any;
    const firstFinish = (await engine.handle("accounts.oauth_finish", { pendingId: first.pendingId })) as any;
    expect(firstFinish.name).toBe("grok-build");

    const second = (await engine.handle("accounts.oauth_start", { provider: "grok-build" })) as any;
    const secondFinish = (await engine.handle("accounts.oauth_finish", { pendingId: second.pendingId })) as any;
    expect(secondFinish.name).toBe("grok-build-2");
  });

  it("surfaces a background failure as status:error, then clears the pending record", async () => {
    const home = makeHome({ ...BASE, providers: { experimental: true } });
    const flows = new Map<string, OAuthFlow>([["copilot", new DeviceFlow()]]);
    const { engine } = makeEngine(home, { oauthFlows: flows });
    const started = (await engine.handle("accounts.oauth_start", { provider: "copilot" })) as any;

    engine.pendingOAuth.fail(started.pendingId, "device code expired before the user authorized it");

    const finished = (await engine.handle("accounts.oauth_finish", { pendingId: started.pendingId })) as any;
    expect(finished).toEqual({ status: "error", message: "device code expired before the user authorized it" });

    await expect(engine.handle("accounts.oauth_finish", { pendingId: started.pendingId })).rejects.toMatchObject({ code: "protocol" });
  });
});
