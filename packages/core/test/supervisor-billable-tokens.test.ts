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
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { fakeExec } from "./helpers.js";

// F11: AgentRecord.billableTokens is the token counterpart of costUsd — a MONOTONE cumulative
// per-record total. Backends report cumulative-PER-SESSION usage, so it is booked as a delta
// against bookedTurnUsage with the same max(0, …) clamp costUsd uses. StepJournal reads this
// field at step open and close and subtracts the two snapshots, so a total that double-counts
// or silently subtracts corrupts every per-step token figure downstream.
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

function makeSupervisor(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-billable-tokens-"));
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(SOLO),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend(scenarios)]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
  });
  return { sup, dir };
}

describe("F11: AgentRecord.billableTokens accumulates cumulative usage without double-counting", () => {
  it("books only the un-booked remainder of each turn's cumulative figure", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { billableUsage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 6 } } } },
      // A SMALLER cumulative than the last turn — a fresh backend session on the same record.
      // The clamp must make this a no-op, never a subtraction.
      { emit: { kind: "turn_complete", data: { billableUsage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 2 } } } },
      { emit: { kind: "turn_complete", data: { billableUsage: { input_tokens: 150, output_tokens: 15, cache_read_input_tokens: 3 } } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).billableTokens?.input === 350);

    // 300, then +0 (smaller cumulative), then +50 — not 550 (naive sum) and not 150 (unclamped).
    expect(sup.status(rec.agentId).billableTokens).toEqual({ input: 350, output: 35, cacheRead: 7, cacheCreation: 0 });
    // The baseline is observable on the record while the turn is live — which is what makes the
    // `toBeUndefined()` assertions in the terminal-path tests below non-vacuous.
    expect(sup.status(rec.agentId).bookedTurnUsage).toEqual({ input: 150, output: 15, cacheRead: 3, cacheCreation: 0 });
    await sup.kill(rec.agentId);
  });

  it("books the terminal result's cumulative usage and clears the per-attempt baseline", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { billableUsage: { input_tokens: 100, output_tokens: 10 } } } },
      { end: { resultText: "ok", billableUsage: { input_tokens: 250, output_tokens: 20 } } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "done");

    // The result's figure is cumulative too: 100 booked mid-run, then its 150 remainder.
    expect(sup.status(rec.agentId).billableTokens).toEqual({ input: 250, output: 20, cacheRead: 0, cacheCreation: 0 });
    // Reset alongside bookedTurnCostUsd — otherwise a respawn on this record would compare the
    // fresh session's reset-to-0 counter against the dead attempt's booked figure and undercount.
    expect(sup.status(rec.agentId).bookedTurnUsage).toBeUndefined();
  });

  it("leaves billableTokens absent for a run that never reported usage", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { end: { resultText: "ok" } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).state === "done");
    expect(sup.status(rec.agentId).billableTokens).toBeUndefined();
  });

  it("books usage on an unclean exit too — the settle path a kill() takes", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "sonnet" } } },
      { emit: { kind: "turn_complete", data: { costUsd: 0, billableUsage: { input_tokens: 80, output_tokens: 8 } } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await until(() => sup.status(rec.agentId).billableTokens?.input === 80);
    await sup.kill(rec.agentId);
    expect(sup.status(rec.agentId).state).toBe("killed");
    // settleUnrecordedUsage must not re-book what turn_complete already booked...
    expect(sup.status(rec.agentId).billableTokens).toEqual({ input: 80, output: 8, cacheRead: 0, cacheCreation: 0 });
    // ...and must clear the baseline wherever it clears bookedTurnCostUsd.
    expect(sup.status(rec.agentId).bookedTurnUsage).toBeUndefined();
  });
});
