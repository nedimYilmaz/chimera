import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema, AgentSpecSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentRecord } from "@chimera/core/supervisor";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker, QuotaTracker } from "@chimera/core/failover";
import { makeSupervisor, fakeExec } from "./helpers.js";

// A session-limit backend error carrying an absolute ISO reset. `at(ms)` builds one whose
// reset lands `ms` from NOW — near-future for auto-resume, far-future to hold without resuming.
const sessionFail = (isoResetAt: string): FakeStep[] => [
  { fail: { message: `You've hit your session limit · resets at ${isoResetAt}` } },
];
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const HAPPY: FakeStep[] = [{ end: { resultText: "recovered", costUsd: 0.02 } }];
// A single-account config: an auto spawn has NO failover target, so a session limit HOLDs.
const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
});

// ROOT CAUSE (found while QA-hardening FEATURE-1): under a full-suite parallel vitest run,
// this file's ~40ms-timer-driven "paused" transitions were observed flaking not because
// `until`'s own deadline was too short, but because vitest's OWN default per-test timeout
// (5000ms) killed the test first ("Test timed out in 5000ms", not "condition not met before
// deadline") — same pre-existing flake diagnosed for scheduler-session-limit.test.ts, root-
// caused there first. Raising this file's default testTimeout (matching the precedent
// already established elsewhere in the repo for the identical class of problem)
// is the fix that actually matters; `until`'s own ms parameter is secondary headroom.
vi.setConfig({ testTimeout: 15_000 });

// Poll a predicate to a deadline — the auto-resume fires on a real (unref'd) timer, so tests
// wait for the state transition rather than racing a fixed sleep.
async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

describe("session-limit pause: failover preferred when a target exists", () => {
  it("fails over to the next account instead of pausing when one is available", async () => {
    // Default CFG has main+second (both claude) — a session limit on main should FAILOVER.
    const { sup, fake } = makeSupervisor([sessionFail(at(60_000)), HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto → main
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");                                 // NOT paused
    expect(final.resultText).toBe("recovered");
    expect(final.attempts.map((a) => a.account)).toEqual(["main", "second"]);
    expect(fake.spawns.map((s) => s.accountName)).toEqual(["main", "second"]);
  });

  // WEEKLY-LIMIT-NO-FAILOVER: proves the fix at the SUPERVISOR level, not just the classifier —
  // onError() must actually take the failover/reroute branch (spec §7: isRateLimit && account
  // === "auto") for this exact live-observed message, on the default account:"auto" spec.
  // Pre-fix, this message matched neither classifyError's RATE list nor SESSION_LIMIT, so
  // isRateLimit was false and the agent failed loudly instead of rerouting to "second".
  it("reroutes to the next account on the exact observed 'weekly limit' message (account: auto)", async () => {
    const WEEKLY: FakeStep[] = [{ fail: { message: "You've hit your weekly limit · resets 1pm (Europe/Istanbul)" } }];
    const { sup, fake } = makeSupervisor([WEEKLY, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto → main
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");                                 // NOT failed, NOT paused
    expect(final.resultText).toBe("recovered");
    expect(final.attempts.map((a) => a.account)).toEqual(["main", "second"]);
    expect(fake.spawns.map((s) => s.accountName)).toEqual(["main", "second"]);
  });
});

describe("session-limit pause: HOLD when no failover target", () => {
  it("pauses the agent, cools the account until the reset, and emits a paused event", async () => {
    const resetIso = at(3600_000);                                   // 1h out: resume won't fire mid-test
    const { sup, dir, cooldowns } = makeSupervisor([sessionFail(resetIso)], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto → main, no failover target
    await until(() => sup.status(rec.agentId).state === "paused");

    const held = sup.status(rec.agentId);
    expect(held.state).toBe("paused");
    expect(held.resumeAt).toBe(Date.parse(resetIso));
    expect(cooldowns.isCooling("main")).toBe(true);                  // cooled until the parsed reset

    const paused = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.data["paused"] === true);
    expect(paused?.data).toMatchObject({ paused: true, reason: "session-limit", account: "main", resumeScheduledAt: Date.parse(resetIso) });
  });

  it("pauses on a session-limit phrasing that is NOT a rate-limit pattern (cls-independent parse)", async () => {
    // "hit your account limit" matches the session-limit signature but no classifyError RATE
    // pattern — the HOLD must still fire because a parseable reset is itself definitive.
    const ACCT: FakeStep[] = [{ fail: { message: `you've hit your account limit — resets at ${at(3600_000)}` } }];
    const { sup } = makeSupervisor([ACCT], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    expect(sup.status(rec.agentId).state).toBe("paused");
  });

  it("still fails loudly for a session limit with NO parseable reset (defensive fallback)", async () => {
    const NO_RESET: FakeStep[] = [{ fail: { message: "You've hit your session limit, try again later" } }];
    const { sup } = makeSupervisor([NO_RESET], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");                              // no reset ⇒ no hold, existing behavior
  });
});

// QUOTA-METER-WRONG-BY-100X: a session-limit error's parsed reset is scraped from a
// human-readable provider string and can be stale (observed live: "resets 2:10am" while the
// account's real quota window resets ~04:10). holdUntilReset must prefer an authoritative,
// STILL-FUTURE quota session window over the parsed string when it disagrees — but only ever to
// EXTEND the hold, never to release a capped account earlier than the string said.
describe("session-limit pause: cooldown reconciles against authoritative quota", () => {
  it("extends the cooldown to the quota's resetsAt when it is LATER than the parsed reset", async () => {
    const parsedResetIso = at(3600_000);                              // parsed: 1h out
    const quotaResetAt = Date.now() + 7200_000;                       // authoritative: 2h out — later
    const quotas = new QuotaTracker();
    quotas.record("main", { kind: "session", usedFraction: 0.96, windowStartedAt: Date.now() - 1000, resetsAt: quotaResetAt });
    const { sup, cooldowns } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    const held = sup.status(rec.agentId);
    expect(held.resumeAt).toBe(quotaResetAt);                         // extended to the authoritative reset
    expect(cooldowns.isCooling("main")).toBe(true);
  });

  it("does NOT shorten the cooldown when the quota's resetsAt is EARLIER than the parsed reset — never releases early", async () => {
    const parsedResetIso = at(7200_000);                              // parsed: 2h out
    const quotaResetAt = Date.now() + 3600_000;                       // authoritative: 1h out — earlier
    const quotas = new QuotaTracker();
    quotas.record("main", { kind: "session", usedFraction: 0.3, windowStartedAt: Date.now() - 1000, resetsAt: quotaResetAt });
    const { sup } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(sup.status(rec.agentId).resumeAt).toBe(Date.parse(parsedResetIso));   // NOT shortened to quotaResetAt
  });

  it("ignores a STALE quota window (resetsAt already in the past) and falls back to the parsed reset", async () => {
    const parsedResetIso = at(3600_000);
    const quotas = new QuotaTracker();
    quotas.record("main", { kind: "session", usedFraction: 0.99, windowStartedAt: Date.now() - 10_000, resetsAt: Date.now() - 1000 });   // already reset per stale data
    const { sup } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(sup.status(rec.agentId).resumeAt).toBe(Date.parse(parsedResetIso));   // stale quota ignored, parsed value used
  });

  it("a genuinely capped account (weekly window unrelated) stays cooled — reconciliation only reads the SESSION kind", async () => {
    const parsedResetIso = at(3600_000);
    const quotas = new QuotaTracker();
    // A "weekly" window, even a wildly different resetsAt, must never leak into session reconciliation.
    quotas.record("main", { kind: "weekly", usedFraction: 1, windowStartedAt: Date.now() - 1000, resetsAt: Date.now() + 999_000_000 });
    const { sup } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(sup.status(rec.agentId).resumeAt).toBe(Date.parse(parsedResetIso));
  });
});

describe("session-limit pause: auto-resume at reset", () => {
  it("resumes the paused agent when the reset passes, continuing under the same session id", async () => {
    // reset ~40ms out; second scenario (HAPPY) is consumed by the resumed re-launch.
    const { sup, fake, dir } = makeSupervisor([sessionFail(at(40)), HAPPY], SOLO);
    // Give the agent a session id first so resume=sessionId is exercised.
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "done", 3000);

    const final = sup.status(rec.agentId);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("recovered");
    expect(final.resumeAt).toBeUndefined();                         // cleared on resume
    expect(final.attempts.map((a) => a.account)).toEqual(["main", "main"]);   // re-launched on the same account
    expect(fake.spawns).toHaveLength(2);
    const resumed = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.data["resumed"] === true);
    expect(resumed?.data).toMatchObject({ resumed: true, account: "main" });
  });
});

describe("session-limit pause: restart-survival (reattachPaused)", () => {
  it("rehydrates a prior paused agent and resumes it (reset already passed) under resume=sessionId", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], SOLO);
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const prior: AgentRecord = {
      agentId: "held-1", spec, accountName: "main", provider: "claude",
      state: "paused", depth: 0, treeId: "held-1", createdAt: Date.now(),
      sessionId: "sess-1", resumeAt: Date.now() - 1000,             // reset already passed → resume immediately
      principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachPaused(prior);
    await until(() => sup.status("held-1").state === "done", 3000);

    expect(sup.status("held-1").state).toBe("done");
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.resume).toBe("sess-1");                  // resumed the prior session, not a fresh one
  });

  it("re-arms the timer for a future reset instead of resuming immediately", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], SOLO);
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const prior: AgentRecord = {
      agentId: "held-2", spec, accountName: "main", provider: "claude",
      state: "paused", depth: 0, treeId: "held-2", createdAt: Date.now(),
      sessionId: "sess-2", resumeAt: Date.now() + 3600_000,         // 1h out
      principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachPaused(prior);
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.status("held-2").state).toBe("paused");              // still held, not resumed
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("session-limit pause: waitFor treats paused as non-terminal", () => {
  it("keeps waiting through a pause instead of resolving the paused record as done", async () => {
    const { sup } = makeSupervisor([sessionFail(at(3600_000))], SOLO);   // 1h hold — won't resume mid-test
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    // Pre-fix this resolved immediately with the paused record; now it must time out (still waiting).
    await expect(sup.waitFor(rec.agentId, 150)).rejects.toThrow(/timed out/);
  });
});

describe("session-limit pause: far-future reset does not tight-loop", () => {
  it("holds a >2^31ms reset without a setTimeout-clamp relaunch storm", async () => {
    const farIso = new Date(Date.now() + 40 * 24 * 3600_000).toISOString();   // 40 days out (> 2^31 ms)
    const { sup, fake } = makeSupervisor([sessionFail(farIso)], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    await new Promise((r) => setTimeout(r, 60));
    expect(sup.status(rec.agentId).state).toBe("paused");   // still held, not clamped-to-1ms and relaunched
    expect(fake.spawns).toHaveLength(1);
  });
});

describe("session-limit pause: resume whose re-launch throws fails terminally", () => {
  it("commits failed + emits a terminal event so a waiter observes it (not a hang)", async () => {
    // A backend that runs the first spawn (→ session limit) but THROWS on the resume re-launch.
    class ThrowOnResume extends FakeAgentBackend {
      override spawn(...args: Parameters<FakeAgentBackend["spawn"]>): ReturnType<FakeAgentBackend["spawn"]> {
        if (this.spawns.length >= 1) throw new Error("resume boom: backend unavailable");
        return super.spawn(...args);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "chimera-sup-slrz-"));
    const backend = new ThrowOnResume([sessionFail(at(40))]);
    const events = new EventLog(dir);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(SOLO),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", backend]]),
      events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "failed", 3000);   // paused → resume throws → failed
    const failed = events.tail(rec.agentId, 50).find((e) => e.data["error"] !== undefined);
    expect(String(failed?.data["error"])).toContain("resume failed");
  });
});

// STALE-RESUME-SESSION-FALLBACK: the record DOES have a captured sessionId (distinct from the
// no-sessionId freshFallback covered in supervisor-paused-conductor.test.ts), but the backend
// rejects it as gone/expired — resumePaused must fall back once to a fresh launch of the
// original spec instead of failing the revive terminally like the generic-throw test above.
describe("session-limit pause: resume whose re-launch throws a STALE-SESSION error falls back to a fresh launch", () => {
  it("(a) an ordinary resume with a live session still resumes normally (no fallback stamped)", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], SOLO);
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const prior: AgentRecord = {
      agentId: "held-ok", spec, accountName: "main", provider: "claude",
      state: "paused", depth: 0, treeId: "held-ok", createdAt: Date.now(),
      sessionId: "sess-live", resumeAt: Date.now() - 1000,
      principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachPaused(prior);
    await until(() => sup.status("held-ok").state === "done", 3000);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.resume).toBe("sess-live");
    expect(sup.status("held-ok").staleResumeFallback).toBeUndefined();
  });

  it("(b) a stale sessionId falls back to a fresh launch of the original spec and stamps staleResumeFallback", async () => {
    class ThrowStaleThenSucceed extends FakeAgentBackend {
      override spawn(...args: Parameters<FakeAgentBackend["spawn"]>): ReturnType<FakeAgentBackend["spawn"]> {
        if (this.spawns.length === 0) {
          this.spawns.push(args[0]);
          throw new Error("session not found");
        }
        return super.spawn(...args);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "chimera-sup-stale-"));
    const backend = new ThrowStaleThenSucceed([HAPPY]);
    const events = new EventLog(dir);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(SOLO),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", backend]]),
      events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
    });
    const spec = AgentSpecSchema.parse({ prompt: "original prompt", cwd: "/tmp", isolation: "none" });
    const prior: AgentRecord = {
      agentId: "held-stale", spec, accountName: "main", provider: "claude",
      state: "paused", depth: 0, treeId: "held-stale", createdAt: Date.now(),
      sessionId: "stale-sess", resumeAt: Date.now() - 1000,
      principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachPaused(prior);
    await until(() => sup.status("held-stale").state === "done", 3000);

    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[0]?.resume).toBe("stale-sess");             // the doomed resume attempt
    expect(backend.spawns[1]?.resume).toBeNull();                     // fresh launch, no resume id
    expect(backend.spawns[1]?.resumeOnly).toBe(false);
    expect(backend.spawns[1]?.prompt).toBe("original prompt");        // original spec survived the fallback

    const st = sup.status("held-stale");
    expect(st.staleResumeFallback).toMatchObject({ resumedFromPause: false, reason: expect.stringContaining("session not found") });
    const fallbackEvent = events.tail("held-stale", 50).find((e) => e.data["resumeFallback"] === "stale-session");
    expect(fallbackEvent?.data).toMatchObject({ resumedFromPause: false });
  });

  it("(c) the fallback is also honoured on the mailbox-revive path (resumedBy: mailbox)", async () => {
    class ThrowStaleThenSucceed extends FakeAgentBackend {
      override spawn(...args: Parameters<FakeAgentBackend["spawn"]>): ReturnType<FakeAgentBackend["spawn"]> {
        if (this.spawns.length === 0) {
          this.spawns.push(args[0]);
          throw new Error("session not found");
        }
        return super.spawn(...args);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "chimera-sup-stale-mbx-"));
    const backend = new ThrowStaleThenSucceed([HAPPY]);
    const events = new EventLog(dir);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(SOLO),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", backend]]),
      events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
    });
    const spec = AgentSpecSchema.parse({ prompt: "mailbox prompt", cwd: "/tmp", isolation: "none" });
    const prior: AgentRecord = {
      agentId: "held-mbx", spec, accountName: "main", provider: "claude",
      state: "paused", depth: 0, treeId: "held-mbx", createdAt: Date.now(),
      sessionId: "stale-sess-2", resumeAt: Date.now() + 3600_000,     // far out: reattach must not auto-fire this
      principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachPaused(prior);
    expect(sup.status("held-mbx").state).toBe("paused");

    await sup.resumePaused("held-mbx", { resumedBy: "mailbox", from: "ask" });

    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[1]?.resume).toBeNull();
    expect(backend.spawns[1]?.prompt).toBe("mailbox prompt");
    expect(sup.status("held-mbx").staleResumeFallback?.resumedFromPause).toBe(false);
    const fallbackEvent = events.tail("held-mbx", 50).find((e) => e.data["resumeFallback"] === "stale-session");
    expect(fallbackEvent?.data).toMatchObject({ resumedBy: "mailbox", from: "ask" });
  });
});

describe("session-limit pause: kill cancels the pending resume", () => {
  it("a killed paused agent never auto-resumes", async () => {
    // 2026-09-02 harness triage: was at(40) — under concurrent-agent CPU contention the
    // ~40ms pause window can close (auto-resume already fired) before `until`'s 10ms poll
    // ever observes "paused", so the test raced its own subject. 1h out (matching the
    // far-future pattern already used elsewhere in this file for "must not resume mid-test")
    // makes the pause window effectively unbounded; the 80ms wait below now just guards
    // against an erroneous immediate resume rather than "past the real reset".
    const { sup, fake } = makeSupervisor([sessionFail(at(3600_000)), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    await sup.kill(rec.agentId);
    expect(sup.status(rec.agentId).state).toBe("killed");
    await new Promise((r) => setTimeout(r, 80));                    // guard against an erroneous immediate resume
    expect(sup.status(rec.agentId).state).toBe("killed");          // stayed killed
    expect(fake.spawns).toHaveLength(1);                           // no resume re-launch
  });
});

describe("session-limit pause: closeInput cancels the hold (team retire path)", () => {
  it("closing a paused agent's input ends it terminally so its resume timer can't resurrect it", async () => {
    // 2026-09-02 harness triage: same race as the kill test above — widened to 1h for the
    // same reason (see its comment).
    const { sup, fake } = makeSupervisor([sessionFail(at(3600_000)), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    await sup.closeInput(rec.agentId);                             // mirrors scheduler.retire() on a paused pool worker
    expect(sup.status(rec.agentId).state).toBe("killed");
    await new Promise((r) => setTimeout(r, 80));                    // guard against an erroneous immediate resume
    expect(sup.status(rec.agentId).state).toBe("killed");          // not resurrected
    expect(fake.spawns).toHaveLength(1);                           // no resume re-launch
  });
});
