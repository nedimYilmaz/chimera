import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver, type ExecFn } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore, type MailboxMessage } from "@chimera/core/mailbox";
import { CooldownTracker, type CrashLoopPolicy } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { makeSupervisor, CFG } from "./helpers.js";

// AGENT-FAILURE-REACHES-CONDUCTOR: before this fix, afterResult() (the "result"/done path) was
// the ONLY place that ever notified a deliverTo mailbox — every one of the 7 places supervisor.ts
// commits record.state = "failed" duplicated "set state + append status event" by hand and none
// of them told the conductor. This file proves each of the 7 sites now delivers EXACTLY ONE
// "child_failed" mailbox message, that a crash-loop retry (not yet given up) delivers NOTHING,
// and that a live credential embedded in stderr/reason text never reaches the conductor raw.
//
// Every test's "conductor" is spawned and run to completion FIRST, then the failing child is
// spawned with deliverTo pointing at it. This is deliberate, not incidental: deliverPending()
// drains+ACKs a mailbox message the instant its target is live and running (same as a real
// conductor mid-conversation), so the message would otherwise vanish from mailboxes.pending()
// before a test could inspect its shape — a settled (done) target keeps the message parked so
// its full kind/text/meta (error/exitCode/stderrTail) stays inspectable.

vi.setConfig({ testTimeout: 15_000 });

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

const CONDUCTOR: FakeStep[] = [{ end: { resultText: "conductor done" } }];

function childFailures(dir: string, conductorId: string): MailboxMessage[] {
  return new MailboxStore(dir).pending(conductorId).filter((m) => m.kind === "child_failed");
}

// ---------- Site 1: onError's rerouted-launch .catch (cross-account failover, then launch() throws) ----------

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 1 — onError rerouted-launch catch", () => {
  it("delivers exactly one child_failed when the rerouted account's launch() rejects", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        // deliberately-unset env var: credential resolution on the rerouted account throws
        // inside launch(), exercising onError's rerouted-launch .catch (supervisor.ts ~line 1696).
        { name: "second", provider: "claude", auth: { type: "env", var: "CHIMERA_TEST_UNSET_VAR_AFRC1", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
      ],
      autoOrder: ["main", "second"],
    });
    const RATE_FAIL: FakeStep[] = [{ fail: { message: "rate limit exceeded" } }];
    const { sup, dir } = makeSupervisor([CONDUCTOR, RATE_FAIL], cfg);
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", deliverTo: conductor.agentId }); // auto → main first attempt

    const final = await sup.waitFor(child.agentId, 2000);
    expect(final.state).toBe("failed");

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ from: child.agentId, kind: "child_failed" });
    expect(String(failures[0]!.meta?.["error"])).toContain("rerouted launch failed");
  });
});

// ---------- Site 2: onError's plain fail-loud fallback (non-rate-limit, non-crash class) ----------

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 2 — onError plain fail-loud fallback", () => {
  it("delivers exactly one child_failed for a credential-class error (not rate-limit, not backend-crash)", async () => {
    const CRED_FAIL: FakeStep[] = [{ fail: { message: "401 Unauthorized: invalid api key" } }];
    const { sup, dir } = makeSupervisor([CONDUCTOR, CRED_FAIL], CFG);
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });

    const final = await sup.waitFor(child.agentId, 2000);
    expect(final.state).toBe("failed");

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ from: child.agentId, kind: "child_failed" });
    expect(String(failures[0]!.meta?.["error"])).toContain("401 Unauthorized");
  });
});

// ---------- Site 3 + Gap D: crash-loop circuit breaker (retry stays silent, give-up notifies) ----------

const CRASH: FakeStep[] = [{ fail: { message: "process exited with code 1" } }];
const CRASH_RECOVER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "recovered" } }];

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 3 / Gap D — crash-loop circuit breaker", () => {
  it("a crash that WILL be retried delivers NOTHING to the conductor's mailbox", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 20_000, maxDelayMs: 60_000 };
    const { sup, dir } = makeSupervisor([CONDUCTOR, CRASH], CFG, { crashLoopPolicy: policy });
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });

    await until(() => sup.status(child.agentId).state === "paused");
    expect(sup.status(child.agentId).circuitOpen).toBeUndefined();
    expect(childFailures(dir, conductor.agentId)).toHaveLength(0);
  });

  it("the terminal circuit-breaker give-up delivers exactly one child_failed (after N-1 silent retries)", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 1, baseDelayMs: 5, maxDelayMs: 50 };
    const { sup, dir, events } = makeSupervisor([CONDUCTOR, CRASH, CRASH], CFG, { crashLoopPolicy: policy });
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });

    await until(() => sup.status(child.agentId).state === "failed");
    expect(sup.status(child.agentId).circuitOpen).toBe(true);
    // circuitOpen/crashCount ride the STATUS event (full diagnostic picture, per markFailed's
    // `extra`) — the mailbox meta itself only ever carries error/exitCode/stderrTail (B's spec).
    const failedEvent = events.tail(child.agentId, 50).find((e) => e.kind === "status" && e.data["state"] === "failed");
    expect(failedEvent?.data).toMatchObject({ circuitOpen: true, crashCount: 2 });

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ from: child.agentId, kind: "child_failed" });
  });

  it("a crash-loop that RECOVERS before the circuit trips delivers nothing at all", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 10, maxDelayMs: 50 };
    const { sup, dir } = makeSupervisor([CONDUCTOR, CRASH, CRASH_RECOVER], CFG, { crashLoopPolicy: policy });
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });

    await until(() => sup.status(child.agentId).state === "done");
    expect(childFailures(dir, conductor.agentId)).toHaveLength(0);
  });
});

// ---------- Site 4: resumePaused's launch() .catch (session-limit HOLD, resume relaunch fails) ----------

const sessionFail = (isoResetAt: string): FakeStep[] => [
  { fail: { message: `You've hit your session limit · resets at ${isoResetAt}` } },
];
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function makeFlakyConductorSupervisor(exec: ExecFn, childScenario: FakeStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-afrc4-"));
  const cfg = ChimeraConfigSchema.parse({
    accounts: [{ name: "flaky", provider: "claude", auth: { type: "command", run: "irrelevant", injectAs: "ANTHROPIC_API_KEY" } }],
    autoOrder: ["flaky"],
  });
  const fake = new FakeAgentBackend([CONDUCTOR, childScenario]);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(exec),
    backends: new Map([["claude", fake]]),
    events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
  });
  return { sup, dir, events };
}

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 4 — resumePaused's re-launch catch", () => {
  it("delivers exactly one child_failed when the session-limit auto-resume's re-launch throws", async () => {
    let calls = 0;
    // call 1: conductor's initial credential resolve. call 2: child's initial credential resolve
    // (→ hits the session limit). call 3: the auto-resume's re-launch credential resolve → FAILS.
    const exec: ExecFn = async () => {
      calls++;
      return calls <= 2 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 };
    };
    const { sup, dir } = makeFlakyConductorSupervisor(exec, sessionFail(at(40)));
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "flaky", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "flaky", isolation: "none", deliverTo: conductor.agentId });

    await until(() => sup.status(child.agentId).state === "failed", 3000);

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ from: child.agentId, kind: "child_failed" });
    expect(String(failures[0]!.meta?.["error"])).toContain("resume failed");
  });
});

// ---------- Sites 5, 6, 7: setModel / setEffort / setAccount's atomic-failure recovery ----------

const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

function makeFlakySupervisorForRpc(exec: ExecFn) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-afrc567-"));
  const cfg = ChimeraConfigSchema.parse({
    accounts: [{ name: "flaky", provider: "claude", auth: { type: "command", run: "irrelevant", injectAs: "ANTHROPIC_API_KEY" } }],
    autoOrder: ["flaky"],
  });
  const fake = new FakeAgentBackend([CONDUCTOR, RUNNING_WITH_SESSION]);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(exec),
    backends: new Map([["claude", fake]]),
    events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
  });
  return { sup, dir };
}

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 5 — setModel's atomic-failure recovery", () => {
  it("delivers exactly one child_failed when the model-change respawn's launch() throws", async () => {
    let calls = 0;
    const exec: ExecFn = async () => { calls++; return calls <= 2 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 }; };
    const { sup, dir } = makeFlakySupervisorForRpc(exec);
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "flaky", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "flaky", isolation: "none", deliverTo: conductor.agentId });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setModel(child.agentId, "claude-sonnet-5")).rejects.toThrow(/credential/i);

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.meta?.["error"])).toContain("model change failed");
  });
});

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 6 — setEffort's atomic-failure recovery", () => {
  it("delivers exactly one child_failed when the effort-change respawn's launch() throws", async () => {
    let calls = 0;
    const exec: ExecFn = async () => { calls++; return calls <= 2 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 }; };
    const { sup, dir } = makeFlakySupervisorForRpc(exec);
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "flaky", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "flaky", isolation: "none", deliverTo: conductor.agentId });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setEffort(child.agentId, "high")).rejects.toThrow(/credential/i);

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.meta?.["error"])).toContain("effort change failed");
  });
});

describe("AGENT-FAILURE-REACHES-CONDUCTOR: site 7 — setAccount's atomic-failure recovery", () => {
  it("delivers exactly one child_failed when the account-switch respawn's launch() throws", async () => {
    // "main" (subscription) needs no exec call at all — the ONLY exec invocation this test
    // ever makes is setAccount's respawn onto "second" (keychain), which always fails here.
    const alwaysFailExec: ExecFn = async () => ({ stdout: "", code: 1 });
    const dir = mkdtempSync(join(tmpdir(), "chimera-sup-afrc7-"));
    const fake = new FakeAgentBackend([CONDUCTOR, RUNNING_WITH_SESSION]);
    const events = new EventLog(dir);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(CFG),
      credentials: new CredentialResolver(alwaysFailExec),
      backends: new Map([["claude", fake]]),
      events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
    });
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none", deliverTo: conductor.agentId });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setAccount(child.agentId, "second")).rejects.toThrow();

    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.meta?.["error"])).toContain("account change failed");
  });
});

// ---------- Credential scrubbing (spec §6): stderrTail/reason redacted in BOTH the status event and the mailbox message ----------

describe("AGENT-FAILURE-REACHES-CONDUCTOR: credential scrubbing", () => {
  it("redacts a live secret out of stderrTail in both the appended status event and the delivered child_failed message", async () => {
    // "second" is a keychain account (fakeExec resolves it to the literal secret "tok-second") —
    // by the time the crash fires, that value is a registered secret (this.secrets), so both
    // the durable event log and the mailbox message must have it stripped, never raw.
    const policy: CrashLoopPolicy = { maxRestarts: 0, baseDelayMs: 5, maxDelayMs: 50 };
    const CRASH_WITH_SECRET: FakeStep[] = [
      { fail: { message: "process exited with code 1", exitCode: 1, stderrTail: "fatal: leaked credential token=tok-second" } },
    ];
    const { sup, dir, events } = makeSupervisor([CONDUCTOR, CRASH_WITH_SECRET], CFG, { crashLoopPolicy: policy });
    const conductor = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(conductor.agentId, 1000);
    const child = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: conductor.agentId });

    await until(() => sup.status(child.agentId).state === "failed");

    // the appended status(failed) event
    const failedEvent = events.tail(child.agentId, 50).find((e) => e.kind === "status" && e.data["state"] === "failed" && e.data["circuitOpen"] === true);
    expect(failedEvent).toBeDefined();
    expect(String(failedEvent?.data["stderrTail"])).not.toContain("tok-second");
    expect(String(failedEvent?.data["stderrTail"])).toContain("[REDACTED]");
    expect(String(failedEvent?.data["error"])).not.toContain("tok-second");

    // the delivered mailbox message
    const failures = childFailures(dir, conductor.agentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.text).not.toContain("tok-second");
    expect(String(failures[0]!.meta?.["stderrTail"])).not.toContain("tok-second");
    expect(String(failures[0]!.meta?.["stderrTail"])).toContain("[REDACTED]");
    expect(failures[0]!.meta?.["exitCode"]).toBe(1);

    // never present raw anywhere in the durable event log file
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "events", "events.jsonl"), "utf8")).not.toContain("tok-second");
  });
});

// ---------- checkDeliverTargetSettled also applies to child_failed (not just child_result) ----------

describe("AGENT-FAILURE-REACHES-CONDUCTOR: checkDeliverTargetSettled covers child_failed too", () => {
  it("a child_failed arriving after its deliverTo target already settled is surfaced as undeliveredMessage, not silently dropped", async () => {
    const CRED_FAIL: FakeStep[] = [{ fail: { message: "401 Unauthorized: invalid api key" } }];
    const { sup, events } = makeSupervisor([CONDUCTOR, CRED_FAIL], CFG);
    const p = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(p.agentId, 1000);   // parent settles BEFORE the child ever fails
    const c = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: p.agentId });
    await sup.waitFor(c.agentId, 1000);

    const undelivered = events.tail(p.agentId, 50).find((e) => e.data["undeliveredMessage"] === true);
    expect(undelivered?.data["reason"]).toContain("child_result arrived after deliverTo target settled");
  });
});
