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
  it.each(["running", "paused", "failed"] as const)("explicit Codex full-risk grant applies to %s settings without a respawn", async state => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]], "codex");
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["codex", fake]]) });
    await e.handle("config.patch", { patch: { accounts: [{ name: "codex", provider: "codex", auth: { type: "subscription" } }], autoOrder: ["codex"] } });
    const a = await spawn(e, { provider: "codex", account: "codex", permissionProfile: "acceptEdits" });
    try {
      const record = e.supervisor.status(a.agentId);
      record.state = state;
      for (const grant of [undefined, false, "true"]) {
        await expect(e.handle("agent.reconfigure", { agentId: a.agentId, live: { permissionProfile: "full" }, patch: grant === undefined ? {} : { acknowledgeCodexFullAccessRisk: grant } })).rejects.toThrow("risk grant");
        expect(record.spec.permissionProfile).toBe("acceptEdits");
        expect(record.spec.acknowledgeCodexFullAccessRisk).toBe(false);
      }
      const result = await e.handle("agent.reconfigure", { agentId: a.agentId, live: { permissionProfile: "full", permissionRequest: "auto" }, patch: { acknowledgeCodexFullAccessRisk: true } });
      expect(result).toMatchObject({ respawned: false, applied: ["permission"], state });
      expect(fake.spawns).toHaveLength(1);
      expect(record.spec).toMatchObject({ permissionProfile: "full", acknowledgeCodexFullAccessRisk: true });
      expect(e.events.tail(a.agentId, 30).some(event => event.data.permissionChanged && event.data.acknowledgeCodexFullAccessRisk === true)).toBe(true);
    } finally { await e.supervisor.kill(a.agentId); }
  });

  it("enables native MCP settings for one agent without losing its session or changing fleet defaults", async () => {
    const fake = new FakeAgentBackend(Array.from({ length: 6 }, () => [
      { emit: { kind: "agent_started" as const, data: { sessionId: "native-plugin-session" } } },
      { awaitSend: true as const },
    ]));
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    await e.handle("config.patch", { patch: { leanAgentContext: true } });
    const a = await spawn(e, { loadSettings: false });
    await flush();
    expect(fake.spawns[0]!.providerOptions.strictMcpConfig).toBe(true);
    expect(fake.spawns[0]!.inherit.settingSources).toEqual([]);
    expect(e.supervisor.status(a.agentId).sessionId).toBe("native-plugin-session");
    const patch = { loadSettings: true, strictMcpConfig: false };
    await e.handle("agent.reconfigure", { agentId: a.agentId, patch });
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]).toMatchObject({ agentId: a.agentId, resume: "native-plugin-session", strictMcpConfig: false });
    expect(fake.spawns[1]!.providerOptions.strictMcpConfig).toBeUndefined();
    expect(fake.spawns[1]!.inherit.settingSources).toEqual(["project", "user"]);
    expect(await e.handle("agent.reconfigure", { agentId: a.agentId, patch })).toMatchObject({ respawned: false });
    expect(fake.spawns).toHaveLength(2);
    await spawn(e);
    expect(fake.spawns[2]!.providerOptions.strictMcpConfig).toBe(true);
    await e.handle("agent.reconfigure", { agentId: a.agentId, patch: { strictMcpConfig: true } });
    expect(fake.spawns[3]!.strictMcpConfig).toBe(true);
  });

  it("validates native MCP configuration before stopping the existing process and replaces a legacy override", async () => {
    const fake = new FakeAgentBackend(Array.from({ length: 4 }, () => [{ awaitSend: true as const }]));
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    const a = await spawn(e, { strictMcpConfig: false, providerOptions: { strictMcpConfig: true, unrelated: "preserved" } });
    const before = e.supervisor.status(a.agentId);
    await expect(e.handle("agent.reconfigure", { agentId: a.agentId, patch: { strictMcpConfig: "false" } })).rejects.toThrow(/boolean/);
    expect(e.supervisor.status(a.agentId)).toBe(before);
    expect(fake.spawns).toHaveLength(1);
    await e.handle("agent.reconfigure", { agentId: a.agentId, patch: { strictMcpConfig: false } });
    expect(fake.spawns[1]!.strictMcpConfig).toBe(false);
    expect(fake.spawns[1]!.providerOptions.strictMcpConfig).toBeUndefined();
    expect(fake.spawns[1]!.providerOptions.unrelated).toBe("preserved");
  });

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
