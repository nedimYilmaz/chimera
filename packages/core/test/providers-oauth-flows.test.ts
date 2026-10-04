import { describe, it, expect, vi } from "vitest";
import { PendingOAuthStore } from "@chimera/core/providers/pending-oauth";
import {
  CopilotOAuthFlow, CopilotTokenRefresher, GrokCliOAuthFlow, GrokCliTokenRefresher,
} from "@chimera/core/providers/oauth-flows";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

// A fake HTTP layer keyed by URL with a per-URL queue of responses (consumed FIFO) — lets a
// test script exactly the "authorization_pending" -> "slow_down" -> success sequence a real
// device flow goes through.
function fakeFetch(queues: Record<string, unknown[]>): typeof fetch {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const q = queues[key];
    if (!q || q.length === 0) throw new Error(`fakeFetch: no queued response for ${key}`);
    return jsonResponse(q.shift());
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: string[] }).calls = calls;
  return fn;
}

const GITHUB_DEVICE = "https://github.com/login/device/code";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const COPILOT_EXCHANGE = "https://api.github.com/copilot_internal/v2/token";

describe("F23-2A: CopilotOAuthFlow (device code)", () => {
  it("start() returns the device user code immediately and resolves the pending record in the background", async () => {
    const fetchFn = fakeFetch({
      [GITHUB_DEVICE]: [{ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }],
      [GITHUB_TOKEN]: [{ error: "authorization_pending" }, { access_token: "ghu_live123" }],
      [COPILOT_EXCHANGE]: [{ token: "cop_abc", expires_at: Math.floor(Date.now() / 1000) + 1500 }],
    });
    const flow = new CopilotOAuthFlow({ clientId: "Iv1.test", scopes: ["read:user"], fetchFn, sleepFn: async () => {} });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("copilot");

    const result = await flow.start(pending, id);
    expect(result).toEqual({ kind: "device", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    expect(pending.get(id)?.state.status).toBe("pending");   // background poll hasn't resolved yet

    await vi.waitFor(() => {
      expect(pending.get(id)?.state.status).not.toBe("pending");
    });

    const state = pending.get(id)!.state;
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.token.accessToken).toBe("cop_abc");
      expect(state.token.refreshToken).toBe("ghu_live123");   // the ghu_ token re-mints future Copilot tokens
      expect(state.token.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("device flow expiry surfaces as an error state, not an unhandled rejection", async () => {
    const fetchFn = fakeFetch({
      [GITHUB_DEVICE]: [{ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 0, interval: 0 }],
    });
    const flow = new CopilotOAuthFlow({ clientId: "Iv1.test", scopes: [], fetchFn, sleepFn: async () => {} });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("copilot");
    await flow.start(pending, id);

    await vi.waitFor(() => {
      expect(pending.get(id)?.state.status).toBe("error");
    });
    const state = pending.get(id)!.state;
    if (state.status === "error") expect(state.message).toMatch(/expired/i);
  });

  it("a hard device-flow error (not authorization_pending/slow_down) fails the pending record", async () => {
    const fetchFn = fakeFetch({
      [GITHUB_DEVICE]: [{ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }],
      [GITHUB_TOKEN]: [{ error: "access_denied" }],
    });
    const flow = new CopilotOAuthFlow({ clientId: "Iv1.test", scopes: [], fetchFn, sleepFn: async () => {} });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("copilot");
    await flow.start(pending, id);

    await vi.waitFor(() => {
      expect(pending.get(id)?.state.status).toBe("error");
    });
    const state = pending.get(id)!.state;
    if (state.status === "error") expect(state.message).toContain("access_denied");
  });

  it("a non-ok device-code request throws synchronously (pre-flight failure, nothing scheduled)", async () => {
    const fetchFn = (async () => jsonResponse({}, false, 500)) as unknown as typeof fetch;
    const flow = new CopilotOAuthFlow({ clientId: "Iv1.test", scopes: [], fetchFn });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("copilot");
    await expect(flow.start(pending, id)).rejects.toThrow(/device code request failed/);
  });
});

describe("F23-2A: CopilotTokenRefresher", () => {
  it("re-exchanges the stored ghu_ token for a fresh Copilot token", async () => {
    const fetchFn = fakeFetch({
      [COPILOT_EXCHANGE]: [{ token: "cop_fresh", expires_at: Math.floor(Date.now() / 1000) + 1500 }],
    });
    const refresher = new CopilotTokenRefresher(fetchFn);
    const refreshed = await refresher.refresh(
      { accessToken: "cop_stale", refreshToken: "ghu_live123", expiresAt: Date.now() - 1000 },
      { id: "copilot", label: "GitHub Copilot", kind: "openai-compat", baseUrl: "x", defaultModel: "m", models: [], authModes: ["oauth"], capabilities: { tools: true, vision: true, streaming: true } },
    );
    expect(refreshed.accessToken).toBe("cop_fresh");
    expect(refreshed.refreshToken).toBe("ghu_live123");   // carried forward unchanged
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws a clean error when there is no stored ghu_ token to re-mint from", async () => {
    const refresher = new CopilotTokenRefresher();
    await expect(refresher.refresh({ accessToken: "cop_stale" }, {
      id: "copilot", label: "GitHub Copilot", kind: "openai-compat", baseUrl: "x", defaultModel: "m", models: [], authModes: ["oauth"], capabilities: { tools: true, vision: true, streaming: true },
    })).rejects.toThrow(/no stored GitHub token/);
  });
});

describe("F23-2A: GrokCliOAuthFlow (external CLI credentials)", () => {
  const profile = { id: "grok-build", label: "xAI Grok Build", kind: "openai-compat" as const, baseUrl: "x", defaultModel: "m", models: [], authModes: ["oauth" as const], capabilities: { tools: true, vision: true, streaming: true } };

  it("resolves immediately from a valid auth.json", async () => {
    const readFile = vi.fn(async () => JSON.stringify({ access_token: "grok-tok", refresh_token: "grok-refresh", expires_at: Date.now() + 3600_000 }));
    const flow = new GrokCliOAuthFlow({ authFilePath: "/fake/.grok/auth.json", readFile });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("grok-build");

    const result = await flow.start(pending, id);
    expect(result).toEqual({ kind: "immediate" });
    const state = pending.get(id)!.state;
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.token.accessToken).toBe("grok-tok");
      expect(state.token.refreshToken).toBe("grok-refresh");
    }
    expect(readFile).toHaveBeenCalledWith("/fake/.grok/auth.json");
  });

  it("throws a clear install+login message when the auth file is missing", async () => {
    const readFile = vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    const flow = new GrokCliOAuthFlow({ authFilePath: "/fake/.grok/auth.json", readFile });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("grok-build");
    await expect(flow.start(pending, id)).rejects.toThrow(/install the official Grok CLI/i);
    expect(pending.get(id)?.state.status).toBe("pending");   // never resolved — caller drops the pending record
  });

  it("throws when the auth file has no access_token", async () => {
    const readFile = vi.fn(async () => JSON.stringify({ refresh_token: "only-refresh" }));
    const flow = new GrokCliOAuthFlow({ authFilePath: "/fake/.grok/auth.json", readFile });
    const pending = new PendingOAuthStore();
    const { id } = pending.create("grok-build");
    await expect(flow.start(pending, id)).rejects.toThrow(/no access_token/i);
  });

  it("GrokCliTokenRefresher re-reads the file and returns the current contents", async () => {
    const readFile = vi.fn(async () => JSON.stringify({ access_token: "grok-tok-2", refresh_token: "grok-refresh-2", expires_at: 123 }));
    const refresher = new GrokCliTokenRefresher({ authFilePath: "/fake/.grok/auth.json", readFile });
    const refreshed = await refresher.refresh({ accessToken: "stale", accountMeta: { a: 1 } }, profile);
    expect(refreshed).toEqual({ accessToken: "grok-tok-2", refreshToken: "grok-refresh-2", expiresAt: 123, accountMeta: { a: 1 } });
  });

  it("GrokCliTokenRefresher falls back to the stale token if the file can no longer be read", async () => {
    const readFile = vi.fn(async () => { throw new Error("gone"); });
    const refresher = new GrokCliTokenRefresher({ authFilePath: "/fake/.grok/auth.json", readFile });
    const stale = { accessToken: "stale", expiresAt: 1 };
    await expect(refresher.refresh(stale, profile)).resolves.toEqual(stale);
  });
});
