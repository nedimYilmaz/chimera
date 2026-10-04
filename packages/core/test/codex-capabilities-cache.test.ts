import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_CAPABILITY_CACHE_MS, createCodexModelValidator, validateCodexModel } from "@chimera/core/providers/codex-cli-models";

const entry = { slug: "gpt-x", supports_search_tool: true, supported_reasoning_levels: [{ effort: "high" }], input_modalities: ["text", "image"] };
const ok = (over: Record<string, unknown> = {}) => ({ code: 0, stdout: JSON.stringify({ models: [{ ...entry, ...over }] }) });
const failed = (reason = "probe timed out after 15s") => ({ code: 1, stdout: "", reason });
const { fresh, retry, staleMax } = CODEX_CAPABILITY_CACHE_MS;

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "chimera-cap-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// An env whose CODEX_HOME is unique per test: the cache key includes it, so tests never share state.
const accountEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ CHIMERA_CODEX_CLI_PATH: process.execPath, CODEX_HOME: tmp(), ...extra });

function harness(first: { code: number; stdout: string; reason?: string } = ok()) {
  let t = 1_000_000;
  let next = first;
  const exec = vi.fn(async () => next);
  return {
    exec, validate: createCodexModelValidator(exec, () => t),
    advance: (ms: number) => { t += ms; },
    respond: (r: { code: number; stdout: string; reason?: string }) => { next = r; },
  };
}

describe("capability probe: transient refresh failure vs. verified sessions", () => {
  it("serves the last verified catalog when the refresh after the fresh window fails (ARC/HowTo repro)", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond(failed());
    // Two agents turning 12s apart used to share one cached null and both die.
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toMatchObject({ source: "codex" });
    h.advance(12_000);
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toMatchObject({ source: "codex" });
  });

  it("does not respawn the probe for every turn during an outage, and recovers once it passes", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond(failed());
    await h.validate("gpt-x", "high", false, env);
    expect(h.exec).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) await h.validate("gpt-x", "high", false, env);   // inside the retry backoff
    expect(h.exec).toHaveBeenCalledTimes(2);
    h.advance(retry);
    h.respond(ok({ context_window: 400_000 }));
    expect(await h.validate("gpt-x", "high", false, env)).toEqual({ source: "codex", defaultWindow: 400_000 });
    expect(h.exec).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight probe between concurrent turns", async () => {
    let release!: (r: ReturnType<typeof ok>) => void;
    const exec = vi.fn(() => new Promise<ReturnType<typeof ok>>((resolve) => { release = resolve; }));
    const validate = createCodexModelValidator(exec, () => 1);
    const env = accountEnv();
    const turns = [validate("gpt-x", "high", false, env), validate("gpt-x", "high", false, env), validate("gpt-x", undefined, false, env)];
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    release(ok());
    await Promise.all(turns);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("stops serving the stale catalog after the bound, naming the cause and the age", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.respond(failed());
    h.advance(staleMax - 1_000);
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
    h.advance(2_000);
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/unavailable: probe timed out after 15s; last verified catalog is 30m old \(limit 30m\)/);
  });

  it("fails closed on the first validation, with the real cause and without blaming the login", async () => {
    const h = harness(failed("probe exited with code 7"));
    const env = accountEnv();
    const error = await h.validate("gpt-x", "high", false, env).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex model capabilities unavailable: probe exited with code 7; no verified catalog yet for this Codex CLI and account");
    expect((error as Error).message).not.toMatch(/login/i);
  });

  it("does not cache a failure for the fresh window: first validation recovers after the short backoff", async () => {
    const h = harness(failed());
    const env = accountEnv();
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/unavailable/);
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/unavailable/);
    expect(h.exec).toHaveBeenCalledTimes(1);   // burst shares the failure
    h.advance(retry);
    h.respond(ok());
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
  });

  it.each([
    ["invalid JSON", { code: 0, stdout: "not json" }, "probe returned invalid JSON"],
    ["no models array", { code: 0, stdout: "{}" }, "probe returned no models array"],
    ["empty catalog", { code: 0, stdout: JSON.stringify({ models: [] }) }, "probe returned an empty model list"],
    ["exit without detail", { code: 3, stdout: "" }, "probe exited with code 3"],
  ])("classifies %s", async (_name, response, reason) => {
    const h = harness(response);
    await expect(h.validate("gpt-x", undefined, false, accountEnv())).rejects.toThrow(reason);
  });

  it("keeps a probe's reason bounded and printable, and survives an exec that throws", async () => {
    const hostile = harness(failed(`token=secret\n\u0000${"x".repeat(500)}`));
    const message = (await hostile.validate("gpt-x", undefined, false, accountEnv()).catch((e: Error) => e.message)) as string;
    expect(message.split(";")[0]).toMatch(/^Codex model capabilities unavailable: [\x20-\x7e]{1,120}$/);
    const throwing = createCodexModelValidator(async () => { throw new Error("spawn /secret/path ENOENT"); }, () => 1);
    const thrown = (await throwing("gpt-x", undefined, false, accountEnv()).catch((e: Error) => e.message)) as string;
    expect(thrown).toMatch(/probe could not run/);
    expect(thrown).not.toContain("/secret/path");
  });

  it("an empty degraded refresh does not replace a verified catalog", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond({ code: 0, stdout: JSON.stringify({ models: [] }) });
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
  });
});

describe("capability probe: explicit mismatches stay fail-closed", () => {
  it("a fresh successful catalog that drops a capability overrides the earlier verified one", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond(ok({ supported_reasoning_levels: [{ effort: "low" }] }));
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/does not support reasoning effort high/);
    // ...and the outage afterwards must not resurrect the older, more permissive catalog.
    h.advance(fresh + 1);
    h.respond(failed());
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/does not support reasoning effort high/);
  });

  it.each([
    ["tool search", ok({ supports_search_tool: false }), "high", false, /does not advertise tool search/],
    ["reasoning effort", ok(), "ultra", false, /does not support reasoning effort ultra/],
    ["image input", ok({ input_modalities: ["text"] }), "high", true, /does not support image input/],
  ] as const)("a verified catalog lacking %s keeps rejecting during an outage", async (_name, catalog, effort, images, error) => {
    const h = harness(catalog);
    const env = accountEnv();
    await expect(h.validate("gpt-x", effort, images, env)).rejects.toThrow(error);
    h.advance(fresh + 1);
    h.respond(failed());
    await expect(h.validate("gpt-x", effort, images, env)).rejects.toThrow(error);
  });

  it("a model missing from an outdated catalog is reported as unavailable, not as unsupported", async () => {
    const h = harness();
    const env = accountEnv();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond(failed());
    await expect(h.validate("gpt-newer", "high", false, env)).rejects.toThrow(/unavailable: probe timed out after 15s; last verified catalog \(\d+s old\) does not list gpt-newer/);
  });
});

describe("capability probe: the verified catalog never crosses a CLI/account boundary", () => {
  async function verifiedThenDown(env: NodeJS.ProcessEnv) {
    const h = harness();
    await h.validate("gpt-x", "high", false, env);
    h.advance(fresh + 1);
    h.respond(failed());
    return h;
  }

  it("a different CODEX_HOME starts unverified", async () => {
    const env = accountEnv();
    const h = await verifiedThenDown(env);
    await expect(h.validate("gpt-x", "high", false, { ...env, CODEX_HOME: tmp() })).rejects.toThrow(/no verified catalog yet/);
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
  });

  it("a different API key starts unverified", async () => {
    const env = accountEnv({ OPENAI_API_KEY: "key-one" });
    const h = await verifiedThenDown(env);
    await expect(h.validate("gpt-x", "high", false, { ...env, OPENAI_API_KEY: "key-two" })).rejects.toThrow(/no verified catalog yet/);
  });

  it("a replaced binary starts unverified", async () => {
    const binary = join(tmp(), "codex");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = accountEnv({ CHIMERA_CODEX_CLI_PATH: binary });
    const h = await verifiedThenDown(env);
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
    writeFileSync(binary, "#!/bin/sh\n# upgraded\nexit 0\n", { mode: 0o755 });
    await expect(h.validate("gpt-x", "high", false, env)).rejects.toThrow(/no verified catalog yet/);
  });

  const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
  const login = (home: string, accountId: string, sub: string, accessToken = "access-1") =>
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt(sub), access_token: accessToken, refresh_token: "r", account_id: accountId } }));

  it.each([
    ["another workspace account", "acct-B", "user-1"],
    ["another user in the same workspace", "acct-A", "user-2"],
  ])("re-logging into the same CODEX_HOME as %s starts unverified", async (_name, accountId, sub) => {
    const env = accountEnv();
    login(env.CODEX_HOME!, "acct-A", "user-1");
    const h = await verifiedThenDown(env);
    login(env.CODEX_HOME!, accountId, sub);
    const error = (await h.validate("gpt-x", "high", false, env).catch((e: Error) => e.message)) as string;
    expect(error).toMatch(/no verified catalog yet/);
    expect(error).not.toMatch(/acct-|user-/);
  });

  it("a routine token refresh of the same identity keeps the verified catalog", async () => {
    const env = accountEnv();
    login(env.CODEX_HOME!, "acct-A", "user-1");
    const h = await verifiedThenDown(env);
    login(env.CODEX_HOME!, "acct-A", "user-1", "access-2-rotated");
    await expect(h.validate("gpt-x", "high", false, env)).resolves.toBeDefined();
  });
});

// The production path — real execFile, real module-level cache, no DI of the cache itself. This is
// the case the injected-exec tests historically bypassed (a custom exec skipped the cache entirely).
describe("production cache with a real probe binary", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeCodex() {
    const dir = tmp();
    const state = join(dir, "state");
    const models = join(dir, "models.json");
    const binary = join(dir, "codex");
    writeFileSync(models, JSON.stringify({ models: [entry] }));
    // The binary file is never rewritten (its size/mtime are part of the cache key); behaviour is
    // flipped through the state file it reads.
    writeFileSync(binary, `#!/bin/sh\ncase "$(cat "$CHIMERA_TEST_STATE")" in ok) cat "$CHIMERA_TEST_MODELS";; garbage) echo '{{';; *) exit 7;; esac\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CHIMERA_CODEX_CLI_PATH: binary, CODEX_HOME: join(dir, "home"), CHIMERA_TEST_STATE: state, CHIMERA_TEST_MODELS: models };
    return { env, set: (s: "ok" | "fail" | "garbage") => writeFileSync(state, s) };
  }

  it("a probe failure after the fresh window does not fail agents that were already verified", async () => {
    const { env, set } = fakeCodex();
    set("ok");
    await expect(validateCodexModel("gpt-x", "high", false, env)).resolves.toMatchObject({ source: "codex" });
    vi.setSystemTime(Date.now() + fresh + 1_000);
    set("fail");
    await expect(validateCodexModel("gpt-x", "high", false, env)).resolves.toMatchObject({ source: "codex" });
    vi.setSystemTime(Date.now() + 12_000);
    await expect(validateCodexModel("gpt-x", "high", false, env)).resolves.toMatchObject({ source: "codex" });
  });

  it("reports the real exit code for an unverified context instead of a login hint", async () => {
    const { env, set } = fakeCodex();
    set("fail");
    await expect(validateCodexModel("gpt-x", "high", false, env)).rejects.toThrow(/unavailable: probe exited with code 7; no verified catalog yet/);
    vi.setSystemTime(Date.now() + retry);
    set("garbage");
    await expect(validateCodexModel("gpt-x", "high", false, env)).rejects.toThrow(/unavailable: probe returned invalid JSON/);
    vi.setSystemTime(Date.now() + retry);
    set("ok");
    await expect(validateCodexModel("gpt-x", "high", false, env)).resolves.toBeDefined();
  });

  it("reports a binary that cannot start (execFile throws synchronously for ENOEXEC)", async () => {
    const { env } = fakeCodex();
    const missing = join(tmp(), "codex-gone");
    writeFileSync(missing, "", { mode: 0o755 });   // executable at resolve time, but not a runnable program
    await expect(validateCodexModel("gpt-x", "high", false, { ...env, CHIMERA_CODEX_CLI_PATH: missing })).rejects.toThrow(/unavailable: probe failed to start \(E[A-Z]+\)/);
  });
});
