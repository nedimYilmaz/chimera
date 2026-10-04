import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { ExplainCheckSchema, TaskExplainResultSchema } from "@chimera/protocol";
import { DISPATCH_PREDICATES, DISPATCH_PREDICATE_NAMES } from "@chimera/core/dispatch-predicates";
import { ADMISSION_CHECK_NAMES } from "@chimera/core/supervisor";
import { makeCoordination } from "./coord-helpers.js";

// F15's verdict-mandated parity guard: a predicate that exists in dispatch and not in explain
// must fail a test. Both paths read the ONE exported array, so this passes by construction —
// which is the point. It fails only if someone reintroduces an inline check (caught by the two
// source guards in scheduler-dispatch-predicates / supervisor-admission-array) or hands the
// drain loop a private copy of the array (caught by the spy test below).

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held", costUsd: 0.01 } }];
const DEV_TEAM = {
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
  maxConcurrent: 2, queue: "work",
};

function rig() {
  const r = makeCoordination([HOLD, HOLD, HOLD]);
  r.queues.create({ name: "work" });
  r.teams.create(DEV_TEAM);
  return r;
}

describe("F15 parity: explain covers every dispatch decision", () => {
  it("explainTask returns EVERY dispatch predicate, in array order", () => {
    const r = rig();
    const t = r.queues.push("work", { prompt: "t1" });
    expect(r.scheduler.explainTask(t.taskId).checks.map((c) => c.name)).toEqual(DISPATCH_PREDICATE_NAMES);
  });

  it("a task blocked EARLY still returns every predicate name (short-circuit never truncates checks)", () => {
    const r = rig();
    const t = r.queues.push("work", { prompt: "t1" });
    r.queues.pause("work");                       // blocks at predicate index 2
    const res = r.scheduler.explainTask(t.taskId);
    expect(res.blockedBy).toBe("queueNotPaused");
    expect(res.checks.map((c) => c.name)).toEqual(DISPATCH_PREDICATE_NAMES);
  });

  it("explainTask returns every admission check when dispatch reaches that far", () => {
    const r = rig();
    const t = r.queues.push("work", { prompt: "t1" });
    const res = r.scheduler.explainTask(t.taskId);
    expect(res.blockedBy).toBeNull();
    expect(res.admission.map((c) => c.name)).toEqual([...ADMISSION_CHECK_NAMES]);
  });

  it("adding a predicate to the array without explaining it is impossible", () => {
    const r = rig();
    const t = r.queues.push("work", { prompt: "t1" });
    const names = new Set(r.scheduler.explainTask(t.taskId).checks.map((c) => c.name));
    for (const p of DISPATCH_PREDICATES) expect(names.has(p.name)).toBe(true);
  });

  it("the LIVE drain loop evaluates the same predicate objects explainTask does (not a copy)", async () => {
    const r = rig();
    r.queues.push("work", { prompt: "t1" });
    const spies = DISPATCH_PREDICATES.map((p) => vi.spyOn(p, "evaluate"));
    try {
      await r.scheduler.tick();
      expect(r.fake.spawns).toHaveLength(1);      // the task really did dispatch through this path
      for (const p of DISPATCH_PREDICATES) {
        const spy = spies[DISPATCH_PREDICATES.indexOf(p)]!;
        // liveSite:"spawn" predicates are evaluated BY supervisor.spawn itself — the loop must
        // not replay them off the explain path's projected spec (see DispatchLiveSite).
        expect([p.name, spy.mock.calls.length > 0]).toEqual([p.name, p.liveSite === "loop"]);
      }
    } finally { for (const s of spies) s.mockRestore(); }
  });
  // [F15.QA] WIRE CAPS, asserted where a predicate author actually works. explainTask
  // defensively truncates every OTHER capped field it emits (dependsOn->64 unmet-first,
  // recentSteps->3, error->400, detail->240) but passes `checks` and `admission` through
  // untouched, so the arrays themselves are the bound: the 25th predicate or the 9th admission
  // check silently produces a payload that no longer satisfies TaskExplainResultSchema
  // (checks.max(24) / admission.max(8)), and an over-long predicate name one that fails
  // ExplainCheckSchema.name.max(48). scheduler-explain-task.test.ts does parse a live payload
  // and would go red too — but two files away and with a zod error naming the schema, not the
  // array someone just grew. Parse rather than compare literals so the caps stay in ONE place.
  it("the predicate and admission arrays still fit the wire caps they are validated against", () => {
    const r = rig();
    const t = r.queues.push("work", { prompt: "t1" });
    const res = r.scheduler.explainTask(t.taskId);
    expect(TaskExplainResultSchema.parse(res)).toBeTruthy();
    expect(res.checks).toHaveLength(DISPATCH_PREDICATES.length);      // nothing truncated on the way out
    expect(res.admission).toHaveLength(ADMISSION_CHECK_NAMES.length);
    for (const p of DISPATCH_PREDICATES)
      expect(ExplainCheckSchema.safeParse({ name: p.name, ok: true, detail: "" }).success).toBe(true);
  });
});
