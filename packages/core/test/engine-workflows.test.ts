import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { EventLog } from "@chimera/core/events";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord, WorkflowRecord, WorkflowSpec } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

// CORE-SUITE-BASELINE: command gates here spawn a real `node -e` subprocess, and pure
// scheduler coordination (fake backends) can also exceed vitest's 5000ms default under
// this machine's concurrent-agent load; widened alongside the waitUntil deadlines below.
vi.setConfig({ testTimeout: 25_000 });

// A 5-step workflow exercising all four gate kinds (except artifact, D13-pending):
// none, none, a PASSING command gate, an approval gate, none.
const FIVE_STEPS: WorkflowSpec["steps"] = [
  { id: "s0", title: "plan", gate: { kind: "none" } },
  { id: "s1", title: "implement", gate: { kind: "none" } },
  { id: "s2", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(0)"] } } },
  { id: "s3", title: "review", gate: { kind: "approval", spec: {} } },
  { id: "s4", title: "ship", gate: { kind: "none" } },
];

// One fake spawn's step script driving the 5-step happy path IN ORDER: a `turn`
// completes the current step, `awaitSend` blocks for the scheduler's next-step
// delivery, and the final `end` supplies the terminal resultText once the daemon
// closes the conductor session after step 4's gate passes.
const FIVE_STEP_SCENARIO: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { turn: {} },
  { awaitSend: true },
  { end: { resultText: "shipped" } },
];

// F16.1 Phase 1: same shape as FIVE_STEPS, but s0/s2/s4 carry `instructions` and
// s1/s3 don't — exercises both "instructions present" and "instructions absent
// (byte-identical to today)" in the same run.
const FIVE_STEPS_WITH_INSTRUCTIONS: WorkflowSpec["steps"] = [
  { id: "s0", title: "plan", gate: { kind: "none" }, instructions: "Read the design doc before touching code." },
  { id: "s1", title: "implement", gate: { kind: "none" } },
  { id: "s2", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(0)"] } }, instructions: "Run the full suite, not just unit tests." },
  { id: "s3", title: "review", gate: { kind: "approval", spec: {} } },
  { id: "s4", title: "ship", gate: { kind: "none" }, instructions: "Tag the release and announce in #ship." },
];

const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };

async function driveApproval(e: Engine): Promise<void> {
  let questionId: string | undefined;
  let gate: unknown;
  const unsub = e.events.subscribe((ev) => {
    if (ev.kind === "agent_question") { questionId = ev.data["questionId"] as string; gate = ev.data["gate"]; }
  });
  await waitUntil(() => questionId !== undefined, 20_000);
  unsub();
  // FEATURE-9 (attention inbox): the approval-gate's ask() must be tagged so a client
  // can label it distinctly from a plain question — see scheduler.ts's evaluateGate.
  expect(gate).toBe("approval");
  await e.handle("agent.answerQuestion", { questionId, answer: { optionIds: ["approve"] } });
}

describe("Engine workflow.* RPC family + step machine (D12)", () => {
  it("workflow.create/list/update/delete lifecycle, versioned", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const created = await e.handle("workflow.create", { spec: { name: "release", steps: FIVE_STEPS } }) as WorkflowRecord;
    expect(created.version).toBe(1);

    const listed = await e.handle("workflow.list", {}) as Array<{ name: string }>;
    expect(listed.map((w) => w.name)).toEqual(["release"]);

    const updated = await e.handle("workflow.update", { name: "release", patch: { retryLimit: 2 } }) as { version: number; retryLimit: number };
    expect(updated.version).toBe(2);
    expect(updated.retryLimit).toBe(2);

    expect(await e.handle("workflow.delete", { name: "release" })).toEqual({ deleted: true });
    expect(await e.handle("workflow.list", {})).toEqual([]);
  });

  it("queue.create/update/push reject an unknown workflow reference before persisting", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("queue.create", { spec: { name: "work", workflow: "ghost" } })).rejects.toMatchObject({ code: "protocol" });
    await e.handle("queue.create", { spec: { name: "work" } });
    await expect(e.handle("queue.update", { name: "work", patch: { workflow: "ghost" } })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("queue.push", { queue: "work", prompt: "x", workflow: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("drives a 5-step workflow task in order on a claude-native engine, via the queue's default binding", async () => {
    const fake = new FakeAgentBackend([FIVE_STEP_SCENARIO]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", { spec: { name: "release", steps: FIVE_STEPS } });
    await e.handle("queue.update", { name: "work", patch: { workflow: "release" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const advanced: Array<{ stepIndex: number; stepId: string }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "ship it" }) as TaskRecord;
    await driveApproval(e);
    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);

    expect(advanced.map((a) => a.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(advanced.map((a) => a.stepId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.workflow).toEqual({ name: "release", version: 1 });
    expect(final.stepIndex).toBe(4);
    expect(final.resultText).toBe("shipped");

    // native engine: the FIRST spawn's instructions carry the full plan
    expect(fake.spawns[0]!.instructions).toContain("Full step plan");
    expect(fake.spawns[0]!.instructions).toContain("plan");

    // F16.1 Phase 2 (WF-4/G4): every step opened+closed exactly once, all "passed", in order.
    expect(final.stepHistory).toHaveLength(5);
    expect(final.stepHistory.map((h) => h.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(final.stepHistory.map((h) => h.stepId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    for (const h of final.stepHistory) {
      expect(h.outcome).toBe("passed");
      expect(h.reason).toBeUndefined();
      expect(h.agentId).toBe(fake.spawns[0]!.agentId);
      expect(h.endedAt).not.toBeNull();
      expect(h.startedAt).toBeLessThanOrEqual(h.endedAt!);
    }
  });

  it("drives the SAME 5-step workflow on a forced non-native (codex) engine — per-task override wins over the queue default", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-wf-codex-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-wf-codex-cx-")) } },
      ],
      autoOrder: ["main", "cx"],
    }));
    const claudeFake = new FakeAgentBackend([]);
    const codexFake = new FakeAgentBackend([FIVE_STEP_SCENARIO], "codex");
    const e = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", claudeFake], ["codex", codexFake]]) });
    await e.handle("queue.create", { spec: { name: "work" } });   // no default binding — per-task override drives this
    await e.handle("workflow.create", { spec: { name: "release", steps: FIVE_STEPS } });
    await e.handle("team.create", {
      spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "cx", provider: "codex", isolation: "none" } } }, maxConcurrent: 2, queue: "work" },
    });

    const task = await e.handle("queue.push", { queue: "work", prompt: "ship it", workflow: "release" }) as TaskRecord;
    await driveApproval(e);
    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);

    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.workflow).toEqual({ name: "release", version: 1 });

    // non-native engine: only the CURRENT step's scope, not the full plan
    expect(codexFake.spawns[0]!.instructions).not.toContain("Full step plan");
    expect(codexFake.spawns[0]!.instructions).toContain("step 1/5");
  });

  it("a failing command gate blocks the task and emits task_step_failed (onFail:halt, the default)", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: { name: "gated", steps: [{ id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "gated" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean; reason: string }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    expect(failed).toHaveLength(1);
    expect(failed[0]!.willRetry).toBe(false);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain("gate failed");
  });

  it("onFail:retry re-runs the same step up to retryLimit, then halts", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },
      { turn: {} }, { awaitSend: true },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "flaky", onFail: "retry", retryLimit: 2,
        steps: [{ id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "flaky" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    expect(failed.map((f) => f.willRetry)).toEqual([true, true, false]);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.stepAttempts).toBe(2);

    // F16.1 Phase 2 (WF-4/G4): 3 attempts at the SAME step (stepIndex 0) — 2 retried, 1 failed,
    // each carrying the gate's failure reason, each opened/closed in order.
    expect(final.stepHistory).toHaveLength(3);
    expect(final.stepHistory.every((h) => h.stepIndex === 0 && h.stepId === "s0")).toBe(true);
    expect(final.stepHistory.map((h) => h.outcome)).toEqual(["retried", "retried", "failed"]);
    for (const h of final.stepHistory) {
      expect(h.reason).toBeTruthy();
      expect(h.endedAt).not.toBeNull();
    }
    for (let i = 1; i < final.stepHistory.length; i++) {
      expect(final.stepHistory[i]!.startedAt).toBeGreaterThanOrEqual(final.stepHistory[i - 1]!.endedAt!);
    }
  });

  // ---------- F16.1 Phase 2 (WF-5/G6): per-step onFail/retryLimit overrides ----------

  it("a step's onFail:retry override retries within a workflow that defaults to halt", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },
      { turn: {} }, { awaitSend: true },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "mixed", onFail: "halt", retryLimit: 0,
        steps: [{
          id: "s0", title: "flaky test",
          gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
          onFail: "retry", retryLimit: 2,
        }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "mixed" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    // step's own onFail:"retry"/retryLimit:2 govern, NOT the workflow's halt/0 — two retries, then halt.
    expect(failed.map((f) => f.willRetry)).toEqual([true, true, false]);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.stepAttempts).toBe(2);
  });

  it("a step's onFail:halt override halts immediately within a workflow that defaults to retry", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "mixed", onFail: "retry", retryLimit: 5,
        steps: [{
          id: "s0", title: "critical gate",
          gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
          onFail: "halt",
        }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "mixed" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    // step's own onFail:"halt" wins over the workflow's retry/5 — halts on the FIRST failure.
    expect(failed.map((f) => f.willRetry)).toEqual([false]);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.stepAttempts).toBe(0);
  });

  it("a step's own retryLimit overrides the workflow's, even when both are onFail:retry", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "mixed", onFail: "retry", retryLimit: 5,
        steps: [{
          id: "s0", title: "capped retry",
          gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
          retryLimit: 1,
        }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "mixed" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    // step's retryLimit:1 (onFail inherited as "retry" from the workflow) caps it at ONE retry,
    // not the workflow's 5.
    expect(failed.map((f) => f.willRetry)).toEqual([true, false]);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.stepAttempts).toBe(1);
  });

  it("a workflows.json persisted before Phase 2 (steps without `onFail`/`retryLimit`) behaves exactly as the workflow-level policy — parity with pre-WF-5", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "legacy-shaped", onFail: "retry", retryLimit: 1,
        steps: [{ id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "legacy-shaped" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const failed: Array<{ willRetry: boolean }> = [];
    e.events.subscribe((ev) => { if (ev.kind === "task_step_failed") failed.push(ev.data as never); });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    // no step-level onFail/retryLimit set — falls back to the workflow's retry/1, unchanged.
    expect(failed.map((f) => f.willRetry)).toEqual([true, false]);
    const final = e.queues.getTask(task.taskId);
    expect(final.stepAttempts).toBe(1);
  });

  it("step state (workflow binding, stepIndex, stepAttempts) survives a daemon restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-wf-restart-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    const wf = workflows.create({ name: "release", steps: FIVE_STEPS });

    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const task = queues1.push("work", { prompt: "ship it" });
    queues1.markInProgress(task.taskId, "ag-1");
    queues1.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
    queues1.startStep(task.taskId, 0, "s0", "ag-1");
    queues1.closeStep(task.taskId, "passed");
    queues1.advanceStep(task.taskId, 2);
    queues1.startStep(task.taskId, 2, "s2", "ag-1");
    queues1.closeStep(task.taskId, "retried", "test failed");
    queues1.incrementStepAttempts(task.taskId);
    queues1.startStep(task.taskId, 2, "s2", "ag-1");   // the retry attempt — left OPEN (crash mid-step)

    // simulate a daemon restart: reopen BOTH stores over the same home dir
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(task.taskId);
    expect(recovered.state).toBe("pending");           // in_progress reverts on restart (pre-existing contract)
    expect(recovered.agentId).toBeNull();
    expect(recovered.workflow).toEqual({ name: "release", version: 1 });   // PINNED binding survives
    expect(recovered.stepIndex).toBe(2);                                  // step cursor survives
    expect(recovered.stepAttempts).toBe(1);                               // retry counter survives

    // F16.1 Phase 2 (WF-4/G4): the full stepHistory survives byte-for-byte, INCLUDING the
    // still-open (crash-mid-step) last entry — never guessed-closed on restart.
    expect(recovered.stepHistory).toHaveLength(3);
    expect(recovered.stepHistory[0]).toMatchObject({ stepIndex: 0, stepId: "s0", outcome: "passed" });
    expect(recovered.stepHistory[1]).toMatchObject({ stepIndex: 2, stepId: "s2", outcome: "retried", reason: "test failed" });
    expect(recovered.stepHistory[2]).toMatchObject({ stepIndex: 2, stepId: "s2", outcome: null, endedAt: null });
  });

  // ---------- F16.1 Phase 1: per-step instructions ----------

  it("per-step instructions surface in the native spawn header and each step's advance-turn text; a step without instructions renders BYTE-IDENTICAL text", async () => {
    const fake = new FakeAgentBackend([FIVE_STEP_SCENARIO]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const sendSpy = vi.spyOn(e.supervisor, "send");
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", { spec: { name: "release", steps: FIVE_STEPS_WITH_INSTRUCTIONS } });
    await e.handle("queue.update", { name: "work", patch: { workflow: "release" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await e.handle("queue.push", { queue: "work", prompt: "ship it" });
    await driveApproval(e);
    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);

    // native spawn: header lists TITLES only (plan stays scannable); step 0's own
    // instructions are appended, but a LATER step's instructions are not (not yet current).
    const spawnInstructions = fake.spawns[0]!.instructions!;
    expect(spawnInstructions).toContain("Full step plan");
    expect(spawnInstructions).toContain("Read the design doc before touching code.");
    expect(spawnInstructions).not.toContain("Run the full suite");

    // every step-advance ride on supervisor.send("scheduler") — capture them in order.
    const sentTexts = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    expect(sentTexts).toHaveLength(4);   // advances to steps 1,2,3,4

    // step 1 ("implement") has NO instructions — identical to today's template, no extra sentence.
    expect(sentTexts[0]).toBe(
      `[workflow "release" v1 — step 2/5: "implement"] Complete ONLY this step, then end your turn — chimera evaluates the gate and delivers the next step automatically; you cannot advance by declaring a later step done.`,
    );
    // step 2 ("test") HAS instructions — inserted after the scope header, before the enforcement sentence.
    expect(sentTexts[1]).toBe(
      `[workflow "release" v1 — step 3/5: "test"] Run the full suite, not just unit tests. Complete ONLY this step, then end your turn — chimera evaluates the gate and delivers the next step automatically; you cannot advance by declaring a later step done.`,
    );
    // step 3 ("review") has no instructions — byte-identical again.
    expect(sentTexts[2]).toBe(
      `[workflow "release" v1 — step 4/5: "review"] Complete ONLY this step, then end your turn — chimera evaluates the gate and delivers the next step automatically; you cannot advance by declaring a later step done.`,
    );
    // step 4 ("ship") has instructions.
    expect(sentTexts[3]).toBe(
      `[workflow "release" v1 — step 5/5: "ship"] Tag the release and announce in #ship. Complete ONLY this step, then end your turn — chimera evaluates the gate and delivers the next step automatically; you cannot advance by declaring a later step done.`,
    );
  });

  it("non-native (codex) spawn instructions append the CURRENT step's instructions after the current-step-only header", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-wf-codex-instr-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-wf-codex-instr-cx-")) } },
      ],
      autoOrder: ["main", "cx"],
    }));
    const claudeFake = new FakeAgentBackend([]);
    const codexFake = new FakeAgentBackend([FIVE_STEP_SCENARIO], "codex");
    const e = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", claudeFake], ["codex", codexFake]]) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", { spec: { name: "release", steps: FIVE_STEPS_WITH_INSTRUCTIONS } });
    await e.handle("team.create", {
      spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "cx", provider: "codex", isolation: "none" } } }, maxConcurrent: 2, queue: "work" },
    });

    await e.handle("queue.push", { queue: "work", prompt: "ship it", workflow: "release" });
    await driveApproval(e);
    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);

    const spawnInstructions = codexFake.spawns[0]!.instructions!;
    expect(spawnInstructions).not.toContain("Full step plan");
    expect(spawnInstructions).toContain("step 1/5");
    expect(spawnInstructions).toContain("Read the design doc before touching code.");
    expect(spawnInstructions).not.toContain("Run the full suite");   // step 2's instructions — not current yet
  });

  it("a gate-failure retry resends the SAME step's instructions alongside the retry note, ahead of the enforcement sentence", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} }, { awaitSend: true },
      { turn: {} }, { awaitSend: true },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const sendSpy = vi.spyOn(e.supervisor, "send");
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "flaky", onFail: "retry", retryLimit: 2,
        steps: [{
          id: "s0", title: "test", gate: { kind: "command", spec: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
          instructions: "Check the logs under ./tmp before retrying.",
        }],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "flaky" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await e.handle("queue.push", { queue: "work", prompt: "x" });
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 20_000);

    const retryTexts = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    expect(retryTexts).toHaveLength(2);   // two retries before halting at retryLimit
    for (const text of retryTexts) {
      expect(text).toContain("did not pass its gate");
      expect(text).toContain("Check the logs under ./tmp before retrying.");
      expect(text.indexOf("did not pass its gate")).toBeLessThan(text.indexOf("Check the logs"));
      expect(text.indexOf("Check the logs")).toBeLessThan(text.indexOf("Complete ONLY this step"));
    }
  });

  it("idle-persistent-worker reuse routes the new workflow task's CURRENT-step instructions through the same workflowStepText prompt", async () => {
    const WORKER: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "t1" } },   // task1 (no workflow) completes in one turn — worker goes idle, stays alive
    ];
    const rig = makeCoordination([WORKER]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { worker: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 1 } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.workflows.create({ name: "wf", steps: [{ id: "s0", title: "draft", gate: { kind: "none" }, instructions: "Follow the style guide." }] });

    rig.queues.push("work", { prompt: "task1" });   // unbound — ordinary single-turn completion
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 20_000);

    const sendSpy = vi.spyOn(rig.sup, "send");
    const t2 = rig.queues.push("work", { prompt: "task2", workflow: "wf" });   // bound — must land on the now-idle worker
    await rig.scheduler.tick();

    expect(rig.fake.spawns.length).toBe(1);   // reused the idle worker — no 2nd spawn
    const agentId = rig.queues.getTask(t2.taskId).agentId!;
    const sent = sendSpy.mock.calls.find((c) => c[0] === agentId);
    expect(sent).toBeDefined();
    const text = sent![1] as string;
    expect(text).toContain("Follow the style guide.");
    expect(text).toContain(t2.prompt);
  });

  it("critic gate (FEATURE-3): a revise round then a pass drives the task through the RPC surface end to end", async () => {
    const fake = new FakeAgentBackend([
      [
        { emit: { kind: "agent_started", data: {} } },
        { turn: {} },        // attempt 1 -> critic round 1 (REVISE)
        { awaitSend: true },  // parks for the scheduler's auto retry-send (round 1 feedback)
        { turn: {} },        // attempt 2 -> critic round 2 (PASS)
        { awaitSend: true },  // parks for the scheduler's auto advance-send to s1
        { turn: {} },        // s1 ("ship", gate:none)
        { end: { resultText: "shipped" } },
      ],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "GATE: REVISE\nAdd a test for the empty-input case." } }],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "GATE: PASS" } }],
    ]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    const sendSpy = vi.spyOn(e.supervisor, "send");
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "release",
        steps: [
          { id: "s0", title: "implement", gate: { kind: "critic", spec: { criteria: "covers the empty-input edge case", maxRounds: 3 } } },
          { id: "s1", title: "ship", gate: { kind: "none" } },
        ],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "release" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "ship it" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);

    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("shipped");
    expect(fake.spawns.length).toBe(3);   // worker + 2 critic rounds — never a 3rd critic spawn once it passes

    const schedulerSends = sendSpy.mock.calls.filter((c) => c[2] === "scheduler").map((c) => c[1] as string);
    // the critic's feedback rides the SAME worker's retry-send, verbatim.
    expect(schedulerSends.some((t) => t.includes("Add a test for the empty-input case."))).toBe(true);
  });

  it("bounded fan-out (maxParallel+chunkSize) drives a map-reduce workflow to completion through the real RPC surface", async () => {
    const ONE_SHOT = (resultText: string): FakeStep[] => [
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText } },
    ];
    // 6 items, chunkSize:2 -> 3 branch tasks, maxParallel:2 -> at most 2 branches in flight at
    // once, so this drains in 2 waves of 2 then a join — a fake spawn per: plan, 3 branches,
    // join = 5 total.
    const fake = new FakeAgentBackend([
      ONE_SHOT("planned"), ONE_SHOT("wave1-a"), ONE_SHOT("wave1-b"), ONE_SHOT("wave2"), ONE_SHOT("joined"),
    ]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });

    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "map-reduce",
        steps: [
          { id: "plan", title: "plan", gate: { kind: "none" } },
          {
            id: "spread", title: "spread", gate: { kind: "none" },
            fanOut: { source: { kind: "list", items: ["a", "b", "c", "d", "e", "f"] }, joinStep: "join", chunkSize: 2, maxParallel: 2 },
          },
          { id: "join", title: "join", gate: { kind: "none" } },
        ],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "map-reduce" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 10, queue: "work" } });

    const task = await e.handle("queue.push", { queue: "work", prompt: "reduce it" }) as TaskRecord;
    // counts.done covers the parent AND its branch tasks (4 total once everything settles) —
    // wait on the PARENT's own state, not the aggregate count.
    await waitUntil(() => e.queues.getTask(task.taskId).state === "done", 10_000);

    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("joined");
    // every wave got admitted (fanOutRemaining drained), not just the first — the observable
    // proof, via queue.status, that windowed admission didn't silently drop the tail.
    expect(final.branchChildren).toHaveLength(3);
    expect(final.fanOutRemaining).toEqual([]);
    expect(fake.spawns.length).toBe(5);   // plan + 3 branches + join — no extra/missing spawns

    const status = e.queues.status("work");
    const branches = status.tasks.filter((t) => t.parentTaskId === task.taskId);
    expect(branches).toHaveLength(3);
    expect(branches.every((b) => b.state === "done")).toBe(true);
  }, 15_000);

  it("bounded conditional loops (iterate-until gate): drives a loopBack edge to completion through the real RPC surface", async () => {
    // Deterministic full-boot blackbox for the loop feature: workflow.create/queue.push/
    // queue.status/artifact.add-equivalent — all through Engine.handle(), the exact same handler
    // surface the daemon's RPC server dispatches into — asserting only observable outcomes
    // (final task state, loopIterations, stepHistory), never scheduler internals.
    // head -> work (loops back to head twice while an artifact reads "continue", falls through
    // to done once it reads "done") -> done. 7 step-executions, same role throughout.
    const steps: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }];
    for (let i = 0; i < 6; i++) { steps.push({ turn: {} }); steps.push({ awaitSend: true }); }
    steps.push({ end: { resultText: "converged" } });
    const fake = new FakeAgentBackend([steps]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });

    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "loop-wf",
        steps: [
          { id: "head", title: "head", gate: { kind: "none" }, role: "dev" },
          {
            id: "work", title: "work", gate: { kind: "none" }, role: "dev",
            next: [
              { to: "head", when: { kind: "artifactValue", spec: { value: "done", op: "notEquals" } }, loopBack: { maxIterations: 5 } },
              { to: "done" },
            ],
          },
          { id: "done", title: "done", gate: { kind: "none" }, role: "dev", next: [] },
        ],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "loop-wf" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "converge" }) as TaskRecord;

    let round = 0;
    const counterFile = join(mkdtempSync(join(tmpdir(), "chimera-wf-loop-")), "counter.txt");
    const unsub = e.events.subscribe((ev) => {
      if (ev.kind === "task_step_advanced" && (ev.data as { stepId: string }).stepId === "work") {
        round++;
        writeFileSync(counterFile, round >= 3 ? "done" : "continue");
        e.artifacts.add({ kind: "file", path: counterFile, label: "counter", agentId: null, taskId: task.taskId });
      }
    });

    await waitUntil(() => e.queues.status("work").counts.done === 1, 20_000);
    unsub();

    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("converged");
    expect(final.loopIterations).toEqual({ work: 2 });
    expect(final.stepHistory.filter((h) => h.stepId === "work")).toHaveLength(3);
    expect(final.stepHistory.filter((h) => h.stepId === "head")).toHaveLength(3);
  });

  it("a workflows.json persisted before Phase 1 (steps without `instructions`) parses unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-wf-legacy-"));
    const legacySteps = [
      { id: "s0", title: "plan", gate: { kind: "none" } },
      { id: "s1", title: "ship", gate: { kind: "command", spec: { command: "true", args: [] } } },
    ];
    const legacy = {
      workflows: [{ name: "release", onFail: "halt", retryLimit: 0, version: 1, createdAt: 1700000000000, steps: legacySteps }],
    };
    writeFileSync(join(dir, "workflows.json"), JSON.stringify(legacy, null, 2));

    const events = new EventLog(dir);
    const store = new WorkflowStore(dir, events);
    const wf = store.get("release", 1);
    // `instructions` (optional, undefaulted) stays absent; `context` (F16.1 Phase 3, WF-9)
    // IS defaulted — a legacy step with no role can never hit a switch anyway, but the
    // parsed value still materializes as "handoff" (zod's declared default), not absent.
    expect(wf.steps).toEqual(legacySteps.map((s) => ({ ...s, context: "handoff" })));
    expect(wf.steps[0]!.instructions).toBeUndefined();
  });
});
