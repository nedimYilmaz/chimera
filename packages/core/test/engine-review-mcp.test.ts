import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// F25.1 — WAKE-REVIEW-AUTHOR: review.decide({status:"changes_requested"}) must wake the task's
// agent (mailbox message + supervisor.wakeMailbox) so an idle agent finds out about a review it
// has no other way to poll for. Coalesced: one undelivered wake per task is enough.

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const role = { cwd: "/tmp/dev", account: "main", isolation: "none" as const };

// A plain task manually bound to an agentId that never spawned a live supervisor record —
// supervisor.wakeMailbox's deliverPending no-ops when `this.agents.get(agentId)` is undefined,
// so the wake message stays undelivered in the mailbox, exactly like an idle/dormant agent that
// has no live handle to drain into. This is what makes the mailbox observable via
// e.mailboxes.pending(agentId) after review.decide, matching acceptance criterion #6.
async function boundToDanglingAgent() {
  const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
  await e.handle("queue.create", { spec: { name: "work" } });
  const task = (await e.handle("queue.push", { queue: "work", prompt: "go" })) as TaskRecord;
  const agentId = "dangling-agent";
  e.queues.markInProgress(task.taskId, agentId);
  return { e, agentId, taskId: task.taskId };
}

describe("Engine review.decide — wakeReviewAuthor (F25.1)", () => {
  it("wakes the task's agent exactly once on changes_requested, with a bounded findings summary", async () => {
    const { e, agentId, taskId } = await boundToDanglingAgent();
    for (let i = 0; i < 3; i++) {
      await e.handle("review.finding.add", { taskId, path: `f${i}.ts`, severity: "note", body: `finding ${i}` });
    }
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "please address these" });

    const pending = e.mailboxes.pending(agentId);
    const wakes = pending.filter((m) => m.meta?.["reviewWake"] === true);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.meta).toMatchObject({ taskId, revision: 4 });
    expect(wakes[0]!.text).toContain("please address these");
    expect(wakes[0]!.text).toContain("3 open finding(s)");
  });

  it("does not add a second wake while the first is still undelivered", async () => {
    const { e, agentId, taskId } = await boundToDanglingAgent();
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "first" });
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "second" });

    const wakes = e.mailboxes.pending(agentId).filter((m) => m.meta?.["reviewWake"] === true);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain("first");
  });

  it("does not wake on an accepted decision", async () => {
    const { e, agentId, taskId } = await boundToDanglingAgent();
    await e.handle("review.decide", { taskId, status: "accepted", summary: "lgtm" });

    const wakes = e.mailboxes.pending(agentId).filter((m) => m.meta?.["reviewWake"] === true);
    expect(wakes).toHaveLength(0);
  });

  it("does not throw when the taskId is not a queue task", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(
      e.handle("review.decide", { taskId: "not-a-real-task", status: "changes_requested", summary: "x" }),
    ).resolves.toMatchObject({ decision: { status: "changes_requested" } });
  });

  it("bounds the wake message at 20 findings with a '+N more' line", async () => {
    const { e, agentId, taskId } = await boundToDanglingAgent();
    for (let i = 0; i < 25; i++) {
      await e.handle("review.finding.add", { taskId, path: `f${i}.ts`, severity: "note", body: `finding ${i}` });
    }
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "many findings" });

    const wakes = e.mailboxes.pending(agentId).filter((m) => m.meta?.["reviewWake"] === true);
    expect(wakes).toHaveLength(1);
    const bulletLines = wakes[0]!.text.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines).toHaveLength(20);
    expect(wakes[0]!.text).toContain("(+5 more — call review_get)");
  });
});

// Parks a fresh agent bound to a plain (non-workflow) task, mid-turn — enough for
// scheduler.taskFor(agentId) to resolve, mirroring engine-agent-remediate.test.ts's recipe.
async function boundAgent() {
  const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
  const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
  await e.handle("queue.create", { spec: { name: "work" } });
  await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role } }, maxConcurrent: 2, queue: "work" } });
  const task = (await e.handle("queue.push", { queue: "work", prompt: "go" })) as TaskRecord;
  await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
  const agentId = e.scheduler.agentsFor("crew")[0]!;
  return { e, agentId, taskId: task.taskId };
}

describe("Engine review.get / review.finding.resolve — agent-relative binding + resolve authority (F25.0)", () => {
  it("review.get with no taskId resolves the caller's current task binding", async () => {
    const { e, agentId, taskId } = await boundAgent();
    await e.handle("review.finding.add", { taskId, path: "a.ts", severity: "note", body: "hi" });
    const session = (await e.handle("review.get", { agentId })) as { taskId: string };
    expect(session.taskId).toBe(taskId);
  });

  it("review.get with neither taskId nor a bound agent rejects with a protocol error", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("review.get", {})).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("review.get", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("review.get with an explicit taskId is unchanged for the app's call shape", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = (await e.handle("queue.push", { queue: "work", prompt: "hello" })) as TaskRecord;
    const session = (await e.handle("review.get", { taskId: task.taskId })) as { taskId: string };
    expect(session.taskId).toBe(task.taskId);
  });

  it("review.finding.resolve forwards actorAgentId to the store", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = (await e.handle("queue.push", { queue: "work", prompt: "hello" })) as TaskRecord;
    const finding = (await e.handle("review.finding.add", {
      taskId: task.taskId, path: "a.ts", severity: "blocking", body: "fix", authorAgentId: "a1",
    })) as { id: string };

    await expect(
      e.handle("review.finding.resolve", { taskId: task.taskId, findingId: finding.id, actorAgentId: "a2" }),
    ).rejects.toMatchObject({ code: "protocol" });

    const resolved = (await e.handle("review.finding.resolve", {
      taskId: task.taskId, findingId: finding.id, actorAgentId: "a1",
    })) as { status: string };
    expect(resolved.status).toBe("resolved");
  });
});

// F25.QA — the wake has to actually REACH a live agent, and must not rot silently when the
// author has already settled. Both halves were unverified by the landed tests: every wake case
// above uses a dangling agentId with no supervisor record at all, which is neither.
async function teamAgentOnTask(steps: FakeStep[]) {
  const fake = new FakeAgentBackend([steps]);
  const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
  await e.handle("queue.create", { spec: { name: "work" } });
  await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role } }, maxConcurrent: 1, queue: "work" } });
  const task = (await e.handle("queue.push", { queue: "work", prompt: "go" })) as TaskRecord;
  return { e, taskId: task.taskId };
}

const undeliveredFor = (e: Engine, agentId: string) =>
  e.events.replay({ fromSeq: 1, limit: 10_000 })
    .filter((ev) => ev.agentId === agentId && ev.kind === "status" && ev.data["undeliveredMessage"] === true);

describe("Engine review.decide — wake delivery (F25.QA)", () => {
  it("delivers the wake to a live running agent", async () => {
    const { e, taskId } = await teamAgentOnTask([{ awaitSend: true }, { end: { resultText: "done" } }]);
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    const agentId = e.queues.getTask(taskId).agentId!;
    await e.handle("review.finding.add", { taskId, path: "a.ts", severity: "blocking", body: "fix this" });
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "please fix" });

    await waitUntil(() => e.events.replay({ fromSeq: 1, limit: 10_000 }).some(
      (ev) => ev.agentId === agentId && ev.kind === "status" && ev.data["delivered"] === true
        && String(ev.data["text"] ?? "").includes("[review] Your task"),
    ));
    expect(e.mailboxes.pending(agentId).filter((m) => m.meta?.["reviewWake"] === true)).toHaveLength(0);
  });

  it("does not strand the wake in a settled agent's mailbox — it reports it undelivered", async () => {
    const { e, taskId } = await teamAgentOnTask([{ end: { resultText: "done" } }]);
    await waitUntil(() => e.queues.status("work").counts.done === 1);
    const agentId = e.queues.getTask(taskId).agentId!;
    await waitUntil(() => e.supervisor.status(agentId).state === "done");

    await e.handle("review.finding.add", { taskId, path: "a.ts", severity: "blocking", body: "fix this" });
    await e.handle("review.decide", { taskId, status: "changes_requested", summary: "please fix" });

    // Nothing may be left rotting in the mailbox: wakeMailbox is a no-op for a settled record,
    // so an enqueued wake would sit there forever AND suppress every later wake via the
    // coalescing check.
    expect(e.mailboxes.pending(agentId).filter((m) => m.meta?.["reviewWake"] === true)).toHaveLength(0);
    const undelivered = undeliveredFor(e, agentId);
    expect(undelivered).toHaveLength(1);
    expect(String(undelivered[0]!.data["reason"])).toContain("settled");
  });
});
