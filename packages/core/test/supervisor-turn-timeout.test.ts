import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { AgentRecord } from "@chimera/core/supervisor";
import type { CrashLoopPolicy } from "@chimera/core/failover";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// R2-TURN-LIFECYCLE: a backend-detected hang (turn_timeout BackendEvent) routes through the
// SAME onError/classifyError disposition a real crash gets today — backend-crash-class,
// which never triggers cross-account failover (matching every other non-rate-limit class).
//
// R2 (self-healing supervision) LANDED ALONGSIDE this feature and changed WHAT that
// disposition actually is: backend-crash-class errors (turn_timeout included) now go through
// AgentSupervisor.scheduleCrashRestart — pause + exponential-backoff auto-resume under the
// crash-loop circuit breaker — instead of failing outright on the very first occurrence. A
// turn_timeout hang therefore now gets automatically retried, not permanently killed; it only
// becomes terminal ("failed", circuitOpen:true) once consecutive crashes exceed the configured
// CrashLoopPolicy.maxRestarts. Tests below assert THAT behavior; the mailbox-drain
// (checkPendingOnSettle) test needs an actual terminal state to exercise its own precondition,
// so it uses a maxRestarts:0 policy so the very first turn_timeout trips the breaker directly.
const castCheck = (s: unknown) => s as unknown as { checkPendingOnSettle(r: AgentRecord): void };

const TIMEOUT_STEP: FakeStep = {
  emit: { kind: "turn_timeout", data: { reason: "idle", elapsedMs: 5000, idleTimeoutMs: 5000 } },
};

describe("AgentSupervisor: turn_timeout routes through onError (R2-TURN-LIFECYCLE)", () => {
  it("does NOT trigger cross-account failover on an auto account — instead gets crash-loop backoff (R2), not an immediate fail", async () => {
    const { sup, fake } = makeSupervisor([[TIMEOUT_STEP], [{ end: { resultText: "unused" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // auto account
    await waitUntil(() => sup.status(rec.agentId).state === "paused");

    const held = sup.status(rec.agentId);
    expect(held.crashCount).toBe(1);
    expect(held.pauseReason).toBe("crash-loop-backoff");
    expect(held.attempts.length).toBe(1);              // no cross-account reroute/second attempt
    expect(held.attempts[0]!.errorClass).toBe("backend-crash");
    expect(fake.spawns.length).toBe(1);                 // no failover spawn attempted (yet — backoff hasn't fired)
  });

  it("appends a status{state:\"paused\", reason:\"crash-loop-backoff\"} event alongside the raw turn_timeout event", async () => {
    const { sup, events } = makeSupervisor([[TIMEOUT_STEP]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await waitUntil(() => sup.status(rec.agentId).state === "paused");
    const tail = events.tail(rec.agentId, 100);
    expect(tail.some((e) => e.kind === "turn_timeout" && e.data["reason"] === "idle")).toBe(true);
    expect(tail.some((e) => e.kind === "status" && e.data["state"] === "paused" && e.data["reason"] === "crash-loop-backoff")).toBe(true);
  });

  it("a turn_timeout-settled record with stranded mail surfaces an undelivered-message status event (checkPendingOnSettle)", async () => {
    // maxRestarts:0 — the very first turn_timeout trips the circuit breaker directly, landing
    // in "failed" (checkPendingOnSettle's own guard requires a terminal state) without waiting
    // through any backoff timer.
    const TRIP_ON_FIRST: CrashLoopPolicy = { maxRestarts: 0, baseDelayMs: 1, maxDelayMs: 1 };
    const { sup, fake, dir, events } = makeSupervisor([[TIMEOUT_STEP]], undefined, { crashLoopPolicy: TRIP_ON_FIRST });
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-tt-1" });
    await waitUntil(() => sup.status("agent-tt-1").state === "failed");
    expect(sup.status("agent-tt-1").circuitOpen).toBe(true);

    new MailboxStore(dir).enqueue("agent-tt-1", { from: "tui", kind: "user_message", text: "hello?" });
    castCheck(sup).checkPendingOnSettle(sup.status("agent-tt-1"));
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);            // no respawn attempted (matches the no-session/failed cases)
    const tail = events.tail("agent-tt-1", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });

  it("a max-duration reason is classified and disposed identically to idle", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "turn_timeout", data: { reason: "max-duration", elapsedMs: 60_000, maxTurnDurationMs: 60_000 } } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await waitUntil(() => sup.status(rec.agentId).state === "paused");
    const held = sup.status(rec.agentId);
    expect(held.pauseReason).toBe("crash-loop-backoff");
    expect(held.attempts[0]!.errorClass).toBe("backend-crash");
  });
});
