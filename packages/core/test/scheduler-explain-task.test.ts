import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { TaskExplainResultSchema, ChimeraConfigSchema } from "@chimera/protocol";
import { UnknownTaskError } from "@chimera/core/queues";
import { makeCoordination, waitUntil, COORD_CFG } from "./coord-helpers.js";

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0.02 } }];
const DEV_TEAM = (maxConcurrent: number) => ({
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
  maxConcurrent, queue: "work",
});

function rigWithQueue(scenarios: FakeStep[][] = [HOLD, HOLD, HOLD], maxConcurrent = 2, cfg = COORD_CFG) {
  const rig = makeCoordination(scenarios, cfg);
  rig.queues.create({ name: "work" });
  rig.teams.create(DEV_TEAM(maxConcurrent));
  return rig;
}

describe("F15: QueueScheduler.explainTask", () => {
  it("A2: a dispatchable task reports blockedBy null and every check ok-or-skipped", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    const r = rig.scheduler.explainTask(t.taskId);

    expect(TaskExplainResultSchema.parse(r)).toBeTruthy();     // the payload validates as-is
    expect(r.dispatchable).toBe(true);
    expect(r.blockedBy).toBeNull();
    expect(r.detail).toBeNull();
    expect(r.team).toBe("crew");
    expect(r.role).toBe("dev");
    expect(r.checks.every((c) => c.ok || c.skipped)).toBe(true);
    expect(r.admission.map((c) => c.name)).toEqual(
      ["depth", "treeNotPaused", "budgetHeadroom", "globalCap", "accountRouting", "accountCap"]);
  });

  it("A3: a dependency-blocked task names each unfinished dep WITH its state", () => {
    const rig = rigWithQueue();
    const a = rig.queues.push("work", { prompt: "a" });
    const b = rig.queues.push("work", { prompt: "b" });
    const c = rig.queues.push("work", { prompt: "c", dependsOn: [a.taskId, b.taskId] });

    const r = rig.scheduler.explainTask(c.taskId);
    expect(r.blockedBy).toBe("dependenciesSatisfied");
    expect(r.detail).toContain(`${a.taskId} is pending`);
    expect(r.detail).toContain(`${b.taskId} is pending`);
    // the symptom (state "blocked") defers to the cause rather than masking it
    expect(r.checks.find((ch) => ch.name === "taskPending")!.skipped).toBe(true);
    expect(r.context.dependsOn).toEqual([
      { taskId: a.taskId, state: "pending" }, { taskId: b.taskId, state: "pending" },
    ]);
  });

  it("A1: a paused queue is named as the blocker", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.pause("work");
    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("queueNotPaused");
    expect(r.detail).toContain("paused");
    expect(r.dispatchable).toBe(false);
  });

  it("R5: a non-front task names the task that actually drains first", () => {
    const rig = rigWithQueue();
    rig.queues.push("work", { prompt: "first", priority: 5 });
    const second = rig.queues.push("work", { prompt: "second" });
    const r = rig.scheduler.explainTask(second.taskId);
    expect(r.blockedBy).toBe("headOfDrainOrder");
    expect(r.detail).toContain("drains first (priority 5");
  });

  it("A7: a task parked in retry backoff says how long is left", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.markInProgress(t.taskId, "agent-x");
    // pendingRetries is in-memory only (scheduler.ts) — reach it the way settle() populates it
    (rig.scheduler as unknown as { pendingRetries: Map<string, number> })
      .pendingRetries.set(t.taskId, Date.now() + 5_000);

    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("taskPending");
    expect(r.detail).toMatch(/parked for retry backoff, ~[45]s remaining/);
  });

  it("A7: a task parked on a guardrailed role switch names the role and step", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.markInProgress(t.taskId, "agent-x");
    (rig.scheduler as unknown as { parkedSwitches: Map<string, unknown> })
      .parkedSwitches.set(t.taskId, { team: "crew", roleName: "reviewer", wfName: "wf", wfVersion: 1, stepIndex: 2, handoff: null });

    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("taskPending");
    expect(r.detail).toBe('parked on a guardrailed role switch to "reviewer" at step 2');
  });

  it("A8: a failed task carries its error and attempt count", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.markFailed(t.taskId, "boom: the gate never passed");

    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("taskPending");
    expect(r.detail).toContain("boom: the gate never passed");
    expect(r.detail).toContain("attempt(s)");
    expect(r.context.error).toContain("boom");
  });

  it("A4: a caps-starved task blames supervisorAdmission and admission[] names the failing sub-check", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"], caps: { maxAgentsTotal: 1, perAccount: {} },
    });
    const rig = rigWithQueue([HOLD, HOLD], 5, cfg);
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(1);          // the one global slot is now taken

    const t2 = rig.queues.push("work", { prompt: "t2" });
    const r = rig.scheduler.explainTask(t2.taskId);
    expect(r.blockedBy).toBe("supervisorAdmission");
    expect(r.detail).toContain("maxAgentsTotal 1 reached");
    const globalCap = r.admission.find((c) => c.name === "globalCap")!;
    expect(globalCap.ok).toBe(false);
    expect(globalCap.detail).toBe("maxAgentsTotal 1 reached");
    // every earlier dispatch predicate passed — the operator sees caps, not a false blocker
    expect(r.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name)).toEqual(["supervisorAdmission"]);
  });

  it("A5/A6: a workflow-bound in-progress task reports its step, agent and the agent's own costUsd", async () => {
    const rig = makeCoordination([HOLD, HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        builder: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.workflows.create({ name: "wf-two", steps: [
      { id: "s0", title: "plan", gate: { kind: "none" as const }, role: "planner" },
      { id: "s1", title: "build", gate: { kind: "none" as const }, role: "builder" },
    ] });
    const t = rig.queues.push("work", { prompt: "ship it", workflow: "wf-two" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(t.taskId).state === "in_progress");

    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.context.stepId).toBe("s0");
    expect(r.context.stepIndex).toBe(0);
    expect(r.context.agentId).toBe(rig.fake.spawns[0]!.agentId);
    expect(r.context.costUsd).toBe(rig.sup.status(r.context.agentId!).costUsd);
    expect(r.context.recentSteps.length).toBeGreaterThan(0);
    expect(r.context.recentSteps.length).toBeLessThanOrEqual(3);
    expect(r.context.recentSteps.at(-1)!.stepId).toBe("s0");
  });

  it("A6: costUsd is null for a task with no bound agent", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.context.agentId).toBeNull();
    expect(r.context.costUsd).toBeNull();
  });

  it("a queue with no team bound reports teamBound, not a spurious later blocker", () => {
    const rig = makeCoordination([HOLD]);
    rig.queues.create({ name: "orphan" });
    const t = rig.queues.push("orphan", { prompt: "t1" });
    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("teamBound");
    expect(r.team).toBeNull();
    expect(r.role).toBeNull();
    expect(r.admission).toEqual([]);                  // never reached, so nothing was probed
  });

  it("explainTask spawns nothing, appends no event and mutates no task", async () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    const queuesBefore = readFileSync(join(rig.dir, "queues.json"), "utf8");
    const eventsBefore = readFileSync(join(rig.dir, "events", "events.jsonl"), "utf8");
    const spawnsBefore = rig.fake.spawns.length;

    for (let i = 0; i < 50; i++) rig.scheduler.explainTask(t.taskId);

    expect(readFileSync(join(rig.dir, "queues.json"), "utf8")).toBe(queuesBefore);
    expect(readFileSync(join(rig.dir, "events", "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(rig.fake.spawns).toHaveLength(spawnsBefore);
  });

  it("explainTask on an unknown taskId throws UnknownTaskError", () => {
    const rig = rigWithQueue();
    expect(() => rig.scheduler.explainTask("t-nope")).toThrow(UnknownTaskError);
  });

  // QA of f0df6ef0: buildDispatchContext used to cap depStates at the first 64 deps in PUSH
  // order, so taskPending could not see the unmet ones, stopped deferring, and answered the
  // operator's "why is this not running?" with a bare 'state is "blocked", not "pending"'.
  it("[F15.QA] a >64-dependency join still names its unmet deps, not a bare blocked state", () => {
    const rig = rigWithQueue();
    const done = Array.from({ length: 64 }, (_, i) => rig.queues.push("work", { prompt: `d${i}` }));
    const unmet = [rig.queues.push("work", { prompt: "u1" }), rig.queues.push("work", { prompt: "u2" })];
    const join = rig.queues.push("work", {
      prompt: "join", dependsOn: [...done, ...unmet].map((t) => t.taskId),
    });
    for (const d of done) rig.queues.markDone(d.taskId, "ok");

    const r = rig.scheduler.explainTask(join.taskId);
    expect(r.blockedBy).toBe("dependenciesSatisfied");
    expect(r.detail).toContain("waiting on 2 of 66 dependencies");
    expect(r.checks.find((ch) => ch.name === "taskPending")!.skipped).toBe(true);
    // the wire cap still holds, but the two that matter claim the slots
    expect(r.context.dependsOn).toHaveLength(64);
    expect(r.context.dependsOn.slice(0, 2)).toEqual(
      unmet.map((t) => ({ taskId: t.taskId, state: "pending" })));
    expect(TaskExplainResultSchema.parse(r)).toBeTruthy();
  });

  it("[F15.QA] a dead-lettered task is explained by taskPending, carrying its recorded error", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1" });
    rig.queues.markDeadLetter(t.taskId, "gave up after 3 tries");

    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.dispatchable).toBe(false);
    expect(r.blockedBy).toBe("taskPending");
    expect(r.detail).toContain("dead_letter");
    expect(r.detail).toContain("gave up after 3 tries");
    expect(r.context.state).toBe("dead_letter");
  });

  it("[F15.2] an unknown role blocks before an unknown workflow is even checked (roleKnown precedes workflowResolvable)", () => {
    const rig = rigWithQueue();
    const t = rig.queues.push("work", { prompt: "t1", role: "ghost", workflow: "no-such-wf" });
    const r = rig.scheduler.explainTask(t.taskId);
    expect(r.blockedBy).toBe("roleKnown");
    expect(r.detail).toContain('unknown role "ghost"');
  });
});
