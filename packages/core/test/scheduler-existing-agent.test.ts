import { describe, expect, it, vi } from "vitest";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { QueueStore } from "@chimera/core/queues";
import { QueueScheduler } from "@chimera/core/scheduler";
import { MailboxStore } from "@chimera/core/mailbox";
import { TaskExplainResultSchema } from "@chimera/protocol";

async function setup() {
  const rig = makeCoordination([[{ awaitSend: true }, { awaitSend: true }, { awaitSend: true }, { awaitClose: { resultText: "finished" } }]]);
  const agent = await rig.sup.spawn({ prompt: "persistent review", cwd: rig.dir, isolation: "none", persistent: true, orchestration: { allow: true } });
  rig.queues.create({ name: "requests", existingAgentId: agent.agentId });
  return { ...rig, agent };
}

describe("queue bound to an existing conversation", () => {
  it("serializes two tasks without a team or new agents; unrelated turns do not complete work", async () => {
    const r = await setup();
    try {
      const first = r.queues.push("requests", { prompt: "first PR" });
      const second = r.queues.push("requests", { prompt: "second PR", dependsOn: [first.taskId] });
      await r.scheduler.tick();
      expect(first.agentId).toBe(r.agent.agentId);
      expect(first.state).toBe("in_progress");
      expect(second.state).toBe("blocked");
      r.events.append({ agentId: r.agent.agentId, kind: "turn_complete", data: {} });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(first.state).toBe("in_progress");
      expect(r.fake.deliveries[0]?.text).toContain(`queue_complete_task with taskId "${first.taskId}"`);
      expect(() => r.queues.completeExistingTask(first.taskId, "other-agent", "done", true)).toThrow(/assigned agent/);
      r.queues.completeExistingTask(first.taskId, r.agent.agentId, "review evidence", true);
      await r.scheduler.tick();
      expect(second.agentId).toBe(r.agent.agentId);
      expect(first.resultText).toBe("review evidence");
      r.queues.completeExistingTask(second.taskId, r.agent.agentId, "could not fetch PR", false);
      expect(second.state).toBe("failed");
      expect(second.error).toBe("could not fetch PR");
      expect(second.agentId).toBe(r.agent.agentId);
      expect(r.queues.completeExistingTask(second.taskId, r.agent.agentId, "could not fetch PR", false).state).toBe("failed");
      expect(() => r.queues.completeExistingTask(second.taskId, "other-agent", "could not fetch PR", false)).toThrow(/assigned agent/);
      expect(r.fake.spawns).toHaveLength(1);
    } finally { r.scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("uses one assignment across queues and never lets a legacy team spawn for the pinned queue", async () => {
    const r = await setup();
    try {
      r.teams.create({ name: "legacy", queue: "requests", maxConcurrent: 1, roles: { worker: { role: "blank" } } });
      r.queues.create({ name: "other", existingAgentId: r.agent.agentId });
      const first = r.queues.push("requests", { prompt: "one" });
      const second = r.queues.push("other", { prompt: "two" });
      await Promise.all([r.scheduler.tick(), r.scheduler.tick()]);
      expect(first.state).toBe("in_progress");
      expect(second.state).toBe("pending");
      expect(r.scheduler.explainTask(second.taskId).blockedBy).toBe("existingAgentFree");
      expect(r.fake.spawns).toHaveLength(1);
    } finally { r.scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("holds paused queues and unavailable targets without spawning or claiming success", async () => {
    const r = await setup();
    try {
      r.queues.pause("requests");
      const task = r.queues.push("requests", { prompt: "review" });
      await r.scheduler.tick();
      expect(task.state).toBe("pending");
      expect(r.scheduler.explainTask(task.taskId).blockedBy).toBe("queueNotPaused");
      r.queues.resume("requests");
      await r.sup.kill(r.agent.agentId);
      await r.scheduler.tick();
      expect(task.state).toBe("pending");
      const explanation = r.scheduler.explainTask(task.taskId);
      expect(explanation.blockedBy).toBe("existingAgentAvailable");
      expect(TaskExplainResultSchema.safeParse(explanation).success).toBe(true);
      expect(r.fake.spawns).toHaveLength(1);
    } finally { r.scheduler.detach(); }
  });

  it("preserves assignment across restart and does not redeliver an accepted mailbox ID", async () => {
    const r = await setup();
    let scheduler: QueueScheduler | undefined;
    try {
      const task = r.queues.push("requests", { prompt: "one" });
      await r.scheduler.tick();
      const count = r.fake.deliveries.length;
      r.scheduler.detach();
      const queues = new QueueStore(r.dir, r.events);
      expect(queues.getTask(task.taskId).state).toBe("in_progress");
      scheduler = new QueueScheduler({ queues, supervisor: r.sup, teams: r.teams, roles: r.roles, workflows: r.workflows, events: r.events, artifacts: r.artifacts });
      await scheduler.tick();
      expect(r.fake.deliveries).toHaveLength(count);
      queues.completeExistingTask(task.taskId, r.agent.agentId, "verified", true);
      expect(queues.completeExistingTask(task.taskId, r.agent.agentId, "verified", true).state).toBe("done");
      const reloaded = new QueueStore(r.dir, r.events);
      expect(reloaded.getTask(task.taskId).state).toBe("done");
    } finally { r.scheduler.detach(); scheduler?.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("rejects settings changes, workflow combinations, retargeting active work and premature completion", async () => {
    const r = await setup();
    try {
      for (const extra of [{ role: "worker" }, { overrides: { permissionProfile: "full" } }, { workflow: "flow" }])
        expect(() => r.queues.push("requests", { prompt: "x", ...extra })).toThrow(/not supported/);
      expect(() => r.queues.update("requests", { workflow: "flow" })).toThrow(/workflows/);
      const task = r.queues.push("requests", { prompt: "x" });
      expect(() => r.queues.editTask(task.taskId, { role: "worker" }, null)).toThrow(/not supported/);
      expect(() => r.queues.completeExistingTask(task.taskId, undefined, "x", true)).toThrow(/not in progress/);
      await r.scheduler.tick();
      expect(() => r.queues.update("requests", { existingAgentId: null })).toThrow(/in-progress/);
      // Operator can resolve a stranded assignment without killing the shared agent.
      r.queues.completeExistingTask(task.taskId, undefined, "operator resolved", false);
      expect(r.queues.update("requests", { existingAgentId: null }).existingAgentId).toBeNull();
    } finally { r.scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });
});

it("recovers a claim written before mailbox delivery and resumes the same paused identity", async () => {
  const r = makeCoordination([[{ awaitSend: true }], [{ awaitSend: true }, { awaitClose: { resultText: "done" } }]]);
  const agent = await r.sup.spawn({ prompt: "review", cwd: r.dir, isolation: "none", persistent: true, orchestration: { allow: true } });
  let recovered: QueueScheduler | undefined;
  try {
    r.queues.create({ name: "reviews", existingAgentId: agent.agentId });
    const task = r.queues.push("reviews", { prompt: "queued before shutdown" });
    r.queues.markInProgress(task.taskId, agent.agentId);
    r.scheduler.detach();
    await r.sup.hold(agent.agentId);
    expect(agent.state).toBe("paused");
    const queues = new QueueStore(r.dir, r.events);
    recovered = new QueueScheduler({ queues, supervisor: r.sup, teams: r.teams, roles: r.roles, workflows: r.workflows, events: r.events, artifacts: r.artifacts });
    await recovered.tick();
    expect(agent.state).toBe("running");
    expect(r.fake.spawns.map(s => s.agentId)).toEqual([agent.agentId, agent.agentId]);
    expect(r.fake.deliveries.filter(d => d.text.includes(task.taskId))).toHaveLength(1);
    expect(queues.getTask(task.taskId).state).toBe("in_progress");
  } finally { r.scheduler.detach(); recovered?.detach(); await r.sup.kill(agent.agentId); }
});


function lostAssignment(r: Awaited<ReturnType<typeof setup>>) {
  const task = r.queues.push("requests", { prompt: "review the original PR; record its outcome" });
  r.queues.markInProgress(task.taskId, r.agent.agentId);
  const mailbox = new MailboxStore(r.dir);
  // Simulate a crash after the mailbox watermark moved, before the provider saw the input.
  mailbox.enqueue(r.agent.agentId, { id: `queue:${task.taskId}:assignment`, ts: Date.now() - 360_000,
    from: "queue:requests", kind: "user_message", text: task.prompt });
  mailbox.drain(r.agent.agentId);
  return { task, mailbox };
}

describe("existing-agent delivery recovery", () => {
  it("recovers a consumed lost delivery in the same conversation, retaining the serial claim and cooldown across restart", async () => {
    const r = await setup();
    let restarted: QueueScheduler | undefined;
    try {
      const { task, mailbox } = lostAssignment(r);
      const next = r.queues.push("requests", { prompt: "next PR" });
      await r.scheduler.tick();
      expect(r.fake.deliveries).toHaveLength(1);
      expect(r.fake.deliveries[0]!.text).toContain(`Recovery check for unfinished queue task ${task.taskId}`);
      expect(r.fake.deliveries[0]!.text).toContain("Do not repeat completed external actions");
      expect(r.fake.deliveries[0]!.text).toContain(task.prompt);
      expect(task.state).toBe("in_progress");
      expect(next.state).toBe("pending");
      expect(r.fake.spawns).toHaveLength(1);
      r.scheduler.detach();
      const queues = new QueueStore(r.dir, r.events);
      restarted = new QueueScheduler({ queues, supervisor: r.sup, teams: r.teams, roles: r.roles, workflows: r.workflows, events: r.events, artifacts: r.artifacts });
      await restarted.tick();
      expect(r.fake.deliveries).toHaveLength(1);
      expect(mailbox.history(r.agent.agentId).filter(m => m.id.includes(":recovery:"))).toHaveLength(1);
      queues.completeExistingTask(task.taskId, r.agent.agentId, "verified review journal", true);
      await restarted.tick();
      expect(queues.getTask(next.taskId).state).toBe("in_progress");
      expect(r.fake.deliveries).toHaveLength(2);
    } finally { r.scheduler.detach(); restarted?.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("rechecks without a new watcher event and stops its timer on detach", async () => {
    const r = await setup();
    r.scheduler.detach();
    const scheduler = new QueueScheduler({ queues: r.queues, supervisor: r.sup, teams: r.teams, roles: r.roles,
      workflows: r.workflows, events: r.events, artifacts: r.artifacts, existingRecoveryCheckMs: 10 });
    try {
      const { task } = lostAssignment(r);
      scheduler.attach();
      await waitUntil(() => r.fake.deliveries.length === 1);
      scheduler.detach();
      r.queues.completeExistingTask(task.taskId, r.agent.agentId, "verified", true);
      const second = r.queues.push("requests", { prompt: "must remain pending" });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(second.state).toBe("pending");
      expect(r.fake.deliveries).toHaveLength(1);
    } finally { scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("does not recover while the queue is paused or the agent is operator-held", async () => {
    const r = await setup();
    try {
      lostAssignment(r);
      r.queues.pause("requests");
      await r.scheduler.tick();
      expect(r.fake.deliveries).toHaveLength(0);
      r.queues.resume("requests");
      await r.sup.hold(r.agent.agentId);
      await r.scheduler.tick();
      expect(r.agent.state).toBe("paused");
      expect(r.fake.spawns).toHaveLength(1);
      expect(r.fake.deliveries).toHaveLength(0);
    } finally { r.scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });

  it("wakes an existing pending mailbox message instead of making a duplicate", async () => {
    const r = await setup();
    try {
      const task = r.queues.push("requests", { prompt: "pending original" });
      r.queues.markInProgress(task.taskId, r.agent.agentId);
      const mailbox = new MailboxStore(r.dir);
      mailbox.enqueue(r.agent.agentId, { id: `queue:${task.taskId}:assignment`, from: "queue:requests", kind: "user_message", text: task.prompt });
      await r.scheduler.tick();
      await waitUntil(() => r.fake.deliveries.length === 1);
      expect(r.fake.deliveries[0]!.text).toBe("pending original");
      expect(mailbox.history(r.agent.agentId)).toHaveLength(1);
    } finally { r.scheduler.detach(); await r.sup.kill(r.agent.agentId); }
  });
});


it("does not interrupt an active turn; reconciles the still-open claim after the turn ends", async () => {
  const r = makeCoordination([[{ awaitSend: true }, { emit: { kind: "message_delta", data: { text: "working" } } }, { awaitSend: true },
    { turn: { text: "unrelated work finished" } }, { awaitSend: true }, { awaitClose: { resultText: "finished" } }]]);
  const agent = await r.sup.spawn({ prompt: "working", cwd: r.dir, isolation: "none", persistent: true, orchestration: { allow: true } });
  r.queues.create({ name: "requests", existingAgentId: agent.agentId });
  try {
    await r.sup.send(agent.agentId, "start unrelated work", "operator");
    await new Promise(resolve => setTimeout(resolve, 20));
    const { task } = lostAssignment({ ...r, agent });
    await r.scheduler.tick();
    expect(r.fake.deliveries).toHaveLength(1);
    expect(task.state).toBe("in_progress");
    // Ask the fake backend to finish its actual active turn. The new input creates
    // a fresh grace interval, so even that boundary must not immediately remind it.
    await r.sup.send(agent.agentId, "finish", "operator");
    await new Promise(resolve => setTimeout(resolve, 20));
    await r.scheduler.tick();
    expect(r.fake.deliveries.map(d => d.text)).toEqual(["start unrelated work", "finish"]);
  } finally { r.scheduler.detach(); await r.sup.kill(agent.agentId); }
});

it("resumes an infrastructure-paused identity without spawning a replacement and stops recovery after completion", async () => {
  const r = makeCoordination([[{ awaitSend: true }], [{ awaitSend: true }, { awaitClose: { resultText: "finished" } }]]);
  const agent = await r.sup.spawn({ prompt: "review", cwd: r.dir, isolation: "none", persistent: true, orchestration: { allow: true } });
  r.queues.create({ name: "requests", existingAgentId: agent.agentId });
  try {
    const { task } = lostAssignment({ ...r, agent });
    await r.sup.hold(agent.agentId);
    agent.pauseReason = "daemon-restart";
    await r.scheduler.tick();
    expect(r.fake.spawns.map(s => s.agentId)).toEqual([agent.agentId, agent.agentId]);
    expect(r.fake.deliveries).toHaveLength(1);
    expect(r.fake.deliveries[0]!.text).toContain(task.taskId);
    expect(task.state).toBe("in_progress");
    r.queues.completeExistingTask(task.taskId, agent.agentId, "already verified", true);
    await r.scheduler.tick();
    expect(r.fake.deliveries).toHaveLength(1);
  } finally { r.scheduler.detach(); await r.sup.kill(agent.agentId); }
});


it("does not deliver a recovery reminder if the task completes while its session resumes", async () => {
  const r = makeCoordination([[{ awaitSend: true }], [{ awaitSend: true }]]);
  const agent = await r.sup.spawn({ prompt: "review", cwd: r.dir, isolation: "none", persistent: true, orchestration: { allow: true } });
  r.queues.create({ name: "requests", existingAgentId: agent.agentId });
  const { task } = lostAssignment({ ...r, agent });
  const resume = r.sup.resumePaused.bind(r.sup);
  try {
    await r.sup.hold(agent.agentId);
    agent.pauseReason = "daemon-restart";
    vi.spyOn(r.sup, "resumePaused").mockImplementation(async (...args) => {
      await resume(...args);
      r.queues.completeExistingTask(task.taskId, agent.agentId, "verified before recovery send", true);
    });
    await r.scheduler.tick();
    expect(task.state).toBe("done");
    expect(r.fake.deliveries).toHaveLength(0);
  } finally { vi.restoreAllMocks(); r.scheduler.detach(); await r.sup.kill(agent.agentId); }
});
