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
import { UsageLedger } from "@chimera/core/usage";
import { fakeExec } from "./helpers.js";

// LEDGER-UNCLEAN-EXIT: a run that DID real, billable work but never produced a clean "result"
// event (reaped/killed, or crash-looped past the circuit breaker) used to vanish from the usage
// ledger entirely — agentState recorded, costUsd silently $0. usage.ts's ledger only ever
// listened for "result"; every one of these exit paths ends the record without one. This suite
// proves the fix: supervisor.ts now stashes the last "turn_complete" cost/usage per record and
// flushes it as a ledger-only "usage_settle" event at every non-"done" terminal transition.
vi.setConfig({ testTimeout: 15_000 });

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

const SOLO = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
});

function makeSupervisor(scenarios: FakeStep[][], crashLoopPolicy?: CrashLoopPolicy) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-ledger-unclean-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(SOLO),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(crashLoopPolicy ? { crashLoopPolicy } : {}),
  });
  // Mirrors engine.ts's REAL UsageLedger wiring exactly (resolveContext reads the live
  // AgentRecord off supervisor.list()) — proves the fix against the actual production seam,
  // not just supervisor.ts's internal event in isolation.
  const usage = new UsageLedger(dir, {
    events,
    resolveContext: (agentId) => {
      const record = sup.list().find((a) => a.agentId === agentId);
      if (!record) return null;
      return { account: record.accountName, provider: record.provider, model: record.actualModel ?? "sonnet", team: null, job: null };
    },
  });
  return { sup, fake, dir, events, usage };
}

describe("LEDGER-UNCLEAN-EXIT: usage is booked even when a run ends without a clean result", () => {
  it("kill() flushes the last turn_complete's cost/usage instead of losing it to a silent $0", async () => {
    const { sup, events, usage } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 1.23, billableUsage: { input_tokens: 100, output_tokens: 50 } } } },
      { awaitSend: true },   // stay "running" — simulates real work already done, agent still alive
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => (sup.status(rec.agentId).lastTurnCostUsd ?? 0) > 0);

    await sup.kill(rec.agentId);
    expect(sup.status(rec.agentId).state).toBe("killed");
    // The normal "result" path never fired, but BUDGET-UNCLEAN-EXIT-BLIND now books the
    // settled spend onto the record too (not just the ledger) — real spend must count.
    expect(sup.status(rec.agentId).costUsd).toBeCloseTo(1.23, 10);

    const settled = events.tail(rec.agentId, 50).find((e) => e.kind === "usage_settle");
    expect(settled?.data).toMatchObject({ costUsd: 1.23 });

    // The actual regression assertion: real tokens were spent, and the ledger proves it — not
    // agentState alone, the usage.query() row itself carries the non-zero cost.
    const q = usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(1.23, 10);
    expect(q.groups).toEqual([{ key: rec.agentId, costUsd: 1.23, tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, count: 1 }]);
  });

  it("does NOT double-book: a clean result still books through the normal path, kill() on an already-done agent flushes nothing extra", async () => {
    const { sup, usage } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.5, billableUsage: { input_tokens: 10, output_tokens: 5 } } } },
      { end: { resultText: "done", costUsd: 0.5 } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "done");

    await sup.kill(rec.agentId).catch(() => {});   // no-op: kill() guards on running/paused only
    const q = usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(0.5, 10);   // exactly one booking, not two
    expect(q.count).toBe(1);
  });

  it("a genuinely zero-cost kill (nothing ever accrued) stays silent — no phantom $0 row", async () => {
    const { sup, events, usage } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "running");

    await sup.kill(rec.agentId);
    expect(events.tail(rec.agentId, 50).some((e) => e.kind === "usage_settle")).toBe(false);
    expect(usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" }).count).toBe(0);
  });

  it("the crash-loop circuit breaker trip also flushes accrued cost, not just an explicit kill()", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 50 };
    const CRASH: FakeStep[] = [{ fail: { message: "process exited with code 1" } }];
    const WORK_THEN_CRASH: FakeStep[] = [
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 2.5, billableUsage: { input_tokens: 200, output_tokens: 80 } } } },
      { fail: { message: "process exited with code 1" } },
    ];
    const { sup, events, usage } = makeSupervisor([WORK_THEN_CRASH, CRASH, CRASH], policy);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });

    await until(() => sup.status(rec.agentId).state === "failed");
    expect(sup.status(rec.agentId).circuitOpen).toBe(true);

    const settled = events.tail(rec.agentId, 50).find((e) => e.kind === "usage_settle");
    expect(settled?.data).toMatchObject({ costUsd: 2.5 });
    const q = usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(2.5, 10);
  });

  // Follow-up flagged (not shipped) at LEDGER-UNCLEAN-EXIT's own landing: a crash-loop RETRY
  // that goes on to succeed never hits kill()/onError's fail-loud/the circuit breaker — the
  // three sites already covered above — so the crashed attempt's already-accrued cost used to
  // just get silently overwritten by the fresh attempt's own counter (which restarts at 0),
  // instead of ever being booked. This is the MOST COMMON crash-loop outcome (retry-then-
  // recover), not an edge case.
  it("a crash-loop retry that goes on to succeed still books the crashed attempt's accrued cost, not just the survivor's", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 2, baseDelayMs: 10, maxDelayMs: 50 };
    const WORK_THEN_CRASH: FakeStep[] = [
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 2.5, billableUsage: { input_tokens: 200, output_tokens: 80 } } } },
      { fail: { message: "process exited with code 1" } },
    ];
    const RECOVERS: FakeStep[] = [
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { end: { resultText: "done", costUsd: 1.0 } },
    ];
    const { sup, events, usage } = makeSupervisor([WORK_THEN_CRASH, RECOVERS], policy);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });

    await until(() => sup.status(rec.agentId).state === "done");
    expect(sup.status(rec.agentId).circuitOpen).toBeFalsy();   // recovered — never tripped

    // The crashed FIRST attempt's spend must survive as its own settled row: without the fix,
    // only the survivor's $1.00 "result" ever gets booked and this $2.50 usage_settle never
    // fires (record.lastTurnCostUsd was silently overwritten by the second attempt instead).
    const settled = events.tail(rec.agentId, 50).find((e) => e.kind === "usage_settle");
    expect(settled?.data).toMatchObject({ costUsd: 2.5 });

    const q = usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" });
    expect(q.count).toBe(2);   // one settle row (crashed attempt) + one result row (survivor)
    expect(q.totalCostUsd).toBeCloseTo(3.5, 10);   // 2.5 (lost attempt) + 1.0 (the one that finished)
  });

  // BUDGET-UNCLEAN-EXIT-BLIND: before this fix, settleUnrecordedUsage only fed usage.ts's
  // billing ledger — never trackCost/the FEATURE-5 budget governor — so a tree that crash-loops
  // (each attempt burning real turn cost before dying) never tripped its maxBudgetUsd pause no
  // matter how much it spent, because every attempt's cost vanished from budget accounting the
  // moment it crashed.
  it("a killed agent's accrued spend now counts against its tree's budget ceiling, not just the ledger", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.06 } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", maxBudgetUsd: 0.05 });
    await until(() => (sup.status(rec.agentId).lastTurnCostUsd ?? 0) > 0);
    // BUDGET-MIDRUN-BLIND: turn_complete now books its delta into the tree's budget the
    // moment it lands, not just when the run later settles at exit — a persistent agent
    // that never emits "result" would otherwise never trip its own budget ceiling.
    expect(sup.treePaused(rec.agentId)).toBe(true);

    await sup.kill(rec.agentId);
    // Killing must not re-book (and so not double-count) spend turn_complete already booked.
    expect(sup.treePaused(rec.agentId)).toBe(true);
  });

  // BUDGET-MIDRUN-BLIND: a persistent/conductor agent can run for many turns and never emit
  // a "result" at all. Before this fix, its real spend only ever reached the budget governor
  // at exit (settleUnrecordedUsage) — which never runs while it's still alive — so it could
  // burn arbitrarily far past its ceiling without ever tripping the pause.
  it("a long-lived agent with no 'result' yet still trips its budget ceiling turn by turn", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.02 } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.04 } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.06 } } },   // crosses the 0.05 ceiling
      { awaitSend: true },   // still "running" — never reaches "result"
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", maxBudgetUsd: 0.05 });

    await until(() => (sup.status(rec.agentId).lastTurnCostUsd ?? 0) >= 0.06);
    expect(sup.status(rec.agentId).state).toBe("running");   // still alive, no exit/settle path taken
    expect(sup.status(rec.agentId).costUsd).toBeCloseTo(0.06, 10);   // booked live, not stuck at 0
    expect(sup.treePaused(rec.agentId)).toBe(true);
  });

  it("a clean 'result' after several turn_complete events books only the unbooked remainder", async () => {
    const { sup, usage } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.3 } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.7 } } },
      { end: { resultText: "done", costUsd: 1.0 } },   // same cumulative total as the last turn
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });

    await until(() => sup.status(rec.agentId).state === "done");
    // Without the fix's delta bookkeeping, "result" would re-add the full $1.00 on top of the
    // $0.30+$0.70 turn_complete already booked, double-counting to $2.00.
    expect(sup.status(rec.agentId).costUsd).toBeCloseTo(1.0, 10);
    const q = usage.query({ from: 0, to: Date.now() + 1, groupBy: "agent" });
    expect(q.totalCostUsd).toBeCloseTo(1.0, 10);
  });

  it("a crash-loop that never emits a clean result still trips the budget pause on accrued spend", async () => {
    const policy: CrashLoopPolicy = { maxRestarts: 0, baseDelayMs: 10, maxDelayMs: 50 };
    const WORK_THEN_CRASH: FakeStep[] = [
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0.2 } } },
      { fail: { message: "process exited with code 1" } },
    ];
    const { sup } = makeSupervisor([WORK_THEN_CRASH], policy);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", maxBudgetUsd: 0.05 });

    await until(() => sup.status(rec.agentId).state === "failed");
    expect(sup.status(rec.agentId).circuitOpen).toBe(true);
    expect(sup.treePaused(rec.agentId)).toBe(true);
  });
});
