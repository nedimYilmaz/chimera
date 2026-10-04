import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChimeraConfigSchema, AgentSpecSchema, type DynamicCapConfig } from "@chimera/protocol";
import { DynamicCapConfigSchema } from "@chimera/protocol";
import { AgentSupervisor, ADMISSION_CHECK_NAMES, GuardrailError, type AdmissionProbe } from "@chimera/core/supervisor";
import { ConfigError, AccountRegistry } from "@chimera/core/accounts";
import { BudgetDeniedError } from "@chimera/core/budget";
import { DynamicCapTracker, type ResourceSample } from "@chimera/core/dynamic-cap";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSupervisor, CFG, fakeExec } from "./helpers.js";

// F15 (task_explain): spawn()'s six admission checks are ONE named, ordered array that
// queue.explainTask and F51's spawn_estimate replay without spawning. These tests pin the
// three things a later change can silently break: the array's shape, the exact GuardrailError
// message strings the extraction had to preserve byte-for-byte, and the ERROR CLASS of each
// denial (scheduler.ts routes on `code`, so a ConfigError or BudgetDeniedError flattened into
// GuardrailError turns a permanent failure into an infinite starve).

const IDLE = (): FakeStep[] => [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok", costUsd: 0 } }];
const PARKED: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "-" } }];

function probe(over: Partial<AdmissionProbe> = {}): AdmissionProbe {
  return {
    spec: AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }),
    depth: 0, treeId: "tree-1", ...over,
  };
}

function dynamicCfg(over: Partial<DynamicCapConfig> = {}): DynamicCapConfig {
  return DynamicCapConfigSchema.parse({ enabled: true, ...over });
}

// A supervisor with ZERO configured accounts — the ONBOARDING-PROVIDER branch of routeAccount,
// which is the one admission failure that must NOT be a GuardrailError.
function makeAccountlessSupervisor() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-noacct-"));
  return new AgentSupervisor({
    registry: new AccountRegistry(ChimeraConfigSchema.parse({ accounts: [], autoOrder: [], caps: { maxAgentsTotal: 4, perAccount: {} } })),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
  });
}

describe("F15: the supervisor spawn-admission array", () => {
  it("evaluateAdmission returns one entry per ADMISSION_CHECK_NAMES, in order, with no short-circuit", () => {
    const { sup } = makeSupervisor([]);
    const checks = sup.explainAdmission(probe());
    expect(checks.map((c) => c.name)).toEqual([...ADMISSION_CHECK_NAMES]);
    // No short-circuit: a FAILING first check must not truncate the array.
    const denied = sup.explainAdmission(probe({ depth: 9, maxDepthCap: 2 }));
    expect(denied.map((c) => c.name)).toEqual([...ADMISSION_CHECK_NAMES]);
    expect(denied.find((c) => c.name === "depth")!.ok).toBe(false);
    expect(denied.find((c) => c.name === "accountCap")!.ok).toBe(true);   // still evaluated
  });

  it("every check names its live values in `detail`, never a bare boolean", () => {
    const { sup } = makeSupervisor([]);
    const byName = new Map(sup.explainAdmission(probe()).map((c) => [c.name, c.detail]));
    expect(byName.get("depth")).toMatch(/depth 0 is within effective maxDepth \d+/);
    expect(byName.get("globalCap")).toBe("0 of 2 agent slots in use");        // helpers CFG: maxAgentsTotal 2
    expect(byName.get("accountRouting")).toBe('routed to account "main"');
    expect(byName.get("accountCap")).toBe('account "main": 0 of 1 in use');   // helpers CFG: perAccount.main 1
    for (const d of byName.values()) expect(d.length).toBeLessThanOrEqual(240);
  });

  it("spawn throws the SAME message every inline check threw — depth, global cap, per-account cap", async () => {
    const { sup } = makeSupervisor([PARKED, PARKED, PARKED]);

    await expect(sup.spawn({ prompt: "deep", cwd: "/tmp", account: "main", isolation: "none" }, { depth: 9, maxDepthCap: 2 }))
      .rejects.toThrow("depth 9 exceeds effective maxDepth 2");

    // main's per-account cap is 1 (helpers CFG) — the second explicit "main" spawn hits it,
    // while maxAgentsTotal (2) still has room, so this is unambiguously accountCap.
    await sup.spawn({ prompt: "a1", cwd: "/tmp", account: "main", isolation: "none" });
    await expect(sup.spawn({ prompt: "a2", cwd: "/tmp", account: "main", isolation: "none" }))
      .rejects.toThrow('per-account cap for "main" reached');

    // ...and once BOTH slots are taken, the global ceiling message, not the per-account one.
    await sup.spawn({ prompt: "b1", cwd: "/tmp", account: "second", isolation: "none" });
    const err = await sup.spawn({ prompt: "c1", cwd: "/tmp", account: "second", isolation: "none" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as Error).message).toBe("maxAgentsTotal 2 reached");
  });

  it("a genuinely paused tree still throws the byte-identical treeNotPaused message", async () => {
    const COST = (usd: number): FakeStep[] => [{ end: { resultText: "ok", costUsd: usd } }];
    const { sup } = makeSupervisor([COST(0.03), COST(0.03)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    await sup.waitFor(root.agentId, 1000);
    const child = await sup.spawn({ prompt: "c1", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId });
    await sup.waitFor(child.agentId, 1000);                 // 0.06 > 0.05 → tree paused
    expect(sup.treePaused(root.agentId)).toBe(true);

    const err = await sup.spawn({ prompt: "c2", cwd: "/tmp", account: "main", isolation: "none" }, { treeId: root.agentId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as Error).message).toBe(`tree ${root.agentId} is paused: budget ceiling exceeded`);
    expect(sup.explainAdmission(probe({ treeId: root.agentId })).find((c) => c.name === "treeNotPaused")!.ok).toBe(false);
  });

  it("preserves the dynamic-cap message variant verbatim, including its unbounded explain suffix", async () => {
    const ROOMY = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"], caps: { maxAgentsTotal: 5, perAccount: {} },
    });
    const HIGH_LOAD: ResourceSample = { load1: 20, cores: 12, freeMemGb: 30 };
    const tracker = new DynamicCapTracker(() => HIGH_LOAD);
    const cfg = dynamicCfg({ floor: 2 });
    for (let i = 0; i < 5; i++) tracker.sample(cfg);
    const { sup } = makeSupervisor([PARKED, PARKED, PARKED], ROOMY, { dynamicCap: tracker, dynamicCapConfig: () => cfg });

    const snap = tracker.effectiveCap(5, cfg);
    expect(snap.cap).toBeLessThan(5);
    for (let i = 0; i < snap.cap; i++) await sup.spawn({ prompt: `p${i}`, cwd: "/tmp", account: "main", isolation: "none" });

    const err = await sup.spawn({ prompt: "over", cwd: "/tmp", account: "main", isolation: "none" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as Error).message).toBe(`dynamic cap ${snap.cap} of 5 reached (${snap.explain})`);
    // The thrown text is NOT ExplainCheck.detail (which is truncated at 240) — the two must
    // stay separate or a long explain string would silently reword a guardrail.
    expect(sup.explainAdmission(probe()).find((c) => c.name === "globalCap")!.ok).toBe(false);
  });

  it("zero configured accounts still throws ConfigError, not GuardrailError", async () => {
    const sup = makeAccountlessSupervisor();
    const err = await sup.spawn({ prompt: "p", cwd: "/tmp", isolation: "none" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).not.toBeInstanceOf(GuardrailError);
    // scheduler.ts branches on `code === "guardrail"` (transient → stay pending); a config
    // error must fall through to markFailed instead of starving forever.
    expect((err as { code?: string }).code).toBe("protocol");
    expect((err as Error).message).toBe("no accounts configured — connect a provider in Settings");

    const checks = sup.explainAdmission(probe());
    expect(checks.find((c) => c.name === "accountRouting")).toMatchObject({ ok: false });
    expect(checks.find((c) => c.name === "accountCap")).toMatchObject({ ok: false, skipped: true });
  });

  it("a budget denial keeps its BudgetDeniedError class AND still emits budget_denied, with every ancestor's totalCostUsd untouched", async () => {
    const { sup, events } = makeSupervisor([IDLE(), IDLE(), IDLE()]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 10 });
    await sup.waitFor(root.agentId, 1000);

    const before = events.tail(null, 1000).filter((e) => e.kind === "budget_denied").length;
    const err = await sup.spawn(
      { prompt: "c", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 15 },
      { budgetParentId: root.agentId },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetDeniedError);
    expect(err).not.toBeInstanceOf(GuardrailError);
    expect((err as { code?: string }).code).toBe("budget_denied");
    expect(events.tail(null, 1000).filter((e) => e.kind === "budget_denied").length).toBe(before + 1);

    // "parent budget preserved": the denial mutated nothing, so a child requesting the FULL
    // original ceiling still admits.
    await expect(sup.spawn({ prompt: "c2", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 10 }, { budgetParentId: root.agentId }))
      .resolves.toBeDefined();
  });

  it("explainAdmission is pure: it never spawns, and it never appends the budget_denied event a real denial would", async () => {
    const { sup, events } = makeSupervisor([IDLE()]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 10 });
    await sup.waitFor(root.agentId, 1000);

    const agentsBefore = sup.list().length;
    const eventsBefore = events.tail(null, 5000).length;
    const overBudget = probe({
      spec: AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 999 }),
      budgetParentId: root.agentId,
    });
    for (let i = 0; i < 50; i++) {
      const checks = sup.explainAdmission(overBudget);
      expect(checks.find((c) => c.name === "budgetHeadroom")!.ok).toBe(false);
    }
    expect(sup.list().length).toBe(agentsBefore);
    expect(events.tail(null, 5000).length).toBe(eventsBefore);
  });

  it("source guard: the fenced admission region holds exactly one `new GuardrailError(`", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/supervisor.ts", import.meta.url)), "utf8");
    const begin = src.indexOf("F15-ADMISSION-FENCE:BEGIN");
    const end = src.indexOf("F15-ADMISSION-FENCE:END");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const region = src.slice(begin, end);
    // One throw site == one decision surface. Adding an inline guardrail beside the array
    // fails this until the check is moved INTO evaluateAdmission, where explainTask sees it.
    expect(region.match(/new GuardrailError\(/g) ?? []).toHaveLength(1);
    expect(region.match(/new ConfigError\(/g) ?? []).toHaveLength(1);
    // ...and spawn() itself must no longer decide anything: its admission block is two lines.
    const spawnBody = src.slice(src.indexOf("const admission = this.evaluateAdmission("), src.indexOf("const account = this.deps.registry.get(accountName)"));
    expect(spawnBody).not.toMatch(/new GuardrailError\(/);
  });
});
