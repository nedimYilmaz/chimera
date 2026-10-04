import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { BudgetDeniedError, estimateEffectiveSpendUsd, meterTurnCost } from "@chimera/core/budget";
import { ChimeraConfigSchema, computeCostUsd } from "@chimera/protocol";
import { makeSupervisor } from "./helpers.js";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const COST = (usd: number): FakeStep[] => [{ end: { resultText: "ok", costUsd: usd } }];
const IDLE = (): FakeStep[] => [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok", costUsd: 0 } }];

// FEATURE-5 (hierarchical budget governor + cache signals) — supervisor-level tests drive
// the generalized treeBudgets hierarchy directly via spawn()'s new budgetNodeId/
// budgetParentId opts; the last two tests drive it end-to-end through the REAL scheduler
// (spawnForTask/spawnStepAgent's task.taskId-keyed wiring, see scheduler.ts).
describe("FEATURE-5: hierarchical budget governor (pre-flight admission)", () => {
  it("denies a subtree over-allocation pre-flight, preserving the parent's remaining budget", async () => {
    const { sup } = makeSupervisor([IDLE(), IDLE()]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 10 });
    await sup.waitFor(root.agentId, 1000);

    await expect(
      sup.spawn({ prompt: "c", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 15 }, { budgetParentId: root.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);

    // parent budget preserved: a second child requesting the FULL original ceiling (10,
    // not reduced by the denied 15-request) still succeeds.
    const ok = await sup.spawn({ prompt: "c2", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 10 }, { budgetParentId: root.agentId });
    expect(ok).toBeDefined();
  });

  it("propagates a leaf's spend up every ancestor node (true hierarchy, not a flat root ceiling)", async () => {
    const { sup } = makeSupervisor([IDLE(), IDLE(), COST(15), COST(0), COST(0)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 100 });
    await sup.waitFor(root.agentId, 1000);
    const step = await sup.spawn({ prompt: "step", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 20 }, { budgetParentId: root.agentId });
    await sup.waitFor(step.agentId, 1000);
    const grandchild = await sup.spawn({ prompt: "gc", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: step.agentId });
    await sup.waitFor(grandchild.agentId, 1000);   // grandchild spends 15 — step total 15/20, root total 15/100

    expect(sup.treePaused(step.agentId)).toBe(false);
    expect(sup.treePaused(root.agentId)).toBe(false);

    // root's remaining is 100-15=85 — a sibling requesting 86 must be denied...
    await expect(
      sup.spawn({ prompt: "sib1", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 86 }, { budgetParentId: root.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    // ...while exactly 85 (the true remaining, proving the grandchild's spend propagated to root) succeeds.
    const sibling = await sup.spawn({ prompt: "sib2", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 85 }, { budgetParentId: root.agentId });
    expect(sibling).toBeDefined();
  });

  it("a mid-tree node's exhaustion blocks only its own subtree, not sibling branches", async () => {
    const { sup } = makeSupervisor([IDLE(), IDLE(), COST(6), IDLE(), IDLE()]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 100 });
    await sup.waitFor(root.agentId, 1000);
    const step = await sup.spawn({ prompt: "step", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 5 }, { budgetParentId: root.agentId });
    await sup.waitFor(step.agentId, 1000);
    const overspend = await sup.spawn({ prompt: "over", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: step.agentId });
    await sup.waitFor(overspend.agentId, 1000);   // 6 > step's 5 ceiling — step exhausted

    expect(sup.treePaused(step.agentId)).toBe(true);
    expect(sup.treePaused(root.agentId)).toBe(false);   // root (100, spent 6) nowhere near its own ceiling

    await expect(
      sup.spawn({ prompt: "more-under-step", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: step.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);

    // a DIFFERENT branch directly under root is unaffected by step's exhaustion.
    const sibling = await sup.spawn({ prompt: "sibling-branch", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: root.agentId });
    expect(sibling).toBeDefined();
  });

  it("a spawn's own maxBudgetUsd registers correctly even when treeId is inherited from elsewhere (native nesting)", async () => {
    const { sup } = makeSupervisor([IDLE(), COST(6)]);
    const outer = await sup.spawn({ prompt: "outer", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(outer.agentId, 1000);
    // simulates a native nested spawn that BOTH inherits the caller's treeId (unrelated to
    // its own agentId) AND declares its own maxBudgetUsd — engine.ts's real agent.spawn RPC
    // forwards both sp.treeId and sp.parentId for a genuine nested agent_spawn call, so
    // trackCost must climb from the key this spawn actually registered under, not treeId.
    const nested = await sup.spawn(
      { prompt: "nested", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 5 },
      { treeId: outer.agentId },
    );
    await sup.waitFor(nested.agentId, 1000);   // spends 6 > its own 5 ceiling
    expect(sup.treePaused(nested.agentId)).toBe(true);    // its OWN node (keyed by its own agentId) paused
    expect(sup.treePaused(outer.agentId)).toBe(false);    // the inherited treeId/outer's own node is untouched
  });

  it("a nested agent_spawn threading ONLY opts.parentId (mirroring engine.ts's real agent.spawn RPC) resolves budget ancestry from the parent's OWN registered node, not the parent's raw agentId", async () => {
    const { sup } = makeSupervisor([IDLE(), COST(6)]);
    // mimics spawnForTask (scheduler.ts:434): a task's conductor registers its OWN budget
    // node keyed by task.taskId, NOT its own agentId — the two are always distinct uuids
    // for a real scheduler-spawned conductor.
    const conductor = await sup.spawn(
      { prompt: "conductor", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 5 },
      { budgetNodeId: "task-123" },
    );
    await sup.waitFor(conductor.agentId, 1000);

    // a genuine nested agent_spawn (engine.ts's agent.spawn RPC case) only ever threads
    // opts.parentId — never budgetParentId directly. The child declares no budget of its
    // own; its spend must still book against the task's node.
    const child = await sup.spawn(
      { prompt: "child", cwd: "/tmp", account: "main", isolation: "none" },
      { parentId: conductor.agentId },
    );
    await sup.waitFor(child.agentId, 1000);   // spends 6 > the task's 5 ceiling

    expect(sup.treePaused("task-123")).toBe(true);   // child's spend booked to the task node, not dropped

    // pre-flight admission must now deny further nested spawns under the same conductor.
    await expect(
      sup.spawn({ prompt: "sib", cwd: "/tmp", account: "main", isolation: "none" }, { parentId: conductor.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
  });

  it("send() denies dispatching a next turn once the tree is paused (turn-dispatch pre-flight)", async () => {
    const { sup } = makeSupervisor([
      [{ awaitSend: true }, { end: { resultText: "done", costUsd: 0 } }],   // root: stays running, awaiting a turn
      COST(0.06),                                                          // child: breaches root's ceiling on its own result
    ]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.05 });
    const child = await sup.spawn({ prompt: "burn", cwd: "/tmp", account: "second", isolation: "none" }, { treeId: root.agentId });
    await sup.waitFor(child.agentId, 1000);
    expect(sup.treePaused(root.agentId)).toBe(true);

    await expect(sup.send(root.agentId, "next turn")).rejects.toBeInstanceOf(BudgetDeniedError);
  });
});

describe("FEATURE-5: cache-aware effective spend", () => {
  it("cache-heavy usage produces a materially lower effective spend than an equivalent all-fresh-token usage", () => {
    const allFresh = estimateEffectiveSpendUsd({ input: 100_000, output: 0, cacheRead: 0, cacheCreation: 0 });
    const cacheHeavy = estimateEffectiveSpendUsd({ input: 100_000, output: 0, cacheRead: 95_000, cacheCreation: 0 });
    expect(cacheHeavy).toBeGreaterThan(0);
    expect(cacheHeavy).toBeLessThan(allFresh * 0.2);
  });

  it("cache-heavy live usage avoids the premature backpressure an equivalent all-fresh-token usage triggers", async () => {
    const freshUsage = { input_tokens: 10_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const cacheUsage = { input_tokens: 10_000, output_tokens: 0, cache_read_input_tokens: 9_500, cache_creation_input_tokens: 0 };

    const { sup: supFresh, events: eventsFresh } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage: freshUsage } } },
      { end: { resultText: "ok", costUsd: 0 } },   // the REAL final cost never itself breaches — any pause is from the live estimate
    ]]);
    const rootFresh = await supFresh.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.01 });
    await supFresh.waitFor(rootFresh.agentId, 1000);
    // the live estimate DID trip a pause mid-turn (a "live" status event was emitted)...
    expect(eventsFresh.tail(rootFresh.agentId, 50).some((e) => e.kind === "status" && e.data["live"] === true)).toBe(true);
    // ...but since the real cost that landed (0) never actually breached the ceiling, the
    // pause is reconciled away rather than freezing the subtree forever (see the dedicated
    // reconciliation test below).
    expect(supFresh.treePaused(rootFresh.agentId)).toBe(false);

    const { sup: supCache, events: eventsCache } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage: cacheUsage } } },
      { end: { resultText: "ok", costUsd: 0 } },
    ]]);
    const rootCache = await supCache.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.01 });
    await supCache.waitFor(rootCache.agentId, 1000);
    expect(eventsCache.tail(rootCache.agentId, 50).some((e) => e.kind === "status" && e.data["live"] === true)).toBe(false);
    expect(supCache.treePaused(rootCache.agentId)).toBe(false);
  });

  // BUDGET-LIVE-ESTIMATE-REVERSIBLE regression: applyLiveEstimate's mid-turn pause is
  // computed at budget.ts's FIXED opus-tier rate ($3/M input), regardless of the record's
  // actual (possibly much cheaper, tiered-down) model. Before this fix, that pause was
  // permanent — pausedTrees was never reconciled against the turn's real, authoritative
  // cost, so a single large-context turn on a cheap model could over-estimate by ~12x and
  // freeze the subtree forever even once the real cost proved it well under budget.
  it("a live-estimate pause is reconciled and lifted once the turn's real (lower) cost lands", async () => {
    // 200k fresh input tokens: live estimate = 200_000 * $3/M = $0.60 — trips the pause
    // against a $0.50 ceiling — but a cheap-tier model's REAL cost for that turn is $0.05,
    // well under the ceiling.
    const usage = { input_tokens: 200_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const { sup, events } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage } } },
      { end: { resultText: "ok", costUsd: 0.05 } },
    ]]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);

    // the live estimate DID trip a pause mid-turn...
    expect(events.tail(root.agentId, 50).some((e) => e.kind === "status" && e.data["live"] === true)).toBe(true);
    // ...but it is lifted once the real, much-lower cost reconciles against it — NOT stuck
    // paused forever.
    expect(sup.treePaused(root.agentId)).toBe(false);

    // and the subtree is admitting again — a spawn under it is NOT denied.
    const child = await sup.spawn({ prompt: "child", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: root.agentId });
    expect(child).toBeDefined();
  });

  it("a live-estimate pause that a real overage CONFIRMS stays paused (not reconciled away)", async () => {
    // live estimate breaches, AND the real cost also breaches (a genuinely exhausted node) —
    // reconciliation must not un-pause a truly overspent subtree.
    const usage = { input_tokens: 200_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const { sup } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage } } },
      { end: { resultText: "ok", costUsd: 0.6 } },
    ]]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);

    expect(sup.treePaused(root.agentId)).toBe(true);
    await expect(
      sup.spawn({ prompt: "child", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: root.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
  });

  // BUDGET-LIVE-ESTIMATE-REVERSIBLE, unclean-exit half (QA of 8915e8e4): applyLiveEstimate
  // does not merely pause — it interrupt()s every running agent under the node, and
  // claude.ts's interrupt/kill are best-effort and do NOT guarantee a final cost-bearing
  // turn_complete/result (see backends/claude.ts:35). So the live estimate's own pause is a
  // LIKELY CAUSE of the unclean exit that lands in settleUnrecordedUsage — which is exactly
  // where the reconciliation must still fire, or the estimate freezes the subtree forever
  // with its only possible reconciler already dead.
  it("an unclean exit reconciles a live-estimate pause even when turn_complete already booked the whole cumulative cost", async () => {
    // 200k fresh input tokens: live estimate = $0.60 on top of the $0.05 already booked —
    // trips the $0.50 ceiling. The REAL recorded spend ($0.05) is nowhere near it.
    const usage = { input_tokens: 200_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const { sup } = makeSupervisor([[
      { emit: { kind: "turn_complete", data: { costUsd: 0.05 } } },   // books 0.05, booked=0.05
      { emit: { kind: "usage", data: { usage } } },                   // estimate trips the pause
      { awaitSend: true },                                            // stays "running" — never reaches "result"
    ]]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await waitUntil(() => sup.treePaused(root.agentId));

    await sup.kill(root.agentId);

    // settleUnrecordedUsage sees costUsd=0.05 with delta=0 (turn_complete booked all of it).
    // Skipping trackCost on that zero delta leaves the node paused on a proven-wrong estimate.
    expect(sup.treePaused(root.agentId)).toBe(false);
  });

  it("an unclean exit reconciles a live-estimate pause even when the agent died before its first turn_complete", async () => {
    const usage = { input_tokens: 200_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const { sup } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage } } },   // estimate trips the pause on turn 1
      { awaitSend: true },
    ]]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await waitUntil(() => sup.treePaused(root.agentId));

    await sup.kill(root.agentId);

    // lastTurnCostUsd is undefined (no turn ever completed), so nothing is booked — but the
    // node's RECORDED spend ($0) never breached its ceiling, and the estimate's owner is now
    // dead, so nothing else will ever un-pause it.
    expect(sup.treePaused(root.agentId)).toBe(false);
    // and the subtree admits again.
    const child = await sup.spawn({ prompt: "child", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: root.agentId });
    expect(child).toBeDefined();
  });

  // trackCost(record, 0) is now called on paths that previously called nothing — prove it is
  // inert beyond the reconciliation: it must not manufacture a budget_warning on a node
  // nowhere near its 80% threshold.
  it("the $0 reconciliation call emits no spurious budget_warning", async () => {
    const { sup, events } = makeSupervisor([[
      { emit: { kind: "turn_complete", data: { costUsd: 0.01 } } },   // 1% of the ceiling
      { awaitSend: true },
    ]]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 1 });
    await waitUntil(() => sup.status(root.agentId).state === "running");
    await sup.kill(root.agentId);

    expect(events.tail(root.agentId, 50).some((e) => e.kind === "budget_warning")).toBe(false);
  });

  // R2 (unified cache-aware token/ctx/cost metrics): a priced model (the new protocol pricing
  // table) engages a DIFFERENT, more accurate formula than the flat-rate fallback above — and
  // roughly agrees with computeCostUsd's own number for the same input, proving budget.ts and
  // the pricing table are aligned rather than drifted apart (goal 4's "align with budget.ts").
  it("a priced model uses the per-model pricing table, diverging from the flat-rate fallback", () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };
    const flatRate = estimateEffectiveSpendUsd(usage);              // no model -> unchanged flat-rate fallback
    const priced = estimateEffectiveSpendUsd(usage, "claude-opus-4-8");   // opus is pricier than the flat sonnet-tier rate
    expect(priced).not.toBeCloseTo(flatRate, 5);
    expect(priced).toBeCloseTo(computeCostUsd(usage, "claude-opus-4-8")!, 10);
  });

  it("an unpriced/unknown model falls back to the flat rate exactly (no regression for the other 15+ providers)", () => {
    const usage = { input: 100_000, output: 0, cacheRead: 0, cacheCreation: 0 };
    expect(estimateEffectiveSpendUsd(usage, "some-unpriced-model")).toBeCloseTo(estimateEffectiveSpendUsd(usage), 10);
  });
});

// F50 BUDGET-COVERAGE: before this feature every unpriced turn booked a flat $0 — dollars really
// spent that no ceiling could ever see (computeCostUsd returns null for the 15+ openai-compat
// providers with no pricing row, and every caller did `?? 0`). These drive the derivation through
// the REAL supervisor seam: `end` steps carrying billableUsage but a $0/absent costUsd, exactly
// the shape codex.ts/generic.ts put on the wire.
//
// Every scenario below deliberately omits a `usage` step: a `usage` event trips applyLiveEstimate,
// whose provisional pause fires BEFORE any dollars are booked, which would make the
// applyCostToNode assertions below pass for the wrong reason.
describe("F50: token-only metering", () => {
  // 400k fresh input at budget.ts's flat rate = $1.20; "some-unpriced-model" has no pricing row,
  // so this is the flat-rate path, not the table one.
  const TOKENS = { input_tokens: 400_000 };
  const UNPRICED = { prompt: "r", cwd: "/tmp", account: "main", isolation: "none" as const, model: "some-unpriced-model" };

  it("a run reporting costUsd 0 with real tokens on an UNPRICED model books derived spend, not $0", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "ok", costUsd: 0, billableUsage: TOKENS } }]]);
    const root = await sup.spawn({ ...UNPRICED, maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);

    expect(sup.treePaused(root.agentId)).toBe(true);
    const pause = events.tail(root.agentId, 50).find((e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["paused"] === true);
    expect(pause).toBeDefined();
    expect(pause!.data["totalCostUsd"]).toBeCloseTo(1.2, 6);
    // the whole booked total is DERIVED — an operator surface must never present it as measured
    expect(pause!.data["estimatedUsd"]).toBeCloseTo(1.2, 6);
    // not a live-estimate pause: no `usage` event was ever emitted, so nothing reconciles it away
    expect(pause!.data["live"]).toBeUndefined();
  });

  it("a reported non-zero costUsd always wins over the token-derived estimate", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "ok", costUsd: 0.05, billableUsage: TOKENS } }]]);
    const root = await sup.spawn({ ...UNPRICED, maxBudgetUsd: 0.04 });
    await sup.waitFor(root.agentId, 1000);

    const pause = events.tail(root.agentId, 50).find((e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["paused"] === true);
    // $0.05 reported, NOT the $1.20 the same tokens would derive — overriding a provider's own
    // billing figure with our table would be a regression in accuracy, not an improvement.
    expect(pause!.data["totalCostUsd"]).toBeCloseTo(0.05, 6);
    expect(pause!.data["estimatedUsd"]).toBe(0);
  });

  it("costEstimated:true on a reported figure books the figure and marks it estimated", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "ok", costUsd: 0.05, costEstimated: true, billableUsage: TOKENS } }]]);
    const root = await sup.spawn({ ...UNPRICED, maxBudgetUsd: 0.04 });
    await sup.waitFor(root.agentId, 1000);

    const pause = events.tail(root.agentId, 50).find((e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["paused"] === true);
    expect(pause!.data["totalCostUsd"]).toBeCloseTo(0.05, 6);
    // codex.ts/generic.ts compute their own costUsd from the pricing table — the figure is real,
    // but it is a DERIVATION, and the governor has to be able to tell the two apart.
    expect(pause!.data["estimatedUsd"]).toBeCloseTo(0.05, 6);
  });

  it("a backend with no usage telemetry at all books $0 and fabricates nothing", async () => {
    // the kimi shape (kimi.ts:45 — no usage on the wire, by design)
    const { sup, events } = makeSupervisor([[{ end: { resultText: "ok" } }]]);
    const root = await sup.spawn({ ...UNPRICED, maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);

    expect(sup.treePaused(root.agentId)).toBe(false);
    expect(events.tail(root.agentId, 50).some((e) => e.kind === "budget_warning")).toBe(false);
  });

  it("budget_warning carries estimatedUsd alongside the total", async () => {
    // $1.20 derived against a $1.40 ceiling = 86% — over the 80% warning line, under the pause line
    const { sup, events } = makeSupervisor([[{ end: { resultText: "ok", costUsd: 0, billableUsage: TOKENS } }]]);
    const root = await sup.spawn({ ...UNPRICED, maxBudgetUsd: 1.4 });
    await sup.waitFor(root.agentId, 1000);

    expect(sup.treePaused(root.agentId)).toBe(false);
    const warn = events.tail(root.agentId, 50).find((e) => e.kind === "budget_warning");
    expect(warn).toBeDefined();
    expect(warn!.data["totalCostUsd"]).toBeCloseTo(1.2, 6);
    expect(warn!.data["estimatedUsd"]).toBeCloseTo(1.2, 6);
  });

  // Direct unit tests on the pure helper — one per `basis` value, mirroring the direct
  // estimateEffectiveSpendUsd tests above.
  it("meterTurnCost: a provider's own figure is basis \"reported\" and never estimated", () => {
    expect(meterTurnCost(0.05, { input_tokens: 400_000 })).toEqual({ costUsd: 0.05, estimated: false, basis: "reported" });
  });

  it("meterTurnCost: a reported-but-derived figure is basis \"table\" and estimated", () => {
    expect(meterTurnCost(0.05, undefined, undefined, undefined, true)).toEqual({ costUsd: 0.05, estimated: true, basis: "table" });
  });

  it("meterTurnCost: tokens on a PRICED model derive from the pricing table", () => {
    const usage = { input_tokens: 1_000_000 };
    const m = meterTurnCost(0, usage, "claude-opus-4-8");
    expect(m.basis).toBe("table");
    expect(m.estimated).toBe(true);
    expect(m.costUsd).toBeCloseTo(computeCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, "claude-opus-4-8")!, 10);
  });

  it("meterTurnCost: tokens on an UNPRICED model fall to basis \"flat-rate\"", () => {
    const m = meterTurnCost(undefined, { input_tokens: 100_000 }, "some-unpriced-model");
    expect(m.basis).toBe("flat-rate");
    expect(m.estimated).toBe(true);
    expect(m.costUsd).toBeCloseTo(estimateEffectiveSpendUsd({ input: 100_000, output: 0, cacheRead: 0, cacheCreation: 0 }), 10);
  });

  it("meterTurnCost: nothing to meter is basis \"none\", $0, and NOT flagged estimated", () => {
    // $0 is a fact here, not a guess — flagging it estimated would put a fabricated marker on a
    // total that contains no derived dollars at all.
    expect(meterTurnCost(0, undefined)).toEqual({ costUsd: 0, estimated: false, basis: "none" });
    expect(meterTurnCost(0, {})).toEqual({ costUsd: 0, estimated: false, basis: "none" });
  });
});

// F50 BUDGET-RESUME: the release valve on the fleet's hardest guardrail. The load-bearing
// assertion here is the delta-0 one: trackCost fires with delta 0 on every unclean exit, so a
// resume implemented as a bare pausedTrees.delete() is undone within milliseconds and buys the
// operator nothing. The watermark (budgetResumeAcks) is what makes the release survive.
describe("F50: audited budget resume", () => {
  // 200k fresh input tokens = $0.60 at budget.ts's flat opus-tier rate — trips applyLiveEstimate
  // against a $0.50 ceiling while the REAL cost is only $0.05.
  const BIG_USAGE = { input_tokens: 200_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  // CFG caps "main" at ONE concurrent agent, which would deny the post-resume child spawn with a
  // CONCURRENCY verdict and prove nothing about the budget. These tests need the budget verdict.
  const ROOMY = ChimeraConfigSchema.parse({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    caps: { maxAgentsTotal: 4, perAccount: {} },
  });

  it("resuming a live-estimate over-estimate pause releases the node permanently", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage: BIG_USAGE } } },
      { awaitSend: true },
    ], IDLE()], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await waitUntil(() => sup.treePaused(root.agentId));

    const r = sup.resumeBudget(root.agentId);
    expect(r).not.toBeNull();
    // recorded spend is $0 — the pause was a pure over-estimate, so this is not a raise of any cap;
    // the watermark it does record is what keeps applyLiveEstimate from undoing it (test below).
    expect(r!.overBudget).toBe(false);
    expect(r!.resumed).toBe(true);
    expect(sup.treePaused(root.agentId)).toBe(false);

    const child = await sup.spawn({ prompt: "child", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: root.agentId });
    expect(child).toBeDefined();
  });

  it("a resumed OVER-BUDGET node is not re-paused by a delta-0 reconciliation", async () => {
    const { sup } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    expect(sup.treePaused(root.agentId)).toBe(true);

    const r = sup.resumeBudget(root.agentId)!;
    expect(r.overBudget).toBe(true);            // still over its ceiling — the ack, not a raise
    expect(r.maxBudgetUsd).toBe(0.5);
    expect(sup.treePaused(root.agentId)).toBe(false);

    // the delta-0 settle that fires on every unclean exit must NOT undo the release.
    const record = sup["agents"].get(root.agentId)!;
    sup["trackCost"](record, 0);
    expect(sup.treePaused(root.agentId)).toBe(false);
    sup["trackCost"](record, 0);
    expect(sup.treePaused(root.agentId)).toBe(false);
  });

  it("a resumed over-budget node re-pauses on the next real spend, with afterResume:true", async () => {
    const { sup, events } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    sup.resumeBudget(root.agentId);
    expect(sup.treePaused(root.agentId)).toBe(false);

    // one dollar of NEW spend past the acknowledged watermark re-engages the guardrail.
    const record = sup["agents"].get(root.agentId)!;
    sup["trackCost"](record, 0.01);
    expect(sup.treePaused(root.agentId)).toBe(true);

    const repause = events.tail(root.agentId, 50).filter(
      (e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["paused"] === true,
    );
    expect(repause.at(-1)!.data["afterResume"]).toBe(true);
    // the FIRST breach carried no afterResume — it really is a second-breach marker.
    expect(repause[0]!.data["afterResume"]).toBeUndefined();
  });

  it("resume never changes maxBudgetUsd", async () => {
    const { sup } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    const before = sup["treeBudgets"].get(root.agentId)!.maxBudgetUsd;
    sup.resumeBudget(root.agentId);
    const record = sup["agents"].get(root.agentId)!;
    sup["trackCost"](record, 5);                 // re-pause on a big new spend
    expect(sup["treeBudgets"].get(root.agentId)!.maxBudgetUsd).toBe(before);
    expect(before).toBe(0.5);
  });

  it("resuming a node whose ancestor is still paused reports blockedByAncestorNodeId", async () => {
    const { sup } = makeSupervisor([IDLE(), IDLE(), COST(6)]);
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 5 });
    await sup.waitFor(root.agentId, 1000);
    const step = await sup.spawn({ prompt: "step", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 5 }, { budgetParentId: root.agentId });
    await sup.waitFor(step.agentId, 1000);
    const leaf = await sup.spawn({ prompt: "leaf", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: step.agentId });
    await sup.waitFor(leaf.agentId, 1000);       // $6 propagates: both step and root breach $5

    expect(sup.treePaused(step.agentId)).toBe(true);
    expect(sup.treePaused(root.agentId)).toBe(true);

    const r = sup.resumeBudget(step.agentId)!;
    expect(r.blockedByAncestorNodeId).toBe(root.agentId);
    // releasing the leaf's node alone changes nothing the admission check will let through.
    await expect(
      sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" }, { budgetParentId: step.agentId }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);

    // resume the root too, and the ancestor is no longer named / the subtree admits.
    expect(sup.resumeBudget(root.agentId)!.blockedByAncestorNodeId).toBeNull();
    expect(sup.resumeBudget(step.agentId)!.blockedByAncestorNodeId).toBeNull();
  });

  // CARRY-FORWARD (F50 planning ground truth): a release must RE-ARM at the next threshold above
  // the watermark it was granted at — never loop-resume itself, never widen into "unlimited".
  // One cycle cannot tell those apart; two can, which is why this resumes twice.
  it("resuming twice re-arms at each next threshold and never becomes unlimited", async () => {
    const { sup, events } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    const record = sup["agents"].get(root.agentId)!;
    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    expect(sup.treePaused(root.agentId)).toBe(true);

    // cycle 1 — released at $0.60, so $0.60 is the new threshold.
    expect(sup.resumeBudget(root.agentId)!.overBudget).toBe(true);
    expect(acks.get(root.agentId)).toBeCloseTo(0.6);
    sup["trackCost"](record, 0);
    expect(sup.treePaused(root.agentId)).toBe(false);
    sup["trackCost"](record, 0.01);
    expect(sup.treePaused(root.agentId)).toBe(true);
    expect(acks.has(root.agentId)).toBe(false);          // watermark consumed by the re-pause

    // cycle 2 — the second release must behave identically, at the NEW (higher) threshold.
    expect(sup.resumeBudget(root.agentId)!.overBudget).toBe(true);
    expect(acks.get(root.agentId)).toBeCloseTo(0.61);
    sup["trackCost"](record, 0);
    expect(sup.treePaused(root.agentId)).toBe(false);
    sup["trackCost"](record, 0.01);
    expect(sup.treePaused(root.agentId)).toBe(true);

    // and no number of releases turns the ceiling off: it is untouched and still bites.
    expect(sup["treeBudgets"].get(root.agentId)!.maxBudgetUsd).toBe(0.5);
    sup.resumeBudget(root.agentId);
    sup["trackCost"](record, 100);
    expect(sup.treePaused(root.agentId)).toBe(true);

    const pauses = events.tail(root.agentId, 100).filter(
      (e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["paused"] === true,
    );
    expect(pauses).toHaveLength(4);                      // first breach + exactly one per release
    expect(pauses.slice(1).map((e) => e.data["afterResume"])).toEqual([true, true, true]);
  });

  // The pause a release clears is only half of it: applyLiveEstimate re-pauses from MID-TURN token
  // counts, and the released turn is still streaming them. Without a watermark the operator's
  // release is undone by the next `usage` event of the very turn it released — milliseconds later.
  it("a released live-estimate pause survives the released turn's next mid-turn estimate", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage: BIG_USAGE } } },
      { awaitSend: true },
    ], IDLE()], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await waitUntil(() => sup.treePaused(root.agentId));
    expect(sup.resumeBudget(root.agentId)!.resumed).toBe(true);

    const record = sup["agents"].get(root.agentId)!;
    sup["applyLiveEstimate"](record, 0.6);               // same call onEvent's "usage" branch makes
    expect(sup.treePaused(root.agentId)).toBe(false);

    // real spend past the watermark still bites — the suspension is one turn, not a blank cheque.
    sup["trackCost"](record, 0.6);
    expect(sup.treePaused(root.agentId)).toBe(true);
  });

  // A release is a release of SOMETHING: resumeBudget is reachable from the app banner, the tui
  // command and the raw RPC, so a stray or double call on a HEALTHY tree must arm no watermark.
  // A watermark on a tree nobody paused silently suspends applyLiveEstimate's mid-turn
  // backpressure (the guard 0c752276 exists for) until real spend books past the current total —
  // i.e. it disarms the guardrail in exchange for nothing.
  it("resuming a tree that is NOT paused arms no watermark and leaves live backpressure intact", async () => {
    const { sup } = makeSupervisor([IDLE(), IDLE()], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    expect(sup.treePaused(root.agentId)).toBe(false);

    const r = sup.resumeBudget(root.agentId)!;
    expect(r.resumed).toBe(false);                      // nothing was paused — nothing to release
    expect((sup["budgetResumeAcks"] as Map<string, number>).has(root.agentId)).toBe(false);

    const record = sup["agents"].get(root.agentId)!;
    sup["applyLiveEstimate"](record, 0.6);              // mid-turn estimate over the $0.50 cap
    expect(sup.treePaused(root.agentId)).toBe(true);
  });

  it("resuming an unknown node returns null", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.resumeBudget("no-such-node")).toBeNull();
  });

  // F50.QA-FIX finding 7: budgetResumeAcks entries are scoped to a record's own budget node and
  // can never be consulted again once that record is terminal — pruning them at the
  // terminal-transition chokepoints (markFailed, kill, closeInput's paused branch, the natural
  // "done" completion, and purgeTerminal as an idempotent backstop) keeps the map bounded by LIVE
  // trees instead of every tree the process has ever run.
  describe("finding 7: budgetResumeAcks pruned on terminal transitions", () => {
  it("clears the ack once a released, still-running tree reaches natural completion (done)", async () => {
    const { sup } = makeSupervisor([[
      { emit: { kind: "usage", data: { usage: BIG_USAGE } } },
      { awaitSend: true },
      { end: { resultText: "ok", costUsd: 0 } },
    ]], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await waitUntil(() => sup.treePaused(root.agentId));
    expect(sup.resumeBudget(root.agentId)!.resumed).toBe(true);

    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    expect(acks.has(root.agentId)).toBe(true);   // the release did arm a watermark

    await sup.send(root.agentId, "continue");
    await sup.waitFor(root.agentId, 1000);
    expect(sup.status(root.agentId).state).toBe("done");
    expect(acks.has(root.agentId)).toBe(false);  // done can never re-trigger it — pruned
  });

  it("clears the ack when the tree fails", async () => {
    const { sup } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    sup.resumeBudget(root.agentId);
    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    expect(acks.has(root.agentId)).toBe(true);

    // markFailed is the single chokepoint for every "failed" transition — drive it directly rather
    // than threading a real backend failure through, since the hook is on the transition itself.
    const record = sup["agents"].get(root.agentId)!;
    sup["markFailed"](record, "boom");
    expect(sup.status(root.agentId).state).toBe("failed");
    expect(acks.has(root.agentId)).toBe(false);
  });

  it("clears the ack when the tree is killed", async () => {
    const { sup } = makeSupervisor([COST(0.6)]);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none", maxBudgetUsd: 0.5 });
    await sup.waitFor(root.agentId, 1000);
    sup.resumeBudget(root.agentId);
    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    expect(acks.has(root.agentId)).toBe(true);

    // kill() only transitions from running/paused — restore a live state first since the tree
    // already ran to completion via COST's one-shot "end" step.
    sup["agents"].get(root.agentId)!.state = "running";
    await sup.kill(root.agentId);
    expect(sup.status(root.agentId).state).toBe("killed");
    expect(acks.has(root.agentId)).toBe(false);
  });

  it("clears the ack when a PAUSED tree is closed (closeInput's killed transition)", async () => {
    const LIVE: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([LIVE], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none" });
    await waitUntil(() => sup.status(root.agentId).state === "running");
    await sup.parkIdle(root.agentId, 99_999);
    expect(sup.status(root.agentId).state).toBe("paused");

    // no budget pause was actually taken on this tree — seed the ack directly to isolate the
    // closeInput hook itself from the (already separately tested) budget-pause plumbing.
    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    acks.set(root.agentId, 0.6);
    expect(acks.has(root.agentId)).toBe(true);   // retained while merely paused, not terminal

    await sup.closeInput(root.agentId);
    expect(sup.status(root.agentId).state).toBe("killed");
    expect(acks.has(root.agentId)).toBe(false);
  });

  it("purgeTerminal prunes any lingering ack for a swept terminal record (idempotent backstop)", async () => {
    const { sup } = makeSupervisor([IDLE()], ROOMY);
    const root = await sup.spawn({ prompt: "r", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(root.agentId, 1000);
    expect(sup.status(root.agentId).state).toBe("done");

    // simulate a lingering ack that survived the done transition, to test purgeTerminal's own
    // backstop clear independent of whether the other hooks already did the work.
    const acks = sup["budgetResumeAcks"] as Map<string, number>;
    acks.set(root.agentId, 0.6);
    sup.purgeTerminal([root.agentId]);
    expect(acks.has(root.agentId)).toBe(false);
  });
  });
});

const HANDOFF_STEPS = [
  { id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner" },
  { id: "s1", title: "build", gate: { kind: "none" as const }, role: "builder" },
];
const HANDOFF_TEAM = {
  name: "crew",
  roles: {
    planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
    builder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
  },
  maxConcurrent: 2, queue: "work",
};

describe("FEATURE-5: WorkflowStepSchema.budgetUsd threads through the real scheduler", () => {
  it("a step-level budgetUsd registers as its own node nested under the task's root ceiling", async () => {
    const PLANNER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } }, { turn: {} }, { awaitSend: true }, { turn: { text: "planned" } },
    ];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped", costUsd: 6 } }];
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({
      name: "wf-step-budget",
      steps: [HANDOFF_STEPS[0]!, { ...HANDOFF_STEPS[1]!, budgetUsd: 5 }],
    });
    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-step-budget", overrides: { maxBudgetUsd: 20 } });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.fake.spawns).toHaveLength(2);
    expect(rig.fake.spawns[1]!.maxBudgetUsd).toBe(5);         // step-level override won the spec merge
    const builderAgentId = rig.fake.spawns[1]!.agentId;
    expect(rig.sup.treePaused(builderAgentId)).toBe(true);    // builder spent 6 > its OWN 5 ceiling
    expect(rig.sup.treePaused(task.taskId)).toBe(false);      // but the task root (20, spent 6) is nowhere near exhausted
  });

  it("a pre-flight budget denial at a role-switch respawn terminal-fails the task instead of retrying it", async () => {
    const PLANNER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "planned", costUsd: 0.02 } }];
    const BUILDER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "shipped" } }];   // never reached
    const rig = makeCoordination([PLANNER, BUILDER]);
    rig.queues.create({ name: "work" });
    rig.teams.create(HANDOFF_TEAM);
    rig.workflows.create({ name: "wf-budget-deny", steps: HANDOFF_STEPS });
    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf-budget-deny", overrides: { maxBudgetUsd: 0.01 } });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const failed = rig.queues.getTask(task.taskId);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/budget/i);
    expect(rig.fake.spawns).toHaveLength(1);   // builder's respawn was denied pre-flight — never attempted
  });
});
