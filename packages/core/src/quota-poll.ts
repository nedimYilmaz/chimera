import { execFile, spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { Readable, Writable } from "node:stream";
import { resolveCodexBinary } from "./providers/codex-cli-path.js";
export { resolveCodexSdkCliPath } from "./providers/codex-cli-path.js";
import type { AccountConfig, AccountQuotaReason, AccountQuotaWindow } from "@chimera/protocol";
import { implausibleQuotaWindowReason } from "./failover.js";
import type { CredentialResolver, ExecFn } from "./credentials.js";

// ACCOUNT-QUOTA-METERS-PULL: the event path (claude.ts's rate_limit_event -> quotas.record,
// see failover.ts's QuotaTracker doc comment) only fires when the Claude Agent SDK decides to
// report one — empirically, almost never outside of actually being near a limit — so the meter
// sits empty for the entire lifetime of a normal session. This is a PULL source for the SAME
// QuotaTracker: Claude Code's own `/usage` slash command hits `GET /api/oauth/usage` on
// api.anthropic.com (confirmed by a strings scan of the vendored CLI binary — the literal path
// and the `fetchUtilization: GET /api/oauth/usage` log line are both present verbatim — and by
// an actual authenticated GET against it during this feature's development, using this
// machine's real "Claude Code-credentials" keychain item). A real captured response:
//   {"five_hour":{"utilization":1.0,"resets_at":"2026-07-25T04:00:00.459369+00:00",...},
//    "seven_day":{"utilization":20.0,"resets_at":"2026-07-30T10:00:00.459392+00:00",...},
//    "limits":[{"kind":"session","percent":1,...},{"kind":"weekly_all","percent":20,...}],...}
// Cross-referencing `five_hour.utilization` (1.0) against `limits[].percent` (1) for the same
// window PROVES `utilization` is a 0..100 PERCENT, never a 0..1 fraction — settling the open
// question normalizeClaudeRateLimit's doc comment (claude.ts) flagged as unverified for the SDK
// event path, which reports the same provider-side figure under the same field name.
// `resets_at` is an ISO-8601 string (not epoch anything) — parsed via Date.parse below.
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 15_000;

const POLL_WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

// WEEKLY-QUOTA-VARIANT-KEYS: live confirmed 2026-07-30 — a real GET against CLAUDE_USAGE_ENDPOINT
// returns top-level keys beyond five_hour/seven_day (seven_day_opus, seven_day_sonnet,
// seven_day_oauth_apps, and several more that don't map to a quota window at all). This list is
// deliberately an ALLOWLIST matching protocol/src/index.ts's documented rateLimitType enum
// exactly (the same set claude.ts's normalizeClaudeRateLimit already recognizes on the SDK-event
// push path — CLAUDE_QUOTA_WINDOW_MS there) rather than a prefix match on "seven_day*": the live
// response also carries unrelated fields like "seven_day_oauth_apps" that happen to start with
// "seven_day" but are not a quota window, and fabricating a meter reading from those would be
// exactly the "plausible-looking LIE" this file's design explicitly forbids. All variants share
// the same 7-day length; "overage" (a spend-credit concept, not a rolling window) has no place
// in the two-window model and is never matched, same as the SDK path. Value is the short label
// shown in the UI when this variant wins the multi-bucket selection below (null for the plain
// key, which needs no qualifier).
const WEEKLY_VARIANT_LABEL: Record<string, string | null> = {
  seven_day: null,
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
  seven_day_overage_included: "overage included",
};

// QUOTA-ABSENCE-IS-INVISIBLE: the result now carries WHY a failure happened (never just null) so
// the poller can record an honest AccountQuotaReason instead of leaving the account silent. A
// poll miss still never throws across account boundaries and never fabricates a window — only
// the failure's classification changed, not the "leave the tracker at its last known value"
// policy.
export type ClaudeUsageFetchResult =
  | { ok: true; body: Record<string, unknown> }
  // retryAfterMs: parsed from the response's Retry-After header (seconds, per RFC 9110 §10.2.3 —
  // this endpoint has only ever been observed to send the delta-seconds form, never an HTTP-date)
  // when present and finite. Only ever set alongside httpStatus === 429; undefined otherwise or
  // when the header is absent/unparseable, so callers can't accidentally trust a stale value.
  | { ok: false; httpStatus: number; retryAfterMs?: number }   // a real HTTP response, just not 2xx (401/403/429/…)
  | { ok: false; httpStatus?: undefined; error: string };   // never reached a response at all

// GETs CLAUDE_USAGE_ENDPOINT with the same bearer-token auth the CLI itself uses.
export async function fetchClaudeUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<ClaudeUsageFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfterRaw = res.headers?.get?.("retry-after");
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec * 1000 : undefined;
      return { ok: false, httpStatus: res.status, retryAfterMs };
    }
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object") return { ok: true, body: body as Record<string, unknown> };
    return { ok: false, error: "malformed response body" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// A {utilization (0..100 percent), resets_at (ISO-8601)} pair, read defensively off an unknown
// top-level field — returns null (never fabricates) when the field is absent/null or either
// sub-field is missing/mistyped.
function readUsagePollField(w: unknown): { utilization: number; resetsAt: number } | null {
  if (!w || typeof w !== "object") return null;
  const utilization = (w as Record<string, unknown>)["utilization"];
  const resetsAtRaw = (w as Record<string, unknown>)["resets_at"];
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  if (typeof resetsAtRaw !== "string") return null;
  const resetsAt = Date.parse(resetsAtRaw);
  if (!Number.isFinite(resetsAt)) return null;
  return { utilization, resetsAt };
}

type WeeklyCandidate = { usedFraction: number; resetsAt: number; variant: string | null };

// Maps the REST payload's windows onto the SAME AccountQuotaWindow shape the SDK-event path
// produces (failover.ts's QuotaTracker.record upserts by `kind`, so either source can freely top
// up the other). A window absent/null in the response (e.g. an API-key-only account with no
// five_hour figure) is simply skipped — never fabricated.
export function normalizeClaudeUsagePoll(body: Record<string, unknown>): AccountQuotaWindow[] {
  const out: AccountQuotaWindow[] = [];

  // session: five_hour has no documented variant (see WEEKLY_VARIANT_LABEL's comment) — the
  // plain key has always been the only one that needed handling here.
  const session = readUsagePollField(body["five_hour"]);
  if (session) {
    out.push({
      kind: "session",
      usedFraction: Math.min(1, Math.max(0, session.utilization / 100)),
      windowStartedAt: session.resetsAt - POLL_WINDOW_MS.five_hour,
      resetsAt: session.resetsAt,
    });
  }

  // weekly: an account can report SEVERAL buckets at once (e.g. seven_day_opus AND
  // seven_day_sonnet on a plan with model-split weekly limits) — collect every populated one.
  const weeklyCandidates: WeeklyCandidate[] = [];
  for (const [key, variant] of Object.entries(WEEKLY_VARIANT_LABEL)) {
    const parsed = readUsagePollField(body[key]);
    if (parsed) {
      weeklyCandidates.push({ usedFraction: Math.min(1, Math.max(0, parsed.utilization / 100)), resetsAt: parsed.resetsAt, variant });
    }
  }

  // Secondary source, used ONLY when no top-level weekly key was populated: the response's own
  // `limits[]` array, a THIRD naming axis (kind: "weekly_all"/"weekly_scoped"/...) discriminated
  // by `group: "weekly"` rather than a key name. Each entry carries its own resets_at, so this
  // needs no window-length assumption the top-level branch above doesn't already make.
  if (weeklyCandidates.length === 0) {
    const limits = body["limits"];
    if (Array.isArray(limits)) {
      for (const raw of limits) {
        if (!raw || typeof raw !== "object") continue;
        const limit = raw as Record<string, unknown>;
        if (limit["group"] !== "weekly") continue;
        const percent = limit["percent"];
        const resetsAtRaw = limit["resets_at"];
        if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
        if (typeof resetsAtRaw !== "string") continue;
        const resetsAt = Date.parse(resetsAtRaw);
        if (!Number.isFinite(resetsAt)) continue;
        const variant = typeof limit["kind"] === "string" ? (limit["kind"] as string) : null;
        weeklyCandidates.push({ usedFraction: Math.min(1, Math.max(0, percent / 100)), resetsAt, variant });
      }
    }
  }

  // Selection rule when multiple weekly candidates exist at once: show the MOST-CONSTRAINING one
  // (highest utilization) — the meter exists to warn about running out, so understating usage is
  // the wrong failure mode. `variant` records WHICH bucket won so the UI can say so rather than
  // showing an unlabelled percentage that could be misread as blended usage.
  if (weeklyCandidates.length > 0) {
    const winner = weeklyCandidates.reduce((a, b) => (b.usedFraction > a.usedFraction ? b : a));
    out.push({
      kind: "weekly",
      usedFraction: winner.usedFraction,
      windowStartedAt: winner.resetsAt - POLL_WINDOW_MS.seven_day,
      resetsAt: winner.resetsAt,
      ...(winner.variant ? { variant: winner.variant } : {}),
    });
  }

  return out;
}

// QUOTA-FROM-RESPONSE-HEADERS: CLAUDE_USAGE_ENDPOINT throttles per-credential — a busy account
// can sit permanently 429'd there (confirmed live: the same OAuth token that gets 429 with
// Retry-After from the usage endpoint gets HTTP 200 from a real `POST /v1/messages` call, and
// THAT response carries the account's live rate-limit windows in headers). This is a SECOND,
// independent source feeding the same QuotaTracker — used only as a fallback when the usage
// endpoint 429s (see pollAccount), never in place of it. `/v1/messages` is an endpoint this
// system already calls constantly for real agent turns; this adds no new destination, only a
// near-free (max_tokens:1) extra call on the already-throttled credential.
// Real headers observed live against api.anthropic.com/v1/messages (never a token in a header
// name or value — these are the exact keys, values redacted/rounded only where obviously
// account-specific):
//   anthropic-ratelimit-unified-status: allowed
//   anthropic-ratelimit-unified-5h-status: allowed
//   anthropic-ratelimit-unified-5h-reset: 1785241200          (unix EPOCH SECONDS, not ISO)
//   anthropic-ratelimit-unified-5h-utilization: 0.07          (0..1 FRACTION, not 0..100 percent —
//                                                               the opposite convention from the
//                                                               usage endpoint above)
//   anthropic-ratelimit-unified-7d-status: allowed
//   anthropic-ratelimit-unified-7d-reset: 1785405600
//   anthropic-ratelimit-unified-7d-utilization: 0.5
// Deliberately NOT consumed: unified-representative-claim, unified-fallback-percentage,
// unified-reset, unified-overage-status/-reason — none map onto AccountQuotaWindow's
// per-window {kind, usedFraction, windowStartedAt, resetsAt} shape without guessing, so they are
// left unread rather than distorted into it.
export const CLAUDE_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const PROBE_MODEL = "claude-haiku-4-5-20251001";

export type MessagesProbeResult =
  | { ok: true; headers: Headers }
  | { ok: false; httpStatus: number; retryAfterMs?: number }
  | { ok: false; httpStatus?: undefined; error: string };

// POSTs the minimal possible real request (max_tokens:1, one-word prompt) and reads only the
// response headers — the body is never parsed or retained, and the token is never logged.
export async function fetchMessagesRateLimitProbe(token: string, fetchImpl: typeof fetch = fetch): Promise<MessagesProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(CLAUDE_MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfterRaw = res.headers?.get?.("retry-after");
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec * 1000 : undefined;
      return { ok: false, httpStatus: res.status, retryAfterMs };
    }
    return { ok: true, headers: res.headers };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_HEADER_KIND: Record<string, AccountQuotaWindow["kind"]> = {
  "5h": "session",
  "7d": "weekly",
};

// Mirrors normalizeClaudeUsagePoll's "never fabricate" policy: a window whose utilization or
// reset header is missing/unparseable is skipped, not guessed at. Note the header's utilization
// is already a 0..1 fraction (opposite of the usage endpoint's 0..100 percent) and its reset is
// epoch SECONDS (opposite of the usage endpoint's ISO-8601 string) — both converted here.
// WEEKLY-QUOTA-VARIANT-KEYS: audited live 2026-07-30 against both a plain-weekly and a
// multi-bucket account — unlike the JSON usage endpoint, these headers carry NO per-variant
// naming at all (always exactly `unified-7d-*`, regardless of how many weekly buckets the
// account has; `unified-representative-claim` names which window is currently BINDING, e.g.
// "seven_day", but never which bucket, e.g. opus vs sonnet). The fixed 5h/7d mapping below is
// therefore already complete — this fallback path never had the variant-key gap the JSON path
// had, so nothing here needed the same fix.
export function normalizeMessagesRateLimitHeaders(headers: Headers): AccountQuotaWindow[] {
  const out: AccountQuotaWindow[] = [];
  for (const key of ["5h", "7d"] as const) {
    const utilRaw = headers.get(`anthropic-ratelimit-unified-${key}-utilization`);
    const resetRaw = headers.get(`anthropic-ratelimit-unified-${key}-reset`);
    if (utilRaw === null || resetRaw === null) continue;
    const utilization = Number(utilRaw);
    const resetSec = Number(resetRaw);
    if (!Number.isFinite(utilization) || !Number.isFinite(resetSec)) continue;
    const resetsAt = resetSec * 1000;
    const usedFraction = Math.min(1, Math.max(0, utilization));
    out.push({ kind: PROBE_HEADER_KIND[key], usedFraction, windowStartedAt: resetsAt - POLL_WINDOW_MS[key === "5h" ? "five_hour" : "seven_day"], resetsAt });
  }
  return out;
}

// CODEX-QUOTA-APP-SERVER: codex exec's JSONL stream still does not carry account limits, but
// the same CLI exposes a small read-only JSON-RPC method over `codex app-server --stdio`.
// Keeping this as a short-lived status probe avoids changing the agent backend or maintaining
// another daemon: initialize, read one snapshot, terminate. The CLI resolves authentication
// from CODEX_HOME, exactly like the SDK-spawned agent does.
type CodexRateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

type CodexRateLimitSnapshot = {
  primary?: unknown;
  secondary?: unknown;
};

export type CodexRateLimitsFetchResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

type CodexAppServerProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => CodexAppServerProcess;

const realCodexSpawn: CodexAppServerSpawn = (command, args, options) =>
  spawn(command, args, options);

const CODEX_APP_SERVER_TIMEOUT_MS = 15_000;
const CODEX_APP_SERVER_MAX_LINE_BYTES = 1024 * 1024;

export async function fetchCodexRateLimits(
  homeDir?: string,
  deps: {
    spawnImpl?: CodexAppServerSpawn;
    codexPath?: string;
    timeoutMs?: number;
  } = {},
): Promise<CodexRateLimitsFetchResult> {
  return new Promise((resolve) => {
    let child: CodexAppServerProcess;
    try {
      child = (deps.spawnImpl ?? realCodexSpawn)(
        deps.codexPath ?? resolveCodexBinary(),
        ["app-server", "--stdio"],
        {
          env: { ...process.env, ...(homeDir ? { CODEX_HOME: homeDir } : {}) },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      resolve({ ok: false, error: `could not start codex app-server: ${(error as Error).message}` });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: CodexRateLimitsFetchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      resolve(result);
    };
    const fail = (message: string): void => {
      const detail = stderr.trim();
      finish({ ok: false, error: detail ? `${message}: ${detail.slice(-4_096)}` : message });
    };
    const write = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(
      () => fail("codex app-server rate-limit request timed out"),
      deps.timeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS,
    );
    timer.unref?.();

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
    child.stdin.on("error", (error) => fail(`codex app-server stdin failed: ${(error as Error).message}`));
    child.once("error", (error) => fail(`could not start codex app-server: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (!settled) fail(`codex app-server exited before returning rate limits (${signal ?? code ?? "unknown"})`);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > CODEX_APP_SERVER_MAX_LINE_BYTES && !stdout.includes("\n")) {
        fail("codex app-server returned an oversized JSON-RPC line");
        return;
      }

      let newline = stdout.indexOf("\n");
      while (newline !== -1 && !settled) {
        if (newline > CODEX_APP_SERVER_MAX_LINE_BYTES) {
          fail("codex app-server returned an oversized JSON-RPC line");
          return;
        }
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line) continue;

        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail("codex app-server returned a non-object JSON-RPC message");
            return;
          }
          message = parsed as Record<string, unknown>;
        } catch {
          fail("codex app-server returned malformed JSON");
          return;
        }

        if (message["id"] === 1) {
          if (message["error"]) {
            fail(`codex app-server initialize failed: ${JSON.stringify(message["error"])}`);
            return;
          }
          write({ method: "initialized" });
          write({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (message["id"] === 2) {
          if (message["error"]) {
            fail(`codex app-server rate-limit read failed: ${JSON.stringify(message["error"])}`);
            return;
          }
          const result = message["result"];
          if (!result || typeof result !== "object" || Array.isArray(result)) {
            fail("codex app-server returned an invalid rate-limit result");
            return;
          }
          finish({ ok: true, body: result as Record<string, unknown> });
        }
      }
    });

    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "chimera-quota-poller", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

const CODEX_WINDOW_KIND_BY_MINUTES = new Map<number, AccountQuotaWindow["kind"]>([
  [5 * 60, "session"],
  [7 * 24 * 60, "weekly"],
]);

// The app-server intentionally calls these windows primary/secondary rather than
// session/weekly. Their order is not stable across plans (a weekly-only account can expose the
// weekly window as primary), so duration is the only trustworthy discriminator.
export function normalizeCodexRateLimits(body: Record<string, unknown>): AccountQuotaWindow[] {
  const byLimitId = body["rateLimitsByLimitId"];
  const codexBucket = byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)
    ? (byLimitId as Record<string, unknown>)["codex"]
    : undefined;
  const rawSnapshot = codexBucket ?? body["rateLimits"];
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) return [];
  const snapshot = rawSnapshot as CodexRateLimitSnapshot;
  const windows = new Map<AccountQuotaWindow["kind"], AccountQuotaWindow>();

  for (const raw of [snapshot.primary, snapshot.secondary]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const window = raw as CodexRateLimitWindow;
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    if (typeof window.windowDurationMins !== "number" || !Number.isFinite(window.windowDurationMins)) continue;
    if (typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt)) continue;
    const kind = CODEX_WINDOW_KIND_BY_MINUTES.get(window.windowDurationMins);
    if (!kind) continue;
    const resetsAt = window.resetsAt * 1000;
    windows.set(kind, {
      kind,
      usedFraction: Math.min(1, Math.max(0, window.usedPercent / 100)),
      windowStartedAt: resetsAt - window.windowDurationMins * 60_000,
      resetsAt,
    });
  }

  return (["session", "weekly"] as const).flatMap((kind) => {
    const window = windows.get(kind);
    return window ? [window] : [];
  });
}

const realExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => resolve({ stdout: stdout ?? "", code: err ? 1 : 0 }));
  });

// Resolves a bearer token usable against CLAUDE_USAGE_ENDPOINT for one configured account, or
// null when this account has no ambient/stored OAuth-style credential this poller can read:
//   - "keychain" accounts classified oauthToken (D4's `sk-ant-oat01-...` shape, e.g. an account
//     added via accounts.setKey with a pasted `claude setup-token` value) — reuse the SAME
//     CredentialResolver the spawn path already uses, so this is never a second credential store.
//   - plain "subscription" accounts with NO homeDir override — read the CLI's own ambient
//     macOS Keychain item "Claude Code-credentials" directly (the exact mechanism verified live
//     above; darwin-only, matching MacKeychain's existing platform scope in this codebase).
// Deliberately unhandled (returns null, no window emitted, no error thrown):
//   - "subscription" accounts WITH a homeDir override (CLAUDE_CONFIG_DIR set) — the CLI then
//     addresses a DIFFERENT, hash-namespaced Keychain service name it derives internally; that
//     derivation was not independently verified during this work and is not guessed at here.
//   - "keychain" accounts classified apiKey/adminKey, and "env"/"command"/"oauth" auth types —
//     none of these carry Pro/Max-subscription-style rate-limit windows to poll.
//   - non-darwin hosts, for the ambient-keychain "subscription" case.
// QUOTA-ABSENCE-IS-INVISIBLE: every decline path below carries its OWN `detail` string instead
// of collapsing into a single indistinguishable null. Codex does not pass through this Claude
// credential resolver; pollAccount handles its app-server source before reaching this function.
export type UsageTokenResolution = { token: string } | { token: null; detail: string };

export async function resolveUsageToken(
  account: AccountConfig,
  deps: { credentials: CredentialResolver; exec?: ExecFn },
): Promise<UsageTokenResolution> {
  if (account.provider !== "claude") {
    return {
      token: null,
      detail: account.provider === "codex"
        ? "codex quota uses the app-server source, not Claude OAuth usage polling"
        : `provider '${account.provider}' has no known quota API`,
    };
  }
  if (account.auth.type === "keychain") {
    if (account.auth.credentialType !== "oauthToken") {
      return { token: null, detail: `credential type '${account.auth.credentialType}' has no Pro/Max-style rate-limit window to poll` };
    }
    const resolved = await deps.credentials.resolve(account.auth).catch(() => null);
    if (!resolved?.value) return { token: null, detail: "keychain credential could not be resolved" };
    return { token: resolved.value };
  }
  if (account.auth.type === "subscription") {
    if (account.auth.homeDir) {
      return { token: null, detail: "custom home dir override — this account addresses a differently-namespaced keychain entry this poller does not derive" };
    }
    if (process.platform !== "darwin") {
      return { token: null, detail: "ambient-keychain quota polling is only implemented for macOS" };
    }
    const exec = deps.exec ?? realExec;
    // Claude Code selects both service and OS account. A service-only lookup
    // can return an older user's MCP-only entry instead of the active login.
    const username = process.env.USER || userInfo().username;
    const { stdout, code } = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"]);
    if (code !== 0 || !stdout.trim()) {
      return { token: null, detail: "no ambient 'Claude Code-credentials' keychain item found" };
    }
    try {
      const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: unknown } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) return { token };
      return { token: null, detail: "ambient keychain item found but contained no access token" };
    } catch {
      return { token: null, detail: "ambient keychain item found but could not be parsed" };
    }
  }
  return { token: null, detail: `auth type '${account.auth.type}' has no Pro/Max-style rate-limit window to poll` };
}

// EVIDENCE-DRIVEN-UN-COOL: the seam through which a fresh quota reading can END an account's
// cooldown early. Before this, a session-limit hold's duration was decided ONCE from a parsed
// error string and nothing could revise it — observed live, the daemon kept an account cooling
// until 17:10 and its agents parked while a 16:19 poll of that same account showed the session
// window had already rolled (15% used, started 16:10, resets 21:10).
//
// A callback pair rather than a direct CooldownTracker reference on purpose: clearing the stamp
// is only half the fix (the other half is un-parking the agents that were holding for it, which
// only the supervisor can do), and the poller has no business knowing about either. engine.ts
// owns both and wires this closure.
export type CooldownRelief = {
  // Is this account being avoided right now, and would a quota reading be evidence about WHY?
  // `since` is when the cooldown was stamped (the reference point for "the window rolled after we
  // decided to hold") and is null when the account is held with no live stamp — a session-limit
  // pause is persisted on the AgentRecord while CooldownTracker is in-memory, so across a daemon
  // restart the parked agents outlive the stamp entirely. `sessionLimit` false means a plain
  // failover cooldown (an overloaded/RPM 429): quota headroom says NOTHING about that, so it is
  // never relieved from here. Returns null when nothing about this account is held.
  heldState(account: string): { since: number | null; sessionLimit: boolean } | null;
  clear(account: string, evidence: { usedFraction: number; windowStartedAt: number; resetsAt: number; rolled: boolean }): void;
};

export type QuotaPollerDeps = {
  registry: { list(): Array<{ name: string; provider: string }>; get(name: string): AccountConfig };
  credentials: CredentialResolver;
  quotas: { record(account: string, window: AccountQuotaWindow): void; recordReason?(account: string, reason: AccountQuotaReason): void };
  cooldownRelief?: CooldownRelief;
  // Session usage at or above this fraction is NOT headroom — the hold stands. 0.90 (not 1.0)
  // because the provider rejects near, not exactly at, the top of the window, and a reading that
  // close to the limit is no evidence the limit lifted.
  uncoolThresholdFraction?: number;
  // Cadence for an account that is currently held (item 2) — the 10-minute baseline is what made
  // the observed incident last ~50 minutes longer than the quota did.
  coolingIntervalMs?: number;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  fetchCodexRateLimits?: (homeDir?: string) => Promise<CodexRateLimitsFetchResult>;
  now?: () => number;
  // Baseline cadence — how often every quota-capable account gets polled regardless of activity.
  // Default 10 min: the two windows this endpoint reports (5h session / 7d weekly) both move
  // slowly enough that a 10-minute-stale meter is still a faithful "close enough" gauge, and at
  // one request per account per 10 minutes this is nowhere near any plausible rate limit on an
  // account-status endpoint (contrast with the SDK's rate_limit_event, which the daemon has
  // observed NOT fire across an entire multi-agent wave — see this file's header comment).
  intervalMs?: number;
  // Opportunistic top-up floor — pollAccount(name) (called after an agent's turn completes,
  // see supervisor.ts's "result" branch) is a no-op if that account was polled more recently
  // than this, so a burst of agents finishing on the same account within a short window still
  // only costs one real request.
  minPollGapMs?: number;
  log?: (line: string) => void;
};

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_MIN_POLL_GAP_MS = 2 * 60_000;
const DEFAULT_UNCOOL_THRESHOLD = 0.90;
const DEFAULT_COOLING_INTERVAL_MS = 60_000;
// Two consecutive failed polls of a held account and the tight cadence stands down to this. The
// endpoint being unreachable is not a reason to hit it 5x harder than the baseline — and the one
// failure mode that would (a 429 from the usage endpoint itself) is exactly what the tight
// cadence could cause. rateLimitedUntil already floors a 429 at 30 minutes; this covers the rest.
const COOLING_FAILURE_BACKOFF_MS = 5 * 60_000;
const COOLING_FAILURE_STREAK = 2;

// Mirrors HealthMonitor's shape (health.ts): own file, injectable `now`, exposed per-account
// poll for deterministic tests, a single unref'd self-rearming timer for the baseline cadence.
// Feeds the SAME QuotaTracker instance the event path (claude.ts's rate_limit_event handler)
// already writes to — this is a second SOURCE, not a second STORE; whichever of the two last
// wrote a given (account, kind) wins, exactly like two event-path updates would.
export class QuotaPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPolledAt = new Map<string, number>();
  private inflight = new Set<string>();
  // QUOTA-ABSENCE-IS-INVISIBLE: a 429 means the credential is FINE — hammering it on the next
  // baseline tick (or on every opportunistic post-turn call, which ignores minPollGapMs) would
  // just draw more rate limiting. Held separately from lastPolledAt/minPollGapMs so a 429 backs
  // off much harder than the normal debounce, without touching the debounce's own semantics.
  private rateLimitedUntil = new Map<string, number>();
  // EVIDENCE-DRIVEN-UN-COOL: consecutive failed polls per account, reset by any poll that
  // produced a usable answer. Only consulted for the tight held-account cadence.
  private failureStreak = new Map<string, number>();

  constructor(private readonly deps: QuotaPollerDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private intervalMs(): number { return this.deps.intervalMs ?? DEFAULT_INTERVAL_MS; }
  private minPollGapMs(): number { return this.deps.minPollGapMs ?? DEFAULT_MIN_POLL_GAP_MS; }
  private coolingIntervalMs(): number { return this.deps.coolingIntervalMs ?? DEFAULT_COOLING_INTERVAL_MS; }
  private isHeld(account: string): boolean { return this.deps.cooldownRelief?.heldState(account) != null; }

  /** How long this account must wait between polls right now: the tight cadence while it is
   *  held (backed off after two straight failures), the baseline otherwise. */
  private gapFor(account: string): number {
    if (!this.isHeld(account)) return this.intervalMs();
    return (this.failureStreak.get(account) ?? 0) >= COOLING_FAILURE_STREAK
      ? COOLING_FAILURE_BACKOFF_MS
      : this.coolingIntervalMs();
  }

  private noteOutcome(account: string, ok: boolean): void {
    if (ok) this.failureStreak.delete(account);
    else this.failureStreak.set(account, (this.failureStreak.get(account) ?? 0) + 1);
  }

  // EVIDENCE-DRIVEN-UN-COOL: every place a freshly-fetched window reaches the tracker also
  // reaches this — including the 429-probe fallback, which is the path a busy (i.e. likely
  // cooling) account is MOST likely to take.
  private recordWindows(account: string, windows: AccountQuotaWindow[]): void {
    for (const w of windows) this.deps.quotas.record(account, w);
    this.relieveCooldown(account, windows);
  }

  /** Does this reading disprove the account's hold? If so, end it. */
  private relieveCooldown(account: string, windows: AccountQuotaWindow[]): void {
    const relief = this.deps.cooldownRelief;
    if (!relief) return;
    const held = relief.heldState(account);
    if (!held || !held.sessionLimit) return;
    // QUOTA-SANITY-GUARD: a window QuotaTracker itself REFUSES to store (failover.ts's
    // implausibleQuotaWindowReason) must not be allowed to release a hold either. Without this,
    // the exact unit bug that guard exists for — a seconds value read as milliseconds, which
    // lands the window near 1970 — would arrive with a plausible-looking usedFraction and un-cool
    // a genuinely capped account. The tracker's rejection is silent to us here, so the check has
    // to be repeated rather than inferred. Dropped rather than treated as blocking: a rejected
    // window carries no information in EITHER direction.
    const now = this.now();
    const usable = windows.filter((w) => !implausibleQuotaWindowReason(w, now));
    const session = usable.find((w) => w.kind === "session");
    if (!session) return;
    const threshold = this.deps.uncoolThresholdFraction ?? DEFAULT_UNCOOL_THRESHOLD;
    // The hold is on the ACCOUNT, and the account is limited by ALL of its windows. holdUntilReset
    // is reached by any parseable-reset message — including "You've hit your weekly limit" — so
    // 5-hour headroom on a weekly-exhausted account is not evidence the account will accept work.
    // Clearing on the session window alone would resume the agent straight into the weekly
    // rejection, re-park it, and do it again every coolingIntervalMs: a spawn, a failover event
    // and an attempts[] entry per minute, forever.
    if (usable.some((w) => w.kind !== "session" && w.usedFraction >= threshold)) return;
    // The window ROLLED: it began after we decided to hold, so whatever the error string said
    // reset at, that window is already over. Only decidable when there is a live stamp to compare
    // against (see CooldownRelief.since) — with none, headroom is the only available evidence.
    const rolled = held.since !== null && session.windowStartedAt > held.since;
    if (!rolled && session.usedFraction >= threshold) return;
    relief.clear(account, {
      usedFraction: session.usedFraction,
      windowStartedAt: session.windowStartedAt,
      resetsAt: session.resetsAt,
      rolled,
    });
  }

  // Fires an immediate baseline poll of every account (so the meter is populated from
  // the first tick after daemon start, not empty for the first `intervalMs`), then arms the
  // recurring timer. No `events.subscribe` here — the opportunistic top-up is driven by
  // supervisor.ts calling pollAccount() directly where it already has the account name.
  start(): void {
    void this.pollAll();
    this.arm();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  // EVIDENCE-DRIVEN-UN-COOL: with a relief seam wired, the TICK runs at the tight cadence
  // unconditionally and pollAll() decides per account whether this tick is actually its turn.
  // Deciding the tick rate from "is anything cooling right now" instead would leave a hold that
  // began just after a tick waiting most of a baseline interval before the tight cadence even
  // started — which is the same "the decision was made once and never revisited" failure this
  // whole change exists to remove. Without the seam (every pre-existing caller and test) the
  // cadence is byte-identical to before.
  private arm(): void {
    const delay = this.deps.cooldownRelief ? Math.min(this.coolingIntervalMs(), this.intervalMs()) : this.intervalMs();
    const timer = setTimeout(() => { void this.pollAll().finally(() => this.arm()); }, delay);
    timer.unref?.();
    this.timer = timer;
  }

  async pollAll(): Promise<void> {
    const accounts = this.deps.registry.list();
    await Promise.all(accounts.map((a) => (
      // No relief seam ⇒ the original unconditional force, unchanged. With one, the tick fires
      // far more often than the baseline, so each account is gated by its OWN due time instead:
      // held accounts every coolingIntervalMs, everyone else still every intervalMs.
      this.deps.cooldownRelief
        ? this.pollAccount(a.name, { minGapMs: this.gapFor(a.name) })
        : this.pollAccount(a.name, { force: true })
    )));
  }

  // force:true bypasses the minPollGapMs debounce — used by the baseline cadence, which should
  // always actually poll. The opportunistic call site (supervisor.ts) omits it, so a same-account
  // burst of turn-completions only re-polls once the gap has elapsed. minGapMs overrides which
  // gap that is (pollAll's per-account cadence); force still wins over both.
  async pollAccount(name: string, opts: { force?: boolean; minGapMs?: number } = {}): Promise<void> {
    if (this.inflight.has(name)) return;
    // A 429 backoff applies regardless of force — the baseline cadence must not override it,
    // or the "back off" behavior it exists for never actually happens.
    if ((this.rateLimitedUntil.get(name) ?? 0) > this.now()) return;
    if (!opts.force) {
      const last = this.lastPolledAt.get(name) ?? 0;
      if (this.now() - last < (opts.minGapMs ?? this.minPollGapMs())) return;
    }
    this.inflight.add(name);
    try {
      this.lastPolledAt.set(name, this.now());
      const account = this.deps.registry.get(name);
      if (account.provider === "codex") {
        if (account.auth.type !== "subscription") {
          this.deps.quotas.recordReason?.(name, {
            kind: "unsupported",
            detail: `codex auth type '${account.auth.type}' has no subscription rate-limit window`,
            at: this.now(),
          });
          this.noteOutcome(name, true);   // a permanent classification, not a transient failure
          return;
        }
        const result = await (this.deps.fetchCodexRateLimits ?? fetchCodexRateLimits)(account.auth.homeDir);
        if (!result.ok) {
          this.deps.quotas.recordReason?.(name, { kind: "network_error", detail: result.error, at: this.now() });
          this.noteOutcome(name, false);
          return;
        }
        const windows = normalizeCodexRateLimits(result.body);
        this.recordWindows(name, windows);
        this.noteOutcome(name, true);
        this.deps.quotas.recordReason?.(
          name,
          windows.length > 0 ? { kind: "ok", at: this.now() } : { kind: "empty", at: this.now() },
        );
        return;
      }
      const resolution = await resolveUsageToken(account, { credentials: this.deps.credentials, exec: this.deps.exec });
      if (resolution.token === null) {
        this.deps.quotas.recordReason?.(name, { kind: "unsupported", detail: resolution.detail, at: this.now() });
        this.noteOutcome(name, true);   // a permanent classification, not a transient failure
        return;
      }
      const result = await fetchClaudeUsage(resolution.token, this.deps.fetchImpl ?? fetch);
      if (!result.ok) {
        if (result.httpStatus === 429) {
          // Prefer the server's own Retry-After when it sent one — it's the authoritative
          // signal for when THIS credential's throttle actually clears. Still floored at the
          // same 30-minute minimum as the fallback heuristic, so a surprisingly short
          // Retry-After can never turn this into a fast retry loop. Falls back to "six
          // intervals, floored at 30 minutes" (the original heuristic) only when the header is
          // absent or unparseable.
          const backoffMs = Math.max(result.retryAfterMs ?? this.intervalMs() * 6, 30 * 60_000);
          const nextRetryAt = this.now() + backoffMs;
          this.rateLimitedUntil.set(name, nextRetryAt);
          this.deps.quotas.recordReason?.(name, { kind: "rate_limited", httpStatus: 429, at: this.now(), nextRetryAt });
          // QUOTA-FROM-RESPONSE-HEADERS: the usage endpoint's 429 is exactly the case this
          // fallback exists for — the busiest accounts are the ones the usage endpoint throttles
          // hardest, so this is the credential most in need of a reading. The probe's OWN 429
          // (if it happens) is left alone here — it does not touch rateLimitedUntil again or
          // recurse, so a doubly-throttled credential still only backs off once per poll tick.
          const probe = await fetchMessagesRateLimitProbe(resolution.token, this.deps.fetchImpl ?? fetch);
          if (probe.ok) {
            const windows = normalizeMessagesRateLimitHeaders(probe.headers);
            this.recordWindows(name, windows);
            if (windows.length > 0) this.deps.quotas.recordReason?.(name, { kind: "ok", at: this.now() });
          }
          this.noteOutcome(name, probe.ok);
        } else if (result.httpStatus !== undefined) {
          this.deps.quotas.recordReason?.(name, { kind: "http_error", httpStatus: result.httpStatus, at: this.now() });
          this.noteOutcome(name, false);
        } else {
          this.deps.quotas.recordReason?.(name, { kind: "network_error", detail: result.error, at: this.now() });
          this.noteOutcome(name, false);
        }
        return;
      }
      this.rateLimitedUntil.delete(name);
      const windows = normalizeClaudeUsagePoll(result.body);
      this.recordWindows(name, windows);
      this.noteOutcome(name, true);
      this.deps.quotas.recordReason?.(name, windows.length > 0 ? { kind: "ok", at: this.now() } : { kind: "empty", at: this.now() });
    } catch (err) {
      this.noteOutcome(name, false);
      this.deps.log?.(`chimerad: quota poll failed for account ${name}: ${(err as Error).message}`);
    } finally {
      this.inflight.delete(name);
    }
  }
}
