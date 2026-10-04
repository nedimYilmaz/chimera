import { afterEach, describe, it, expect, vi } from "vitest";
import { userInfo } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  fetchClaudeUsage,
  fetchCodexRateLimits,
  normalizeClaudeUsagePoll,
  normalizeCodexRateLimits,
  resolveCodexSdkCliPath,
  resolveUsageToken,
  QuotaPoller,
  CLAUDE_USAGE_ENDPOINT,
  CLAUDE_MESSAGES_ENDPOINT,
  fetchMessagesRateLimitProbe,
  normalizeMessagesRateLimitHeaders,
  type CodexAppServerSpawn,
} from "@chimera/core/quota-poll";
import { CredentialResolver } from "@chimera/core/credentials";
import type { AccountConfig } from "@chimera/protocol";

// ACCOUNT-QUOTA-METERS-PULL: fixture shaped exactly like the REAL response captured live from
// GET /api/oauth/usage during this feature's development (see quota-poll.ts's header comment) —
// utilization is a 0..100 percent (five_hour: 1.0 == limits[].percent: 1 for the same window).
const REAL_SAMPLE = {
  five_hour: { utilization: 1.0, resets_at: "2026-07-25T04:00:00.459369+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null },
  seven_day: { utilization: 20.0, resets_at: "2026-07-30T10:00:00.459392+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null },
  seven_day_opus: null, seven_day_sonnet: null,
  limits: [
    { kind: "session", group: "session", percent: 1, severity: "normal", resets_at: "2026-07-25T04:00:00.459369+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 20, severity: "normal", resets_at: "2026-07-30T10:00:00.459392+00:00", scope: null, is_active: true },
  ],
};

// Shape captured live from codex-cli 0.145.0's `account/rateLimits/read`. The multi-bucket
// field is authoritative when present; primary/secondary ordering is deliberately reversed
// here to prove normalization uses duration rather than position.
const CODEX_SAMPLE = {
  rateLimits: {
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_785_250_000 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      primary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: 1_785_405_600 },
      secondary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1_785_259_200 },
    },
  },
};

describe("normalizeClaudeUsagePoll (pure)", () => {
  it("maps five_hour -> session and seven_day -> weekly, converting percent to a 0..1 fraction", () => {
    const windows = normalizeClaudeUsagePoll(REAL_SAMPLE);
    expect(windows).toEqual([
      { kind: "session", usedFraction: 0.01, windowStartedAt: Date.parse("2026-07-25T04:00:00.459369+00:00") - 5 * 60 * 60 * 1000, resetsAt: Date.parse("2026-07-25T04:00:00.459369+00:00") },
      { kind: "weekly", usedFraction: 0.2, windowStartedAt: Date.parse("2026-07-30T10:00:00.459392+00:00") - 7 * 24 * 60 * 60 * 1000, resetsAt: Date.parse("2026-07-30T10:00:00.459392+00:00") },
    ]);
  });

  it("cross-checks against the real payload's own limits[].percent — proves utilization is percent, not a fraction", () => {
    const windows = normalizeClaudeUsagePoll(REAL_SAMPLE);
    const session = windows.find((w) => w.kind === "session")!;
    const sessionPercent = REAL_SAMPLE.limits.find((l) => l.kind === "session")!.percent;
    expect(session.usedFraction * 100).toBeCloseTo(sessionPercent);
  });

  it("skips a null window instead of fabricating one", () => {
    const windows = normalizeClaudeUsagePoll({ five_hour: null, seven_day: null, seven_day_opus: null });
    expect(windows).toEqual([]);
  });

  it("skips a window with a non-numeric utilization or non-string resets_at", () => {
    expect(normalizeClaudeUsagePoll({ five_hour: { utilization: "42", resets_at: "2026-01-01T00:00:00Z" } })).toEqual([]);
    expect(normalizeClaudeUsagePoll({ five_hour: { utilization: 42, resets_at: 12345 } })).toEqual([]);
  });

  it("clamps an out-of-range utilization into [0,1]", () => {
    const windows = normalizeClaudeUsagePoll({ five_hour: { utilization: 150, resets_at: "2026-01-01T00:00:00Z" } });
    expect(windows[0]!.usedFraction).toBe(1);
  });
});

// WEEKLY-QUOTA-VARIANT-KEYS: live-confirmed 2026-07-30 — GET /api/oauth/usage can report the
// weekly window under seven_day_opus/seven_day_sonnet/seven_day_overage_included instead of
// plain seven_day (protocol/src/index.ts's documented rateLimitType enum; claude.ts's SDK-event
// path already handled this set, the REST poll was the one place still missing it). Each variant
// normalizes to kind "weekly" with the correct fraction/derived window start, labelled with the
// short variant name so the UI can say which bucket it's showing.
describe("normalizeClaudeUsagePoll — seven-day variant keys", () => {
  const RESETS_AT = "2026-08-02T11:59:59.865152+00:00";
  const resetsAtMs = Date.parse(RESETS_AT);

  it("seven_day_opus normalizes to kind weekly, correct fraction and derived window start, labelled 'opus'", () => {
    const windows = normalizeClaudeUsagePoll({ seven_day_opus: { utilization: 42, resets_at: RESETS_AT } });
    expect(windows).toEqual([{ kind: "weekly", usedFraction: 0.42, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs, variant: "opus" }]);
  });

  it("seven_day_sonnet normalizes to kind weekly, labelled 'sonnet'", () => {
    const windows = normalizeClaudeUsagePoll({ seven_day_sonnet: { utilization: 10, resets_at: RESETS_AT } });
    expect(windows).toEqual([{ kind: "weekly", usedFraction: 0.1, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs, variant: "sonnet" }]);
  });

  it("seven_day_overage_included normalizes to kind weekly, labelled 'overage included'", () => {
    const windows = normalizeClaudeUsagePoll({ seven_day_overage_included: { utilization: 5, resets_at: RESETS_AT } });
    expect(windows).toEqual([{ kind: "weekly", usedFraction: 0.05, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs, variant: "overage included" }]);
  });

  it("an unrelated 'seven_day_*' field (e.g. seven_day_oauth_apps — a real live top-level key, not a quota window) is never mistaken for a weekly bucket", () => {
    const windows = normalizeClaudeUsagePoll({ seven_day_oauth_apps: { utilization: 99, resets_at: RESETS_AT } });
    expect(windows).toEqual([]);
  });

  it("multiple weekly variants at once: picks the MOST-CONSTRAINING (highest utilization), labelling the winner", () => {
    const windows = normalizeClaudeUsagePoll({
      seven_day_opus: { utilization: 30, resets_at: RESETS_AT },
      seven_day_sonnet: { utilization: 87, resets_at: "2026-08-01T00:00:00.000000+00:00" },
    });
    expect(windows).toEqual([{
      kind: "weekly",
      usedFraction: 0.87,
      windowStartedAt: Date.parse("2026-08-01T00:00:00.000000+00:00") - 7 * 24 * 60 * 60 * 1000,
      resetsAt: Date.parse("2026-08-01T00:00:00.000000+00:00"),
      variant: "sonnet",
    }]);
  });

  it("falls back to limits[] (group: 'weekly') when no top-level weekly key is populated", () => {
    const windows = normalizeClaudeUsagePoll({
      five_hour: null,
      seven_day: null,
      limits: [
        { kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-07-30T02:29:59.000Z", scope: null, is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 62, severity: "normal", resets_at: RESETS_AT, scope: null, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
      ],
    });
    // the null-resets_at "weekly_scoped" entry is skipped (never fabricated); "weekly_all" wins
    // both because it's the only valid candidate AND because it has the higher utilization.
    expect(windows).toEqual([{ kind: "weekly", usedFraction: 0.62, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs, variant: "weekly_all" }]);
  });

  it("limits[] is a SECONDARY source only — a populated top-level key wins even if limits[] also has weekly entries", () => {
    const windows = normalizeClaudeUsagePoll({
      seven_day: { utilization: 3, resets_at: RESETS_AT },
      limits: [{ kind: "weekly_all", group: "weekly", percent: 99, severity: "normal", resets_at: "2026-08-05T00:00:00.000Z", scope: null, is_active: true }],
    });
    expect(windows).toEqual([{ kind: "weekly", usedFraction: 0.03, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs }]);
  });

  it("genuinely absent: no top-level weekly key and no weekly-group limits entry -- session still normalizes, weekly is simply omitted (never a fabricated window)", () => {
    const windows = normalizeClaudeUsagePoll({
      five_hour: { utilization: 3, resets_at: "2026-07-30T02:29:59.000Z" },
      seven_day: null,
      limits: [{ kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-07-30T02:29:59.000Z", scope: null, is_active: true }],
    });
    expect(windows).toEqual([{ kind: "session", usedFraction: 0.03, windowStartedAt: Date.parse("2026-07-30T02:29:59.000Z") - 5 * 60 * 60 * 1000, resetsAt: Date.parse("2026-07-30T02:29:59.000Z") }]);
  });

  it("regression: plain five_hour/seven_day parsing is byte-identical to before this fix (no variant field)", () => {
    const windows = normalizeClaudeUsagePoll(REAL_SAMPLE);
    expect(windows).toEqual([
      { kind: "session", usedFraction: 0.01, windowStartedAt: Date.parse("2026-07-25T04:00:00.459369+00:00") - 5 * 60 * 60 * 1000, resetsAt: Date.parse("2026-07-25T04:00:00.459369+00:00") },
      { kind: "weekly", usedFraction: 0.2, windowStartedAt: Date.parse("2026-07-30T10:00:00.459392+00:00") - 7 * 24 * 60 * 60 * 1000, resetsAt: Date.parse("2026-07-30T10:00:00.459392+00:00") },
    ]);
    expect(windows.every((w) => !("variant" in w))).toBe(true);
  });
});

describe("fetchClaudeUsage", () => {
  it("GETs CLAUDE_USAGE_ENDPOINT with a bearer token and returns { ok: true, body }", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(CLAUDE_USAGE_ENDPOINT);
      expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-abc");
      return { ok: true, status: 200, json: async () => REAL_SAMPLE } as Response;
    });
    const result = await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, body: REAL_SAMPLE });
  });

  it("carries the real HTTP status on a non-200 response (e.g. 429)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) } as Response));
    expect(await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, httpStatus: 429 });
  });

  it("parses a Retry-After header (delta-seconds) on a 429 into retryAfterMs", async () => {
    const headers = new Map([["retry-after", "3600"]]);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, json: async () => ({}) } as unknown as Response));
    expect(await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, httpStatus: 429, retryAfterMs: 3_600_000 });
  });

  it("omits retryAfterMs when the header is absent or unparseable", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) } as Response));
    expect(await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, httpStatus: 429, retryAfterMs: undefined });
  });

  it("carries a 401 status distinctly from a 429", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as Response));
    expect(await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, httpStatus: 401 });
  });

  it("returns an error string on a network error instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const result = await fetchClaudeUsage("tok-abc", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: "ECONNRESET" });
  });
});

describe("normalizeCodexRateLimits (pure)", () => {
  it("maps app-server windows by duration, converts percent/epoch-seconds, and prefers the codex bucket", () => {
    expect(normalizeCodexRateLimits(CODEX_SAMPLE)).toEqual([
      {
        kind: "session",
        usedFraction: 0.09,
        windowStartedAt: 1_785_259_200_000 - 5 * 60 * 60 * 1000,
        resetsAt: 1_785_259_200_000,
      },
      {
        kind: "weekly",
        usedFraction: 0.55,
        windowStartedAt: 1_785_405_600_000 - 7 * 24 * 60 * 60 * 1000,
        resetsAt: 1_785_405_600_000,
      },
    ]);
  });

  it("supports a weekly-only legacy snapshot and never guesses an unknown duration", () => {
    expect(normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: 1_785_848_853 },
        secondary: { usedPercent: 80, windowDurationMins: 60, resetsAt: 1_785_000_000 },
      },
    })).toEqual([{
      kind: "weekly",
      usedFraction: 0.01,
      windowStartedAt: 1_785_848_853_000 - 7 * 24 * 60 * 60 * 1000,
      resetsAt: 1_785_848_853_000,
    }]);
  });

  it("skips incomplete windows rather than fabricating reset or duration data", () => {
    expect(normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 20, windowDurationMins: null, resetsAt: 1_785_000_000 },
      },
    })).toEqual([]);
  });
});

describe("fetchCodexRateLimits", () => {
  it("resolves the same vendored native CLI that the Codex SDK uses without relying on PATH", () => {
    const resolved = resolveCodexSdkCliPath();
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/[/\\]vendor[/\\].*[/\\]bin[/\\]codex(?:\.exe)?$/);
  });

  it("initializes the app-server, reads the snapshot, and scopes auth with CODEX_HOME", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const requests: Array<Record<string, unknown>> = [];
    let input = "";
    stdin.on("data", (chunk) => {
      input += String(chunk);
      let newline = input.indexOf("\n");
      while (newline !== -1) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        newline = input.indexOf("\n");
        const message = JSON.parse(line) as Record<string, unknown>;
        requests.push(message);
        if (message["id"] === 1) {
          stdout.write(`${JSON.stringify({ id: 1, result: { codexHome: "/tmp/codex-a" } })}\n`);
        } else if (message["id"] === 2) {
          stdout.write(`${JSON.stringify({ id: 2, result: CODEX_SAMPLE })}\n`);
        }
      }
    });
    const spawnImpl = vi.fn(() => child) as unknown as CodexAppServerSpawn;

    await expect(fetchCodexRateLimits("/tmp/codex-a", {
      spawnImpl,
      codexPath: "/opt/codex",
      timeoutMs: 1_000,
    })).resolves.toEqual({ ok: true, body: CODEX_SAMPLE });

    expect(spawnImpl).toHaveBeenCalledWith(
      "/opt/codex",
      ["app-server", "--stdio"],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: "/tmp/codex-a" }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(requests.map((request) => request["method"])).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

const fakeExec = (table: Record<string, { stdout: string; code: number }>) =>
  async (cmd: string, args: string[]) => table[[cmd, ...args].join(" ")] ?? { stdout: "", code: 1 };

describe("resolveUsageToken", () => {
  it("keeps codex out of the Claude OAuth-token resolver because it uses app-server polling", async () => {
    const account = { name: "a", provider: "codex", auth: { type: "subscription" } } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({}));
    const result = await resolveUsageToken(account, { credentials });
    expect(result.token).toBeNull();
    expect((result as { detail: string }).detail).toMatch(/app-server source/);
  });

  it("declines an unrecognized non-claude/non-codex provider with a provider-named detail", async () => {
    const account = { name: "b", provider: "gemini", auth: { type: "subscription" } } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({}));
    const result = await resolveUsageToken(account, { credentials });
    expect(result.token).toBeNull();
    expect((result as { detail: string }).detail).toBe("provider 'gemini' has no known quota API");
  });

  it("reuses CredentialResolver for a keychain account classified oauthToken", async () => {
    const account = {
      name: "claude-pers", provider: "claude",
      auth: { type: "keychain", service: "chimera:claude-pers", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" },
    } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({
      "security find-generic-password -s chimera:claude-pers -w": { stdout: "sk-ant-oat01-xyz\n", code: 0 },
    }));
    expect(await resolveUsageToken(account, { credentials })).toEqual({ token: "sk-ant-oat01-xyz" });
  });

  it("declines a keychain account classified apiKey (no subscription-style quota data), with a credentialType-named detail", async () => {
    const account = {
      name: "raw-key", provider: "claude",
      auth: { type: "keychain", service: "chimera:raw-key", injectAs: "ANTHROPIC_API_KEY", credentialType: "apiKey" },
    } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({
      "security find-generic-password -s chimera:raw-key -w": { stdout: "sk-ant-api03-xyz\n", code: 0 },
    }));
    const result = await resolveUsageToken(account, { credentials });
    expect(result.token).toBeNull();
    expect((result as { detail: string }).detail).toMatch(/credential type 'apiKey'/);
  });

  it("reads the ambient 'Claude Code-credentials' keychain item for a plain subscription account (darwin)", async () => {
    if (process.platform !== "darwin") return;
    const account = { name: "claude", provider: "claude", auth: { type: "subscription" } } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({}));
    const exec = fakeExec({
      [`security find-generic-password -s Claude Code-credentials -a ${process.env.USER || userInfo().username} -w`]: {
        stdout: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-ambient" } }),
        code: 0,
      },
    });
    expect(await resolveUsageToken(account, { credentials, exec })).toEqual({ token: "sk-ant-oat01-ambient" });
  });

  it("declines a subscription account with a homeDir override, with a homeDir-named detail (hash-namespaced keychain service, not replicated)", async () => {
    const account = { name: "claude-2", provider: "claude", auth: { type: "subscription", homeDir: "/tmp/other-home" } } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({}));
    const result = await resolveUsageToken(account, { credentials, exec: fakeExec({}) });
    expect(result.token).toBeNull();
    expect((result as { detail: string }).detail).toMatch(/home dir override/);
  });

  it("declines when the ambient keychain item is absent, with a keychain-item-not-found detail", async () => {
    if (process.platform !== "darwin") return;
    const account = { name: "claude", provider: "claude", auth: { type: "subscription" } } as unknown as AccountConfig;
    const credentials = new CredentialResolver(fakeExec({}));
    const result = await resolveUsageToken(account, { credentials, exec: fakeExec({}) });
    expect(result.token).toBeNull();
    expect((result as { detail: string }).detail).toMatch(/no ambient/);
  });

  it("declines env/command auth types (no subscription-style quota data), each with an auth-type-named detail", async () => {
    const credentials = new CredentialResolver(fakeExec({}));
    const env = { name: "e", provider: "claude", auth: { type: "env", var: "X", injectAs: "ANTHROPIC_API_KEY" } } as unknown as AccountConfig;
    const cmd = { name: "c", provider: "claude", auth: { type: "command", run: "echo x", injectAs: "ANTHROPIC_API_KEY" } } as unknown as AccountConfig;
    const envResult = await resolveUsageToken(env, { credentials });
    const cmdResult = await resolveUsageToken(cmd, { credentials });
    expect(envResult.token).toBeNull();
    expect(cmdResult.token).toBeNull();
    expect((envResult as { detail: string }).detail).toMatch(/auth type 'env'/);
    expect((cmdResult as { detail: string }).detail).toMatch(/auth type 'command'/);
  });
});

function makeDeps() {
  const recorded: Array<{ account: string; window: unknown }> = [];
  const account: AccountConfig = {
    name: "claude-pers", provider: "claude",
    auth: { type: "keychain", service: "chimera:claude-pers", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" },
  } as unknown as AccountConfig;
  const registry = { list: () => [{ name: "claude-pers", provider: "claude" }], get: () => account };
  const credentials = new CredentialResolver(fakeExec({
    "security find-generic-password -s chimera:claude-pers -w": { stdout: "sk-ant-oat01-xyz\n", code: 0 },
  }));
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => REAL_SAMPLE }) as Response);
  const reasons: Array<{ account: string; reason: unknown }> = [];
  const quotas = {
    record: vi.fn((acct: string, window: unknown) => recorded.push({ account: acct, window })),
    recordReason: vi.fn((acct: string, reason: unknown) => reasons.push({ account: acct, reason })),
  };
  return { registry, credentials, quotas, fetchImpl, recorded, reasons, account };
}

describe("QuotaPoller", () => {

  it("pollAll polls every claude account and records both windows into the shared tracker", async () => {
    const { registry, credentials, quotas, fetchImpl, recorded } = makeDeps();
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.account).toBe("claude-pers");
  });

  it("pollAccount debounces within minPollGapMs unless forced", async () => {
    const { registry, credentials, quotas, fetchImpl } = makeDeps();
    let now = 1_000_000;
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, minPollGapMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 10_000;   // inside the 60s gap
    await poller.pollAccount("claude-pers");
    expect(fetchImpl).toHaveBeenCalledTimes(1);   // debounced — no second request
    now += 60_000;   // now past the gap
    await poller.pollAccount("claude-pers");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a failed resolve/fetch never throws out of pollAccount", async () => {
    const registry = { list: () => [{ name: "x", provider: "claude" }], get: () => ({ name: "x", provider: "claude", auth: { type: "env", var: "MISSING", injectAs: "ANTHROPIC_API_KEY" } }) as unknown as AccountConfig };
    const credentials = new CredentialResolver(fakeExec({}));
    const quotas = { record: vi.fn() };
    const poller = new QuotaPoller({ registry, credentials, quotas });
    await expect(poller.pollAccount("x", { force: true })).resolves.toBeUndefined();
    expect(quotas.record).not.toHaveBeenCalled();
  });

  // lastPolledAt is now set at the top of the attempt (so the reason's `at` reflects "when we
  // tried", not "when we last succeeded") — a FAILED poll therefore also consumes the debounce
  // window, same as a successful one. An opportunistic caller (supervisor.ts, no force) that
  // fires again inside minPollGapMs after a failure must not re-fetch.
  it("a failed poll still consumes minPollGapMs — a subsequent unforced call inside the gap does not re-fetch", async () => {
    const { registry, credentials } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const quotas = { record: vi.fn(), recordReason: vi.fn() };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, minPollGapMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 10_000;   // inside the 60s gap
    await poller.pollAccount("claude-pers");
    expect(fetchImpl).toHaveBeenCalledTimes(1);   // debounced despite the prior attempt failing
    now += 60_000;
    await poller.pollAccount("claude-pers");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// QUOTA-ABSENCE-IS-INVISIBLE: one test per distinct outcome, each asserting the recorded
// reason's `kind` (and httpStatus where relevant) — no scenario may ever call quotas.record
// with a fabricated window.
describe("QuotaPoller — recordReason per outcome", () => {
  it("unsupported codex auth type: never starts app-server, records kind 'unsupported'", async () => {
    const registry = { list: () => [{ name: "codex-key", provider: "codex" }], get: () => ({ name: "codex-key", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } }) as unknown as AccountConfig };
    const credentials = new CredentialResolver(fakeExec({}));
    const fetchImpl = vi.fn();
    const fetchCodex = vi.fn();
    const reasons: Array<{ account: string; reason: { kind: string } }> = [];
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: { kind: string }) => reasons.push({ account: a, reason: r })) };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, fetchCodexRateLimits: fetchCodex });
    await poller.pollAccount("codex-key", { force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchCodex).not.toHaveBeenCalled();
    expect(quotas.record).not.toHaveBeenCalled();
    expect(reasons).toEqual([{ account: "codex-key", reason: expect.objectContaining({ kind: "unsupported", detail: expect.stringMatching(/auth type 'env'/) }) }]);
  });

  it("pollAll reads codex through app-server and records its windows alongside Claude", async () => {
    const registry = {
      list: () => [
        { name: "claude-pers", provider: "claude" },
        { name: "codex-1", provider: "codex" },
      ],
      get: (name: string) => (name === "codex-1"
        ? { name: "codex-1", provider: "codex", auth: { type: "subscription" } }
        : { name: "claude-pers", provider: "claude", auth: { type: "keychain", service: "chimera:claude-pers", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" } }) as unknown as AccountConfig,
    };
    const credentials = new CredentialResolver(fakeExec({
      "security find-generic-password -s chimera:claude-pers -w": { stdout: "sk-ant-oat01-xyz\n", code: 0 },
    }));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => REAL_SAMPLE }) as Response);
    const fetchCodex = vi.fn(async () => ({ ok: true as const, body: CODEX_SAMPLE }));
    const recorded: Array<{ account: string; window: unknown }> = [];
    const reasons: Array<{ account: string; reason: { kind: string } }> = [];
    const quotas = {
      record: vi.fn((account: string, window: unknown) => recorded.push({ account, window })),
      recordReason: vi.fn((a: string, r: { kind: string }) => reasons.push({ account: a, reason: r })),
    };
    const poller = new QuotaPoller({
      registry,
      credentials,
      quotas,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fetchCodexRateLimits: fetchCodex,
    });
    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchCodex).toHaveBeenCalledWith(undefined);
    expect(recorded.filter((r) => r.account === "codex-1")).toEqual([
      { account: "codex-1", window: expect.objectContaining({ kind: "session", usedFraction: 0.09 }) },
      { account: "codex-1", window: expect.objectContaining({ kind: "weekly", usedFraction: 0.55 }) },
    ]);
    expect(reasons.find((r) => r.account === "codex-1")).toEqual({
      account: "codex-1",
      reason: expect.objectContaining({ kind: "ok" }),
    });
  });

  it("codex app-server failure records the detail and never fabricates a window", async () => {
    const registry = { list: () => [{ name: "codex", provider: "codex" }], get: () => ({ name: "codex", provider: "codex", auth: { type: "subscription", homeDir: "/tmp/codex-home" } }) as unknown as AccountConfig };
    const credentials = new CredentialResolver(fakeExec({}));
    const fetchCodex = vi.fn(async () => ({ ok: false as const, error: "app-server unavailable" }));
    const reasons: Array<{ account: string; reason: unknown }> = [];
    const quotas = {
      record: vi.fn(),
      recordReason: vi.fn((account: string, reason: unknown) => reasons.push({ account, reason })),
    };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchCodexRateLimits: fetchCodex });
    await poller.pollAccount("codex", { force: true });
    expect(fetchCodex).toHaveBeenCalledWith("/tmp/codex-home");
    expect(quotas.record).not.toHaveBeenCalled();
    expect(reasons).toEqual([{
      account: "codex",
      reason: expect.objectContaining({ kind: "network_error", detail: "app-server unavailable" }),
    }]);
  });

  it("429: records kind 'rate_limited' with httpStatus 429, no window fabricated", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.pollAccount("claude-pers", { force: true });
    expect(quotas.record).not.toHaveBeenCalled();
    expect(reasons).toEqual([{ account: "claude-pers", reason: expect.objectContaining({ kind: "rate_limited", httpStatus: 429 }) }]);
  });

  it("429 then backs off: a second forced poll before the backoff window elapses does not re-fetch", async () => {
    const { registry, credentials } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const quotas = { record: vi.fn(), recordReason: vi.fn() };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    // 2 calls: the usage-endpoint poll (429) plus its header-probe fallback (also 429 here,
    // via the same mocked fetchImpl) — see QUOTA-FROM-RESPONSE-HEADERS in quota-poll.ts.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 60_000;   // past the normal baseline interval, but well inside the 429 backoff
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);   // still backed off — no further requests at all
  });

  it("429 with a Retry-After header: nextRetryAt honors the server's own delay, not just the heuristic", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const headers = new Map([["retry-after", "3600"]]);   // 1 hour, as observed live against claude-pers
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, json: async () => ({}) } as unknown as Response));
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    let now = 1_000_000;
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    expect(reasons[0]!.reason).toEqual(expect.objectContaining({ kind: "rate_limited", nextRetryAt: now + 3_600_000 }));
  });

  it("429 with a short Retry-After: the 30-minute floor still wins — the header can shorten the wait, but never below the floor", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const headers = new Map([["retry-after", "5"]]);   // 5 seconds — far under the floor
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, json: async () => ({}) } as unknown as Response));
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    let now = 1_000_000;
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    expect(reasons[0]!.reason).toEqual(expect.objectContaining({ kind: "rate_limited", nextRetryAt: now + 30 * 60_000 }));
  });

  it("429 without a Retry-After header: falls back to the original six-interval-floored-at-30min heuristic", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    let now = 1_000_000;
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });
    await poller.pollAccount("claude-pers", { force: true });
    expect(reasons[0]!.reason).toEqual(expect.objectContaining({ kind: "rate_limited", nextRetryAt: now + 30 * 60_000 }));
  });

  it("401/403: records kind 'http_error' with the real status, distinct from rate_limited", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.pollAccount("claude-pers", { force: true });
    expect(quotas.record).not.toHaveBeenCalled();
    expect(reasons).toEqual([{ account: "claude-pers", reason: expect.objectContaining({ kind: "http_error", httpStatus: 401 }) }]);
  });

  it("success with zero windows: records kind 'empty', never fabricates a window", async () => {
    const { registry, credentials, reasons } = makeDeps();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ five_hour: null, seven_day: null }) }) as Response);
    const quotas = { record: vi.fn(), recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })) };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.pollAccount("claude-pers", { force: true });
    expect(quotas.record).not.toHaveBeenCalled();
    expect(reasons).toEqual([{ account: "claude-pers", reason: expect.objectContaining({ kind: "empty" }) }]);
  });

  it("success with windows: records both the windows AND kind 'ok'", async () => {
    const { registry, credentials, quotas, fetchImpl, recorded, reasons } = makeDeps();
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.pollAccount("claude-pers", { force: true });
    expect(recorded).toHaveLength(2);
    expect(reasons).toEqual([{ account: "claude-pers", reason: expect.objectContaining({ kind: "ok" }) }]);
  });
});

// QUOTA-FROM-RESPONSE-HEADERS: the header-probe fallback fires when the usage endpoint 429s —
// exactly the case the user demonstrated live (same OAuth token, 429 from GET /api/oauth/usage,
// 200 from POST /v1/messages with rate-limit windows in its headers).
describe("normalizeMessagesRateLimitHeaders (pure)", () => {
  function headersFrom(map: Record<string, string>): Headers {
    return { get: (k: string) => map[k.toLowerCase()] ?? null } as unknown as Headers;
  }

  it("parses real observed headers into AccountQuotaWindow[], converting fraction+epoch-seconds correctly", () => {
    // Real header values captured live against CLAUDE_MESSAGES_ENDPOINT with a 429'd usage-poll token.
    const headers = headersFrom({
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-reset": "1785241200",
      "anthropic-ratelimit-unified-5h-utilization": "0.07",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-reset": "1785405600",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
    });
    const windows = normalizeMessagesRateLimitHeaders(headers);
    expect(windows).toEqual([
      { kind: "session", usedFraction: 0.07, windowStartedAt: 1785241200_000 - 5 * 60 * 60 * 1000, resetsAt: 1785241200_000 },
      { kind: "weekly", usedFraction: 0.5, windowStartedAt: 1785405600_000 - 7 * 24 * 60 * 60 * 1000, resetsAt: 1785405600_000 },
    ]);
  });

  it("never fabricates a window when a header is missing", () => {
    const windows = normalizeMessagesRateLimitHeaders(headersFrom({}));
    expect(windows).toEqual([]);
  });
});

describe("fetchMessagesRateLimitProbe", () => {
  it("POSTs to CLAUDE_MESSAGES_ENDPOINT with max_tokens:1 and returns the raw Headers on success", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(CLAUDE_MESSAGES_ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
      return { ok: true, status: 200, headers: new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.07" }) } as Response;
    });
    const result = await fetchMessagesRateLimitProbe("tok-abc", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect((result as { headers: Headers }).headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.07");
  });

  it("carries the real HTTP status on a 429, same shape as fetchClaudeUsage", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) } as Response));
    expect(await fetchMessagesRateLimitProbe("tok-abc", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, httpStatus: 429 });
  });
});

describe("QuotaPoller: header-probe fallback on 429", () => {
  it("populates the tracker from /v1/messages response headers when the usage endpoint 429s, without weakening the 429 backoff", async () => {
    const { registry, credentials, reasons, recorded } = makeDeps();
    let now = 1_000_000;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === CLAUDE_USAGE_ENDPOINT) return { ok: false, status: 429, json: async () => ({}) } as Response;
      if (url === CLAUDE_MESSAGES_ENDPOINT) {
        return {
          ok: true, status: 200,
          headers: {
            get: (k: string) => ({
              "anthropic-ratelimit-unified-5h-reset": "1785241200",
              "anthropic-ratelimit-unified-5h-utilization": "0.07",
              "anthropic-ratelimit-unified-7d-reset": "1785405600",
              "anthropic-ratelimit-unified-7d-utilization": "0.5",
            } as Record<string, string>)[k.toLowerCase()] ?? null,
          },
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    });
    const quotas = {
      record: vi.fn((a: string, w: unknown) => recorded.push({ account: a, window: w })),
      recordReason: vi.fn((a: string, r: unknown) => reasons.push({ account: a, reason: r })),
    };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });

    await poller.pollAccount("claude-pers", { force: true });

    // The rate_limited reason (and its backoff) still records exactly as before — the probe is
    // an ADD, not a replacement of the usage-endpoint's own 429 handling.
    expect(reasons.some((r) => (r.reason as { kind: string }).kind === "rate_limited")).toBe(true);
    // The probe's own windows still land in the SAME tracker via quotas.record.
    expect(recorded).toEqual([
      { account: "claude-pers", window: expect.objectContaining({ kind: "session", usedFraction: 0.07 }) },
      { account: "claude-pers", window: expect.objectContaining({ kind: "weekly", usedFraction: 0.5 }) },
    ]);

    // Backoff still holds: a forced re-poll well within the 30-minute floor makes no further requests.
    fetchImpl.mockClear();
    now += 60_000;
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Claude usage keychain account selection", () => {
  afterEach(() => vi.unstubAllEnvs());
  const account = { name: "claude", provider: "claude", auth: { type: "subscription" } } as AccountConfig;

  it.skipIf(process.platform !== "darwin")("ignores a duplicate service's MCP-only item and reads the current user's OAuth token", async () => {
    vi.stubEnv("USER", "current-user");
    const exec = vi.fn(async (_cmd: string, args: string[]) => ({
      code: 0,
      stdout: JSON.stringify(args.includes("-a") && args[args.indexOf("-a") + 1] === "current-user"
        ? { claudeAiOauth: { accessToken: "claude-token" } }
        : { mcpOAuth: { server: { accessToken: "unrelated-mcp-token" } } }),
    }));
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer claude-token" });
      return { ok: true, json: async () => ({ five_hour: { utilization: 25, resets_at: "2026-09-28T12:00:00Z" }, seven_day: { utilization: 60, resets_at: "2026-10-01T12:00:00Z" } }) } as Response;
    });
    const record = vi.fn(), recordReason = vi.fn();
    const poller = new QuotaPoller({
      registry: { list: () => [{ name: "claude", provider: "claude" }], get: () => account },
      credentials: new CredentialResolver(fakeExec({})), exec, fetchImpl: fetchImpl as typeof fetch,
      quotas: { record, recordReason }, now: () => Date.parse("2026-09-28T10:00:00Z"),
    });
    await poller.pollAccount("claude", { force: true });
    expect(exec).toHaveBeenCalledExactlyOnceWith("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", "current-user", "-w"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith("claude", expect.objectContaining({ kind: "session", usedFraction: 0.25 }));
    expect(record).toHaveBeenCalledWith("claude", expect.objectContaining({ kind: "weekly", usedFraction: 0.6 }));
    expect(recordReason).toHaveBeenCalledWith("claude", expect.objectContaining({ kind: "ok" }));
  });

  it.skipIf(process.platform !== "darwin")("uses the OS username when a GUI service has no USER variable", async () => {
    vi.stubEnv("USER", "");
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "os-user-token" } }), code: 0 }));
    expect(await resolveUsageToken(account, { credentials: new CredentialResolver(fakeExec({})), exec })).toEqual({ token: "os-user-token" });
    expect(exec).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w"]);
  });

  it.skipIf(process.platform !== "darwin")("does not fall back to another user's entry when the scoped login is missing", async () => {
    vi.stubEnv("USER", "current-user");
    const exec = vi.fn(async () => ({ stdout: "", code: 44 }));
    expect(await resolveUsageToken(account, { credentials: new CredentialResolver(fakeExec({})), exec })).toMatchObject({ token: null });
    expect(exec).toHaveBeenCalledExactlyOnceWith("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", "current-user", "-w"]);
  });
});
