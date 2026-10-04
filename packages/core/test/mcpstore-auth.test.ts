import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain, mcpStoreAuthService } from "@chimera/core/keychain";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// MCP-REMOTE-IMPORT slice 1: mcpstore.setAuth is a UI->daemon-ONLY RPC that writes a
// remote server's bearer secret to the Keychain and never echoes it back — same D0
// invariant as accounts.setKey (engine-mcpstore.test.ts / oauth-token-existing-account.test.ts
// exercise that sibling RPC the same way).

function engineOn(home: string, keychain = new InMemoryKeychain()) {
  const fake = new FakeAgentBackend([]);
  // MCP-OAUTH-DISCOVERABILITY: mcpstore.add's auto-detect probe must never hit the real
  // network for these auth-less http adds — stub it to "never oauth" so every add below
  // stays a plain, unauthenticated entry exactly as asserted.
  const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", fake]]), keychain, mcpStoreDetectAuth: async () => ({ oauth: false }) });
  return { engine, keychain };
}

describe("mcpstore.setAuth", () => {
  it("stores the secret in the keychain under mcpStoreAuthService(name) and responds with no secret", async () => {
    const home = makeEngineHome();
    const { engine, keychain } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "remote-one", type: "http", url: "https://mcp.example.com/mcp" });

    const result = await engine.handle("mcpstore.setAuth", { name: "remote-one", secret: "sk-super-secret-token" });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("sk-super-secret-token");
    expect(await keychain.get(mcpStoreAuthService("remote-one"))).toBe("sk-super-secret-token");
  });

  it("never writes the secret to mcpstore.json", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "remote-one", type: "http", url: "https://mcp.example.com/mcp" });
    await engine.handle("mcpstore.setAuth", { name: "remote-one", secret: "sk-super-secret-token" });

    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(home, "mcpstore.json"), "utf8");
    expect(raw).not.toContain("sk-super-secret-token");
  });

  it("rejects an unknown server name", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.setAuth", { name: "nope", secret: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a stdio server — it has no remote auth to set", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "local-one", type: "stdio", command: "node", args: [], env: {} });
    await expect(engine.handle("mcpstore.setAuth", { name: "local-one", secret: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects an empty/whitespace-only secret", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "remote-one", type: "http", url: "https://mcp.example.com/mcp" });
    await expect(engine.handle("mcpstore.setAuth", { name: "remote-one", secret: "   " }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("a thrown error message never contains the secret", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "local-one", type: "stdio", command: "node", args: [], env: {} });
    try {
      await engine.handle("mcpstore.setAuth", { name: "local-one", secret: "sk-should-never-appear" });
      expect.unreachable();
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain("sk-should-never-appear");
      expect((err as Error).message).not.toContain("sk-should-never-appear");
    }
  });
});

// MCPSTORE-LIFECYCLE-UI: uninstall (mcpstore.remove) must purge the Keychain secret too —
// leaving it behind after the mcpstore.json entry is gone is an orphaned-credential defect.
// Covers both credential shapes that live under the SAME service name (mcpStoreAuthService):
// a bearer secret (setAuth) and an oauth {tokens,clientInfo} blob (oauth.finish's persist path).
describe("mcpstore.remove purges the Keychain secret (uninstall)", () => {
  it("a bearer entry's keychain secret is gone after remove", async () => {
    const home = makeEngineHome();
    const { engine, keychain } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "remote-one", type: "http", url: "https://mcp.example.com/mcp" });
    await engine.handle("mcpstore.setAuth", { name: "remote-one", secret: "sk-super-secret-token" });
    expect(await keychain.get(mcpStoreAuthService("remote-one"))).toBe("sk-super-secret-token");

    await engine.handle("mcpstore.remove", { name: "remote-one" });

    expect(await keychain.get(mcpStoreAuthService("remote-one"))).toBeNull();
  });

  it("an oauth-kind entry's keychain blob is gone after remove", async () => {
    const home = makeEngineHome();
    const { engine, keychain } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "gateway", type: "http", url: "https://gateway.example.com/mcp", auth: { kind: "oauth", keychainRef: mcpStoreAuthService("gateway") } });
    await keychain.set(mcpStoreAuthService("gateway"), JSON.stringify({ tokens: { access_token: "x" }, clientInfo: {} }));

    await engine.handle("mcpstore.remove", { name: "gateway" });

    expect(await keychain.get(mcpStoreAuthService("gateway"))).toBeNull();
  });

  it("removing an entry with no auth set is a clean no-op (delete is idempotent)", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "local-one", type: "stdio", command: "node", args: [], env: {} });
    await expect(engine.handle("mcpstore.remove", { name: "local-one" })).resolves.toEqual({ name: "local-one", removed: true });
  });
});

// MCPSTORE-LIFECYCLE-UI: disable/enable is a temporary off switch — credentials survive it,
// unlike remove/uninstall above.
describe("mcpstore.setEnabled", () => {
  it("flips enabled and persists across a restart, without touching the keychain secret", async () => {
    const home = makeEngineHome();
    const { engine, keychain } = engineOn(home);
    await engine.handle("mcpstore.add", { name: "remote-one", type: "http", url: "https://mcp.example.com/mcp" });
    await engine.handle("mcpstore.setAuth", { name: "remote-one", secret: "sk-super-secret-token" });

    const disabled = await engine.handle("mcpstore.setEnabled", { name: "remote-one", enabled: false });
    expect(disabled).toMatchObject({ name: "remote-one", enabled: false });
    expect(await keychain.get(mcpStoreAuthService("remote-one"))).toBe("sk-super-secret-token");

    const { engine: e2 } = engineOn(home, keychain);
    const list = await e2.handle("mcpstore.list", {}) as Array<{ name: string; enabled?: boolean }>;
    expect(list.find((s) => s.name === "remote-one")?.enabled).toBe(false);
  });

  it("rejects an unknown server name", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("mcpstore.setEnabled", { name: "nope", enabled: false }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
