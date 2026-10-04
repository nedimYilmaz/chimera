import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { EventLog } from "@chimera/core/events";
import { ArtifactStore } from "@chimera/core/artifacts";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord, ArtifactRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };

const LONG_RUNNING_SCENARIO: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { end: { resultText: "done" } },
];

describe("Engine artifact.* RPC family (D13)", () => {
  it("artifact.add/list/get lifecycle for a link artifact", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const added = await e.handle("artifact.add", { kind: "link", url: "https://example.com/report", label: "external report" }) as ArtifactRecord;
    expect(added).toMatchObject({ kind: "link", url: "https://example.com/report", label: "external report", agentId: null, taskId: null, sizeBytes: null });

    const got = await e.handle("artifact.get", { id: added.id });
    expect(got).toEqual(added);

    const listed = await e.handle("artifact.list", {}) as ArtifactRecord[];
    expect(listed.map((r) => r.id)).toEqual([added.id]);
  });

  it("artifact.get on an unknown id rejects (protocol error)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("artifact.get", { id: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("registers a file artifact, snapshotting it, and auto-resolves taskId from the calling agent's binding", async () => {
    const fake = new FakeAgentBackend([LONG_RUNNING_SCENARIO]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: TEAM_SPEC });
    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.getTask(task.taskId).agentId !== null, 5000);
    const agentId = e.queues.getTask(task.taskId).agentId!;

    const srcDir = mkdtempSync(join(tmpdir(), "chimera-art-src-"));
    const src = join(srcDir, "report.md");
    writeFileSync(src, "# report\n");

    const rec = await e.handle("artifact.add", { kind: "report", path: src, label: "review", agentId }) as ArtifactRecord;
    expect(rec.agentId).toBe(agentId);
    expect(rec.taskId).toBe(task.taskId);   // TASK/AGENT SCOPED (F17): auto-resolved from the caller's binding
    expect(rec.sizeBytes).toBe(9);
  });

  it("an oversize registration is refused with an agent-visible error — the RPC rejects, nothing persists", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const srcDir = mkdtempSync(join(tmpdir(), "chimera-art-huge-"));
    const src = join(srcDir, "huge.bin");
    writeFileSync(src, Buffer.alloc(10 * 1024 * 1024 + 1, "x"));

    await expect(e.handle("artifact.add", { kind: "file", path: src, label: "huge" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("10485761") });
    expect(await e.handle("artifact.list", {})).toEqual([]);
  });

  it("task-scoped lists are exact: artifact.list({taskId}) returns only that task's artifacts", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    e.artifacts.add({ kind: "link", url: "https://x/1", label: "a", agentId: null, taskId: "task-1" });
    e.artifacts.add({ kind: "link", url: "https://x/2", label: "b", agentId: null, taskId: "task-2" });
    e.artifacts.add({ kind: "link", url: "https://x/3", label: "c", agentId: null, taskId: "task-1" });

    const listed = await e.handle("artifact.list", { taskId: "task-1" }) as ArtifactRecord[];
    expect(listed.map((r) => r.label).sort()).toEqual(["a", "c"]);
  });

  it("emits artifact_added within the same event tick as the RPC response", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const events: string[] = [];
    e.events.subscribe((ev) => { if (ev.kind === "artifact_added") events.push(ev.data["label"] as string); });
    await e.handle("artifact.add", { kind: "link", url: "https://x", label: "tick-test" });
    expect(events).toEqual(["tick-test"]);
  });
});

describe("D12 workflow `artifact` gate wired against the real registry (D13)", () => {
  it("passes once a matching artifact is registered for the task (unpinned spec — any artifact)", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { end: { resultText: "done" } },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", { spec: { name: "gated", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: {} } }] } });
    await e.handle("queue.update", { name: "work", patch: { workflow: "gated" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    // Registered synchronously right after push returns — the fake backend's scenario
    // steps only run on a setTimeout(0) macrotask, so this always lands BEFORE the
    // agent's first turn_complete, no race with the gate check.
    e.artifacts.add({ kind: "link", url: "https://x/proof", label: "proof", agentId: null, taskId: task.taskId });

    await waitUntil(() => e.queues.status("work").counts.done === 1, 5000);
    expect(e.queues.getTask(task.taskId).state).toBe("done");
  });

  it("passes when the PINNED artifactId is registered against this exact task", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { end: { resultText: "done" } },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    // Push BEFORE any team exists, so nothing drains it yet — this gives a window to
    // register an artifact correctly scoped to the real taskId, THEN pin the workflow
    // gate to that exact id, THEN let team.create's tick() perform the (now correctly
    // set up) pickup.
    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    const artifact = e.artifacts.add({ kind: "link", url: "https://x/pinned", label: "pinned", agentId: null, taskId: task.taskId });
    await e.handle("workflow.create", {
      spec: { name: "gated", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: { artifactId: artifact.id } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "gated" } });
    await e.handle("team.create", { spec: TEAM_SPEC });   // drains the pending task -> pins "gated" at pickup

    await waitUntil(() => e.queues.status("work").counts.done === 1, 5000);
    expect(e.queues.getTask(task.taskId).state).toBe("done");
  });

  it("a pinned artifactId gate fails when that artifact belongs to a DIFFERENT task", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const wrongScoped = e.artifacts.add({ kind: "link", url: "https://x/pinned", label: "pinned", agentId: null, taskId: "some-other-task" });
    await e.handle("workflow.create", {
      spec: { name: "gated", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: { artifactId: wrongScoped.id } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "gated" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 5000);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain(`artifact "${wrongScoped.id}" not registered for this task`);
  });

  it("fails (halts) when no artifact is ever registered for the task", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", { spec: { name: "gated3", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: {} } }] } });
    await e.handle("queue.update", { name: "work", patch: { workflow: "gated3" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.failed === 1, 5000);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain("no artifact registered");
  });

  it("F16.1/G5: scope:'step' REJECTS an artifact registered during an EARLIER step", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },          // step0 (gate none) passes -> advances to step1 -> sends step1's text
      { awaitSend: true },   // consumes step1's delivered text
      { turn: {} },          // step1's OWN turn -> its gate now evaluates -> FAILS (wrong-step artifact only)
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: {
        name: "scoped",
        steps: [
          { id: "s0", title: "plan", gate: { kind: "none" } },
          { id: "s1", title: "ship", gate: { kind: "artifact", spec: { scope: "step" } } },
        ],
      },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "scoped" } });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    // registered up front, explicitly tagged to step 0 — EARLIER than step 1's gate check.
    e.artifacts.add({ kind: "link", url: "https://x/early", label: "early", agentId: null, taskId: task.taskId, stepIndex: 0 });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await waitUntil(() => e.queues.status("work").counts.failed === 1, 5000);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain("no artifact registered for this task in this step");
  });

  it("F16.1/G5: scope:'step' ACCEPTS an artifact registered during the CURRENT step", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { end: { resultText: "done" } },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: { name: "scoped2", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: { scope: "step" } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "scoped2" } });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    // registered up front, tagged to step 0 — which IS the current (only) step when the gate fires.
    e.artifacts.add({ kind: "link", url: "https://x/current", label: "current", agentId: null, taskId: task.taskId, stepIndex: 0 });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await waitUntil(() => e.queues.status("work").counts.done === 1, 5000);
    expect(e.queues.getTask(task.taskId).state).toBe("done");
  });

  it("F16.1/G5: an optional kind pin rejects a registered artifact of the wrong kind", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: { name: "kinded", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: { kind: "report" } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "kinded" } });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    e.artifacts.add({ kind: "link", url: "https://x/wrong-kind", label: "wrong", agentId: null, taskId: task.taskId });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await waitUntil(() => e.queues.status("work").counts.failed === 1, 5000);
    const final = e.queues.getTask(task.taskId);
    expect(final.state).toBe("failed");
    expect(final.error).toContain('of kind "report"');
  });

  it("F16.1/G5: an optional kind pin accepts a registered artifact of the matching kind", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: {} },
      { end: { resultText: "done" } },
    ]]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: { name: "kinded2", steps: [{ id: "s0", title: "ship", gate: { kind: "artifact", spec: { kind: "report" } } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "kinded2" } });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    const srcDir = mkdtempSync(join(tmpdir(), "chimera-art-kind-"));
    const src = join(srcDir, "report.md");
    writeFileSync(src, "# report\n");
    e.artifacts.add({ kind: "report", path: src, label: "right-kind", agentId: null, taskId: task.taskId });
    await e.handle("team.create", { spec: TEAM_SPEC });

    await waitUntil(() => e.queues.status("work").counts.done === 1, 5000);
    expect(e.queues.getTask(task.taskId).state).toBe("done");
  });

  it("F16.1/G5: artifact.add stamps stepIndex server-side from the caller's LIVE bound-task cursor", async () => {
    const fake = new FakeAgentBackend([LONG_RUNNING_SCENARIO]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("workflow.create", {
      spec: { name: "stampwf", steps: [{ id: "s0", title: "hold", gate: { kind: "none" } }] },
    });
    await e.handle("queue.update", { name: "work", patch: { workflow: "stampwf" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const task = await e.handle("queue.push", { queue: "work", prompt: "x" }) as TaskRecord;
    await waitUntil(() => e.queues.getTask(task.taskId).agentId !== null, 5000);
    const agentId = e.queues.getTask(task.taskId).agentId!;

    const rec = await e.handle("artifact.add", { kind: "link", url: "https://x/stamped", label: "stamped", agentId }) as ArtifactRecord;
    expect(rec.taskId).toBe(task.taskId);
    expect(rec.stepIndex).toBe(0);   // the live cursor at call time — never client-supplied (no such param exists)
  });

  it("survives a daemon restart: a registered artifact and its snapshot are still resolvable against a reopened registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-art-restart-"));
    const events = new EventLog(dir);
    const store1 = new ArtifactStore(dir, events);
    const src = join(dir, "src.md");
    writeFileSync(src, "hello");
    const rec = store1.add({ kind: "report", path: src, label: "r", agentId: "a", taskId: "t" });

    const store2 = new ArtifactStore(dir, events);   // simulates a daemon restart over the same home
    expect(store2.get(rec.id)).toEqual(rec);
    expect(store2.existsForTask("t")).toBe(true);
  });
});
