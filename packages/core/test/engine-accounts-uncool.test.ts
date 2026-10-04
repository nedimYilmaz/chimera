import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";

// QUOTA-UNCOOL (RPC surface): accounts.uncool is the operator's override for a cooldown whose
// deadline came from a parsed error string and outlived the actual quota, and agent.release gains
// `force` for the single-agent version of the same problem.

// One account ⇒ a session limit has no failover target and must HOLD.
function makeSoloHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
  }));
  return home;
}

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeSoloHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

const sessionFail = (msFromNow: number): FakeStep[] => [
  { fail: { message: `You've hit your session limit · resets at ${new Date(Date.now() + msFromNow).toISOString()}` } },
];

/** The hold lands on the backend's own error callback — poll agent.status rather than race it. */
async function waitForPaused(e: Engine, agentId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (((await e.handle("agent.status", { agentId })) as { state: string }).state === "paused") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("agent never paused");
}

describe("Engine.handle accounts.uncool", () => {
  it("clears the cooldown and resumes the session-limit-paused agent", async () => {
    const e = engineWithScenarios([sessionFail(3600_000), [{ awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await waitForPaused(e, rec.agentId);

    const out = (await e.handle("accounts.uncool", { name: "main" })) as
      { account: string; wasCooling: boolean; clearedUntil: number | null; resumed: string[] };

    expect(out).toMatchObject({ account: "main", wasCooling: true, resumed: [rec.agentId] });
    expect(typeof out.clearedUntil).toBe("number");
  });

  it("rejects an unknown account instead of silently succeeding", async () => {
    const e = engineWithScenarios([[{ awaitSend: true }]]);
    await expect(e.handle("accounts.uncool", { name: "nope" })).rejects.toThrow();
  });

  it("is a no-op-shaped success when nothing is cooling", async () => {
    const e = engineWithScenarios([[{ awaitSend: true }]]);
    expect(await e.handle("accounts.uncool", { name: "main" })).toMatchObject({
      account: "main", wasCooling: false, clearedUntil: null, resumed: [],
    });
  });
});

describe("Engine.handle agent.release force", () => {
  it("skips a session-limit pause by default and releases it with force:true", async () => {
    const e = engineWithScenarios([sessionFail(3600_000), [{ awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await waitForPaused(e, rec.agentId);

    expect(await e.handle("agent.release", { agentIds: [rec.agentId] }))
      .toMatchObject({ released: [], skipped: [{ agentId: rec.agentId, state: "paused" }] });

    expect(await e.handle("agent.release", { agentIds: [rec.agentId], force: true }))
      .toMatchObject({ released: [rec.agentId] });
  });
});
