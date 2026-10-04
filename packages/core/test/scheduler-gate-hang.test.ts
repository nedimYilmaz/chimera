import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { defaultGateExec, type GateExecFn } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";

// GATE-HANG-HARDENING (2026-08-22 zombie-agent incident regression): two workflow-bound
// agents' last event was an ordinary `turn_complete`/`result` and then NOTHING for
// 7.5-8.6 hours — the daemon filled its 40-agent cap with tasks that were, in fact, done.
// Root cause: handleWorkflowTurn (scheduler.ts) awaits evaluateGate() while holding the
// `stepTransitioning` lock; a command gate's exec relied entirely on the child process
// cooperating with a SIGTERM at its timeout, which a docker child under contention can
// ignore — leaving that await (and the lock) held forever. These tests prove the two
// independent hardening layers that make the wedge impossible now, not merely unlikely.
const TWO_STEP_SCENARIO: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { end: { resultText: "done" } },
];

const WF_STEPS = (gate: { kind: "command"; spec: { command: string; args: string[] } }) => [
  { id: "s0", title: "test", gate },
  { id: "s1", title: "ship", gate: { kind: "none" as const } },
];

describe("GATE-HANG-HARDENING: a gate whose exec promise never resolves cannot wedge a task forever", () => {
  it("the outer hard ceiling forces the step to fail instead of leaving the task/agent stuck forever", async () => {
    // Simulates the worst case: an injected gateExec that NEVER settles, mirroring an
    // unkillable docker child — exactly the case defaultGateExec's own hardening (tested
    // below) exists to prevent, but proven here as a hang from the SCHEDULER's point of
    // view regardless of what the exec seam does internally.
    const gateExec: GateExecFn = () => new Promise(() => {});
    const rig = makeCoordination([TWO_STEP_SCENARIO], COORD_CFG, { gateExec, gateEvalHardCeilingMs: 50 });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "wf", steps: WF_STEPS({ kind: "command", spec: { command: "true", args: [] } }) });

    const t = rig.queues.push("work", { prompt: "task", workflow: "wf" });
    await rig.scheduler.tick();
    const agentId = rig.queues.getTask(t.taskId).agentId!;
    await rig.sup.send(agentId, "go");

    // Without the hard ceiling this never resolves and the test times out with the task
    // stuck "in_progress" and the agent stuck "running" — exactly the production incident.
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5_000);
    expect(rig.queues.getTask(t.taskId).stepHistory[0]?.reason).toContain("hard ceiling");
    // The agent must have SETTLED (unbound from the scheduler's tracked map and reflected
    // as non-running) — not left dangling the way the two zombie agents were.
    expect(rig.sup.status(agentId).state).not.toBe("running");
  });
});

describe("GATE-HANG-HARDENING: defaultGateExec never lets an uncooperative child hang its promise", () => {
  vi.setConfig({ testTimeout: 20_000 });

  it("escalates to SIGKILL when the child ignores SIGTERM at its timeout, so the promise still resolves", async () => {
    const start = Date.now();
    const res = await defaultGateExec(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      "/tmp", {}, 300,
    );
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    // Resolves via the SIGKILL escalation (bound + ~10s), not the ~30s-later hard ceiling
    // fallback — proves the escalation itself, not just the outer bailout, ends the hang.
    expect(elapsed).toBeLessThan(20_000);
  });
});
