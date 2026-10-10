import { describe, it, expect } from "vitest";
import { FailureCauseSchema, FailureDispositionSchema } from "@chimera/protocol";
import { classifyFailure, dispositionFor } from "@chimera/core/failover";
import { classifyError, parseSessionLimit, CooldownTracker, QuotaTracker, computeBackoffMs, DEFAULT_CRASH_LOOP_POLICY, implausibleQuotaWindowReason, type CrashLoopPolicy } from "@chimera/core/failover";

// QUOTA-SANITY-GUARD tests below use realistic post-2020 epoch-ms timestamps throughout — the
// old `resetsAt: 100`/`windowStartedAt: 0` style values used pre-guard are themselves exactly the
// kind of implausible (near-1970) value the guard now rejects.
const BASE = Date.UTC(2026, 0, 1);

describe("classifyError", () => {
  it.each([
    ["HTTP 429 Too Many Requests", "rate-limit"],
    ["Overloaded, please retry", "rate-limit"],
    ["You have hit your usage limit until 5pm", "rate-limit"],
    ["You've hit your session limit · resets 8:20pm", "rate-limit"],   // session-limit joins the rate-limit family
    ["Quota exceeded for this billing period", "rate-limit"],
    ["API rate limit reached", "rate-limit"],           // /rate limit/i (distinct from "usage limit")
    ["You've hit your weekly limit · resets 1pm (Europe/Istanbul)", "rate-limit"],   // WEEKLY-LIMIT-NO-FAILOVER: exact observed string
    ["You've hit your weekly limit, try again later", "rate-limit"],   // bare "weekly limit" alone, no reset clause
    ["authentication_error: invalid x-api-key", "credential"],
    ["OAuth token has expired", "credential"],
    ["HTTP 401 Unauthorized", "credential"],             // /\b401\b/i
    ["invalid api key provided", "credential"],          // /invalid api key/i
    ["process exited with code 1", "backend-crash"],
    ["stream closed unexpectedly", "backend-crash"],     // /stream (broken|closed)/i
    ["read ECONNRESET", "backend-crash"],                // /ECONNRESET/i
    ["turn timed out (idle): backend hang detected, no forward progress", "backend-crash"],   // R2-TURN-LIFECYCLE
    ["socket hang up", "unknown"],
    // precedence: each matches two families; the earlier family must win (order matters, spec §7)
    ["429 during authentication", "rate-limit"],         // RATE beats CRED
    ["process exited: invalid api key", "credential"],   // CRED beats CRASH
    // WEEKLY-LIMIT-NO-FAILOVER guard: "monthly"/"daily" were deliberately NOT added as bare RATE
    // entries (unconfirmed Claude windows) — an unrelated error that happens to contain "monthly
    // limit" without the "hit your ___ limit" clause must stay unknown, not silently retried
    // elsewhere as if it were rate-limit-recoverable.
    ["Deployment failed: exceeded your monthly limit of API calls to a third-party billing service", "unknown"],
  ])("%s -> %s", (msg, cls) => expect(classifyError(msg)).toBe(cls));
});

describe("parseSessionLimit (detection + reset-time parse)", () => {
  // Fixed reference clock so wall-clock parsing is deterministic (no dependency on real time),
  // while staying timezone-agnostic (assertions read the resolved instant back in LOCAL time).
  const NOW = new Date(2026, 6, 14, 10, 0, 0).getTime();   // 2026-07-14 10:00 local

  it("returns null for a non-session error (plain 429/overloaded) — falls back to failover", () => {
    expect(parseSessionLimit("HTTP 429 Too Many Requests", NOW)).toBeNull();
    expect(parseSessionLimit("Overloaded, please retry", NOW)).toBeNull();
  });

  it("returns null for a session limit with NO parseable reset time (defensive fallback)", () => {
    expect(parseSessionLimit("You've hit your session limit, try later", NOW)).toBeNull();
  });

  it("parses a same-day wall-clock reset (8:20pm) as the next such instant after now", () => {
    const r = parseSessionLimit("You've hit your session limit · resets 8:20pm", NOW);
    expect(r).not.toBeNull();
    const d = new Date(r!.resetAt);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(20);
    expect(r!.resetAt).toBeGreaterThan(NOW);              // later today (20:20 > 10:00)
  });

  it("rolls a wall-clock reset that already passed today to tomorrow", () => {
    const r = parseSessionLimit("session limit — resets 9:00am", NOW);   // 09:00 < 10:00 now
    expect(r).not.toBeNull();
    expect(r!.resetAt).toBeGreaterThan(NOW);
    expect(r!.resetAt - NOW).toBeGreaterThan(20 * 60 * 60 * 1000);        // ~23h out, not in the past
  });

  it("parses a 24h wall-clock reset (no am/pm)", () => {
    const r = parseSessionLimit("usage limit reached; resets 20:20", NOW);
    expect(new Date(r!.resetAt).getHours()).toBe(20);
  });

  it("parses an absolute ISO-8601 reset verbatim", () => {
    const iso = "2026-07-14T20:20:00.000Z";
    const r = parseSessionLimit(`session limit · resets at ${iso}`, NOW);
    expect(r!.resetAt).toBe(Date.parse(iso));
  });

  it("parses a bare epoch reset (seconds and milliseconds)", () => {
    expect(parseSessionLimit("session limit resets 1799999999", NOW)!.resetAt).toBe(1799999999 * 1000);
    expect(parseSessionLimit("session limit resets 1799999999000", NOW)!.resetAt).toBe(1799999999000);
  });

  it("still parses when the message has a trailing newline or trailing text (no end-anchor)", () => {
    expect(parseSessionLimit("You've hit your session limit · resets 8:20pm\n", NOW)).not.toBeNull();
    expect(new Date(parseSessionLimit("session limit — resets 8:20pm\n(all times PT)", NOW)!.resetAt).getHours()).toBe(20);
  });

  it("parses a bare hour with am/pm and no minutes (8pm)", () => {
    expect(new Date(parseSessionLimit("session limit · resets 8pm", NOW)!.resetAt).getHours()).toBe(20);
  });

  it("rejects a bare number with neither minutes nor am/pm (ambiguous ⇒ null)", () => {
    expect(parseSessionLimit("session limit resets 8", NOW)).toBeNull();
  });

  it("rejects out-of-range wall-clock times (defensive ⇒ null, not a bogus future instant)", () => {
    expect(parseSessionLimit("session limit resets 25:99", NOW)).toBeNull();
    expect(parseSessionLimit("session limit resets 13:00pm", NOW)).toBeNull();   // pm with hour>12
  });

  it("is not shadowed by an unrelated earlier 'reset' word in the message", () => {
    const r = parseSessionLimit("password reset link expired; you've hit your session limit, resets 8:20pm", NOW);
    expect(new Date(r!.resetAt).getHours()).toBe(20);
  });

  it("handles the 12am/12pm boundary correctly", () => {
    expect(new Date(parseSessionLimit("session limit resets 12:00am", NOW)!.resetAt).getHours()).toBe(0);
    expect(new Date(parseSessionLimit("session limit resets 12:00pm", NOW)!.resetAt).getHours()).toBe(12);
  });

  // WEEKLY-LIMIT-NO-FAILOVER: the EXACT string observed live, verbatim including the "·"
  // separator and the trailing "(Europe/Istanbul)" — a paraphrase would not prove the real case.
  it("parses the exact observed weekly-limit message, reset at the next 1pm", () => {
    const r = parseSessionLimit("You've hit your weekly limit · resets 1pm (Europe/Istanbul)", NOW);
    expect(r).not.toBeNull();
    const d = new Date(r!.resetAt);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(0);
    expect(r!.resetAt).toBeGreaterThan(NOW);   // 1pm is later than the 10:00 reference clock -> today
  });
});

describe("CooldownTracker", () => {
  it("stampUntil cools an account until a specific timestamp (session-limit HOLD)", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    c.stampUntil("acct", 5000);
    expect(c.isCooling("acct")).toBe(true);
    t = 4999; expect(c.isCooling("acct")).toBe(true);
    t = 5000; expect(c.isCooling("acct")).toBe(false);   // strict '>' — released at the boundary
  });
  it("cools an account for exactly the window", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    expect(c.isCooling("second")).toBe(false);
    c.stamp("second");
    expect(c.isCooling("second")).toBe(true);
    t += 59_999; expect(c.isCooling("second")).toBe(true);
    t += 2;      expect(c.isCooling("second")).toBe(false);
  });
  it("is released exactly at cooldownMs, not one tick later (window is exclusive at the boundary)", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    c.stamp("acct");
    t = 1000 + 60_000;                          // now() === until (the only point that distinguishes '>' from '>=')
    expect(c.isCooling("acct")).toBe(false);    // strict '>' => released at the boundary
  });
  it("setCooldownMs changes the window for FUTURE stamps (D7 failoverCooldownMinutes hot-reload)", () => {
    let t = 1000;
    const c = new CooldownTracker(30 * 60_000, () => t);
    expect(c.windowMs).toBe(30 * 60_000);
    c.setCooldownMs(60_000);                     // operator shortens the failover cooldown live
    expect(c.windowMs).toBe(60_000);
    c.stamp("acct");                             // next stamp uses the NEW 1-minute window
    t += 60_001;
    expect(c.isCooling("acct")).toBe(false);     // released after 1 min, not the boot-time 30
  });
  it("setCooldownMs leaves an ALREADY-stamped absolute deadline untouched", () => {
    let t = 1000;
    const c = new CooldownTracker(30 * 60_000, () => t);
    c.stamp("acct");                             // deadline = 1000 + 30min (absolute)
    c.setCooldownMs(60_000);                     // shorten AFTER stamping
    t += 60_001;
    expect(c.isCooling("acct")).toBe(true);      // still cooling — the prior deadline is absolute
  });

  // QUOTA-UNCOOL: the map had no way to end a hold early — stampUntil's deadline came from a
  // parsed error string and outlived any later evidence that it was wrong.
  it("clear() ends a cooldown early and reports the deadline it dropped", () => {
    let t = 1000;
    const c = new CooldownTracker(30 * 60_000, () => t);
    c.stampUntil("acct", t + 60 * 60_000);
    expect(c.isCooling("acct")).toBe(true);

    expect(c.clear("acct")).toBe(1000 + 60 * 60_000);
    expect(c.isCooling("acct")).toBe(false);
    expect(c.snapshot()).toEqual([]);
  });

  it("clear() on an account that is not cooling returns null and changes nothing", () => {
    const c = new CooldownTracker(60_000, () => 1000);
    expect(c.clear("never-stamped")).toBeNull();
  });

  it("stampFor reports WHEN and WHY an account was cooled, and expires with the deadline", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    c.stamp("acct");
    expect(c.stampFor("acct")).toEqual({ until: 61_000, stampedAt: 1000, kind: "failover" });

    t += 10;
    c.stampUntil("acct", 500_000);
    // kind is what keeps quota-driven relief off a plain overloaded/RPM 429 cooldown.
    expect(c.stampFor("acct")).toEqual({ until: 500_000, stampedAt: 1010, kind: "session-limit" });

    t = 500_001;
    expect(c.stampFor("acct")).toBeNull();       // past the deadline: no live stamp to reason about
  });
});

describe("computeBackoffMs (R2: crash-loop backoff policy)", () => {
  const policy: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };

  it("attempt 1 returns baseDelayMs unchanged", () => {
    expect(computeBackoffMs(policy, 1)).toBe(100);
  });

  it("doubles per consecutive attempt", () => {
    expect(computeBackoffMs(policy, 2)).toBe(200);
    expect(computeBackoffMs(policy, 3)).toBe(400);
    expect(computeBackoffMs(policy, 4)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoffMs(policy, 5)).toBe(1_000);   // would be 1600 uncapped
    expect(computeBackoffMs(policy, 10)).toBe(1_000);
  });

  it("DEFAULT_CRASH_LOOP_POLICY: attempt 1 is baseDelayMs, capped at maxDelayMs eventually", () => {
    expect(computeBackoffMs(DEFAULT_CRASH_LOOP_POLICY, 1)).toBe(DEFAULT_CRASH_LOOP_POLICY.baseDelayMs);
    expect(computeBackoffMs(DEFAULT_CRASH_LOOP_POLICY, 20)).toBe(DEFAULT_CRASH_LOOP_POLICY.maxDelayMs);
  });
});

// ACCOUNT-QUOTA-METERS: mirrors CooldownTracker's injectable-clock test style above.
describe("QuotaTracker", () => {
  it("get() returns undefined for an account with no recorded window (never a fabricated quota)", () => {
    expect(new QuotaTracker().get("acct")).toBeUndefined();
  });

  it("record() upserts by window kind — a later 'weekly' record does not clobber 'session'", () => {
    let t = BASE;
    const tracker = new QuotaTracker(() => t);
    tracker.record("acct", { kind: "session", usedFraction: 0.2, windowStartedAt: BASE - 1000, resetsAt: BASE + 100 });
    t = BASE + 1;
    tracker.record("acct", { kind: "weekly", usedFraction: 0.5, windowStartedAt: BASE - 2000, resetsAt: BASE + 200 });
    const q = tracker.get("acct")!;
    expect(q.windows).toHaveLength(2);
    expect(q.windows.find((w) => w.kind === "session")).toEqual({ kind: "session", usedFraction: 0.2, windowStartedAt: BASE - 1000, resetsAt: BASE + 100 });
    expect(q.windows.find((w) => w.kind === "weekly")).toEqual({ kind: "weekly", usedFraction: 0.5, windowStartedAt: BASE - 2000, resetsAt: BASE + 200 });
  });

  it("record() REPLACES the same window kind on a later update", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("acct", { kind: "session", usedFraction: 0.2, windowStartedAt: BASE - 1000, resetsAt: BASE + 100 });
    tracker.record("acct", { kind: "session", usedFraction: 0.9, windowStartedAt: BASE - 1000, resetsAt: BASE + 200 });
    expect(tracker.get("acct")!.windows).toEqual([{ kind: "session", usedFraction: 0.9, windowStartedAt: BASE - 1000, resetsAt: BASE + 200 }]);
  });

  it("fetchedAt is the wall-clock of the LAST record(), not read time — staleness is honestly observable", () => {
    let t = BASE;
    const tracker = new QuotaTracker(() => t);
    tracker.record("acct", { kind: "session", usedFraction: 0.1, windowStartedAt: BASE - 1000, resetsAt: BASE + 100 });
    t = BASE + 999_999;   // time passes with no further update
    expect(tracker.get("acct")!.fetchedAt).toBe(BASE);
  });

  it("snapshot() lists every account with at least one recorded window", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("a", { kind: "session", usedFraction: 0.1, windowStartedAt: BASE - 1000, resetsAt: BASE + 1 });
    tracker.record("b", { kind: "weekly", usedFraction: 0.2, windowStartedAt: BASE - 1000, resetsAt: BASE + 1 });
    expect(tracker.snapshot().map((q) => q.account).sort()).toEqual(["a", "b"]);
  });

  it("accounts stay isolated — recording for one account never touches another's windows", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("a", { kind: "session", usedFraction: 0.1, windowStartedAt: BASE - 1000, resetsAt: BASE + 1 });
    expect(tracker.get("b")).toBeUndefined();
  });
});

// QUOTA-SANITY-GUARD: the incident this guard exists for — a resetsAt/windowStartedAt that
// resolves outside a plausible epoch-ms range is provable evidence of a unit-conversion bug
// upstream (seconds propagated where milliseconds were expected, or vice versa), not a real
// reading. See claude.ts's QUOTA-METER-WRONG-BY-100X for the live incident.
describe("implausibleQuotaWindowReason", () => {
  it("accepts a well-formed, realistic window", () => {
    expect(implausibleQuotaWindowReason({ kind: "session", usedFraction: 0.5, windowStartedAt: BASE - 60_000, resetsAt: BASE }, BASE)).toBeNull();
  });

  it("rejects a resetsAt that resolves to ~1970 — the seconds-read-as-ms signature", () => {
    // The actual live incident value: a real SDK resetsAt of 1_787_015_400 (seconds) propagated
    // as if it were already milliseconds.
    const reason = implausibleQuotaWindowReason({ kind: "session", usedFraction: 0.0094, windowStartedAt: 1_769_015_400, resetsAt: 1_787_015_400 }, BASE);
    expect(reason).toMatch(/before 2020/);
  });

  it("rejects a resetsAt more than a year in the future — the ms-read-as-seconds signature", () => {
    const reason = implausibleQuotaWindowReason({ kind: "session", usedFraction: 0.5, windowStartedAt: BASE, resetsAt: BASE + 1000 * 366 * 24 * 60 * 60 * 1000 }, BASE);
    expect(reason).toMatch(/more than a year in the future/);
  });

  it("rejects windowStartedAt after resetsAt — internally inconsistent regardless of epoch", () => {
    const reason = implausibleQuotaWindowReason({ kind: "session", usedFraction: 0.5, windowStartedAt: BASE + 1000, resetsAt: BASE }, BASE);
    expect(reason).toMatch(/after resetsAt/);
  });
});

describe("QuotaTracker: implausible windows are rejected, not propagated", () => {
  it("record() drops an implausible window and records an 'implausible' reason instead of storing it", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("claude-pers", { kind: "session", usedFraction: 0.0094, windowStartedAt: 1_769_015_400, resetsAt: 1_787_015_400 });
    expect(tracker.get("claude-pers")).toBeUndefined();
    const reason = tracker.getReason("claude-pers");
    expect(reason?.kind).toBe("implausible");
    expect(reason?.detail).toMatch(/before 2020/);
  });

  it("record() keeps the LAST KNOWN GOOD window when a later update is implausible — never overwrites good data with garbage", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("acct", { kind: "session", usedFraction: 0.96, windowStartedAt: BASE - 60_000, resetsAt: BASE + 60_000 });
    tracker.record("acct", { kind: "session", usedFraction: 0.0094, windowStartedAt: 1_769_015_400, resetsAt: 1_787_015_400 });
    expect(tracker.get("acct")!.windows).toEqual([{ kind: "session", usedFraction: 0.96, windowStartedAt: BASE - 60_000, resetsAt: BASE + 60_000 }]);
    expect(tracker.getReason("acct")?.kind).toBe("implausible");
  });

  it("record() still accepts a genuinely plausible window", () => {
    const tracker = new QuotaTracker(() => BASE);
    tracker.record("acct", { kind: "session", usedFraction: 0.96, windowStartedAt: BASE - 60_000, resetsAt: BASE + 60_000 });
    expect(tracker.get("acct")!.windows).toEqual([{ kind: "session", usedFraction: 0.96, windowStartedAt: BASE - 60_000, resetsAt: BASE + 60_000 }]);
  });
});

// BARE-LIMIT-NO-FAILOVER: observed live on a conductor — "You've hit your limit · resets 4:10am
// (Europe/Istanbul)" carries NO window word. It previously matched neither RATE nor
// SESSION_LIMIT, so it classified "unknown": no failover, and no parseable reset to HOLD on
// either. The agent simply stalled on a capped account until a human noticed.
describe("BARE-LIMIT-NO-FAILOVER: a limit with no window word", () => {
  const BARE = "You've hit your limit · resets 4:10am (Europe/Istanbul)";

  it("classifies as rate-limit so it reaches failover", () => {
    expect(classifyError(BARE)).toBe("rate-limit");
  });

  it("parses its reset time so the HOLD path can pause until then", () => {
    expect(parseSessionLimit(BARE, Date.parse("2026-08-03T00:00:00+03:00"))).not.toBeNull();
  });

  it("still classifies the windowed variants (no regression)", () => {
    expect(classifyError("You've hit your session limit · resets 11:30am (Europe/Istanbul)")).toBe("rate-limit");
    expect(classifyError("You've hit your weekly limit · resets 1pm (Europe/Istanbul)")).toBe("rate-limit");
  });

  it("does not swallow an unrelated failure that merely mentions a limit", () => {
    expect(classifyError("exceeded the configured retry limit for this step")).not.toBe("rate-limit");
  });
});

// FAILURE-DISPOSITION: every fixture the single classifier is expected to handle, in one place —
// the legacy classifyError rows (which must keep their exact classes) plus the failure shapes the
// harness actually observed in the field. Both the equivalence proof and the evidence-leak check
// are driven off this list so a new fixture is automatically covered by both.
const FIXTURES: Array<{ msg: string; cause: string; errorClass: string }> = [
  // legacy classifyError rows — same messages, now asserted through the disposition
  { msg: "HTTP 429 Too Many Requests", cause: "provider-rate-limit", errorClass: "rate-limit" },
  { msg: "Overloaded, please retry", cause: "provider-rate-limit", errorClass: "rate-limit" },
  { msg: "You have hit your usage limit until 5pm", cause: "account-cap", errorClass: "rate-limit" },
  { msg: "You've hit your session limit · resets 8:20pm", cause: "account-cap", errorClass: "rate-limit" },
  { msg: "Quota exceeded for this billing period", cause: "account-cap", errorClass: "rate-limit" },
  { msg: "API rate limit reached", cause: "provider-rate-limit", errorClass: "rate-limit" },
  { msg: "You've hit your weekly limit · resets 1pm (Europe/Istanbul)", cause: "account-cap", errorClass: "rate-limit" },
  { msg: "authentication_error: invalid x-api-key", cause: "credential", errorClass: "credential" },
  { msg: "OAuth token has expired", cause: "credential", errorClass: "credential" },
  { msg: "HTTP 401 Unauthorized", cause: "credential", errorClass: "credential" },
  { msg: "invalid api key provided", cause: "credential", errorClass: "credential" },
  { msg: "process exited with code 1", cause: "transient-network", errorClass: "backend-crash" },
  { msg: "stream closed unexpectedly", cause: "transient-network", errorClass: "backend-crash" },
  { msg: "read ECONNRESET", cause: "transient-network", errorClass: "backend-crash" },
  { msg: "turn timed out (idle): backend hang detected, no forward progress", cause: "transient-network", errorClass: "backend-crash" },
  { msg: "socket hang up", cause: "unclassified", errorClass: "unknown" },
  { msg: "429 during authentication", cause: "provider-rate-limit", errorClass: "rate-limit" },
  { msg: "process exited: invalid api key", cause: "credential", errorClass: "credential" },
  { msg: "Deployment failed: exceeded your monthly limit of API calls to a third-party billing service", cause: "unclassified", errorClass: "unknown" },
  // bad-request family — every BAD_REQUEST row, including the literal string generic.ts emits
  { msg: "invalid_request_error: messages.0.content is required", cause: "bad-request", errorClass: "protocol" },
  { msg: "HTTP 400 Bad Request", cause: "bad-request", errorClass: "protocol" },
  { msg: "prompt is too long: 250000 tokens > 200000 maximum", cause: "bad-request", errorClass: "protocol" },
  { msg: "request blocked by safety filters", cause: "bad-request", errorClass: "protocol" },
  { msg: "unknown model: claude-nonexistent-1", cause: "bad-request", errorClass: "protocol" },
  { msg: 'provider "openai" does not support image input (text-only API)', cause: "bad-request", errorClass: "protocol" },
  // precedence: a bad-request phrase never outranks a cap or a credential problem
  { msg: "invalid_request_error: stream closed", cause: "bad-request", errorClass: "protocol" },
  { msg: "quota exceeded: invalid_request_error", cause: "account-cap", errorClass: "rate-limit" },
  { msg: "401: invalid_request_error", cause: "credential", errorClass: "credential" },
  // a bare status code inside unrelated prose must NOT read as bad-request (R1)
  { msg: "prompt used 400 tokens", cause: "unclassified", errorClass: "unknown" },
  // observed harness shapes that deliberately have NO rule — they stay inert rather than being
  // guessed at; see openItems in the F08.0 report
  { msg: "Internal error", cause: "unclassified", errorClass: "unknown" },
  // still unclassified: this is NOT the literal phrase generic.ts emits (see the real one below),
  // so it must keep falling through rather than being guessed at.
  { msg: "finish_reason=length: response truncated", cause: "unclassified", errorClass: "unknown" },
  { msg: "fatal: Unable to create '.git/index.lock': File exists.", cause: "unclassified", errorClass: "unknown" },
  { msg: "Test timed out in 5000ms.", cause: "unclassified", errorClass: "unknown" },
  // F08.QA-FIX item 2: HTTP 403 is now a credential-class failure — a permission rejection, not a
  // transient one, so it must not burn retries.
  { msg: "HTTP 403 Forbidden", cause: "credential", errorClass: "credential" },
  // F08.QA-FIX item 2: the exact one-shot truncation phrase generic.ts emits.
  {
    msg: "output truncated at 4096 tokens (finish_reason: length) -- the model's response was cut off mid-generation",
    cause: "output-truncated",
    errorClass: "backend-crash",
  },
  // F08.QA-FIX item 2: both claude.ts's and codex.ts's structured-output-validation-failed texts
  // must classify identically — they share the substring the BAD_REQUEST rule matches on.
  {
    msg: "structured output validation failed: model could not produce a result matching resultSchema after the SDK's own retries",
    cause: "bad-request",
    errorClass: "protocol",
  },
  { msg: "structured output validation failed against resultSchema (missing field \"foo\")", cause: "bad-request", errorClass: "protocol" },
  // CONTEXT-OVERFLOW: codex-rpc.ts's inbound (stdout) and outbound (stdin) JSONL frame guards emit
  // the same core phrase, the outbound one with a " (outbound)" suffix — both must classify alike.
  { msg: "Codex app-server JSONL frame exceeded 16 MiB", cause: "provider-stream", errorClass: "backend-crash" },
  { msg: "Codex app-server JSONL frame exceeded 16 MiB (outbound)", cause: "provider-stream", errorClass: "backend-crash" },
  { msg: "Claude Code returned an error result: Autocompact is thrashing: the context refilled to the limit within 3 turns", cause: "context-overflow", errorClass: "backend-crash" },
];

// The rule names are re-declared here on purpose: an independent oracle catches an evidence
// string that starts leaking provider text, which asserting against the exported tables would not.
const RULE_NAMES = new Set([
  "usage limit", "session limit", "weekly limit", "hit your limit", "quota",
  "429", "rate limit", "overloaded",
  "authentication", "401", "invalid api key", "invalid x-api-key", "oauth token", "403 forbidden",
  "invalid_request_error", "400 bad request", "context length exceeded", "content policy", "model not found", "unsupported input", "structured output validation failed",
  "process exited", "exited with code", "stream fault", "ECONNRESET", "turn timed out",
  "kimi-internal-error-phase", "output truncated", "no pattern matched",
  "JSONL frame exceeded",
  "autocompact thrashing",
]);

describe("classifyFailure (single classifier + disposition table)", () => {
  it("classifies model saturation without changing accounts or models", () => {
    expect(classifyFailure("Selected model is at capacity. Please try a different model.")).toMatchObject({
      cause: "provider-capacity", retryable: true, restartInPlace: true, failoverAccount: false, holdForReset: false,
    });
    expect(classifyFailure("disk is at capacity").cause).toBe("unclassified");
  });
  it("classifies malformed SDK frames without matching arbitrary payload words", () => {
    expect(classifyFailure('Failed to parse item: {"command":"echo quota 401')).toMatchObject({
      cause: "provider-stream", retryable: true, restartInPlace: true, failoverAccount: false,
    });
    expect(classifyFailure("incomplete frame", { phase: "codex-exec-jsonl" }).cause).toBe("provider-stream");
  });
  it("the disposition table covers every FailureCause and nothing else", () => {
    for (const cause of FailureCauseSchema.options) {
      const d = dispositionFor(cause, "t", 0);
      expect(d.cause).toBe(cause);
      expect(() => FailureDispositionSchema.parse(d)).not.toThrow();
    }
  });

  it.each(FIXTURES.map((f) => [f.msg, f.cause, f.errorClass] as const))(
    "%s -> %s",
    (msg, cause, errorClass) => {
      const d = classifyFailure(msg);
      expect(d.cause).toBe(cause);
      expect(d.errorClass).toBe(errorClass);
    },
  );

  it("classifyError stays exactly classifyFailure(...).errorClass for every fixture", () => {
    for (const f of FIXTURES) expect(classifyError(f.msg)).toBe(classifyFailure(f.msg).errorClass);
  });

  it("evidence always names a rule, never the provider message", () => {
    for (const f of FIXTURES) {
      const { evidence } = classifyFailure(f.msg);
      expect(RULE_NAMES.has(evidence), `${f.msg} -> ${evidence}`).toBe(true);
    }
  });

  it("every disposition round-trips the strict protocol schema", () => {
    for (const f of FIXTURES) expect(() => FailureDispositionSchema.parse(classifyFailure(f.msg))).not.toThrow();
  });

  it("a named cap and a bare 429 share an errorClass but not a disposition", () => {
    const cap = classifyFailure("You've hit your weekly limit · resets 1pm");
    const throttle = classifyFailure("HTTP 429 Too Many Requests");
    expect(cap.errorClass).toBe(throttle.errorClass);
    expect([cap.holdForReset, cap.retryable]).toEqual([true, false]);
    expect([throttle.holdForReset, throttle.retryable]).toEqual([false, true]);
    expect(cap.failoverAccount && throttle.failoverAccount).toBe(true);
  });

  it("a handshake-phase failure is transient-network whatever the message says", () => {
    // KIMI-HANDSHAKE-CRASH-PARITY: the provider's text ("Internal error") carries no signal.
    const d = classifyFailure("Internal error", { phase: "handshake" });
    expect([d.cause, d.evidence, d.restartInPlace]).toEqual(["transient-network", "kimi-internal-error-phase", true]);
  });

  it("F08.QA-FIX item 3: a mid-session kimi rejection classifies identically to the handshake one", () => {
    // kimi.ts emits the same unclassifiable "Internal error" text from two sites: the handshake
    // catch (phase:"handshake") and the per-turn session.prompt() catch (phase:"session"). Both
    // must produce the SAME disposition -- restart-in-place resumes record.sessionId when one
    // was captured (always true mid-session, since the handshake already succeeded), so the
    // mid-session case is at least as safe to restart-in-place as the handshake case.
    const handshake = classifyFailure("Internal error (code -32603)", { phase: "handshake" });
    const midSession = classifyFailure("Internal error (code -32603)", { phase: "session" });
    expect(midSession).toEqual(handshake);
    expect(midSession.restartInPlace).toBe(true);
  });

  it("an unclassified failure does nothing on its own", () => {
    const d = classifyFailure("socket hang up");
    expect([d.retryable, d.failoverAccount, d.holdForReset, d.restartInPlace]).toEqual([false, false, false, false]);
  });

  it("a context-overflow failure is retryable only via a fresh session, never account-cap/restart-in-place", () => {
    // CONTEXT-OVERFLOW: the poisoned resume id can't be salvaged by any of the GENERIC onError
    // branches (failoverAccount/holdForReset/restartInPlace must all stay false so they skip this
    // cause) -- supervisor.onError instead branches on `d.cause === "context-overflow"` directly to
    // drop resume and relaunch fresh, which is what `retryable: true` describes here.
    const d = classifyFailure("Autocompact is thrashing: context refilled to the limit");
    expect(d.cause).toBe("context-overflow");
    expect([d.retryable, d.failoverAccount, d.holdForReset, d.restartInPlace]).toEqual([true, false, false, false]);
  });

  it("stamps `at` from the injected clock so callers stay deterministic", () => {
    expect(classifyFailure("HTTP 429 Too Many Requests", undefined, BASE).at).toBe(BASE);
  });
});
