import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker, type CrashLoopPolicy } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { fakeExec } from "./helpers.js";

// Same "small ms + real unref'd timers + poll" convention supervisor-session-limit.test.ts
// already established for this class of test (its own comment documents WHY: a full-suite
// parallel vitest run can occasionally race vitest's own per-test timeout against a
// real-but-tiny timer — raising testTimeout is the fix that actually matters there).
vi.setConfig({ testTimeout: 15_000 });

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

// A single-account config: an "auto" spawn has no failover target, so a rate-limit error
// would HOLD — irrelevant here since every scenario below is backend-crash-classified, not
// rate-limit, but kept single-account for the same reason supervisor-session-limit.test.ts
// uses SOLO: no cross-account failover noise to reason about.
const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
});

function makeCrashLoopSupervisor(scenarios: FakeStep[][], crashLoopPolicy: CrashLoopPolicy) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-crashloop-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(SOLO),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    crashLoopPolicy,
  });
  return { sup, fake, dir, events };
}

const CRASH: FakeStep[] = [{ fail: { message: "process exited with code 1" } }];
// Match real backend ordering; only a completed result/turn proves recovery, not startup.
const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "recovered", costUsd: 0.01 } }];
const TINY_POLICY: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 20, maxDelayMs: 1000 };

describe("crash-loop backoff + circuit breaker (R2 self-healing supervision)", () => {
  it.each([
    ["provider-capacity", "Selected model is at capacity. Please try a different model."],
    ["provider-stream", 'Failed to parse item: {"type":"item.started","item":{"command":"unfinished'],
  ])("recovers %s on an explicit account with the same session and a continuation", async (_cause, message) => {
    const interrupted: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "saved-thread" } } },
      { fail: { message } },
    ];
    const { sup, fake, events } = makeCrashLoopSupervisor([interrupted, HAPPY], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "original request with actions", cwd: "/tmp", isolation: "none", account: "main", model: "unchanged-model", resumeOnly: true });
    const result = await sup.waitFor(rec.agentId, 4000);
    expect(result.state).toBe("done");
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]).toMatchObject({ accountName: "main", model: "unchanged-model", resume: "saved-thread", resumeOnly: false });
    expect(fake.spawns[1]!.prompt).toContain("Do not repeat completed actions");
    expect(result.spec.prompt).toBe("original request with actions");
    expect(result.crashCount).toBe(0);
    expect(events.tail(rec.agentId, 100).some(e => e.kind === "failover")).toBe(false);
  });

  it("thread startup alone cannot reset the circuit breaker", async () => {
    const interrupted: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "saved-thread" } } },
      { fail: { message: "Selected model is at capacity. Please try a different model." } },
    ];
    const { sup, fake } = makeCrashLoopSupervisor([interrupted, interrupted, interrupted], { ...TINY_POLICY, maxRestarts: 2 });
    const rec = await sup.spawn({ prompt: "task", cwd: "/tmp", isolation: "none" });
    const result = await sup.waitFor(rec.agentId, 4000);
    expect(result.state).toBe("failed");
    expect(result.circuitOpen).toBe(true);
    expect(result.crashCount).toBe(3);
    expect(fake.spawns).toHaveLength(3);
  });

  it("a backend-crash-classified error pauses the agent (crash-loop-backoff) instead of failing it outright", async () => {
    const { sup, events } = makeCrashLoopSupervisor([CRASH], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    const held = sup.status(rec.agentId);
    expect(held.state).toBe("paused");
    expect(held.crashCount).toBe(1);
    expect(held.pauseReason).toBe("crash-loop-backoff");
    expect(held.circuitOpen).toBeUndefined();

    const paused = events.tail(rec.agentId, 50).find((e) => e.data["paused"] === true);
    expect(paused?.data).toMatchObject({
      state: "paused", reason: "crash-loop-backoff", crashCount: 1, attempt: 1, delayMs: 20,
    });
  });

  it("repeated crashes back off exponentially (attempt/delayMs double each time, no wall-clock measurement needed)", async () => {
    // 3 crashes then a happy resume — asserts the SCHEDULED delayMs/attempt sequence directly
    // off the emitted events, not by measuring elapsed wall-clock gaps (non-flaky).
    const { sup, fake, events } = makeCrashLoopSupervisor([CRASH, CRASH, CRASH, HAPPY], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });

    await until(() => sup.status(rec.agentId).state === "done");
    expect(sup.status(rec.agentId).resultText).toBe("recovered");
    expect(fake.spawns.length).toBe(4);   // initial + 3 resumes

    const pauses = events.tail(rec.agentId, 50)
      .filter((e) => e.kind === "status" && e.data["paused"] === true)
      .map((e) => ({ attempt: e.data["attempt"], delayMs: e.data["delayMs"] }));
    expect(pauses).toEqual([
      { attempt: 1, delayMs: 20 },
      { attempt: 2, delayMs: 40 },
      { attempt: 3, delayMs: 80 },
    ]);
  });

  it("crossing maxRestarts trips the circuit breaker: terminal failed+circuitOpen, no further restart", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 50 };
    const { sup, fake, events } = makeCrashLoopSupervisor([CRASH, CRASH, CRASH], policy);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });

    await until(() => sup.status(rec.agentId).state === "failed");
    const final = sup.status(rec.agentId);
    expect(final.circuitOpen).toBe(true);
    expect(final.crashCount).toBe(2);   // 1st crash backs off (attempt 1 <= maxRestarts 1), 2nd trips (attempt 2 > 1)

    const tail = events.tail(rec.agentId, 50);
    const tripped = tail.find((e) => e.kind === "circuit_breaker_tripped");
    expect(tripped?.data).toMatchObject({ crashCount: 2 });
    const failedStatus = tail.filter((e) => e.kind === "status").find((e) => e.data["state"] === "failed");
    expect(failedStatus?.data).toMatchObject({ state: "failed", circuitOpen: true, crashCount: 2 });

    // give any stray timer a chance to fire, then confirm no further spawn happened
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.spawns.length).toBe(2);   // initial + the one backed-off resume; breaker stopped it there
  });

  it("a successful resume resets crashCount to 0", async () => {
    const { sup } = makeCrashLoopSupervisor([CRASH, HAPPY], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "done");
    expect(sup.status(rec.agentId).crashCount).toBe(0);
  });

  // KIMI-HANDSHAKE-CRASH-PARITY: an ACP handshake rejection's message is generic JSON-RPC
  // boilerplate ("Internal error (code -32603)...") that classifyError would call "unknown" —
  // this proves the data.phase:"handshake" tag (kimi.ts's connectKimiAcp catch) overrides that
  // to backend-crash in onError, giving it the SAME crash-loop-backoff disposition a real
  // process-exit crash gets, instead of falling straight through to a terminal fail.
  it("a phase:handshake-tagged error is treated as backend-crash even though its message classifies as unknown", async () => {
    const HANDSHAKE_FAIL: FakeStep[] = [{ fail: { message: "Internal error (code -32603)", phase: "handshake" } }];
    const { sup, events } = makeCrashLoopSupervisor([HANDSHAKE_FAIL], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    const held = sup.status(rec.agentId);
    expect(held.state).toBe("paused");
    expect(held.pauseReason).toBe("crash-loop-backoff");
    expect(held.crashCount).toBe(1);

    const paused = events.tail(rec.agentId, 50).find((e) => e.data["paused"] === true);
    expect(paused?.data).toMatchObject({ state: "paused", reason: "crash-loop-backoff", crashCount: 1 });
  });

  it("a credential-classified error is unaffected — still fails loudly, crash-loop never engages", async () => {
    const CRED_FAIL: FakeStep[] = [{ fail: { message: "401 Unauthorized: invalid api key" } }];
    const { sup } = makeCrashLoopSupervisor([CRED_FAIL], TINY_POLICY);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    expect(final.crashCount ?? 0).toBe(0);
    expect(final.pauseReason).toBeUndefined();
  });
});
