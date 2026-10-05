import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// AGENT-RECONFIGURE: setModel/setEffort/setAccount/setTurnLimit were five copies of one move —
// kill the process, respawn the same agentId into the same session with one field changed. This
// is that move taken once, over a sparse patch, so changing three settings costs ONE respawn
// instead of three (each of which would also interrupt whatever turn was running) — and so the
// fields that never got a setter at all become changeable.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 12 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const spawn = async (e: Engine, spec: Record<string, unknown> = {}) =>
  (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none", ...spec } })) as { agentId: string };

describe("changing settings on a live agent", () => {
  it("applies several at once and keeps the SESSION — the whole point of respawn-with-resume", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e, { maxTurns: 40 });
    await flush();
    const sessionBefore = e.supervisor.status(a.agentId).sessionId;

    const res = await e.handle("agent.reconfigure", {
      agentId: a.agentId,
      patch: { maxTurns: 200, turnLimitPolicy: "soft", effort: "high", contextWindow: 500000 },
    }) as { ok: boolean; respawned: boolean; applied: string[] };

    expect(res.respawned).toBe(true);
    const spec = e.supervisor.status(a.agentId).spec;
    expect(spec.maxTurns).toBe(200);
    expect(spec.turnLimitPolicy).toBe("soft");
    expect(spec.effort).toBe("high");
    expect(spec.contextWindow).toBe(500000);
    await e.handle("agent.reconfigure", { agentId: a.agentId, patch: { contextWindow: null } });
    expect(e.supervisor.status(a.agentId).spec.contextWindow).toBeNull();
    if (sessionBefore) expect(e.supervisor.status(a.agentId).spec.resume).toBe(sessionBefore);
  });

  it("changes fields that never had a setter at all — instructions, autonomy, budget", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.reconfigure", {
      agentId: a.agentId,
      patch: { instructions: "you are now the release manager", autonomy: "full", maxBudgetUsd: 25 },
    });
    const spec = e.supervisor.status(a.agentId).spec;
    expect(spec.instructions).toBe("you are now the release manager");
    expect(spec.autonomy).toBe("full");
    expect(spec.maxBudgetUsd).toBe(25);
  });

  it("a patch that changes nothing is a NO-OP — the panel sends the whole form on every save", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e, { maxTurns: 40, effort: "high" });
    await flush();
    const res = await e.handle("agent.reconfigure", {
      agentId: a.agentId, patch: { maxTurns: 40, effort: "high" },
    }) as { respawned: boolean };
    expect(res.respawned).toBe(false);
  });

  it("live fields apply with NO respawn — a save touching only those never interrupts a turn", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    const res = await e.handle("agent.reconfigure", {
      agentId: a.agentId,
      live: { displayLabel: "release-manager", groups: ["g1"] },
    }) as { respawned: boolean; applied: string[] };

    expect(res.respawned).toBe(false);
    expect(res.applied).toContain("name");
    expect(e.supervisor.status(a.agentId).displayLabel).toBe("release-manager");
    expect(e.supervisor.status(a.agentId).groups).toEqual(["g1"]);
  });
});

describe("what it refuses, and what it says instead", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["provider", "codex", /agent_handoff/],
    ["isolation", "worktree", /agent_rebind/],
    ["cwd", "/elsewhere", /agent_rebind/],
    ["conductor", true, /what the agent IS/],
    ["session", true, /what the agent IS/],
  ];

  for (const [field, value, expected] of cases) {
    it(`refuses ${field} and names what does change it`, async () => {
      const e = new Engine({ home: makeEngineHome(), backends: backends() });
      const a = await spawn(e);
      await flush();
      await expect(e.handle("agent.reconfigure", { agentId: a.agentId, patch: { [field]: value } }))
        .rejects.toThrow(expected);
    });
  }

  // COMPACTION-THRESHOLD-PER-AGENT: the field existed on AgentSpec (settable at spawn) and on the
  // account/provider config, but the live-agent allowlist did not carry it — so the one thing an
  // operator actually wants to do with it, "this running 1M agent is burning context, bring it
  // down to 500k", had no path at all short of killing the agent.
  it("moves a LIVE agent's compaction window, and the ctx meter's denominator with it", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    expect(e.supervisor.status(a.agentId).effectiveContextLimit).toBe(120_000);   // L1-DEFAULT-THRESHOLD, not claude's 200k native

    await e.handle("agent.reconfigure", { agentId: a.agentId, patch: { compactionThreshold: 150_000 } });
    await flush();
    expect(e.supervisor.status(a.agentId).spec.compactionThreshold).toBe(150_000);
    // The meter and the real trigger read ONE resolved value, so this number IS where the CLI
    // now compacts (at ~90% of it) — not a display that agrees by coincidence.
    expect(e.supervisor.status(a.agentId).effectiveContextLimit).toBe(150_000);
  });

  it("CLEARS the override with null, falling back to the account default", async () => {
    // null, not "leave it out": an absent key means "unchanged" in a sparse patch, so without a
    // nullable field there is no way to undo an override — the same shape maxBudgetUsd uses.
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e, { compactionThreshold: 150_000 });
    await flush();
    expect(e.supervisor.status(a.agentId).effectiveContextLimit).toBe(150_000);

    await e.handle("agent.reconfigure", { agentId: a.agentId, patch: { compactionThreshold: null } });
    await flush();
    // L1-DEFAULT-THRESHOLD (F39): "clear my override" now lands on the measured fleet default,
    // not on the model's native window — null drops the SPAWN rung, it does not disable the chain.
    expect(e.supervisor.status(a.agentId).effectiveContextLimit).toBe(120_000);
  });

  it("refuses an unknown setting rather than silently dropping it", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await expect(e.handle("agent.reconfigure", { agentId: a.agentId, patch: { nonsense: 1 } }))
      .rejects.toThrow(/not a reconfigurable agent setting/);
  });

  it("refuses a cross-provider account, pointing at the tool that CAN move a session", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await expect(e.handle("agent.reconfigure", { agentId: a.agentId, patch: { account: "no-such-account" } }))
      .rejects.toThrow();
  });
});
