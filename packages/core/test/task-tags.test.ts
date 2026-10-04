import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookRule, TaskRecord } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";
import { HookEngine, type HookEngineDeps } from "@chimera/core/hooks";
import { TOPIC_TABLE, matchesTopicFilter } from "@chimera/core/topics";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// TASK-TAGS: TopicFilterSchema has declared `tags` since HOOK-1 and topics.ts's
// matchesTopicFilter has implemented the doubly-array "any filter tag present in the payload's
// tags" match all along — but the ONLY topic that ever produced a `tags` payload was
// memory.added. A hook or subscription filtering task work by tag therefore matched NOTHING,
// silently, forever. These tests pin the producer half: tags ride a task from push, through its
// persisted record and every state-change event, into the task.state / gate.verdict payloads the
// filter actually reads.

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]);

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-tags-"));
  const events = new EventLog(dir);
  const queues = new QueueStore(dir, events);
  const deps: HookEngineDeps = {
    events,
    send: async () => {},
    resolveTreeAgent: () => null,
    membersOf: () => [],
    pushTask: (queue, input) => queues.push(queue, input),
    getTaskCause: (taskId) => { try { return queues.getTask(taskId).cause; } catch { return null; } },
    getTaskAgentId: (taskId) => { try { return queues.getTask(taskId).agentId; } catch { return null; } },
    getAgentCause: () => null,
    spawnAgent: async () => ({ agentId: "spawned" }),
    channelDeliver: () => {},
    defaultCwd: () => "/tmp",
  };
  return { events, queues, engine: new HookEngine(deps) };
}

function rule(over: Partial<HookRule>): HookRule {
  return {
    name: "r", enabled: true, on: "task.state",
    actions: [{ type: "channel", channel: "toast" }],
    maxChainDepth: 3, maxFiresPerHour: 20,
    ...over,
  } as HookRule;
}

const firedRules = (events: EventLog): string[] =>
  events.tail(null, 500).filter((e) => e.kind === "hook_fired").map((e) => String((e.data as Record<string, unknown>)["rule"]));

describe("task tags — the producer half of the tag filter", () => {
  it("a pushed task carries its tags on the record and they survive a store reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-tags-"));
    const events = new EventLog(dir);
    const queues = new QueueStore(dir, events);
    queues.create({ name: "Q" });
    const task = queues.push("Q", { prompt: "work", tags: ["gate:coverage", "area:core"] });
    expect(task.tags).toEqual(["gate:coverage", "area:core"]);

    const reloaded = new QueueStore(dir, new EventLog(dir));
    expect(reloaded.getTask(task.taskId).tags).toEqual(["gate:coverage", "area:core"]);
  });

  it("a task pushed without tags gets [] — every pre-existing persisted row parses unchanged", () => {
    const { queues } = rig();
    queues.create({ name: "Q" });
    expect(queues.push("Q", { prompt: "work" }).tags).toEqual([]);
  });

  it("task_state_changed carries the tags, so the task.state payload the filter reads has them", () => {
    const { events, queues } = rig();
    queues.create({ name: "Q" });
    const task = queues.push("Q", { prompt: "work", tags: ["gate:coverage"] });

    const changed = events.tail(null, 100).find((e) => e.kind === "task_state_changed")!;
    expect(changed).toBeTruthy();
    const payload = TOPIC_TABLE["task.state"].toPayload(changed, { agents: () => null })!;
    expect(payload["tags"]).toEqual(["gate:coverage"]);
    expect(payload["taskId"]).toBe(task.taskId);

    // the match that silently never happened before
    expect(matchesTopicFilter(payload, { tags: ["gate:coverage"] })).toBe(true);
    expect(matchesTopicFilter(payload, { tags: ["gate:lint"] })).toBe(false);
  });

  it("a hook filtered on tags fires for a matching task and not for a differently-tagged one", async () => {
    const { events, queues, engine } = rig();
    queues.create({ name: "Q" });
    engine.setRules([
      rule({ name: "coverage-gate", filter: { tags: ["gate:coverage"] } }),
      rule({ name: "lint-gate", filter: { tags: ["gate:lint"] } }),
    ]);
    queues.push("Q", { prompt: "work", tags: ["gate:coverage"] });
    await flush();

    expect(firedRules(events)).toContain("coverage-gate");
    expect(firedRules(events)).not.toContain("lint-gate");
  });

  it("gate.verdict payloads carry the task's tags too — the gate:* routing case", () => {
    const { events, queues } = rig();
    queues.create({ name: "Q" });
    const task = queues.push("Q", { prompt: "work", tags: ["gate:coverage"] });
    // The scheduler emits these two around a workflow step; QueueStore owns the stamping so the
    // payload is populated wherever the event is raised from.
    events.append({
      agentId: `task:${task.taskId}`, kind: "task_step_advanced",
      data: { taskId: task.taskId, stepId: "s1", tags: task.tags },
    });
    const advanced = events.tail(null, 50).find((e) => e.kind === "task_step_advanced")!;
    const payload = TOPIC_TABLE["gate.verdict"].toPayload(advanced, { agents: () => null })!;
    expect(payload["tags"]).toEqual(["gate:coverage"]);
    expect(matchesTopicFilter(payload, { tags: ["gate:coverage"] })).toBe(true);
  });
});

describe("task tags — the RPC/edit/visibility surface", () => {
  it("queue.push accepts tags and queue.editTask can replace them", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "do it", tags: ["gate:coverage"] }) as TaskRecord;
    expect(task.tags).toEqual(["gate:coverage"]);

    const edited = await e.handle("queue.editTask", {
      taskId: task.taskId, patch: { tags: ["gate:lint", "area:tui"] },
    }) as TaskRecord;
    expect(edited.tags).toEqual(["gate:lint", "area:tui"]);
    // the edit is recorded like every other task edit, not applied behind the audit trail's back
    expect(edited.versions.length).toBeGreaterThan(0);
  });

  it("task summaries surface tags so a coordination audit doesn't need the full record", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "do it", tags: ["gate:coverage"] });
    const summary = await e.handle("queue.statusSummary", { queue: "work" }) as { tasks: Array<Record<string, unknown>> };
    expect(summary.tasks[0]!["tags"]).toEqual(["gate:coverage"]);
  });

  it("rejects a malformed tag list rather than persisting junk", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("queue.create", { spec: { name: "work" } });
    await expect(e.handle("queue.push", { queue: "work", prompt: "x", tags: [""] })).rejects.toBeTruthy();
    await expect(e.handle("queue.push", { queue: "work", prompt: "x", tags: ["a".repeat(65)] })).rejects.toBeTruthy();
  });
});
