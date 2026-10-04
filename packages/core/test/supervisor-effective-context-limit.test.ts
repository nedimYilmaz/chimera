import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema, DEFAULT_COMPACTION_THRESHOLD, clampCompactionThresholdForProvider } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor, makeMultiProviderSupervisor, CFG, MULTI_CFG } from "./helpers.js";

// R2 (ctx meter effective-limit): AgentRecord.effectiveContextLimit — stamped by launch() on
// every (re)spawn, mirroring how compactionThreshold itself is resolved (COMPACTION-THRESHOLD-CONFIG)
// and rides agent.list/agent.status verbatim, like gitBranch/turnBudgetExceeded before it
// (supervisor-gitbranch.test.ts is the precedent this file's rig mirrors).

const settle = () => new Promise((r) => setTimeout(r, 20));

// reports a sessionId (so setModel has something to resume) and parks forever.
const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor: effectiveContextLimit (R2 ctx meter)", () => {
  // L1-DEFAULT-THRESHOLD (F39): for claude, "nothing configured" no longer means "the model's
  // native window" — the measured fleet default is the trigger, so it is also the meter's
  // denominator. Codex instead waits for its own session telemetry.
  it("no compactionThreshold configured, claude -> the L1 fleet default, NOT the catalog default model's 200k native window", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(120_000);
  });

  it("no compactionThreshold configured, claude, a pinned model with a LARGER native window -> still the L1 fleet default", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", model: "gpt-5.6-terra" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(120_000);   // not the model's 272k
  });

  it("CLAMP-IDENTITY: the shipped claude default sits inside the SDK's auto-compact range, so the meter's clamp is a no-op on it", async () => {
    // If the default ever drops below CLAUDE_AUTO_COMPACT_WINDOW_MIN, claude.ts silently clamps
    // the REAL trigger up while this constant keeps reading lower — the exact meter/trigger
    // divergence CTX-METER-TRIGGER-CLAMP exists to stop. Pin it here, not just in a comment.
    expect(clampCompactionThresholdForProvider("claude", DEFAULT_COMPACTION_THRESHOLD["claude"]))
      .toBe(DEFAULT_COMPACTION_THRESHOLD["claude"]);
  });

  it("no compactionThreshold configured, codex (no fleet default), a pinned model with a DIFFERENT native window -> waits for provider telemetry", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", model: "gpt-5.6-terra" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  it("no pinned model, codex provider -> keeps the window unknown until provider telemetry arrives", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  it("a provider-level compactionThreshold override wins over the model's native window, even when the window is larger", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...CFG, providerOverrides: { claude: { compactionThreshold: 150_000 } },
    });
    const { sup } = makeSupervisor([[{ awaitSend: true }]], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });   // 200k native
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(150_000);
  });

  it("an account-level compactionThreshold override wins over the provider-level default (mirrors accounts.test.ts's own precedence table)", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...CFG,
      accounts: [
        { ...CFG.accounts[0], compactionThreshold: 150_000 },
        CFG.accounts[1],
      ],
      providerOverrides: { claude: { compactionThreshold: 300_000 } },
    });
    const { sup } = makeSupervisor([[{ awaitSend: true }], [{ awaitSend: true }]], cfg);
    const mainRec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });               // -> "main" (perAccount cap routes here first)
    expect(sup.status(mainRec.agentId).effectiveContextLimit).toBe(150_000);
  });

  // CTX-METER-TRIGGER-CLAMP: a configured value outside claude.ts's own SDK-validated auto-compact
  // range [100_000, 1_000_000] must clamp identically here — otherwise the meter's denominator
  // diverges from the point compaction actually fires at (CTX-COMPACTION-AUDIT finding B).
  it("a claude compactionThreshold below the SDK's floor clamps UP to 100_000, matching claude.ts's real trigger", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...CFG, providerOverrides: { claude: { compactionThreshold: 50_000 } },
    });
    const { sup } = makeSupervisor([[{ awaitSend: true }]], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(100_000);
  });

  it("a claude compactionThreshold above the SDK's ceiling clamps DOWN to 1_000_000, matching claude.ts's real trigger", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...CFG, providerOverrides: { claude: { compactionThreshold: 5_000_000 } },
    });
    const { sup } = makeSupervisor([[{ awaitSend: true }]], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(1_000_000);
  });

  it("a codex compactionThreshold outside claude's SDK range is NOT clamped — codex has no such SDK floor/ceiling, the raw value IS its real trigger", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...MULTI_CFG, providerOverrides: { codex: { compactionThreshold: 50_000 } },
    });
    const { sup } = makeMultiProviderSupervisor([], [[{ awaitSend: true }]], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(50_000);
  });

  it("setModel to a model with a DIFFERENT native window keeps capacity unknown until that model reports it", async () => {
    // A model-name change alone cannot establish the new Codex session window.
    const { sup } = makeMultiProviderSupervisor([], [RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", model: "gpt-5.6-terra" });
    await settle();
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);

    const updated = await sup.setModel(rec.agentId, "gpt-5.6-sol");
    expect(updated.effectiveContextLimit).toBe(0);
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  it("setModel with a configured compactionThreshold: the threshold survives the model change unchanged (an account/provider-level override doesn't move just because the model did)", async () => {
    const cfg = ChimeraConfigSchema.parse({
      ...CFG, providerOverrides: { claude: { compactionThreshold: 150_000 } },
    });
    const { sup } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", model: "gpt-5.6-terra" });
    await settle();
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(150_000);

    const updated = await sup.setModel(rec.agentId, "gpt-5.6-sol");
    expect(updated.effectiveContextLimit).toBe(150_000);
  });

  // CTX-METER-STALE-DENOM: the backend-reported actualModel can diverge from the pre-spawn
  // guess (spec.model ?? provider default) WITHOUT any respawn — an unpinned spawn whose
  // agent_started resolves to a different default than guessed, or an in-session /model change
  // surfaced only via a later message-level event. Neither goes through launch() again, so
  // effectiveContextLimit must be re-resolved off onEvent's actualModel capture instead.
  it("actualModel arrives DIFFERENT from the unpinned guess (no respawn) -> does not guess a window from the model name", async () => {
    // codex, because claude's L1 fleet default would pin the denominator regardless of model and
    // the re-stamp would be invisible. The re-stamp path itself is provider-agnostic.
    const { sup } = makeMultiProviderSupervisor([], [[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { awaitSend: true },
    ]]);
    // A default model name is known, but no session window has been reported.
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);

    await settle();
    // An actual model name still does not establish its active window.
    expect(sup.status(rec.agentId).actualModel).toBe("gpt-5.6-terra");
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  it("a SPAWN's own compactionThreshold survives the actualModel re-stamp — the meter never drifts off the real trigger", async () => {
    // COMPACTION-THRESHOLD-ONE-FORMULA. The re-stamp above re-resolves the denominator when the
    // backend reports a model the pre-spawn guess got wrong. It used to read ONLY the
    // account/provider registry, so a per-spawn window was thrown away at that moment: the CLI
    // went on compacting at 300k (the window it was handed at spawn) while the meter divided by
    // the model's native 1.05M. The operator would watch a 20%-full agent compact.
    const { sup } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-sol" } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", compactionThreshold: 300_000 });
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(300_000);

    await settle();
    expect(sup.status(rec.agentId).actualModel).toBe("gpt-5.6-sol");   // 1.05M native, ignored
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(300_000);
  });

  it("a later message-level event reports a DIFFERENT model mid-session (no respawn, e.g. an in-session /model change) -> clears a guessed context window", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { emit: { kind: "message_complete", data: { model: "gpt-5.6-sol" } } },
      { awaitSend: true },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    await settle();
    // Both events land by the time settle() flushes; the FINAL state must reflect the LATER
    // message_complete model, not get stuck on agent_started's — proving the recompute fires
    // again on a second divergence, not just once at first-model-arrival.
    expect(sup.status(rec.agentId).actualModel).toBe("gpt-5.6-sol");
    expect(sup.status(rec.agentId).effectiveContextLimit).toBe(0);
  });

  // CTX-METER-LIVE-FORWARD: the tests above only assert the SERVER's own record state
  // (sup.status()) recomputes correctly — they don't prove a subscribed CLIENT ever learns the
  // new value, which is the actual bug: the desktop app never re-fetches agent.list after its
  // one-shot bootstrap snapshot (see ui-state/createStore.ts), so only the live event stream can
  // carry a post-spawn change to it. These assert the emitted NormalizedEvent's own `data`.
  it("agent_started's emitted event carries the record's effectiveContextLimit", async () => {
    const { sup, events } = makeMultiProviderSupervisor([], [[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { awaitSend: true },
    ]]);
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "agent_started") seen.push(e.data["effectiveContextLimit"]); });
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    await settle();
    expect(seen).toEqual([0]);
  });

  it("an in-session model change's message_complete carries the NEW effectiveContextLimit in its own event data (not just agent_started's)", async () => {
    const { sup, events } = makeMultiProviderSupervisor([], [[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { emit: { kind: "message_complete", data: { model: "gpt-5.6-sol", text: "hi" } } },
      { awaitSend: true },
    ]]);
    const seen: Array<{ kind: string; limit: unknown }> = [];
    events.subscribe((e) => {
      if (e.kind === "agent_started" || e.kind === "message_complete") {
        seen.push({ kind: e.kind, limit: e.data["effectiveContextLimit"] });
      }
    });
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    await settle();
    expect(seen).toEqual([
      { kind: "agent_started", limit: 0 },
      { kind: "message_complete", limit: 0 },
    ]);
  });

  it("a message_complete that reports the SAME model as before carries no effectiveContextLimit (nothing changed, no spurious re-forward)", async () => {
    const { sup, events } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { emit: { kind: "message_complete", data: { model: "gpt-5.6-terra", text: "hi" } } },
      { awaitSend: true },
    ]]);
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "message_complete") seen.push(e.data["effectiveContextLimit"]); });
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await settle();
    expect(seen).toEqual([undefined]);
  });

  it("a message_complete carrying an SDK sentinel placeholder model (e.g. '<synthetic>') never forwards a limit derived from it", async () => {
    const { sup, events } = makeSupervisor([[
      { emit: { kind: "agent_started", data: { model: "gpt-5.6-terra" } } },
      { emit: { kind: "message_complete", data: { model: "<synthetic>", text: "hi" } } },
      { awaitSend: true },
    ]]);
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "message_complete") seen.push(e.data["effectiveContextLimit"]); });
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await settle();
    expect(seen).toEqual([undefined]);
  });
});


it("preserves Codex session capacity, model maximum and compaction threshold separately in snapshots", async () => {
  const contextLimits = { source: "codex" as const, defaultWindow: 272000, maxWindow: 872000, sessionWindow: 258400, compactAt: 120000 };
  const { sup } = makeMultiProviderSupervisor([], [[
    { emit: { kind: "agent_started", data: { model: "gpt-6-astra" } } },
    { emit: { kind: "usage", data: { contextOnly: true, contextLimits, effectiveContextLimit: 120000 } } },
    { awaitSend: true },
  ]]);
  const rec = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", provider: "codex" });
  await settle();
  expect(sup.status(rec.agentId).contextLimits).toEqual(contextLimits);
  expect(sup.status(rec.agentId).effectiveContextLimit).toBe(120000);
  await sup.kill(rec.agentId);
});
