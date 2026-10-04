import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// WD Stage 1 (coverage B1, spend chip) / D15 unification: daemon.status carries
// spendTodayUsd (the per-day sum of result-event costUsd, RE-READ from the usage
// ledger — <home>/usage/usage.jsonl, see UsageLedger.todayUsd) and dailyCapUsd (the
// optional config ceiling, null when unset). Engine-level harness: FakeAgentBackend
// scenarios drive real result events through the EventLog, exactly like engine.test.ts's
// own coverage.

type Status = { spendTodayUsd: number; dailyCapUsd: number | null };

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

// makeEngineHome writes a config WITHOUT dailyCapUsd; this variant sets one.
function homeWithCap(cap: number): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-cap-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    dailyCapUsd: cap,
  }));
  return home;
}

const endWith = (costUsd: number): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText: "ok", costUsd } },
];

describe("daemon.status spendTodayUsd + dailyCapUsd (WD Stage 1)", () => {
  it("starts at 0 spend with a null cap when config.json sets none", async () => {
    const st = (await engineOn(makeEngineHome()).handle("daemon.status", {})) as Status;
    expect(st.spendTodayUsd).toBe(0);
    expect(st.dailyCapUsd).toBeNull();
  });

  it("surfaces the config's dailyCapUsd (additive optional field)", async () => {
    const st = (await engineOn(homeWithCap(25)).handle("daemon.status", {})) as Status;
    expect(st.dailyCapUsd).toBe(25);
  });

  it("accumulates every result event's costUsd into spendTodayUsd", async () => {
    const e = engineOn(makeEngineHome(), [endWith(0.42), endWith(1.08)]);
    for (let i = 0; i < 2; i++) {
      const rec = (await e.handle("agent.spawn", { spec: { prompt: "job", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });
    }
    const st = (await e.handle("daemon.status", {})) as Status;
    expect(st.spendTodayUsd).toBeCloseTo(1.5, 10);
  });

  it("a costUsd-less result adds nothing (folds to 0, never NaN-poisons the ledger)", async () => {
    const e = engineOn(makeEngineHome(), [[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "free" } },                 // no costUsd key at all
    ]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "job", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });
    const st = (await e.handle("daemon.status", {})) as Status;
    expect(st.spendTodayUsd).toBe(0);
  });

  it("spend survives an engine restart on the same home (usage.jsonl, same local day)", async () => {
    const home = makeEngineHome();
    const e1 = engineOn(home, [endWith(2.5)]);
    const rec = (await e1.handle("agent.spawn", { spec: { prompt: "job", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e1.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });

    const e2 = engineOn(home);                          // fresh engine, same home → ledger reloads
    const st = (await e2.handle("daemon.status", {})) as Status;
    expect(st.spendTodayUsd).toBeCloseTo(2.5, 10);
  });
});
