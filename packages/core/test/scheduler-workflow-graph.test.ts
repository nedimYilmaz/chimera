import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { RoleStore } from "@chimera/core/roles-store";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler, type GateExecFn } from "@chimera/core/scheduler";
import { COORD_CFG, makeCoordination, waitUntil } from "./coord-helpers.js";
import { fakeExec } from "./helpers.js";

// WorkflowGraph (FEATURE-1): routing (`next`) + fan-out/map-reduce (`fanOut`+`joinStep`).
// Mirrors the FakeAgentBackend/coord-helpers conventions already established in
// scheduler-workflow-dead-agent.test.ts / engine-workflows.test.ts.

const ONE_SHOT = (resultText: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: {} } },
  { end: { resultText } },
];
const FAIL_ONE_SHOT: FakeStep[] = [{ fail: { message: "boom" } }];

describe("QueueScheduler — WorkflowGraph", () => {
  it("linear-still-works: a plain 2-step, 1-role workflow (no next/fanOut anywhere) runs to done exactly as today", async () => {
    const rig = makeCoordination([
      [
        { emit: { kind: "agent_started", data: {} } },
        { turn: {} },
        { awaitSend: true },
        { end: { resultText: "shipped" } },
      ],
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "none" } },
        { id: "s1", title: "build", gate: { kind: "none" } },
      ],
    });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.queues.getTask(task.taskId).state).toBe("done");
    expect(rig.fake.spawns).toHaveLength(1);   // same role both steps — one agent, no respawn
  });

  it("route-taken: an artifact-conditioned next edge is followed when the artifact is registered", async () => {
    const rig = makeCoordination([ONE_SHOT("planned"), ONE_SHOT("via-artifact")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        {
          id: "s0", title: "plan", gate: { kind: "none" },
          next: [{ to: "artifact-path", when: { kind: "artifact", spec: {} } }, { to: "fallback-path" }],
        },
        { id: "artifact-path", title: "artifact path", gate: { kind: "none" }, next: [] },
        { id: "fallback-path", title: "fallback path", gate: { kind: "none" }, next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "route me", workflow: "wf" });
    rig.artifacts.add({ kind: "link", url: "https://example.com/x", label: "evidence", agentId: null, taskId: task.taskId });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    // stepHistory records every step attempt this task made, in order.
    const history = rig.queues.getTask(task.taskId).stepHistory.map((h) => h.stepId);
    expect(history).toContain("artifact-path");
    expect(history).not.toContain("fallback-path");
  });

  it("route-skipped: with no artifact registered, the unconditional fallback edge is taken instead", async () => {
    const rig = makeCoordination([ONE_SHOT("planned"), ONE_SHOT("via-fallback")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        {
          id: "s0", title: "plan", gate: { kind: "none" },
          next: [{ to: "artifact-path", when: { kind: "artifact", spec: {} } }, { to: "fallback-path" }],
        },
        { id: "artifact-path", title: "artifact path", gate: { kind: "none" }, next: [] },
        { id: "fallback-path", title: "fallback path", gate: { kind: "none" }, next: [] },
      ],
    });

    const task = rig.queues.push("work", { prompt: "route me", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    const history = rig.queues.getTask(task.taskId).stepHistory.map((h) => h.stepId);
    expect(history).toContain("fallback-path");
    expect(history).not.toContain("artifact-path");
  });

  it("unrouted-fails: a next edge whose only condition never matches fails the task instead of hanging", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "none" }, next: [{ to: "s1", when: { kind: "artifact", spec: {} } }] },
        { id: "s1", title: "unreachable", gate: { kind: "none" } },
      ],
    });

    const task = rig.queues.push("work", { prompt: "route me", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1, 5000);

    const t = rig.queues.getTask(task.taskId);
    expect(t.state).toBe("failed");
    expect(t.error).toContain("no \"next\" condition matched");
  });

  it("map-reduce-join-gates-on-all-branches: the join step only runs once every branch is done", async () => {
    const rig = makeCoordination([
      ONE_SHOT("planned"),
      ONE_SHOT("branch a done"),
      ONE_SHOT("branch b done"),
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "branch c done" } }],
      ONE_SHOT("joined"),
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["a", "b", "c"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    let branchTaskIds: string[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();

    // wait for the fan-out to have happened and produced exactly 3 branch tasks
    await waitUntil(() => branchTaskIds.length === 3, 5000);
    expect(rig.queues.getTask(parent.taskId).state).toBe("blocked");
    expect(rig.queues.getTask(parent.taskId).branchChildren).toEqual(branchTaskIds);

    // branches a+b finish; c is deliberately held open via awaitSend — parent must STAY blocked
    await waitUntil(() => rig.queues.status("work").counts.done === 2, 5000);
    expect(rig.queues.getTask(parent.taskId).state).toBe("blocked");

    // release branch c
    const branchCAgentId = rig.queues.getTask(branchTaskIds[2]!).agentId!;
    await rig.sup.send(branchCAgentId, "go", "test");

    // parent unblocks, join step's agent spawns and finishes
    await waitUntil(() => rig.queues.status("work").counts.done === 1 + 3, 5000);
    const finalParent = rig.queues.getTask(parent.taskId);
    expect(finalParent.state).toBe("done");

    // the join agent's spawn (5th and last) carried the merge summary in its instructions
    const joinSpawn = rig.fake.spawns[4]!;
    expect(joinSpawn.instructions).toContain("fan-out results: 3 branch(es)");
    expect(joinSpawn.instructions).toContain("branch a done");
    expect(joinSpawn.instructions).toContain("branch c done");
  });

  it("post-join-retry-no-stale-fanout: a post-join step's re-dispatch after a failed attempt carries no leftover fan-out summary", async () => {
    const rig = makeCoordination([
      ONE_SHOT("planned"),
      ONE_SHOT("branch done"),
      ONE_SHOT("joined"),
      FAIL_ONE_SHOT,
      ONE_SHOT("after done"),
    ]);
    rig.queues.create({ name: "work" });   // default retryLimit:2 — one failed attempt still retries
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["only"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
        { id: "after", title: "after", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();

    // join finishes, "after" step's first attempt fails and reverts the task to pending,
    // then the retry re-spawns and finishes it.
    await waitUntil(() => rig.fake.spawns.length === 5, 5000);
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 5000);

    // spawns: plan(0), branch(1), join(2), after-attempt-1(3, fails), after-attempt-2(4)
    expect(rig.fake.spawns).toHaveLength(5);
    expect(rig.fake.spawns[2]!.instructions).toContain("fan-out results: 1 branch(es)");
    expect(rig.fake.spawns[4]!.instructions).not.toContain("fan-out results");
  });

  it("branch-failure-cascades: one branch failing fails the parent immediately, without waiting for the others", async () => {
    const rig = makeCoordination([
      ONE_SHOT("planned"),
      FAIL_ONE_SHOT,
      [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "never reached" } }],
    ]);
    // retryLimit:0 — a single branch attempt failure must cascade-fail the parent
    // immediately, not consume a retry (queue.ts's DEFAULT retryLimit is 2).
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["fails", "waits"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();

    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "failed", 5000);
    expect(rig.queues.getTask(parent.taskId).error).toContain("dependency");
    // only 2 agents ever spawned (plan + the failing branch) — the join step never ran,
    // and the still-open "waits" branch was never awaited by the (already-failed) parent.
    expect(rig.fake.spawns.length).toBeLessThanOrEqual(3);
  });

  it("fan-out-role-fallback: a fan-out step with no role of its own inherits the role of the agent whose gate just passed", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        executor: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        planner: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
      },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" }, role: "planner" },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["only"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    let branchTaskIds: string[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => branchTaskIds.length === 1, 5000);

    expect(rig.queues.getTask(branchTaskIds[0]!).role).toBe("planner");
  });

  it("reattach-settle-intact: a one-shot backend whose step passes before the routing decision resolves still lands on the correct next step", async () => {
    const sequence: boolean[] = [true, true];
    let call = 0;
    const delayedGate: GateExecFn = () => new Promise((resolve) => {
      const ok = sequence[Math.min(call, sequence.length - 1)]!;
      call++;
      setTimeout(() => resolve({ ok, message: ok ? "" : "not yet" }), 5);
    });
    const rig = makeCoordination(
      [ONE_SHOT("alpha done"), ONE_SHOT("beta done")],
      undefined,
      { gateExec: delayedGate },
    );
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        alpha: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
        beta: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } },
      },
      maxConcurrent: 3, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "alpha", next: [{ to: "s1" }] },
        { id: "s1", title: "build", gate: { kind: "command", spec: { command: "gate", args: [] } }, role: "beta" },
      ],
    });

    const advanced: number[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_step_advanced") advanced.push((ev.data as { stepIndex: number }).stepIndex); });

    const task = rig.queues.push("work", { prompt: "ship it", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);

    expect(rig.queues.getTask(task.taskId).state).toBe("done");
    expect(advanced).toEqual([0, 1]);
  });

  // Bounded fan-out (map-reduce over dynamic inputs): artifactList source, chunkSize/
  // maxParallel windowed admission, and mergeSummaryText's paged reduce.

  it("fan-out-artifact-list-resolves-at-runtime: items are read from a registered artifact, not the spec", async () => {
    const rig = makeCoordination([ONE_SHOT("planned"), ONE_SHOT("branch a"), ONE_SHOT("branch b"), ONE_SHOT("branch c"), ONE_SHOT("joined")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "artifactList", spec: {} }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    const artifactPath = join(rig.dir, `${parent.taskId}-items.json`);
    writeFileSync(artifactPath, JSON.stringify(["a", "b", "c"]));
    rig.artifacts.add({ kind: "file", path: artifactPath, label: "fan-out items", agentId: null, taskId: parent.taskId });

    let branchTaskIds: string[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    await rig.scheduler.tick();
    await waitUntil(() => branchTaskIds.length === 3, 5000);
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 5000);

    const prompts = branchTaskIds.map((id) => rig.queues.getTask(id).prompt);
    expect(prompts.some((p) => p.includes("Item: a"))).toBe(true);
    expect(prompts.some((p) => p.includes("Item: b"))).toBe(true);
    expect(prompts.some((p) => p.includes("Item: c"))).toBe(true);
  });

  it("fan-out-artifact-list-missing-fails-task: no artifact registered fails the task, no branches pushed", async () => {
    const rig = makeCoordination([ONE_SHOT("planned")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "artifactList", spec: {} }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "failed", 5000);

    expect(rig.queues.getTask(parent.taskId).error).toContain("fan-out list artifact");
    expect(rig.fake.spawns).toHaveLength(1);   // only the plan step's agent ever spawned — no branches
  });

  it("fan-out-windowed-admission-never-exceeds-maxParallel: a bounded fan-out admits in waves", async () => {
    const heldOpen = (): FakeStep[] => [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "done" } }];
    const rig = makeCoordination([
      ONE_SHOT("planned"),
      heldOpen(), heldOpen(),   // wave 1: items a,b
      heldOpen(), heldOpen(),   // wave 2: items c,d
      heldOpen(),                // wave 3: item e
      ONE_SHOT("joined"),
    ]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        {
          id: "spread", title: "spread", gate: { kind: "none" },
          fanOut: { source: { kind: "list", items: ["a", "b", "c", "d", "e"] }, joinStep: "join", maxParallel: 2 },
        },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();

    const inFlight = () => rig.queues.getTask(parent.taskId).dependsOn.filter((id) => {
      const s = rig.queues.getTask(id).state;
      return s === "pending" || s === "in_progress";
    }).length;

    // wave 1: exactly 2 branches admitted (plan's spawn + 2 branch spawns = 3 total)
    await waitUntil(() => rig.fake.spawns.length === 3, 5000);
    expect(rig.queues.getTask(parent.taskId).state).toBe("blocked");
    expect(rig.queues.getTask(parent.taskId).fanOutRemaining).toHaveLength(3);   // c, d, e still waiting
    expect(inFlight()).toBeLessThanOrEqual(2);

    // release wave 1's two branches
    for (const id of rig.queues.getTask(parent.taskId).branchChildren.slice(0, 2)) {
      await rig.sup.send(rig.queues.getTask(id).agentId!, "go", "test");
    }

    // wave 2 admits — exactly 2 more branches (5 spawns total: plan + 2 + 2)
    await waitUntil(() => rig.fake.spawns.length === 5, 5000);
    expect(inFlight()).toBeLessThanOrEqual(2);
    expect(rig.queues.getTask(parent.taskId).fanOutRemaining).toHaveLength(1);   // e still waiting

    // release wave 2's two branches
    for (const id of rig.queues.getTask(parent.taskId).branchChildren.slice(2, 4)) {
      await rig.sup.send(rig.queues.getTask(id).agentId!, "go", "test");
    }

    // wave 3 (final, single item) admits
    await waitUntil(() => rig.fake.spawns.length === 6, 5000);
    expect(rig.queues.getTask(parent.taskId).fanOutRemaining).toHaveLength(0);

    const wave3Id = rig.queues.getTask(parent.taskId).branchChildren[4]!;
    await rig.sup.send(rig.queues.getTask(wave3Id).agentId!, "go", "test");

    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 5000);
    expect(rig.queues.getTask(parent.taskId).branchChildren).toHaveLength(5);
  });

  it("fan-out-chunked-branches: chunkSize groups multiple items into one branch task", async () => {
    const rig = makeCoordination([ONE_SHOT("planned"), ONE_SHOT("chunk1"), ONE_SHOT("chunk2"), ONE_SHOT("chunk3"), ONE_SHOT("joined")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: 10, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        {
          id: "spread", title: "spread", gate: { kind: "none" },
          fanOut: { source: { kind: "list", items: ["a", "b", "c", "d", "e", "f", "g"] }, joinStep: "join", chunkSize: 3 },
        },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    let branchTaskIds: string[] = [];
    rig.events.subscribe((ev) => { if (ev.kind === "task_fan_out") branchTaskIds = ev.data["branchTaskIds"] as string[]; });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => branchTaskIds.length === 3, 5000);   // chunks of 3, 3, 1 -> 3 branch tasks
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 5000);

    const prompts = branchTaskIds.map((id) => rig.queues.getTask(id).prompt);
    expect(prompts.some((p) => p.includes("- a") && p.includes("- b") && p.includes("- c"))).toBe(true);
    expect(prompts.some((p) => p.includes("- d") && p.includes("- e") && p.includes("- f"))).toBe(true);
    expect(prompts.some((p) => p.includes("Item: g"))).toBe(true);   // trailing singleton chunk keeps the singular shape
  });

  it("fan-out-restart-durability: un-admitted waves survive a simulated daemon restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-fanout-restart-"));
    const events = new EventLog(dir);
    const workflows = new WorkflowStore(dir, events);
    workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        {
          id: "spread", title: "spread", gate: { kind: "none" },
          fanOut: { source: { kind: "list", items: ["a", "b", "c", "d"] }, joinStep: "join", maxParallel: 2 },
        },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const queues1 = new QueueStore(dir, events);
    queues1.create({ name: "work" });
    const parent = queues1.push("work", { prompt: "map reduce", workflow: "wf" });

    const teams1 = new TeamManager(dir, events);
    const roles1 = new RoleStore(dir);
    teams1.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } }, maxConcurrent: 10, queue: "work" });
    const artifacts1 = new ArtifactStore(dir, events);
    const heldOpen = (): FakeStep[] => [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }];
    // plan + wave 1's two branches (a,b), both deliberately held open (never complete) so
    // wave 2 (c,d) is never admitted before the "restart" below — fanOutRemaining must still
    // hold [c],[d] at that point.
    const fake1 = new FakeAgentBackend([ONE_SHOT("planned"), heldOpen(), heldOpen()]);
    const sup1 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake1]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler1 = new QueueScheduler({ teams: teams1, queues: queues1, supervisor: sup1, events, workflows, artifacts: artifacts1, roles: roles1 });
    scheduler1.attach();
    await scheduler1.tick();
    await waitUntil(() => queues1.getTask(parent.taskId).branchChildren.length === 2, 5000);

    const before = queues1.getTask(parent.taskId);
    expect(before.state).toBe("blocked");
    expect(before.fanOutRemaining).toEqual([["c"], ["d"]]);

    // simulate a daemon restart: reopen every store over the SAME home dir. The two held-open
    // (in_progress) wave-1 branches revert to "pending" (existing restart-recovery contract);
    // fanOutRemaining, being a durable TaskRecord field, survives verbatim.
    const queues2 = new QueueStore(dir, events);
    const recovered = queues2.getTask(parent.taskId);
    expect(recovered.state).toBe("blocked");
    expect(recovered.fanOutRemaining).toEqual([["c"], ["d"]]);

    const teams2 = new TeamManager(dir, events);
    const roles2 = new RoleStore(dir);
    const artifacts2 = new ArtifactStore(dir, events);
    // resumed a, resumed b, then wave 2's c, d, then the join — a fresh agent identity throughout.
    const fake2 = new FakeAgentBackend([ONE_SHOT("a done"), ONE_SHOT("b done"), ONE_SHOT("c done"), ONE_SHOT("d done"), ONE_SHOT("joined")]);
    const sup2 = new AgentSupervisor({
      registry: new AccountRegistry(COORD_CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake2]]), events, mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100, questionTimeoutMs: 100,
    });
    const scheduler2 = new QueueScheduler({ teams: teams2, queues: queues2, supervisor: sup2, events, workflows, artifacts: artifacts2, roles: roles2 });
    scheduler2.attach();
    await scheduler2.tick();
    await waitUntil(() => queues2.getTask(parent.taskId).state === "done", 5000);

    // every item got a branch task — the restart did NOT silently drop wave 2's tail.
    expect(queues2.getTask(parent.taskId).branchChildren).toHaveLength(4);
    expect(queues2.getTask(parent.taskId).fanOutRemaining).toEqual([]);
    expect(fake2.spawns.length).toBe(5);   // a, b (resumed) + c, d (wave 2) + join
  });

  it("mergeSummaryText-paged-not-truncated: a large fan-out's join summary pages the done bucket instead of hard-truncating", async () => {
    const N = 52;
    const items = Array.from({ length: N }, (_, i) => `item-${i}`);
    const scenarios: FakeStep[][] = [ONE_SHOT("planned"), ...items.map((_, i) => ONE_SHOT(`branch ${i} done`)), ONE_SHOT("joined")];
    const rig = makeCoordination(scenarios);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" as const } } },
      maxConcurrent: N + 5, queue: "work",
    });
    rig.workflows.create({
      name: "wf",
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "spread", title: "spread", gate: { kind: "none" }, fanOut: { source: { kind: "list", items }, joinStep: "join" } },
        { id: "join", title: "join", gate: { kind: "none" } },
      ],
    });

    const parent = rig.queues.push("work", { prompt: "map reduce", workflow: "wf" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.getTask(parent.taskId).state === "done", 10000);

    const joinSpawn = rig.fake.spawns[rig.fake.spawns.length - 1]!;
    expect(joinSpawn.instructions).toContain(`fan-out results: ${N} branch(es)`);
    expect(joinSpawn.instructions).toContain(`${N} done, 0 failed/other`);
    expect(joinSpawn.instructions).toContain(`...and ${N - 50} more`);
    // bounded regardless of N — no unbounded growth from a naive per-branch concatenation.
    expect(joinSpawn.instructions!.length).toBeLessThan(40_000);
  }, 15000);
});
