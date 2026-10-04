import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { MailboxStore } from "@chimera/core/mailbox";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeSupervisor, CFG } from "./helpers.js";

// F08 (failure classification guards), task 1: onError no longer branches on a bare errorClass
// string — it stamps `record.failure` (the FailureDisposition from failover.ts's single
// classifier) and branches on its four booleans. These cases pin the behaviours that are NEW or
// that only the disposition makes observable; the equivalence of the rewire itself is pinned by
// the six existing supervisor suites, which must pass with zero edits (plan A7).

const until = async (ok: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

// Fixture discipline: classifyFailure evaluates CAP -> THROTTLE -> CRED -> BAD_REQUEST -> CRASH,
// so a bad-request fixture must not contain "quota"/"429"/"rate limit"/"401"/... or it classifies
// as the earlier, stronger cause instead. Every string below was checked against those tables.
const BAD_REQ: FakeStep[] = [{ fail: { message: "invalid_request_error: unsupported parameter" } }];
// bad-request beats CRASH: pre-F08 this took the crash-loop-backoff restart path.
const BAD_REQ_CRASHY: FakeStep[] = [{ fail: { message: "invalid_request_error: stream closed" } }];
// SESSION_LIMIT parses "hit your account limit" + "resets 8:20pm"; pre-F08 this HELD the agent.
const BAD_REQ_RESET: FakeStep[] = [{ fail: { message: "invalid_request_error · hit your account limit · resets 8:20pm" } }];
// Matches NO CAP row ("hit your limit" needs the words adjacent) but DOES parse a reset time —
// the BARE-LIMIT-NO-FAILOVER shape that used to classify unknown and strand a capped account.
const BARE_LIMIT: FakeStep[] = [{ fail: { message: "You've hit your account limit · resets 4:10am (Europe/Istanbul)" } }];
const RATE_FAIL: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];
const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "recovered", costUsd: 0.02 } }];
const CONDUCTOR: FakeStep[] = [{ end: { resultText: "conductor done" } }];

function events(dir: string): Array<{ kind: string; data: Record<string, unknown> }> {
  return readFileSync(join(dir, "events", "events.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
}

describe("F08 onError disposition — bad-request never spends accounts", () => {
  it("A5: a bad-request on an auto account with an eligible second account appends no failover event", async () => {
    const { sup, fake, dir } = makeSupervisor([BAD_REQ]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto → main
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("failed");
    expect(final.failure?.cause).toBe("bad-request");
    expect(final.failure?.errorClass).toBe("protocol");
    expect(events(dir).some((e) => e.kind === "failover")).toBe(false);
    expect(fake.spawns).toHaveLength(1);                       // never rotated onto "second"
  });

  it("A6: a bad-request carrying a parseable reset time fails loud instead of parking the agent", async () => {
    const { sup, dir } = makeSupervisor([BAD_REQ_RESET]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("failed");
    expect(final.failure?.cause).toBe("bad-request");
    expect(final.resumeAt).toBeUndefined();
    expect(events(dir).some((e) => e.data["state"] === "paused")).toBe(false);
  });

  it("a bad-request that also names a crash symptom does not enter the crash-loop breaker", async () => {
    const { sup, fake, dir } = makeSupervisor([BAD_REQ_CRASHY], CFG, { crashLoopPolicy: { maxRestarts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 } });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("failed");
    expect(final.failure?.cause).toBe("bad-request");
    expect(final.circuitOpen).toBeUndefined();
    expect(fake.spawns).toHaveLength(1);                       // no restart-in-place attempt
    expect(events(dir).some((e) => e.kind === "circuit_breaker_tripped")).toBe(false);
  });
});

describe("F08 onError disposition — evidence, clearing and stamping", () => {
  it("A9: a bare limit with a parseable reset upgrades to account-cap with evidence 'parsed reset time'", async () => {
    const { sup } = makeSupervisor([BARE_LIMIT]);
    // explicit account: no failover target, so the HOLD branch is what we observe
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    // poll rather than sleep a fixed span: paused is reached off a promise chain, and under
    // fleet load a fixed sleep is the classic flaky-deadline failure.
    await until(() => sup.status(rec.agentId).state === "paused");
    const final = sup.status(rec.agentId);

    expect(final.failure?.cause).toBe("account-cap");
    expect(final.failure?.evidence).toBe("parsed reset time");
    expect(final.failure?.holdForReset).toBe(true);
    expect(final.state).toBe("paused");                        // held until the parsed reset
    expect(final.attempts[final.attempts.length - 1]?.errorClass).toBe("rate-limit");
  });

  it("A13: a successful agent_started clears record.failure alongside crashCount", async () => {
    const { sup } = makeSupervisor([RATE_FAIL, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto → main, then "second"
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("done");
    expect(final.failure).toBeUndefined();
    expect(final.crashCount).toBe(0);
  });

  it("A11: failure is stamped even when attempts is empty (the `if (att)` guard's blind spot)", () => {
    const { sup } = makeSupervisor([]);
    const prior: AgentRecord = {
      agentId: "a11", spec: AgentSpecSchema.parse({ prompt: "hi", cwd: "/tmp", isolation: "none", account: "second" }),
      accountName: "second", provider: "claude", state: "running", depth: 0, treeId: "a11",
      createdAt: Date.now(), principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    };
    sup.reattachTerminal(prior);
    const rec = sup.status("a11");
    (sup as unknown as { onError: (r: AgentRecord, m: string) => void }).onError(rec, "invalid_request_error: unsupported parameter");

    expect(rec.attempts).toHaveLength(0);
    expect(rec.failure?.cause).toBe("bad-request");
    expect(rec.failure?.evidence).toBe("invalid_request_error");
    expect(typeof rec.failure?.at).toBe("number");
  });
});

describe("F08 disposition on the wire", () => {
  it("A15: the status{state:'failed'} event carries the disposition", async () => {
    const { sup, dir } = makeSupervisor([BAD_REQ]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.waitFor(rec.agentId, 2000);

    const failed = events(dir).find((e) => e.kind === "status" && e.data["state"] === "failed");
    expect(failed).toBeTruthy();
    expect((failed!.data["failure"] as { cause?: string } | undefined)?.cause).toBe("bad-request");
  });

  it("A16: the child_failed mailbox meta carries the disposition", async () => {
    const { sup, dir } = makeSupervisor([CONDUCTOR, BAD_REQ]);
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });
    await sup.waitFor(child.agentId, 2000);

    const failures = new MailboxStore(dir).pending(conductor.agentId).filter((m) => m.kind === "child_failed");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.meta?.["failure"] as { cause?: string } | undefined)?.cause).toBe("bad-request");
  });
});

describe("CONTEXT-OVERFLOW-RECOVERY: a poisoned resume relaunches fresh, once, same account", () => {
  // Matches codex-rpc.ts's outbound frame-guard phrase exactly; contains none of the earlier-
  // precedence CAP/THROTTLE/CRED/BAD_REQUEST substrings (see failover.test.ts's fixture discipline
  // note), so it classifies as context-overflow every time it's used below.
  const OVERFLOW: FakeStep[] = [{ fail: { message: "Codex app-server JSONL frame exceeded 16 MiB (outbound)" } }];

  it("a single context-overflow drops resume and relaunches once on the SAME account, mailbox intact", async () => {
    const { sup, fake, dir } = makeSupervisor([OVERFLOW, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", resume: "poisoned-thread", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("done");
    expect(final.contextOverflowRecoveries).toBe(0);            // reset after a successful turn
    expect(final.failure).toBeUndefined();                      // cleared alongside crashCount on recovery
    expect(fake.spawns).toHaveLength(2);                        // the original attempt + exactly one relaunch
    expect(fake.spawns[0]?.resume).toBe("poisoned-thread");
    expect(fake.spawns[1]?.resume).toBeNull();                  // dropped so launch() starts a fresh thread
    expect(fake.spawns[1]?.accountName).toBe("second");         // same account/provider — no failover spend
    const failoverEvents = events(dir).filter((e) => e.kind === "failover");
    expect(failoverEvents).toHaveLength(0);                     // this is a relaunch, not an account failover
    const resumedStatus = events(dir).find((e) => e.data["resumeFallback"] === "context-overflow");
    expect(resumedStatus).toBeTruthy();
  });

  it("a SECOND consecutive context-overflow terminally fails instead of looping a third spawn", async () => {
    const { sup, fake } = makeSupervisor([OVERFLOW, OVERFLOW]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", resume: "poisoned-thread", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 2000);

    expect(final.state).toBe("failed");
    expect(final.failure?.cause).toBe("context-overflow");
    expect(final.contextOverflowRecoveries).toBe(1);            // capped — never incremented past the first recovery
    expect(fake.spawns).toHaveLength(2);                        // original attempt + one relaunch, no third spawn
  });

  it("autocompact thrashing retries once even when both attempts initialize successfully", async () => {
    const thrash: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "oversized" } } },
      { emit: { kind: "turn_complete", data: { errorResult: true } } },
      { fail: { message: "Autocompact is thrashing: the context refilled to the limit" } },
    ];
    const { sup, fake } = makeSupervisor([thrash, thrash]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 2000);
    expect(final.state).toBe("failed");
    expect(final.failure?.cause).toBe("context-overflow");
    expect(final.failureMessage).toContain("Autocompact is thrashing");
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]?.resume).toBeNull();
  });
});

describe("F08 A8: retryable is recorded, never read", () => {
  it("no core source file outside failover.ts reads a .retryable member", () => {
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    walk(srcDir);
    // F05 (per-class retry policy) is the future consumer; until it lands, `retryable` is
    // written by the disposition table and read by nobody — this is the guard that keeps a
    // half-wired retry path from appearing without its own plan.
    const readers = files.filter((f) => /\.retryable\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(srcDir.length));
    expect(readers.filter((f) => f !== "failover.ts")).toEqual([]);
  });
});
