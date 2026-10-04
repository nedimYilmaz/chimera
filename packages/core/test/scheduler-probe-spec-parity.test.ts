import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { resolveAgentSpec } from "@chimera/core/supervisor";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// QA of F15/F22 (S-1). F15's explain path builds a PROBE spec (scheduler.probeAgentSpec) that
// stands in for the spec the drain loop would really spawn. The two must not drift: a probe that
// validates a spec no live path builds can report specValid:false for a task that spawns fine
// (or the reverse). This pins the probe against the spec the live path ACTUALLY hands to
// supervisor.spawn, for both dispatch branches.
//
// The known divergence this file was written for: a persistent role NEVER reaches spawnForTask —
// buildDispatchContext routes it to assignPersistent (scheduler.ts, `ctx.persistent`), which sets
// `persistent: true` and deliberately NOT `conductor` (its D12 comment). The probe used to add
// `conductor: true` for every workflow-bound task, persistent included.

// The three fields probeAgentSpec knowingly approximates (its Risk R2 comment): the roster/
// workflow instruction header, the shared-worktree key, and the team preamble on the prompt.
// Everything else must match exactly.
const APPROXIMATED = ["instructions", "workdirKey", "prompt"] as const;
function comparable(spec: Record<string, unknown>): Record<string, unknown> {
  const out = { ...spec };
  for (const k of APPROXIMATED) delete out[k];
  return out;
}

const WORKER: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: { text: "w1" } },
  { awaitSend: true },
];

function rigFor(persistent: boolean) {
  const r = makeCoordination([WORKER]);
  r.workflows.create({ name: "wf1", steps: [{ id: "s0", title: "work", role: "worker", model: "sonnet", gate: { kind: "none" } }] });
  r.queues.create({ name: "work", workflow: "wf1" });
  r.teams.create({
    name: "crew",
    roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const, poolSize: 1, ...(persistent ? { persistent: true } : {}) } } },
    maxConcurrent: 1, queue: "work",
  });
  return r;
}

async function probeVsLive(r: ReturnType<typeof makeCoordination>) {
  const task = r.queues.push("work", { prompt: "do it" });
  const team = r.teams.list().find((t) => t.name === "crew")!;
  const wf = r.workflows.get("wf1")!;
  const sched = r.scheduler as unknown as {
    resolveTeamRole: (t: unknown, n: string) => unknown;
    probeAgentSpec: (task: unknown, template: unknown, wf: unknown) => Record<string, unknown>;
  };
  const template = sched.resolveTeamRole(team, "worker");
  // taken BEFORE the tick: explain answers about a task that has not dispatched yet
  const probe = sched.probeAgentSpec(task, template, wf);

  const spy = vi.spyOn(r.sup, "spawn");
  await r.scheduler.tick();
  await waitUntil(() => spy.mock.calls.length === 1);
  const live = resolveAgentSpec(spy.mock.calls[0]![0]) as unknown as Record<string, unknown>;
  return { probe, live };
}

describe("probeAgentSpec matches the spec the live dispatch path spawns (F15/F22.QA S-1)", () => {
  it("persistent + workflow: assignPersistent's spec — persistent, NOT conductor", async () => {
    const { probe, live } = await probeVsLive(rigFor(true));
    expect(live).toMatchObject({ persistent: true });
    // the regression itself: the probe must not invent a conductor the live spawn never sets
    expect(probe["conductor"]).toBe(live["conductor"]);
    expect(comparable(probe)).toEqual(comparable(live));
  });

  it("non-persistent + workflow: spawnForTask's spec — conductor, NOT persistent", async () => {
    const { probe, live } = await probeVsLive(rigFor(false));
    expect(live).toMatchObject({ conductor: true });
    expect(comparable(probe)).toEqual(comparable(live));
  });
});
