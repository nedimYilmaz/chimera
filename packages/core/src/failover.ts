import type { AccountOverage, AccountQuota, AccountQuotaReason, AccountQuotaWindow, ErrorClassName, FailureCause, FailureDisposition } from "@chimera/protocol";

// RETRY-BACKOFF: the canonical taxonomy now lives in @chimera/protocol (ErrorClassSchema) —
// RetryPolicy.retryableClasses is a second consumer of the same union, and protocol cannot
// depend on core. Re-exported under the original name so nothing else in core needs an import
// rename.
export type ErrorClass = ErrorClassName;

// FAILURE-DISPOSITION: one table, one classifier. Every failure class maps to an EXPLICIT set of
// booleans here and nowhere else — the supervisor branches on the disposition instead of
// re-testing the message or switching on a class name, which is how the taxonomy forked before.
const DISPOSITION: Record<FailureCause, Omit<FailureDisposition, "cause" | "evidence" | "at">> = {
  "account-cap":         { errorClass: "rate-limit",    retryable: false, failoverAccount: true,  holdForReset: true,  restartInPlace: false },
  "provider-rate-limit": { errorClass: "rate-limit",    retryable: true,  failoverAccount: true,  holdForReset: false, restartInPlace: false },
  "transient-network":   { errorClass: "backend-crash", retryable: true,  failoverAccount: false, holdForReset: false, restartInPlace: true  },
  "provider-capacity":   { errorClass: "rate-limit",    retryable: true,  failoverAccount: false, holdForReset: false, restartInPlace: true  },
  "provider-stream":     { errorClass: "backend-crash", retryable: true,  failoverAccount: false, holdForReset: false, restartInPlace: true  },
  "bad-request":         { errorClass: "protocol",      retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false },
  "credential":          { errorClass: "credential",    retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false },
  // F08.QA-FIX item 2: a one-shot (non-keepAlive) run that hits the output-token ceiling mid
  // generation is NOT a live-process crash (nothing to respawn, restartInPlace stays false) but
  // IS a normal retryable failure -- the model just needs another attempt, possibly with a
  // smaller ask. Reuses errorClass "backend-crash" (already retryable in every existing
  // retryableClasses config) rather than adding a new ErrorClassSchema value, since the two
  // disposition-boolean axes (FailureCause vs ErrorClass) are independent by design here.
  "output-truncated":    { errorClass: "backend-crash", retryable: true,  failoverAccount: false, holdForReset: false, restartInPlace: false },
  // CONTEXT-OVERFLOW: a resumed native thread that blew the transport's own frame/context ceiling
  // (e.g. Codex app-server's 16 MiB JSONL frame guard) can never succeed by retrying the SAME
  // resume id, so failoverAccount/holdForReset/restartInPlace all stay false on purpose — onError's
  // generic branches for those three all skip this cause; supervisor.onError instead branches on
  // `d.cause === "context-overflow"` directly and drops resume for a fresh same-account,
  // same-provider relaunch (see CONTEXT-OVERFLOW-RECOVERY in supervisor.ts). retryable IS true: a
  // fresh session genuinely can succeed where the poisoned resume couldn't, which is what the
  // custom branch acts on (nothing generic reads this boolean for this cause).
  "context-overflow":    { errorClass: "backend-crash", retryable: true,  failoverAccount: false, holdForReset: false, restartInPlace: false },
  "unclassified":        { errorClass: "unknown",       retryable: false, failoverAccount: false, holdForReset: false, restartInPlace: false },
};

// Each row carries a NAME so a disposition's `evidence` can identify the rule that fired without
// ever quoting the provider's message (which may contain keys, prompts or customer data).
type Signal = { name: string; re: RegExp };

// `session limit` joins the rate-limit family: a hard session/usage cap is a
// rate-limit-CLASS error (same failover disposition), so the supervisor's existing
// rate-limit branch handles it. Session-limit-aware PAUSE is layered on top via
// parseSessionLimit() below, which only diverges from plain failover when the error
// also carries a parseable RESET TIME.
// WEEKLY-LIMIT-NO-FAILOVER: "You've hit your weekly limit · resets 1pm (…)" matched NEITHER
// this list nor SESSION_LIMIT below — `weekly` is a real, documented Claude quota window
// (protocol's seven_day/seven_day_opus/seven_day_sonnet/seven_day_overage_included variants,
// see quota-poll.ts) but the CLI's human-facing text was never added here, so it fell through
// to the generic fail-loud path instead of failing over. `weekly limit` is added as its own
// bare entry (mirrors the existing `usage limit`/`session limit` bare entries — same
// convention, same documented-window justification). `monthly`/`daily` are NOT added here:
// there is no evidence Claude emits those windows today, and a bare `monthly limit`/`daily
// limit` substring match is broad enough to catch unrelated non-recoverable errors (e.g. some
// other system's "exceeded your monthly limit of X") and silently retry them on another
// account instead of surfacing to the operator. They ARE added to SESSION_LIMIT's more
// specific "hit your ___ limit" phrase below, as a lower-risk forward hedge.
// BARE-LIMIT-NO-FAILOVER: the SAME class of miss as WEEKLY-LIMIT above, observed live on a
// conductor: "You've hit your limit · resets 4:10am (Europe/Istanbul)" — no window word at all.
// It matched nothing here and nothing in SESSION_LIMIT (whose alternation REQUIRED a window
// word between "your" and "limit"), so it classified "unknown", never reached failover, and the
// agent idled on a capped account until a human noticed. The full phrase `hit your limit` is
// used rather than a bare `limit` substring for the same false-positive reason the comment
// above gives for `monthly`/`daily`.
// CAP vs THROTTLE: the old RATE list was one array; it is split here because the two halves
// need DIFFERENT actions (a spent plan window must park the account until reset, a 429 just
// needs backoff) while still reporting the SAME errorClass "rate-limit" — so no operator
// retryableClasses config changes meaning.
const CAP: Signal[] = [
  { name: "usage limit", re: /usage limit/i },
  { name: "session limit", re: /session limit/i },
  { name: "weekly limit", re: /weekly limit/i },
  { name: "hit your limit", re: /hit your limit/i },
  { name: "quota", re: /quota/i },
];
const THROTTLE: Signal[] = [
  { name: "429", re: /\b429\b/i },
  { name: "rate limit", re: /rate limit/i },
  { name: "overloaded", re: /overloaded/i },
];
const CRED: Signal[] = [
  { name: "authentication", re: /authentication/i },
  { name: "401", re: /\b401\b/i },
  { name: "invalid api key", re: /invalid api key/i },
  { name: "invalid x-api-key", re: /invalid x-api-key/i },
  { name: "oauth token", re: /oauth token/i },
  // F08.QA-FIX item 2: full phrase, not a bare "403", to keep the BAD-REQUEST-FULL-PHRASES-ONLY
  // discipline -- no live emit site produces this today (grepped every backend + failover.ts),
  // this is defensive coverage for a provider permission rejection, which is a credential-class
  // problem (the account/key lacks access) and must never burn retries like a transient error.
  { name: "403 forbidden", re: /403 forbidden/i },
];
// BAD-REQUEST-FULL-PHRASES-ONLY: a false positive here is expensive — bad-request is the one
// cause that neither retries nor fails over, so a recoverable agent would be stranded. Every row
// is therefore a full provider phrase, never a bare status code (a message like "prompt used 400
// tokens" must NOT match). Ordered after CRED so an auth error that happens to embed
// "invalid_request_error" still reads as a credential problem.
const BAD_REQUEST: Signal[] = [
  { name: "invalid_request_error", re: /invalid_request_error/i },
  { name: "400 bad request", re: /\b400 bad request\b/i },
  { name: "context length exceeded", re: /context[_ ]length[_ ]exceeded|prompt is too long/i },
  { name: "content policy", re: /content[_ ]policy|content filter|blocked by safety/i },
  { name: "model not found", re: /model[_ ]not[_ ]found|unknown model/i },
  { name: "unsupported input", re: /does not support image input/i },
  // F08.QA-FIX item 2: claude.ts and codex.ts both emit this after the SDK's own internal
  // retries are exhausted -- by the time this text reaches classifyFailure, retrying at the
  // failover layer too would just repeat the same unproducible-schema request. Genuinely
  // unretryable, unlike the truncation case below.
  { name: "structured output validation failed", re: /structured output validation failed/i },
];
// F08.QA-FIX item 2: a one-shot (non-keepAlive) run that hits maxOutputTokens mid-generation
// emits this exact phrase (generic.ts) and reaches classifyFailure -- keepAlive sessions never
// do, they resolve truncation through scheduler.ts's own turn_complete/truncated path instead.
// WHY this must stay its own cause and NOT fold into "bad-request": bad-request's disposition is
// retryable:false by design (a malformed request will fail identically every time); truncation is
// the opposite -- the model produced a valid-but-incomplete response, and another attempt (or a
// smaller ask) can legitimately succeed. Mapping it to bad-request, as a naive reading of "cut off
// mid-generation" might suggest, would silently dead-letter a class of failure the scheduler is
// fully able to recover from.
const TRUNCATION: Signal[] = [
  { name: "output truncated", re: /output truncated at \d+ tokens \(finish_reason: length\)/i },
];
// R2-TURN-LIFECYCLE: supervisor.onEvent constructs this exact phrase when routing a
// turn_timeout BackendEvent through onError (see supervisor.ts) — classifying a detected hang
// as backend-crash-class gives it the SAME disposition a real crash gets today (fail loud
// unless the account is mid rate-limit-class failover, which this never is).
const CRASH: Signal[] = [
  { name: "process exited", re: /process exited/i },
  { name: "exited with code", re: /exited with code/i },
  { name: "stream fault", re: /stream (broken|closed)/i },
  { name: "ECONNRESET", re: /ECONNRESET/i },
  { name: "turn timed out", re: /turn timed out/i },
];

// CONTEXT-OVERFLOW: checked BEFORE CRASH — codex-rpc.ts's own "Codex app-server exited (...)"
// wrapper (see its `exit` handler) can end up concatenating this phrase into a message that also
// matches CRASH's generic "exited with code", and only the frame-size cause tells the supervisor
// to drop `resume` rather than restart in place against the same poisoned thread.
const CONTEXT_OVERFLOW: Signal[] = [
  { name: "JSONL frame exceeded", re: /JSONL frame exceeded \d+ MiB/i },
  { name: "autocompact thrashing", re: /Autocompact is thrashing\b/i },
];

// STALE-RESUME-SESSION: a resumePaused launch() throwing because the STORED sessionId no longer
// resumes on the backend (evicted/expired conversation) — categorically different from every
// FailureCause above: those all describe THIS attempt failing and being retried/failed over
// as-is, but a stale session can never succeed no matter how many times it's retried with the
// same `resume` id. The only recovery is dropping resume and relaunching fresh, which is a
// supervisor.resumePaused-local decision (see its catch block), not a FailureDisposition — so
// this stays a standalone matcher, deliberately NOT wired into classifyFailure/DISPOSITION.
const STALE_RESUME_SESSION: Signal[] = [
  { name: "Codex rollout not found", re: /no rollout found for thread id\s+\S+/i },
  { name: "no conversation found", re: /no conversation found/i },
  { name: "session not found", re: /session[_ ]?(id)?\s*(not found|does not exist|is invalid|expired)/i },
  { name: "conversation not found", re: /conversation[_ ]?(id)?\s*(not found|does not exist)/i },
  { name: "unknown session", re: /unknown session[_ ]?id/i },
  { name: "invalid session", re: /invalid session[_ ]?id/i },
  { name: "could not resume", re: /could not resume (the )?session/i },
];

// Used by supervisor.ts's resumePaused catch: true only for a launch() failure that names the
// resumed session itself as the problem, never for a generic/transient backend error (see
// supervisor-session-limit.test.ts's "resume whose re-launch throws fails terminally", which
// must keep failing terminally on an unrelated message).
export function isStaleResumeSessionError(message: string): boolean {
  return STALE_RESUME_SESSION.some((s) => s.re.test(message));
}

// The ONLY producer of a FailureDisposition. Precedence is CAP → THROTTLE → CRED → TRUNCATION →
// BAD_REQUEST → CONTEXT_OVERFLOW → CRASH: an account cap outranks a throttle (both are
// "rate-limit" but only one parks the account), auth outranks a malformed-request phrase,
// TRUNCATION is its own self-authored phrase checked before the more generic BAD_REQUEST/CRASH
// buckets, CONTEXT_OVERFLOW is its own exact phrase checked before CRASH for the reason given at
// its definition, and CRASH is last because crash text ("stream closed") frequently rides along
// with a more specific cause.
export function classifyFailure(message: string, errData?: Record<string, unknown>, now = Date.now()): FailureDisposition {
  // The SDK's parse error embeds the entire partial event (including arbitrary command
  // text). Classify its envelope before looking for quota/auth words inside that payload.
  if (errData?.["phase"] === "codex-exec-jsonl" || message.startsWith("Failed to parse item: ")) {
    return dispositionFor("provider-stream", "codex-exec-jsonl", now);
  }
  // KIMI-HANDSHAKE-CRASH-PARITY: a backend that dies during the MCP handshake reports a generic
  // provider "Internal error" whose text matches nothing here; the phase marker is the only
  // reliable signal, and a handshake death is exactly a restart-in-place case. F08.QA-FIX item 3:
  // the SAME "Internal error" rejection can also surface mid-session, from session.prompt()
  // inside the per-turn loop (phase "session"). It gets the identical disposition, not just a
  // similar one: scheduleCrashRestart always resumes record.sessionId when one was captured
  // (supervisor.ts ~3054), and a mid-session rejection by definition has one (the handshake
  // already completed), so restart-in-place there is *more* context-preserving than the
  // handshake case, not less safe. A from-scratch respawn (no resume) only happens when no
  // sessionId exists yet, i.e. exactly the handshake failure -- so one shared row correctly
  // covers both phases.
  if (errData?.["phase"] === "handshake" || errData?.["phase"] === "session") {
    return dispositionFor("transient-network", "kimi-internal-error-phase", now);
  }
  for (const s of CAP) if (s.re.test(message)) return dispositionFor("account-cap", s.name, now);
  for (const s of THROTTLE) if (s.re.test(message)) return dispositionFor("provider-rate-limit", s.name, now);
  for (const s of CRED) if (s.re.test(message)) return dispositionFor("credential", s.name, now);
  if (/\b(?:selected )?model is (?:currently )?at capacity\b/i.test(message)) {
    return dispositionFor("provider-capacity", "model at capacity", now);
  }
  // TRUNCATION is checked before BAD_REQUEST: its phrase is self-authored (generic.ts) and never
  // overlaps any BAD_REQUEST phrase, but it must win over CRASH's generic "process exited"-style
  // matches if a transport ever wraps the truncation message in crash-sounding text.
  for (const s of TRUNCATION) if (s.re.test(message)) return dispositionFor("output-truncated", s.name, now);
  for (const s of BAD_REQUEST) if (s.re.test(message)) return dispositionFor("bad-request", s.name, now);
  for (const s of CONTEXT_OVERFLOW) if (s.re.test(message)) return dispositionFor("context-overflow", s.name, now);
  for (const s of CRASH) if (s.re.test(message)) return dispositionFor("transient-network", s.name, now);
  return dispositionFor("unclassified", "no pattern matched", now);
}

export function dispositionFor(cause: FailureCause, evidence: string, now = Date.now()): FailureDisposition {
  return { cause, ...DISPOSITION[cause], evidence, at: now };
}

// Kept byte-compatible for every caller (supervisor.ts, backends/claude.ts) and derived from the
// single classifier so the two can never drift apart.
export function classifyError(message: string): ErrorClass {
  return classifyFailure(message).errorClass;
}

// A session/usage-limit error that names WHEN access resets (e.g. the backend's
// "You've hit your session limit · resets 8:20pm"). We return the reset moment as an
// absolute epoch-ms so the supervisor can cool the account until then and schedule an
// auto-resume. DEFENSIVE by contract: returns null when the message isn't a session
// limit OR no reset time is parseable — the caller then falls back to plain failover.
// A rate-limit WITHOUT a reset time (a bare 429/overloaded) therefore never pauses.
// `weekly` is a bare alternative (same status as `session limit`/`usage limit` above — a real,
// observed window). `monthly`/`daily` ride only the generic "hit your ___ limit" clause: that
// fuller phrase is a lower false-positive-risk signal than a bare substring, and this HOLD path
// is already double-gated behind a parseable reset time (parseSessionLimit's contract), so the
// forward hedge costs little even though these two windows are unconfirmed for Claude today.
// BARE-LIMIT-NO-FAILOVER: the window word is OPTIONAL — "You've hit your limit · resets 4:10am"
// is a real, observed phrasing. Without this the HOLD path could not parse its reset either, so
// a bare limit neither failed over nor paused; it just stalled.
const SESSION_LIMIT = /session limit|usage limit|weekly limit|hit your (?:(?:session|usage|account|weekly|monthly|daily) )?limit/i;

export function parseSessionLimit(message: string, now = Date.now()): { resetAt: number } | null {
  if (!SESSION_LIMIT.test(message)) return null;
  const resetAt = parseResetTime(message, now);
  return resetAt === null ? null : { resetAt };
}

// Extract the reset time from a "…resets <when>" clause. We take the text immediately AFTER
// a "reset(s)/resetting[ at]" keyword (so an unrelated number elsewhere can't be mistaken for
// it), then match a time token anchored at its START. We deliberately do NOT anchor to
// end-of-line: JS `$` (no `m` flag) does not match before a trailing "\n" and `.` never
// crosses one, so a plain trailing newline / trailing text ("…8:20pm\n(all times PT)") would
// otherwise defeat the whole match. Recognizes, in order: ISO-8601, a bare epoch (s or ms),
// or a wall-clock time ("8:20pm" / "20:20" / "8pm") resolved to its NEXT occurrence after now.
function parseResetTime(message: string, now: number): number | null {
  // Scan EVERY "reset(s)/resetting[ at]" keyword (a global regex) and return the first that
  // yields a parseable time token — an unrelated earlier "reset" (e.g. "password reset:") must
  // not shadow the real "…resets 8:20pm" clause. Deliberately NOT end-anchored: JS `$` (no `m`
  // flag) doesn't match before a trailing "\n" and `.` never crosses one, so trailing
  // newline/text would otherwise defeat the whole match.
  const kw = /reset(?:s|ting)?(?:\s+at)?[:\s]+/gi;
  for (let m = kw.exec(message); m; m = kw.exec(message)) {
    const t = parseTimeToken(message.slice(m.index + m[0].length).trimStart(), now);
    if (t !== null) return t;
  }
  return null;
}

// Parse a time token anchored at the START of `tail`: ISO-8601, a bare epoch (s or ms), or a
// wall-clock time ("8:20pm" / "20:20" / "8pm"). Returns null when the leading token isn't a time.
function parseTimeToken(tail: string, now: number): number | null {
  if (!tail) return null;

  // ISO-8601 / RFC (e.g. "2026-07-14T20:20:00Z" or "…20:20:00"): let Date parse it. Anchored at
  // the token start; a malformed date (Date.parse ⇒ NaN) falls through to the next matcher.
  const iso = /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/i.exec(tail);
  if (iso) { const t = Date.parse(iso[0].replace(" ", "T")); if (!Number.isNaN(t)) return t; }

  // Bare epoch: 10 digits ⇒ seconds, 13 ⇒ milliseconds (heuristic on magnitude).
  const epoch = /^(\d{10,13})\b/.exec(tail);
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n; }

  // Wall-clock "8:20pm" / "8:20 PM" / "20:20" / "8pm" ⇒ the next such instant strictly after
  // now. Require EITHER explicit minutes OR an am/pm marker, so a bare "resets 8" (ambiguous)
  // is rejected rather than silently read as 08:00.
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i.exec(tail);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined))
    return nextClockTime(now, Number(clock[1]), clock[2] ? Number(clock[2]) : 0, clock[3]?.toLowerCase());

  return null;
}

// The next local wall-clock instant matching h:min after `now`, or null when the parsed clock
// is out of range. am/pm is applied when present (12am→00, 12pm→12); a bare 24h time is taken
// as-is. Range-checking keeps the DEFENSIVE contract: nonsense like "25:99" or "13:00pm" is not
// a real reset ⇒ null ⇒ the caller falls back to plain failover instead of pausing on garbage.
function nextClockTime(now: number, h: number, min: number, ampm?: string): number | null {
  if (min > 59) return null;
  if (ampm ? (h < 1 || h > 12) : h > 23) return null;
  let hour = h;
  if (ampm === "am") hour = h % 12;               // 12am ⇒ 00
  else if (ampm === "pm") hour = (h % 12) + 12;   // 12pm ⇒ 12
  const d = new Date(now);
  d.setHours(hour, min, 0, 0);
  // Already passed today ⇒ the upcoming one. setDate (not +86.4e6ms) keeps the SAME wall-clock
  // time across a DST boundary, where a fixed 24h offset would land an hour off.
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// R2 (self-healing supervision): the crash-loop backoff+circuit-breaker policy consumed by
// AgentSupervisor.scheduleCrashRestart. `maxRestarts` is a CONSECUTIVE count (reset to 0 on the
// next successful agent_started) — this is what makes it genuine LOOP detection rather than a
// time-window heuristic: a crash that recovers before the next one never accumulates toward the
// breaker, while unbroken crash-after-crash (a real loop) trips it regardless of how far apart
// in wall-clock time the individual crashes land.
export type CrashLoopPolicy = { maxRestarts: number; baseDelayMs: number; maxDelayMs: number };
export const DEFAULT_CRASH_LOOP_POLICY: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 2_000, maxDelayMs: 300_000 };

// Exponential backoff, capped at maxDelayMs. `attempt` is 1-based (the Nth consecutive crash) —
// attempt 1 returns baseDelayMs unchanged. Pure/deterministic, unlike CooldownTracker (no
// injected clock needed: this only computes a DURATION, the caller adds it to `now()`).
export function computeBackoffMs(policy: CrashLoopPolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

// QUOTA-UNCOOL: a cooldown stamp is no longer a bare deadline. `stampedAt` is what lets fresh
// evidence be compared against the moment the hold was decided (a quota window that STARTED after
// the stamp is proof the window rolled), and `kind` is what keeps poll-driven relief narrow: a
// quota reading with headroom disproves a "session-limit" hold, but says nothing about the
// server-side overloaded/RPM 429 that plain stamp() records — clearing THAT every 60s would just
// churn an account back into the error that cooled it.
export type CooldownStamp = { until: number; stampedAt: number; kind: "failover" | "session-limit" };

export class CooldownTracker {
  private stamps = new Map<string, CooldownStamp>();
  constructor(private cooldownMs: number, private now: () => number = Date.now) {}
  // D7 hot-reload: swap the failover window in place when failoverCooldownMinutes changes
  // in the effective config. The supervisor holds THIS same instance, so the next stamp()
  // uses the new window immediately (no daemon restart); already-stamped `until` deadlines
  // are absolute timestamps and are intentionally left untouched.
  setCooldownMs(ms: number): void { this.cooldownMs = ms; }
  get windowMs(): number { return this.cooldownMs; }
  stamp(account: string): void {
    this.stamps.set(account, { until: this.now() + this.cooldownMs, stampedAt: this.now(), kind: "failover" });
  }
  // Session-limit HOLD: cool an account until a SPECIFIC parsed reset time (not the fixed
  // failover window), so a concurrent routeAccount keeps avoiding it until the limit lifts.
  stampUntil(account: string, until: number): void {
    this.stamps.set(account, { until, stampedAt: this.now(), kind: "session-limit" });
  }
  isCooling(account: string): boolean { return (this.stamps.get(account)?.until ?? 0) > this.now(); }
  /** The live stamp for an account, or null when it is not (or no longer) cooling. */
  stampFor(account: string): CooldownStamp | null {
    const s = this.stamps.get(account);
    return s && s.until > this.now() ? s : null;
  }
  // QUOTA-UNCOOL: end a cooldown EARLY. The one thing this map never had — stampUntil's duration
  // was decided once, from a parsed error string, and no amount of later evidence could shorten
  // it. Returns the deadline that was dropped (null when the account was not cooling), so the
  // caller can put the disproved deadline in its audit event instead of guessing.
  clear(account: string): number | null {
    const s = this.stampFor(account);
    this.stamps.delete(account);
    return s ? s.until : null;
  }
  snapshot(): Array<{ account: string; until: number }> {                       // Phase 3
    const t = this.now();
    return [...this.stamps.entries()].filter(([, s]) => s.until > t).map(([account, s]) => ({ account, until: s.until }));
  }
}

// QUOTA-SANITY-GUARD: the single choke point EVERY quota window passes through (both the poll
// source, quota-poll.ts, and the SDK push-event source, claude.ts's onEvent "quota" branch via
// supervisor.ts, funnel through QuotaTracker.record) — so this is where a provably-impossible
// window must be caught, regardless of which upstream normalizer produced it. Bounds are
// deliberately generous (this only needs to catch multi-order-of-magnitude UNIT bugs, never
// legitimate clock skew): anything before 2020 is the signature of a seconds value landing where
// milliseconds were expected (see QUOTA-METER-WRONG-BY-100X, claude.ts — the real incident this
// guard exists for: a live resetsAt of 1787015400 read as ms resolved to 1970-01-21); anything
// more than a year out is the opposite mistake (ms read as seconds, landing decades in the
// future). `windowStartedAt` after `resetsAt` is internally inconsistent regardless of epoch.
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_LEAD_MS = 366 * 24 * 60 * 60 * 1000;

export function implausibleQuotaWindowReason(window: AccountQuotaWindow, now: number): string | null {
  if (window.resetsAt < MIN_PLAUSIBLE_EPOCH_MS) {
    return `resetsAt ${window.resetsAt} resolves to before 2020 — looks like a seconds value read as milliseconds`;
  }
  if (window.resetsAt - now > MAX_PLAUSIBLE_LEAD_MS) {
    return `resetsAt ${window.resetsAt} is more than a year in the future — looks like a milliseconds value read as seconds`;
  }
  if (window.windowStartedAt < MIN_PLAUSIBLE_EPOCH_MS) {
    return `windowStartedAt ${window.windowStartedAt} resolves to before 2020`;
  }
  if (window.windowStartedAt > window.resetsAt) {
    return `windowStartedAt ${window.windowStartedAt} is after resetsAt ${window.resetsAt}`;
  }
  return null;
}

// ACCOUNT-QUOTA-METERS: mirrors CooldownTracker's shape/injectable-clock convention. A
// backend's "quota" BackendEvent reports ONE window (session or weekly) at a time (the
// Claude SDK's rate_limit_event carries a single rate_limit_info per message) — record()
// upserts by kind so the two windows accumulate independently instead of clobbering each
// other, and fetchedAt tracks the last successful update per account (not read time) so a
// stalled/failed poll is honestly distinguishable from a fresh one (staleness in the UI).
export class QuotaTracker {
  private byAccount = new Map<string, { windows: Map<AccountQuotaWindow["kind"], AccountQuotaWindow>; fetchedAt: number }>();
  // QUOTA-ABSENCE-IS-INVISIBLE: a SEPARATE map, not folded into byAccount — the reason must
  // survive (and be readable) even for an account that has NEVER recorded a window, which is
  // exactly the "unsupported"/"http_error" case this exists to surface.
  private reasons = new Map<string, AccountQuotaReason>();
  // EXTRA-USAGE-VISIBILITY: a SEPARATE map for the same reason `reasons` is one — overage state
  // must be readable for an account that has never recorded a usable WINDOW (the primary window
  // being rejected is exactly when overage matters most).
  private overage = new Map<string, AccountOverage>();
  constructor(private now: () => number = Date.now) {}
  // QUOTA-SANITY-GUARD: a provably-impossible window (see implausibleQuotaWindowReason above) is
  // NEVER stored — the tracker keeps its last known-good value for that (account, kind), same
  // "never fabricate" policy a poll miss already gets, and the rejection itself is recorded as an
  // honest reason (kind "implausible") instead of silently vanishing.
  record(account: string, window: AccountQuotaWindow): void {
    const badReason = implausibleQuotaWindowReason(window, this.now());
    if (badReason) {
      this.recordReason(account, { kind: "implausible", detail: badReason, at: this.now() });
      return;
    }
    let e = this.byAccount.get(account);
    if (!e) { e = { windows: new Map(), fetchedAt: 0 }; this.byAccount.set(account, e); }
    e.windows.set(window.kind, window);
    e.fetchedAt = this.now();
  }
  recordReason(account: string, reason: AccountQuotaReason): void {
    this.reasons.set(account, reason);
  }
  /** EXTRA-USAGE-VISIBILITY: merge in whatever this observation knew. Fields arrive from TWO
   *  transports that each carry only part of the picture — the push event knows status/disabled
   *  reason, the usage poll knows the credit budget — so a partial observation must not blank what
   *  the other one already established. */
  recordOverage(account: string, patch: Partial<Omit<AccountOverage, "observedAt">>): void {
    const prior = this.overage.get(account);
    const merged: AccountOverage = {
      status: patch.status ?? prior?.status ?? null,
      disabledReason: patch.disabledReason ?? prior?.disabledReason ?? null,
      inUse: patch.inUse ?? prior?.inUse ?? null,
      resetsAt: patch.resetsAt ?? prior?.resetsAt ?? null,
      monthlyLimit: patch.monthlyLimit ?? prior?.monthlyLimit ?? null,
      usedCredits: patch.usedCredits ?? prior?.usedCredits ?? null,
      usedFraction: patch.usedFraction ?? prior?.usedFraction ?? null,
      currency: patch.currency ?? prior?.currency ?? null,
      observedAt: this.now(),
    };
    this.overage.set(account, merged);
  }
  getOverage(account: string): AccountOverage | undefined {
    return this.overage.get(account);
  }
  getReason(account: string): AccountQuotaReason | undefined {
    return this.reasons.get(account);
  }
  get(account: string): AccountQuota | undefined {
    const e = this.byAccount.get(account);
    const over = this.overage.get(account);
    // An account can have overage state and NO usable window — that is the rejected-primary case,
    // the one where overage is the whole story. Returning undefined for it would hide it.
    if ((!e || e.windows.size === 0) && !over) return undefined;
    return {
      account,
      windows: e ? [...e.windows.values()] : [],
      fetchedAt: e?.fetchedAt ?? over!.observedAt,
      ...(over ? { overage: over } : {}),
    };
  }
  snapshot(): AccountQuota[] {
    const out: AccountQuota[] = [];
    const accounts = new Set([...this.byAccount.keys(), ...this.overage.keys()]);
    for (const account of accounts) { const q = this.get(account); if (q) out.push(q); }
    return out;
  }
}
