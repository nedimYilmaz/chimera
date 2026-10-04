import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { FakeAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { BuildBackendsDeps } from "@chimera/core/providers/registry";
import type { ProviderProfile } from "@chimera/protocol";

// HOT-RELOAD-BACKENDS: adding a provider account must make that provider spawnable
// WITHOUT a daemon restart, and must never disturb an agent that is already running.

function makeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chm-hotreload-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  return home;
}

const BASE = {
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
};

// A fake builder standing in for the real buildBackends (packages/core/src/providers/
// registry.ts) — deterministic, no real SDK/network, but exercises the exact same
// "engine asks for backends for these providers" contract doReconcileBackends drives.
function fakeBuilder() {
  const calls: Array<{ providers: string[] }> = [];
  const builder = async (_catalog: ProviderProfile[], deps: BuildBackendsDeps) => {
    calls.push({ providers: deps.providers ?? [] });
    const built = new Map<string, AgentBackend>();
    for (const p of deps.providers ?? []) built.set(p, new FakeAgentBackend([], p));
    return built;
  };
  return { builder, calls };
}

function makeEngine(home: string, opts: { backendBuilder: ReturnType<typeof fakeBuilder>["builder"] }) {
  const backends = new Map<string, AgentBackend>([
    ["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]], "claude")],
  ]);
  return new Engine({
    home, backends,
    keychain: new InMemoryKeychain(),
    accountProber: new FakeAccountProber("ok"),
    backendBuilder: opts.backendBuilder,
  });
}

describe("HOT-RELOAD-BACKENDS", () => {
  it("accounts.add registers the new provider's backend live, without a restart", async () => {
    const { builder } = fakeBuilder();
    const engine = makeEngine(makeHome(BASE), { backendBuilder: builder });

    expect(engine.engineCard().providers).toEqual(["claude"]);

    // config.patch drives the exact same live path accounts.add does (both funnel through
    // applyConfig's "accounts" branch) — subscription auth here so the spawn below needs no
    // real credential resolution (CredentialResolver's "keychain" case shells out to the
    // real `security` CLI, orthogonal to what this test is proving).
    await engine.handle("config.patch", {
      patch: { accounts: [...BASE.accounts, { name: "grok", provider: "xai", auth: { type: "subscription" } }], autoOrder: ["main", "grok"] },
    });

    await vi.waitFor(() => {
      expect(engine.engineCard().providers).toContain("xai");
    });

    // the newly-registered backend is immediately usable by a fresh spawn — no restart.
    const rec = (await engine.handle("agent.spawn", {
      spec: { prompt: "hello xai", cwd: "/tmp", isolation: "none", account: "grok" },
    })) as { agentId: string; provider: string };
    expect(rec.provider).toBe("xai");
  });

  it("never touches an already-running agent while registering a new provider", async () => {
    const { builder } = fakeBuilder();
    const engine = makeEngine(makeHome(BASE), { backendBuilder: builder });

    const running = (await engine.handle("agent.spawn", {
      spec: { prompt: "long running", cwd: "/tmp", isolation: "none", account: "main" },
    })) as { agentId: string; state: string };
    expect(running.state).toBe("running");

    await engine.handle("accounts.add", { name: "grok", provider: "xai" });
    await vi.waitFor(() => {
      expect(engine.engineCard().providers).toContain("xai");
    });

    // the pre-existing agent is completely undisturbed by the live backend registration.
    const status = await engine.handle("agent.status", { agentId: running.agentId }) as { state: string };
    expect(status.state).toBe("running");
  });

  it("only builds backends for MISSING providers — an already-registered provider is left alone", async () => {
    const { builder, calls } = fakeBuilder();
    const engine = makeEngine(makeHome(BASE), { backendBuilder: builder });

    // "main"/claude already has a backend at construction time; adding another claude
    // account must not trigger a rebuild of the claude backend.
    await engine.handle("accounts.add", { name: "second-claude", provider: "claude" });
    await vi.waitFor(() => {
      expect(engine.engineCard().providers).toEqual(["claude"]);
    });
    expect(calls).toEqual([]);   // "claude" was never missing, so buildBackends is never even called
  });

  it("a changed providerOverrides entry rebuilds ONLY that provider's backend", async () => {
    const { builder, calls } = fakeBuilder();
    const home = makeHome(BASE);
    const engine = makeEngine(home, { backendBuilder: builder });

    await engine.handle("accounts.add", { name: "grok", provider: "xai" });
    await vi.waitFor(() => expect(engine.engineCard().providers).toContain("xai"));
    calls.length = 0;

    await engine.handle("config.patch", { patch: { providerOverrides: { xai: { baseUrl: "https://example.test/v1" } } } });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.providers).toEqual(["xai"]);   // claude's untouched backend is never rebuilt
  });

  it("a changed custom provider profile rebuilds its backend for future spawns without a restart", async () => {
    const { builder, calls } = fakeBuilder();
    const custom = { label: "Ollama", baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx", requiresKey: false };
    const home = makeHome({
      ...BASE,
      customProviders: { ollama: custom },
      accounts: [...BASE.accounts, { name: "local", provider: "ollama", auth: { type: "subscription" } }],
      autoOrder: [...BASE.autoOrder, "local"],
    });
    const engine = makeEngine(home, { backendBuilder: builder });

    await engine.handle("config.patch", {
      patch: { customProviders: { ollama: { ...custom, defaultModel: "qwen3.5:27b" } } },
    });

    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.providers).toEqual(["ollama"]);
  });
});
