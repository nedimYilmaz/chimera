import { describe, it, expect } from "vitest";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { OAuthTokenStore, REFRESH_WINDOW_MS } from "@chimera/core/providers/oauth";

const profile = {
  id: "anthropic", label: "Anthropic", kind: "agentic-sdk" as const, baseUrl: "https://api.anthropic.com",
  defaultModel: "claude-opus-4-8", models: [], authModes: ["oauth" as const],
  capabilities: { tools: true, vision: true, streaming: true },
};

describe("F23-0D: OAuthTokenStore", () => {
  it("load/save/delete round-trip through the keychain", async () => {
    const store = new OAuthTokenStore(new InMemoryKeychain());
    expect(await store.load("svc-x")).toBeNull();
    await store.save("svc-x", { accessToken: "tok-1" });
    expect(await store.load("svc-x")).toEqual({ accessToken: "tok-1" });
    await store.delete("svc-x");
    expect(await store.load("svc-x")).toBeNull();
  });

  it("treats a corrupt keychain item as no token (never throws)", async () => {
    const keychain = new InMemoryKeychain({ "svc-x": "{not json" });
    const store = new OAuthTokenStore(keychain);
    await expect(store.load("svc-x")).resolves.toBeNull();
  });

  it("treats a stored value missing accessToken as no token", async () => {
    const keychain = new InMemoryKeychain({ "svc-x": JSON.stringify({ refreshToken: "rt" }) });
    const store = new OAuthTokenStore(keychain);
    await expect(store.load("svc-x")).resolves.toBeNull();
  });

  describe("getValid", () => {
    it("returns null when no token is stored", async () => {
      const store = new OAuthTokenStore(new InMemoryKeychain());
      expect(await store.getValid("svc-x", "anthropic", profile)).toBeNull();
    });

    it("returns the token unchanged when it is not expiring", async () => {
      const keychain = new InMemoryKeychain({
        "svc-x": JSON.stringify({ accessToken: "tok-1", expiresAt: Date.now() + 3600_000 }),
      });
      const store = new OAuthTokenStore(keychain);
      expect(await store.getValid("svc-x", "anthropic", profile)).toEqual({ accessToken: "tok-1", expiresAt: expect.any(Number) });
    });

    it("returns a never-expiring token (no expiresAt) unchanged", async () => {
      const keychain = new InMemoryKeychain({ "svc-x": JSON.stringify({ accessToken: "tok-1" }) });
      const store = new OAuthTokenStore(keychain);
      expect(await store.getValid("svc-x", "anthropic", profile)).toEqual({ accessToken: "tok-1" });
    });

    it("refreshes a token expiring within the window and persists the result", async () => {
      const keychain = new InMemoryKeychain({
        "svc-x": JSON.stringify({ accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() + 60_000 }),
      });
      const store = new OAuthTokenStore(keychain);
      let refreshCalls = 0;
      store.registerRefresher("anthropic", {
        refresh: async (token, p) => {
          refreshCalls++;
          expect(token.refreshToken).toBe("rt-1");
          expect(p.id).toBe("anthropic");
          return { accessToken: "fresh", refreshToken: "rt-2", expiresAt: Date.now() + 3600_000 };
        },
      });
      const result = await store.getValid("svc-x", "anthropic", profile);
      expect(result?.accessToken).toBe("fresh");
      expect(refreshCalls).toBe(1);
      expect(JSON.parse((await keychain.get("svc-x"))!).accessToken).toBe("fresh");
    });

    it("an expiring token with no refreshToken is returned as-is (nothing to refresh with)", async () => {
      const keychain = new InMemoryKeychain({
        "svc-x": JSON.stringify({ accessToken: "stale", expiresAt: Date.now() + 1000 }),
      });
      const store = new OAuthTokenStore(keychain);
      store.registerRefresher("anthropic", { refresh: async () => { throw new Error("must not be called"); } });
      expect((await store.getValid("svc-x", "anthropic", profile))?.accessToken).toBe("stale");
    });

    it("an expiring token with no registered refresher is returned as-is", async () => {
      const keychain = new InMemoryKeychain({
        "svc-x": JSON.stringify({ accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() + 1000 }),
      });
      const store = new OAuthTokenStore(keychain);
      expect((await store.getValid("svc-x", "anthropic", profile))?.accessToken).toBe("stale");
    });

    it("exactly the refresh window boundary constant is 5 minutes", () => {
      expect(REFRESH_WINDOW_MS).toBe(5 * 60_000);
    });
  });
});
