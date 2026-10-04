import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { DISPATCH_PREDICATES, DISPATCH_PREDICATE_NAMES, firstBlocking, type DispatchContext } from "@chimera/core/dispatch-predicates";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0.01 } }];
const DEV_TEAM = (maxConcurrent: number) => ({
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
  maxConcurrent, queue: "work",
});

// A synthetic, fully-passing context — each test flips exactly the field under test, so a
// failure names one predicate rather than "something in the fixture".
function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  const task = { taskId: "t-1", queue: "work", state: "pending", priority: 0, attempts: 0, error: null,
                 dependsOn: [], stepIndex: 0 } as unknown as DispatchContext["task"];
  return {
    task, team: { name: "crew", maxConcurrent: 2 } as DispatchContext["team"],
    queue: { name: "work", paused: false } as DispatchContext["queue"],
    roleName: "dev", template: {} as DispatchContext["template"], persistent: false,
    workflow: null, workflowError: null, headOfQueue: task,
    maxConcurrent: 2, poolSize: 0, poolCap: 1, depStates: [],
    parkedRetryMsRemaining: null, parkedSwitch: null,
    runningForTeam: () => 0, hasIdleWorker: () => false,
    spec: () => ({ ok: true, error: null }), admission: () => [], admissionEvaluated: () => [],
    ...over,
  };
}

describe("F15: DISPATCH_PREDICATES", () => {
  it("DISPATCH_PREDICATE_NAMES matches the documented dispatch order", () => {
    expect(DISPATCH_PREDICATE_NAMES).toEqual([
      "teamBound", "queueExists", "queueNotPaused", "taskPending", "dependenciesSatisfied",
      "headOfDrainOrder", "roleKnown", "teamConcurrency", "workflowResolvable", "workerCapacity",
      "specValid", "supervisorAdmission",
    ]);
  });

  it("firstBlocking stops at the first non-skipped failure and never evaluates a later predicate", () => {
    const later = vi.spyOn(DISPATCH_PREDICATES[6]!, "evaluate");     // roleKnown
    try {
      // both queueNotPaused (2) and roleKnown (6) would fail — only the earlier one is reported
      const r = firstBlocking(ctx({ queue: { name: "work", paused: true } as DispatchContext["queue"], template: null }));
      expect(r.blocked?.name).toBe("queueNotPaused");
      expect(later).not.toHaveBeenCalled();
      // A9: every predicate still gets a row, so `checks` can never be shorter than the array
      expect(r.checks.map((c) => c.name)).toEqual(DISPATCH_PREDICATE_NAMES);
      expect(r.checks.every((c) => c.ok || c.skipped)).toBe(false);
      expect(r.checks[6]!.skipped).toBe(true);                       // "not evaluated: queueNotPaused blocked first"
    } finally { later.mockRestore(); }
  });

  it("teamConcurrency is skipped for a persistent role; workerCapacity is skipped for an ephemeral one", () => {
    const ephemeral = firstBlocking(ctx()).checks;
    expect(ephemeral.find((c) => c.name === "teamConcurrency")!.skipped).toBe(false);
    expect(ephemeral.find((c) => c.name === "workerCapacity")!.skipped).toBe(true);

    const persistent = firstBlocking(ctx({ persistent: true })).checks;
    expect(persistent.find((c) => c.name === "teamConcurrency")!.skipped).toBe(true);
    expect(persistent.find((c) => c.name === "workerCapacity")!.skipped).toBe(false);
  });

  it("a skipped predicate never becomes the blocker (workerCapacity full but role is ephemeral)", () => {
    const r = firstBlocking(ctx({ poolSize: 9, poolCap: 1 }));
    expect(r.blocked).toBeNull();
  });

  it("in \"loop\" scope the two spawn-site predicates are not evaluated at all", () => {
    const spec = vi.fn(() => ({ ok: false, error: "bad spec" }));
    const admission = vi.fn(() => []);
    const r = firstBlocking(ctx({ spec, admission }), "loop");
    expect(r.blocked).toBeNull();                 // the spawn call itself is their live site
    expect(spec).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(r.checks.map((c) => c.name)).toEqual(DISPATCH_PREDICATE_NAMES);
  });
});

describe("F15: the live drain loop still short-circuits identically", () => {
  it("maxConcurrent 1 spawns exactly one agent per tick with three pending tasks", async () => {
    const rig = makeCoordination([HOLD, HOLD, HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    for (const p of ["t1", "t2", "t3"]) rig.queues.push("work", { prompt: p });

    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(1);
    expect(rig.queues.status("work").counts).toMatchObject({ pending: 2, in_progress: 1 });
    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(1);      // still gated by teamConcurrency
  });

  it("a paused queue drains nothing and leaves the running agent untouched", async () => {
    const rig = makeCoordination([HOLD, HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(2));
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(1);

    rig.queues.pause("work");
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();
    expect(rig.fake.spawns).toHaveLength(1);
    expect(rig.queues.status("work").counts).toMatchObject({ pending: 1, in_progress: 1 });
  });

  it("an unknown-role task fails permanently even when the team is at maxConcurrent", async () => {
    // F15's ONE accepted behaviour delta: a single linear array evaluates roleKnown (6) before
    // teamConcurrency (7), so this task now fails on the tick that finds the team full instead
    // of on the next tick with a free slot. Deliberate — asserted, not incidental.
    const rig = makeCoordination([HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    expect(rig.scheduler.runningFor("crew")).toBe(1);              // team is now AT maxConcurrent

    const ghost = rig.queues.push("work", { prompt: "t2", role: "ghost" });
    await rig.scheduler.tick();
    const rec = rig.queues.getTask(ghost.taskId);
    expect(rec.state).toBe("failed");
    expect(rec.error).toBe('unknown role "ghost" in team "crew"');  // byte-identical to the pre-F15 message
    expect(rig.fake.spawns).toHaveLength(1);                        // nothing new was spawned
  });

  it("an unresolvable workflow binding still fails the task permanently with the resolver's own message", async () => {
    const rig = makeCoordination([HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    const t = rig.queues.push("work", { prompt: "t1", workflow: "no-such-wf" });
    await rig.scheduler.tick();
    const rec = rig.queues.getTask(t.taskId);
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("no-such-wf");
    expect(rig.fake.spawns).toHaveLength(0);
  });

  it("a team bound to a MISSING queue still emits the queue-missing status event (unchanged)", async () => {
    const rig = makeCoordination([HOLD]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.delete("work");
    await rig.scheduler.tick();
    const evs = rig.events.tail("team:crew", 20);
    expect(evs.some((e) => e.kind === "status" && (e.data as { state?: string }).state === "queue-missing")).toBe(true);
  });

  it("a persistent pool still drains under its pool cap, not teamConcurrency", async () => {
    const WORKER: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];
    const rig = makeCoordination([WORKER, WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, persistent: true, poolSize: 1 } } },
      maxConcurrent: 5, queue: "work",
    });
    rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.fake.spawns.length === 1);
    expect(rig.fake.spawns).toHaveLength(1);       // pool cap 1 governs, not maxConcurrent 5
    expect(rig.queues.status("work").counts).toMatchObject({ pending: 1, in_progress: 1 });
  });
});

describe("F15 source guard: the fenced drain region delegates every decision to the predicate switch", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/scheduler.ts", import.meta.url)), "utf8");
  const fenced = SRC.slice(
    SRC.indexOf("// F15-DISPATCH-FENCE:BEGIN"),
    SRC.indexOf("// F15-DISPATCH-FENCE:END"),
  );

  it("the fence markers exist exactly once each", () => {
    expect(SRC.split("// F15-DISPATCH-FENCE:BEGIN")).toHaveLength(2);
    expect(SRC.split("// F15-DISPATCH-FENCE:END")).toHaveLength(2);
    expect(fenced.length).toBeGreaterThan(0);
  });

  it("no markFailed and no break survives outside the single switch (blocked.onFail) block", () => {
    const switchStart = fenced.indexOf("switch (blocked === null");
    expect(switchStart).toBeGreaterThan(0);
    // the switch runs to the end of the drain loop body; everything after it in the fence is
    // the catch block, which is allowed to append its status event but not to decide dispatch.
    const switchEnd = fenced.indexOf("} catch (err) {", switchStart);
    const outside = fenced.slice(0, switchStart) + fenced.slice(switchEnd);
    // strip comments — the fence's own doc comments legitimately mention these words
    const code = outside.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/markFailed\(/);
    expect(code).not.toMatch(/\bbreak\b/);
  });
});
