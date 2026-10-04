import { describe, it, expect, vi } from "vitest";
import { RealAccountProber, FakeAccountProber } from "@chimera/core/prober";

// OAUTH-TOKEN-ACCOUNTS: adminKey is decided BEFORE any network call (see prober.ts's doc
// comment) — that branch should never invoke fetchImpl.
describe("RealAccountProber: credentialType-aware probing", () => {
  it("reports admin_key for an adminKey credential WITHOUT making a network call", async () => {
    const fetchImpl = vi.fn();
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-admin-x", credentialType: "adminKey" });
    expect(outcome).toEqual({ result: "admin_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still reports auth_error when no key is present, regardless of credentialType", async () => {
    const fetchImpl = vi.fn();
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    expect(await prober.probe({ provider: "claude", key: null, credentialType: "oauthToken" })).toEqual({ result: "auth_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// OAUTH-TOKEN-VALIDATE: an oauthToken credential DOES get a live probe now — GET
// /v1/models with Bearer + anthropic-beta oauth headers (NOT x-api-key), mirroring how
// the Claude Agent SDK itself authenticates a CLAUDE_CODE_OAUTH_TOKEN.
describe("RealAccountProber: oauthToken probe request shape (GET /v1/models, Bearer)", () => {
  it("issues a GET to /v1/models with Bearer + anthropic-beta oauth headers, NOT x-api-key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-oat01-x", credentialType: "oauthToken" });
    expect(outcome).toEqual({ result: "ok", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    const i = init as RequestInit;
    expect(i.method).toBeUndefined();
    expect(i.body).toBeUndefined();
    expect(i.headers).toMatchObject({ authorization: "Bearer sk-ant-oat01-x", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" });
    expect(i.headers).not.toHaveProperty("x-api-key");
  });

  it("maps 401 to auth_error with the provider's redacted detail, same as an apiKey rejection", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid bearer token" } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-oat01-bad", credentialType: "oauthToken" });
    expect(outcome).toEqual({ result: "auth_error", httpStatus: 401, detail: "authentication_error: Invalid bearer token" });
  });
});

// API-KEY-INVALID point 2: the claude probe must validate the key with GET /v1/models
// (x-api-key + anthropic-version) and NO model in the request — so a valid key that lacks
// access to some specific model is never misreported as auth_error.
describe("RealAccountProber: claude probe request shape (GET /v1/models)", () => {
  it("issues a GET to /v1/models with x-api-key + anthropic-version and NO body/model", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-api03-x", credentialType: "apiKey" });
    expect(outcome).toEqual({ result: "ok", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    const i = init as RequestInit;
    // GET is the default method (no explicit method), and crucially there is NO body — no
    // model is sent, which is the whole point of the model-access-decoupling fix.
    expect(i.method).toBeUndefined();
    expect(i.body).toBeUndefined();
    expect(i.headers).toMatchObject({ "x-api-key": "sk-ant-api03-x", "anthropic-version": "2023-06-01" });
  });

  it("treats a 200 as ok even for an unclassified (legacy) claude account", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    expect(await prober.probe({ provider: "claude", key: "sk-ant-api03-x" })).toEqual({ result: "ok", httpStatus: 200 });
  });
});

// API-KEY-INVALID point 3+4: surface the real error and classify 401 vs 403 vs network.
describe("RealAccountProber: error classification + redacted detail", () => {
  it("maps 401 to auth_error and surfaces the provider's key-redacted error message", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-api03-secret", credentialType: "apiKey" });
    expect(outcome).toEqual({ result: "auth_error", httpStatus: 401, detail: "authentication_error: invalid x-api-key" });
  });

  it("maps 403 to auth_error with its own distinct detail (distinguishable from 401)", async () => {
    const body = JSON.stringify({ error: { type: "permission_error", message: "your api key lacks permission for this resource" } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 403 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-api03-x", credentialType: "apiKey" });
    expect(outcome.result).toBe("auth_error");
    expect(outcome.httpStatus).toBe(403);
    expect(outcome.detail).toBe("permission_error: your api key lacks permission for this resource");
  });

  it("redacts the key if it ever appears verbatim in the provider error body", async () => {
    const key = "sk-ant-api03-LEAKY";
    const body = JSON.stringify({ error: { type: "authentication_error", message: `key ${key} is revoked` } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key, credentialType: "apiKey" });
    expect(outcome.detail).not.toContain(key);
    expect(outcome.detail).toContain("[REDACTED]");
  });

  it("falls back to raw (redacted, capped) text when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 403 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "claude", key: "sk-ant-api03-x", credentialType: "apiKey" });
    expect(outcome.result).toBe("auth_error");
    expect(outcome.detail).toBe("<html>502 Bad Gateway</html>");
  });

  it("does NOT invalidate on a non-auth status (a 429/500 is ok, not auth_error)", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    expect(await prober.probe({ provider: "claude", key: "sk-ant-api03-x", credentialType: "apiKey" })).toEqual({ result: "ok", httpStatus: 429 });
  });

  it("classifies a network/DNS failure as ok (transient ≠ auth failure), never auth_error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ENOTFOUND api.anthropic.com"); });
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    expect(await prober.probe({ provider: "claude", key: "sk-ant-api03-x", credentialType: "apiKey" })).toEqual({ result: "ok" });
  });

  it("codex probes GET /v1/models with a Bearer token and classifies 401", async () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided" } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "codex", key: "sk-codexsecret", credentialType: "apiKey" });
    expect(outcome).toEqual({ result: "auth_error", httpStatus: 401, detail: "Incorrect API key provided" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-codexsecret" });
  });
});

// CUSTOM-OPENAI-COMPAT: a custom provider profile drives the generic openai-compat probe
// branch just like a built-in — connection_error is distinct from auth_error, and a
// requiresKey:false profile skips the no-key auth_error entirely.
describe("RealAccountProber: custom openai-compat provider (effective profile)", () => {
  const OLLAMA = {
    id: "ollama-local", label: "Ollama", kind: "openai-compat" as const,
    baseUrl: "http://127.0.0.1:3333/v1", defaultModel: "qwen3.5:9b-mlx",
    models: ["qwen3.5:9b-mlx"], authModes: ["apiKey" as const],
    capabilities: { tools: true, vision: false, streaming: true },
    requiresKey: false, custom: true, envVar: "CUSTOM_OLLAMA_LOCAL_API_KEY",
  };

  it("does NOT return auth_error for a null key when the profile says requiresKey: false", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "ollama-local", key: null, profile: OLLAMA });
    expect(outcome).toEqual({ result: "ok", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports connection_error (not auth_error, not ok) when the baseUrl is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3333"); });
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "ollama-local", key: null, profile: OLLAMA });
    expect(outcome.result).toBe("connection_error");
    expect(outcome.detail).toMatch(/ECONNREFUSED/);
  });

  it("still reports auth_error for a 401 against a custom provider that does require a key", async () => {
    const requiresKeyProfile = { ...OLLAMA, requiresKey: true };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "ollama-local", key: "wrong", profile: requiresKeyProfile });
    expect(outcome.result).toBe("auth_error");
    expect(outcome.httpStatus).toBe(401);
  });

  it("a requiresKey: true custom provider with no key still gets the auto auth_error (no network call)", async () => {
    const requiresKeyProfile = { ...OLLAMA, requiresKey: true };
    const fetchImpl = vi.fn();
    const prober = new RealAccountProber(fetchImpl as unknown as typeof fetch);
    const outcome = await prober.probe({ provider: "ollama-local", key: null, profile: requiresKeyProfile });
    expect(outcome).toEqual({ result: "auth_error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("FakeAccountProber", () => {
  it("threads credentialType into the per-call function and normalizes a bare string result", async () => {
    const prober = new FakeAccountProber((opts) => (opts.credentialType === "adminKey" ? "admin_key" : "ok"));
    expect(await prober.probe({ provider: "claude", key: "k", credentialType: "adminKey" })).toEqual({ result: "admin_key" });
    expect(await prober.probe({ provider: "claude", key: "k", credentialType: "apiKey" })).toEqual({ result: "ok" });
  });

  it("accepts a full ProbeOutcome (with detail) as its fixed result", async () => {
    const prober = new FakeAccountProber({ result: "auth_error", httpStatus: 401, detail: "authentication_error: invalid x-api-key" });
    expect(await prober.probe({ provider: "claude", key: "k" })).toEqual({ result: "auth_error", httpStatus: 401, detail: "authentication_error: invalid x-api-key" });
  });
});
