import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";

// R2 (ctx meter effective-limit): deterministic full-boot blackbox — a REAL chimerad subprocess
// (CHIMERA_BACKEND=fake substitutes FakeAgentBackend per provider, mirrors providers.test.ts's
// own precedent) driven entirely through the real RPC/ChimeraClient surface, asserting only
// observable outcomes (agent.spawn's own response, agent.status) — never reaching into engine
// internals. Proves AgentRecord.effectiveContextLimit resolves correctly end to end: claude's
// operator-configured compactionThreshold winning over the native window, and the Codex contract
// (da6eed0f) — a Codex window is NEVER guessed from a model name, so it is 0 (unknown) at spawn
// until the provider reports one, or the configured compactionThreshold when there is one — over
// the real wire, not just in a unit test that hand-constructs a ResolvedAgentSpec. The "provider
// later reports its authoritative window" half cannot be driven from here (the daemon's fake
// backend runs its default script and exposes no event-injection seam); core's
// supervisor-effective-context-limit.test.ts pins that usage -> contextLimits update.

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-ctxlimit-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "cl", provider: "claude", auth: { type: "subscription" } },
      { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-ctxlimit-codex-")) } },
    ],
    autoOrder: ["cl", "cx"],
    // an operator-configured compaction threshold for claude ONLY — codex stays native, so the
    // two providers' resolved limits must differ for two DIFFERENT reasons (threshold vs window).
    // ABOVE 100k ON PURPOSE: CTX-METER-TRIGGER-CLAMP floors a claude window at
    // CLAUDE_AUTO_COMPACT_WINDOW_MIN, because the Agent SDK's own schema is
    // `autoCompactWindow: z.number().int().min(1e5)`. A value below that clamps UP, so it would
    // assert the clamp rather than the override — pick one the clamp cannot touch.
    providerOverrides: { claude: { compactionThreshold: 150_000 } },
  }));
  return home;
}

// L1-DEFAULT-THRESHOLD (F39) rollback home: NO claude override at all, so the fleet default is
// what resolves — plus the documented one-line rollback an operator writes to opt out of it.
// F39.QA-A (finding M-1): that rollback is an explicit `null`, which resolves to claude's NATIVE
// window — the pre-F39 behaviour the plan promises. It is written into the BASE config.json on
// purpose: config.d/*.json overlays are RFC 7396, where null deletes the key and the rollback
// would silently land back on the 120k default.
function makeRollbackHome(threshold?: number | null): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-ctxlimit-l1-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "cl", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["cl"],
    ...(threshold !== undefined ? { providerOverrides: { claude: { compactionThreshold: threshold } } } : {}),
  }));
  return home;
}

const home = makeHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
const l1Home = makeRollbackHome();
const l1Env = { ...process.env, CHIMERA_HOME: l1Home, CHIMERA_BACKEND: "fake" };
const rollbackHome = makeRollbackHome(null);
const rollbackEnv = { ...process.env, CHIMERA_HOME: rollbackHome, CHIMERA_BACKEND: "fake" };

afterAll(async () => {
  // every home boots its OWN chimerad — leave one running and the suite never exits.
  for (const [h, e] of [[home, env], [l1Home, l1Env], [rollbackHome, rollbackEnv]] as const) {
    const c = await ChimeraClient.connect({ home: h, env: e, autostart: false }).catch(() => null);
    await c?.request("daemon.stop").catch(() => {});
    c?.close();
  }
});

describe("R2 ctx meter effective-limit: daemon-level blackbox", () => {
  it("a configured compactionThreshold wins for claude; an unconfigured codex window is unknown (0), NOT guessed from its catalog default model", async () => {
    const client = await ChimeraClient.connect({ home, env });

    const cl = await client.request<{ agentId: string; effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi claude", cwd: "/tmp", isolation: "none" } });   // no pinned model
    const cx = await client.request<{ agentId: string; effectiveContextLimit?: number; contextLimits?: unknown }>(
      "agent.spawn", { spec: { prompt: "hi codex", cwd: "/tmp", isolation: "none", provider: "codex" } });   // no pinned model

    // the ctx meter's denominator is stamped SYNCHRONOUSLY inside launch(), which agent.spawn
    // awaits before returning — no polling needed, the spawn response itself already carries it.
    expect(cl.effectiveContextLimit).toBe(150_000);     // configured threshold wins over the 200k native window
    // codex has no fleet default and no provider report yet: 0 means "unknown", never the 1.05M of
    // its catalog default model (gpt-5.6-sol) nor the bare 200k default.
    expect(cx.effectiveContextLimit).toBe(0);
    expect(cx.contextLimits).toEqual({ source: "codex" });   // no defaultWindow/maxWindow/sessionWindow/compactAt invented

    // re-confirm via agent.status (the same fields, the OTHER real read path a client uses).
    const clStatus = await client.request<{ effectiveContextLimit?: number }>("agent.status", { agentId: cl.agentId });
    const cxStatus = await client.request<{ effectiveContextLimit?: number; contextLimits?: unknown }>("agent.status", { agentId: cx.agentId });
    expect(clStatus.effectiveContextLimit).toBe(150_000);
    expect(cxStatus.effectiveContextLimit).toBe(0);
    expect(cxStatus.contextLimits).toEqual({ source: "codex" });

    client.close();
  }, 20_000);

  // The one Codex window the daemon CAN know before the provider speaks is an operator-configured
  // compactionThreshold — it is the real trigger, so it is both the meter's denominator and the
  // reported compactAt. A pinned model with a bigger native window must not move it.
  it("a configured compactionThreshold on a codex spawn is its denominator and compactAt, whatever the pinned model's native window", async () => {
    const client = await ChimeraClient.connect({ home, env });

    const cx = await client.request<{ agentId: string; effectiveContextLimit?: number; contextLimits?: unknown }>(
      "agent.spawn", { spec: { prompt: "hi codex", cwd: "/tmp", isolation: "none", provider: "codex", model: "gpt-5.6-sol", compactionThreshold: 123_000 } });
    expect(cx.effectiveContextLimit).toBe(123_000);
    expect(cx.contextLimits).toEqual({ source: "codex", compactAt: 123_000 });

    const status = await client.request<{ effectiveContextLimit?: number; contextLimits?: unknown }>("agent.status", { agentId: cx.agentId });
    expect(status.effectiveContextLimit).toBe(123_000);
    expect(status.contextLimits).toEqual({ source: "codex", compactAt: 123_000 });

    client.close();
  }, 20_000);

  it("a pinned model with a DIFFERENT native window still yields the SAME configured threshold for claude (an account/provider override doesn't move just because the model did)", async () => {
    const client = await ChimeraClient.connect({ home, env });

    const spawned = await client.request<{ effectiveContextLimit?: number }>("agent.spawn", {
      spec: { prompt: "hi", cwd: "/tmp", isolation: "none", model: "claude-sonnet-5" },   // still 200k native, still overridden to 150k
    });
    expect(spawned.effectiveContextLimit).toBe(150_000);

    client.close();
  }, 20_000);

  // L1-DEFAULT-THRESHOLD (F39): the measured fleet default must reach a REAL daemon boot with an
  // untouched config — the whole point of not making it a zod .default() on providerOverrides is
  // that providerOverrides is absent from a live config, so only an end-to-end boot proves it
  // applies at all. And it must stay overridable in one line, or it is not a default.
  it("an untouched claude config resolves to the measured fleet default end to end, and one null providerOverrides line rolls it back to the model's native window", async () => {
    const l1 = await ChimeraClient.connect({ home: l1Home, env: l1Env });
    const dflt = await l1.request<{ effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none" } });
    expect(dflt.effectiveContextLimit).toBe(120_000);   // not claude's 200k native window
    l1.close();

    // F39.QA-A M-1 regression: the documented rollback must restore each MODEL'S OWN window, not a
    // large number that merely looks uncapped. TWO pinned models with DIFFERENT native windows is
    // the whole assertion — the old prescribed rollback (compactionThreshold: 1_000_000) pinned
    // BOTH denominators to 1M, which is native only by coincidence for the 1M-window models and
    // 5x wrong for a 200k one. Pinned on purpose so neither assertion moves with the catalog default.
    const rolled = await ChimeraClient.connect({ home: rollbackHome, env: rollbackEnv });
    const narrow = await rolled.request<{ effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none", model: "claude-opus-4-8" } });
    const wide = await rolled.request<{ effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none", model: "claude-sonnet-5" } });
    expect(narrow.effectiveContextLimit).toBe(200_000);     // claude-opus-4-8's native window
    expect(wide.effectiveContextLimit).toBe(1_000_000);     // claude-sonnet-5's native window (CTX-WINDOW-5-SERIES)
    rolled.close();
  }, 30_000);
});
