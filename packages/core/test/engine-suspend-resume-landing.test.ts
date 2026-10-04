import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { GateExecFn } from "@chimera/core/scheduler";
import { WorkflowSpecSchema, type NormalizedEvent, type Subscription, type TaskRecord, type WorkflowSpec } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

// The recipe ships a runnable example workflow (docs/recipes/suspend-resume-landing.workflow.json).
// This test file lives at packages/core/test/ ⇒ repo root is four levels up.
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

// HOOK-8 (PLAN-HOOKS.md §4.2 + §10): the suspend/resume landing recipe. A worker commits and
// SUSPENDS (ends its turn), a workflow `command` gate runs the repo gate script scheduler-side
// in the worker's worktree (ZERO worker turns), and the verdict drives what happens next.
//
// There are TWO resume mechanisms, and which one is correct depends on WHO waits:
//   1. The WORKER itself → the workflow's native onFail:"retry" resend. A failing gate resends
//      the SAME step to the (still-warm) session WITH the verdict text; a passing gate advances
//      to the land step. This is the recommended fix-loop — the step machine already owns the
//      worker's lifecycle, so a self-subscription would only re-enter it. (Test 1.)
//   2. A SEPARATE observer (a lander/conductor/teammate) → a `gate.verdict` `wake:"resume"`
//      subscription. The verdict becomes an event any settled observer can be resumed on,
//      without the worker having to hand off `deliverTo`. (Test 2.)
//
// docs/recipes/suspend-resume-landing.md is the human-facing recipe these two tests back.

const countTurns = (events: { tail: (a: string, n: number) => NormalizedEvent[] }, agentId: string): number =>
  events.tail(agentId, 500).filter((e) => e.kind === "turn_complete").length;

// The public repository ships without maintainer docs, so this doc guard runs only where the doc exists.
describe("HOOK-8 landing recipe — the shipped example workflow is spec-valid", () => {
  it.skipIf(!existsSync(join(REPO_ROOT, "docs/recipes/suspend-resume-landing.workflow.json")))("docs/recipes/suspend-resume-landing.workflow.json parses as a WorkflowSpec (command gate on 'verify', onFail:retry)", () => {
    const raw = readFileSync(join(REPO_ROOT, "docs/recipes/suspend-resume-landing.workflow.json"), "utf8");
    const spec = WorkflowSpecSchema.parse(JSON.parse(raw));
    expect(spec.name).toBe("land-gate");
    expect(spec.onFail).toBe("retry");
    const verify = spec.steps.find((s) => s.id === "verify")!;
    expect(verify.gate.kind).toBe("command");
    expect(spec.steps.map((s) => s.id)).toEqual(["verify", "land"]);
  });
});

describe("HOOK-8 landing recipe — worker resumes with the verdict (workflow-native onFail:'retry')", () => {
  const WF_STEPS: WorkflowSpec["steps"] = [
    { id: "verify", title: "verify", gate: { kind: "command", spec: { command: "true", args: [] } } },
    { id: "land", title: "land", gate: { kind: "none" } },
  ];

  // agent_started, then: turn (verify attempt 1 → gate FAIL → retry resend), awaitSend (receives
  // the retry text = the verdict), turn (verify attempt 2 → gate PASS → advance), awaitSend
  // (receives the land step), turn (land, gate none → terminal), end.
  const SCENARIO: FakeStep[] = [
    { emit: { kind: "agent_started", data: { sessionId: "sess-w" } } },
    { turn: {} },
    { awaitSend: true },
    { turn: {} },
    { awaitSend: true },
    { turn: {} },
    { end: { resultText: "landed" } },
  ];

  it("a FAILED gate resends the verdict to the warm worker and a later PASS lands it — the gate runs with zero worker turns", async () => {
    let rig!: ReturnType<typeof makeCoordination>;
    let calls = 0;
    // Fail the first gate, pass the second. On EACH call, prove the worker took zero turns while
    // the gate ran: snapshot the worker's completed-turn count, yield, snapshot again — the
    // worker is parked awaiting the scheduler's next send, so the gate never overlaps a turn.
    const zeroTurnWindows: boolean[] = [];
    const gateExec: GateExecFn = async (_cmd, _args, _cwd, env) => {
      calls += 1;
      const agentId = env["CHIMERA_AGENT_ID"]!;
      const before = countTurns(rig.events, agentId);
      await new Promise((r) => setTimeout(r, 5));
      zeroTurnWindows.push(countTurns(rig.events, agentId) === before);
      return calls === 1
        ? { ok: false, message: "vitest: 1 failing (engine-hooks)" }
        : { ok: true, message: "" };
    };
    rig = makeCoordination([SCENARIO], undefined, { gateExec });
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    rig.workflows.create({ name: "land-gate", steps: WF_STEPS, onFail: "retry", retryLimit: 2 });

    const t = rig.queues.push("work", { prompt: "do the work", workflow: "land-gate" });
    await rig.scheduler.tick();

    // The task lands (done) only after the failing gate resumed the worker with the verdict, the
    // worker fixed, the gate passed, and the land step's `none` gate closed the session.
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);
    const agentId = rig.queues.getTask(t.taskId).agentId!;

    // WORKER RESUMES WITH THE VERDICT: the retry resend embedded the gate's failure text
    // (workflowStepText's retryNote) — the warm worker echoed it back verbatim.
    const echoes = rig.events.tail(agentId, 500)
      .filter((e) => e.kind === "message_complete" && typeof e.data["text"] === "string")
      .map((e) => e.data["text"] as string);
    expect(echoes.some((line) => line.includes("vitest: 1 failing (engine-hooks)"))).toBe(true);

    // ZERO WORKER TURNS DURING THE GATE: the gate ran twice (fail, then pass), and neither run
    // overlapped a worker turn.
    expect(calls).toBe(2);
    expect(zeroTurnWindows).toEqual([true, true]);
  });
});

describe("HOOK-8 landing recipe — a settled observer is resumed on gate.verdict (wake:'resume')", () => {
  const TEAM = (cwd: string) => ({
    name: "crew",
    roles: { dev: { role: "blank", overrides: { cwd, account: "main", isolation: "none" as const } } },
    maxConcurrent: 1,
    queue: "work",
  });

  it("runs the gate scheduler-side while the worker is settled, then resumes a separate observer WITH the verdict", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-hook8-"));
    const fake = new FakeAgentBackend([
      // spawn 0 — the observer: settles to "done" with a resumable session, then waits to be
      // woken by the landing verdict.
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-observer" } } }, { end: { resultText: "watching" } }],
      // spawn 1 — the worker: parks after spawn (so the observer's subscription can be
      // registered against the task first), then commits + ends its turn → settles to "done".
      [
        { emit: { kind: "agent_started", data: { sessionId: "sess-worker" } } },
        { awaitSend: true },
        { end: { resultText: "committed; ready-to-land" } },
      ],
      // spawn 2 — the observer's resume: the pending gate.verdict signal is delivered on start.
      [
        { emit: { kind: "agent_started", data: { sessionId: "sess-observer" } } },
        { awaitSend: true },
        { end: { resultText: "acted on the verdict" } },
      ],
    ]);

    // The gate probe proves "zero worker turns during the gate": while the gate runs the worker
    // must be settled ("done") and no run other than the observer's may have started.
    let engine!: Engine;
    let workerId = "";
    const gateProbe: { workerState: string; spawns: number; cwd: string }[] = [];
    const gateExec: GateExecFn = async (_cmd, _args, execCwd, env) => {
      await new Promise((r) => setTimeout(r, 5));
      gateProbe.push({
        workerState: engine.supervisor.status(env["CHIMERA_AGENT_ID"]!).state,
        spawns: fake.spawns.length,
        cwd: execCwd,
      });
      return { ok: false, message: "tsc failed: 1 error in engine.ts" };
    };

    engine = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", fake]]),
      gateExec,
    });

    // 1) Spawn the observer and let it settle.
    const observer = (await engine.handle("agent.spawn", { spec: { prompt: "watch the landing", cwd, isolation: "none" } })) as { agentId: string };
    await waitUntil(() => engine.supervisor.status(observer.agentId).state === "done");

    // 2) A single command-gated workflow. Default onFail:"halt" ⇒ the worker just settles as
    //    failed — the observer's subscription, not the step machine, is what reacts to the
    //    verdict, so there is no competing worker respawn.
    await engine.handle("workflow.create", {
      spec: { name: "land-gate", steps: [{ id: "verify", title: "verify & land", gate: { kind: "command", spec: { command: "true", args: [] } } }] } satisfies WorkflowSpec,
    });
    await engine.handle("queue.create", { spec: { name: "work" } });
    await engine.handle("team.create", { spec: TEAM(cwd) });
    const task = (await engine.handle("queue.push", { queue: "work", prompt: "do the work", workflow: "land-gate" })) as TaskRecord;

    // 3) Register the observer's landing subscription against the task, before the gate fires.
    await waitUntil(() => engine.queues.getTask(task.taskId).agentId !== null);
    workerId = engine.queues.getTask(task.taskId).agentId!;
    const sub = (await engine.handle("sub.create", {
      subscriberId: observer.agentId,
      topic: "gate.verdict",
      filter: { taskId: task.taskId },
      once: true,
      wake: "resume",
    })) as Subscription;
    expect(sub.wake).toBe("resume");

    // 4) Unblock the worker → it ends its turn → settles → gate runs scheduler-side → fails →
    //    gate.verdict fires → the observer is resumed with the verdict.
    await engine.supervisor.send(workerId, "go", "user");
    await waitUntil(() => fake.spawns.length === 3, 5000);

    // ZERO WORKER TURNS DURING THE GATE: the worker was settled and no run but the observer's
    // resume started while the gate ran.
    expect(gateProbe).toHaveLength(1);
    expect(gateProbe[0]!.workerState).toBe("done");
    expect(gateProbe[0]!.spawns).toBe(2);        // observer(0) + worker(1); the resume(2) is later
    expect(gateProbe[0]!.cwd).toBe(cwd);         // the gate ran in the worker's own working dir

    // OBSERVER RESUMES WITH THE VERDICT: a same-session respawn, and the delivered signal carries
    // the gate's verdict text verbatim.
    const resumeSpawn = fake.spawns[2]!;
    expect(resumeSpawn.resume).toBe("sess-observer");
    expect(resumeSpawn.resumeOnly).toBe(true);
    await waitUntil(() =>
      engine.events.tail(observer.agentId, 100).some(
        (e) => e.kind === "status" && e.data["delivered"] === true &&
          typeof e.data["text"] === "string" &&
          (e.data["text"] as string).includes("[signal:gate.verdict]") &&
          (e.data["text"] as string).includes("tsc failed: 1 error in engine.ts"),
      ), 5000);

    // the once:true subscription auto-removed after firing exactly once.
    expect(engine.subscriptions.list(observer.agentId)).toHaveLength(0);
  });
});
