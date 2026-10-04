import { describe, it, expect, vi } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { QuotaTracker } from "@chimera/core/failover";
import { makeSupervisor } from "./helpers.js";

// QUOTA-UNCOOL (supervisor half): clearing the stamp and un-parking the agents that were holding
// for it are one operation — the operator's manual workaround did only the first half and left
// three agents parked.

vi.setConfig({ testTimeout: 15_000 });

const sessionFail = (isoResetAt: string): FakeStep[] => [
  { fail: { message: `You've hit your session limit · resets at ${isoResetAt}` } },
];
const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const HAPPY: FakeStep[] = [{ end: { resultText: "recovered", costUsd: 0.02 } }];
// One account ⇒ a session limit has no failover target and must HOLD.
const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
});

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

describe("clearAccountCooldown", () => {
  it("drops the cooldown, resumes the session-limit-paused agent, and emits the audit event", async () => {
    const resetIso = at(3600_000);   // 1h out — the scheduled resume can never fire inside the test
    const { sup, cooldowns, events } = makeSupervisor([sessionFail(resetIso), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    expect(cooldowns.isCooling("main")).toBe(true);

    const out = sup.clearAccountCooldown("main", "operator");

    expect(out).toMatchObject({ account: "main", wasCooling: true, resumed: [rec.agentId] });
    expect(out.clearedUntil).toBe(Date.parse(resetIso));
    expect(cooldowns.isCooling("main")).toBe(false);
    // The resume is KICKED, not awaited — the agent comes back on its own.
    await until(() => sup.status(rec.agentId).state !== "paused");
    const audit = events.tail("accounts", 50).filter((e) => e.kind === "account_cooldown_cleared");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.agentId).toBe("accounts");
    expect(audit[0]!.data).toMatchObject({ account: "main", clearedBy: "operator", resumed: [rec.agentId] });
  });

  it("carries the poll's evidence into the audit event", async () => {
    const { sup, events } = makeSupervisor([sessionFail(at(3600_000)), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    sup.clearAccountCooldown("main", "quota-poll", { usedFraction: 0.15, rolled: false });

    const audit = events.tail("accounts", 50).filter((e) => e.kind === "account_cooldown_cleared");
    expect(audit[0]!.data).toMatchObject({ clearedBy: "quota-poll", evidence: { usedFraction: 0.15, rolled: false } });
  });

  it("still resumes a parked agent when no cooldown stamp survives (post-restart)", async () => {
    const { sup, cooldowns } = makeSupervisor([sessionFail(at(3600_000)), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");
    // Simulate the restart: CooldownTracker is in-memory, the pause is persisted on the record.
    cooldowns.clear("main");

    const out = sup.clearAccountCooldown("main", "operator");

    expect(out.wasCooling).toBe(false);              // honest: nothing was cooling
    expect(out.resumed).toEqual([rec.agentId]);      // but the agent was still stuck, and moves
    await until(() => sup.status(rec.agentId).state !== "paused");
  });

  it("leaves agents parked for reasons OTHER than a session limit alone", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "ok", costUsd: 0 } }]], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await sup.hold(rec.agentId);
    expect(sup.status(rec.agentId).pauseReason).toBe("operator-hold");

    expect(sup.clearAccountCooldown("main", "operator").resumed).toEqual([]);
    expect(sup.status(rec.agentId).state).toBe("paused");
  });
});

describe("release(force)", () => {
  it("refuses a session-limit pause by default and releases it with force:true", async () => {
    const { sup } = makeSupervisor([sessionFail(at(3600_000)), HAPPY], SOLO);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(await sup.release(rec.agentId)).toBe(false);          // default: left alone by design
    expect(sup.status(rec.agentId).state).toBe("paused");

    expect(await sup.release(rec.agentId, { force: true })).toBe(true);
    expect(sup.status(rec.agentId).state).not.toBe("paused");
  });

  it("does NOT force-release a crash-backoff pause — nothing says a crashing agent stopped crashing", async () => {
    const CRASH: FakeStep[] = [{ fail: { message: "claude process exited with code 1" } }];
    const { sup } = makeSupervisor([CRASH, CRASH], SOLO, {
      crashLoopPolicy: { maxRestarts: 5, baseDelayMs: 3600_000, maxDelayMs: 3600_000 },
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).pauseReason === "crash-loop-backoff");

    expect(await sup.release(rec.agentId, { force: true })).toBe(false);
    expect(sup.status(rec.agentId).state).toBe("paused");
  });
});

// QUOTA-UNCOOL item 5: reconcileResetAt may only LENGTHEN a hold from a reading that is actually
// current. QuotaTracker keeps its last known-good window forever, so without this gate a poll that
// stopped working hours ago would keep stretching every new hold with a long-dead resetsAt.
describe("reconcileResetAt freshness", () => {
  it("extends the hold from a FRESH quota window", async () => {
    const parsedResetIso = at(3600_000);
    const quotaResetAt = Date.now() + 7200_000;
    const quotas = new QuotaTracker();
    quotas.record("main", { kind: "session", usedFraction: 0.96, windowStartedAt: Date.now() - 1000, resetsAt: quotaResetAt });
    const { sup } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas, quotaFreshnessMs: 10 * 60_000 });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(sup.status(rec.agentId).resumeAt).toBe(quotaResetAt);
  });

  it("ignores a STALE quota window and falls back to the parsed reset", async () => {
    const parsedResetIso = at(3600_000);
    const quotaResetAt = Date.now() + 7200_000;   // later than parsed — pre-fix this WOULD extend
    // Recorded through a clock 30 minutes in the past: the window is still in the future and
    // internally consistent, it is just no longer something the poller has confirmed.
    const quotas = new QuotaTracker(() => Date.now() - 30 * 60_000);
    quotas.record("main", { kind: "session", usedFraction: 0.96, windowStartedAt: Date.now() - 60_000, resetsAt: quotaResetAt });
    const { sup } = makeSupervisor([sessionFail(parsedResetIso)], SOLO, { quotas, quotaFreshnessMs: 10 * 60_000 });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "paused");

    expect(sup.status(rec.agentId).resumeAt).toBe(Date.parse(parsedResetIso));
  });
});
