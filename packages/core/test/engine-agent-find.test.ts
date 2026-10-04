import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

// makeEngineHome()'s default config has no `caps` override, so it falls back to the daemon's
// default guardrails.maxAgentsTotal (12) -- too small to demonstrate the token-savings ratio
// at anything close to the real fleet's scale (421 agents). Local-only, roomier config
// (same mkdtemp+config.json shape as helpers.ts's makeEngineHome/makeMultiProviderHome) so
// this one test can spawn enough agents to make the size comparison meaningful without
// raising the shared cap every other test file relies on.
function makeRoomyEngineHome(maxAgentsTotal: number): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-roomy-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    caps: { maxAgentsTotal, perAccount: {} },
  }));
  return home;
}

const spawnBody = (over: Record<string, unknown> = {}) =>
  ({ spec: { prompt: "hello", cwd: "/tmp", isolation: "none", ...over } });

const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "x" } }];

// AGENT-LOOKUP-BY-NAME: this suite is the LIVE PROOF the task asked for, run against the
// real Engine/AgentSupervisor code path (agent.spawn -> agent.rename -> agent.find), with
// only the LLM subprocess swapped for FakeAgentBackend -- the same pattern every other
// engine.ts RPC test in this repo already uses. It reproduces the exact 2026-08-14 incident
// shape (an "PROJ-1234 owner" agent colliding with an "PROJ-1234-2" duplicate) and
// asserts the tool surfaces the ambiguity instead of guessing.
describe("agent.find (AGENT-LOOKUP-BY-NAME)", () => {
  it("resolves a single unambiguous displayLabel match — the PROJ-1234 incident's happy path", async () => {
    const e = engineWithScenarios([RUNNING]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    await e.handle("agent.rename", { agentId: rec.agentId, displayLabel: "PROJ-1234 owner" });

    const result = (await e.handle("agent.find", { q: "PROJ-1234" })) as {
      matches: Array<{ id: string; displayLabel?: string }>; totalMatched: number; hint: string | null;
    };
    expect(result.totalMatched).toBe(1);
    expect(result.matches[0]!.id).toBe(rec.agentId);
    expect(result.matches[0]!.displayLabel).toBe("PROJ-1234 owner");
    expect(result.hint).toBeNull();
  });

  it("returns every candidate — never guesses — when the label is ambiguous (the actual bug this closes)", async () => {
    const e = engineWithScenarios([RUNNING, RUNNING]);
    const owner = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    const dup = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    await e.handle("agent.rename", { agentId: owner.agentId, displayLabel: "PROJ-1234 owner" });
    await e.handle("agent.rename", { agentId: dup.agentId, displayLabel: "PROJ-1234-2" });

    const result = (await e.handle("agent.find", { q: "PROJ-1234" })) as {
      matches: Array<{ id: string }>; totalMatched: number; hint: string | null;
    };
    expect(result.totalMatched).toBe(2);
    expect(result.matches.map((m) => m.id).sort()).toEqual([dup.agentId, owner.agentId].sort());
    expect(result.hint).toMatch(/ambiguous/i);
  });

  it("defaults to live agents only, and explains why zero matched instead of returning silence", async () => {
    const e = engineWithScenarios([[{ fail: { message: "boom" } }]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    await e.handle("agent.rename", { agentId: rec.agentId, displayLabel: "PROJ-1234 owner" });
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 }); // settles to failed (terminal)

    const liveOnly = (await e.handle("agent.find", { q: "PROJ-1234" })) as { totalMatched: number; hint: string | null };
    expect(liveOnly.totalMatched).toBe(0);
    expect(liveOnly.hint).toMatch(/do not spawn a substitute/i);

    const widened = (await e.handle("agent.find", { q: "PROJ-1234", live: false })) as { totalMatched: number };
    expect(widened.totalMatched).toBe(1);
  });

  it("matches case-insensitively as a substring, not just a prefix", async () => {
    const e = engineWithScenarios([RUNNING]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    await e.handle("agent.rename", { agentId: rec.agentId, displayLabel: "owner of proj-1234" });
    const result = (await e.handle("agent.find", { q: "PROJ-1234" })) as { totalMatched: number };
    expect(result.totalMatched).toBe(1);
  });

  it("caps results at `limit` and reports truncated:true rather than silently hiding the overflow", async () => {
    const e = engineWithScenarios(Array.from({ length: 5 }, () => RUNNING));
    for (let i = 0; i < 5; i++) {
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.rename", { agentId: rec.agentId, displayLabel: `dup-${i}` });
    }
    const result = (await e.handle("agent.find", { q: "dup", limit: 2 })) as {
      matches: unknown[]; totalMatched: number; truncated: boolean;
    };
    expect(result.matches.length).toBe(2);
    expect(result.totalMatched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("agent.find's filtered response is dramatically smaller than the unfiltered agent.listSummary payload — the token angle", async () => {
    const e = new Engine({
      home: makeRoomyEngineHome(40),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(Array.from({ length: 40 }, () => RUNNING))]]),
    });
    let target = "";
    for (let i = 0; i < 40; i++) {
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const label = i === 17 ? "PROJ-1234 owner" : `agent-${i}`;
      await e.handle("agent.rename", { agentId: rec.agentId, displayLabel: label });
      if (i === 17) target = rec.agentId;
    }
    const full = await e.handle("agent.listSummary", {});
    const found = (await e.handle("agent.find", { q: "PROJ-1234" })) as { matches: Array<{ id: string }> };
    expect(found.matches[0]!.id).toBe(target);
    const fullSize = JSON.stringify(full).length;
    const foundSize = JSON.stringify(found).length;
    // Measured: fullSize=8080 foundSize=305 (26.5x) at 40 synthetic agents; the real fleet
    // (421 agents, 119,052 chars per the incident) makes the ratio far more dramatic.
    expect(foundSize).toBeLessThan(fullSize / 10);
  });

  it("rejects an empty query (zod validation -> protocol error, not a full unfiltered dump)", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.find", { q: "" })).rejects.toMatchObject({ code: "protocol" });
  });
});
