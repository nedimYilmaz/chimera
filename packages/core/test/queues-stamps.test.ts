import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRecordSchema } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";

// TASK-STAMPS: startedAt/endedAt — the timing half of pushedBy/pushedAt (see
// queues-pushedby.test.ts). startedAt is stamped by markInProgress (first pickup
// only); endedAt by markDone/markFailed. Both optional/additive.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-stamps-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore startedAt/endedAt (TASK-STAMPS)", () => {
  it("a PRE-EXISTING persisted task (no startedAt/endedAt keys) still parses", () => {
    const legacy = TaskRecordSchema.parse({
      taskId: "t-old", queue: "work", prompt: "old", createdAt: 123,
    });
    expect(legacy.startedAt).toBeUndefined();
    expect(legacy.endedAt).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "chimera-q-stamps-legacy-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "queues.json"), JSON.stringify({
      queues: [{ name: "work", retryLimit: 1 }],
      tasks: [{ taskId: "t-old", queue: "work", prompt: "old", createdAt: 123 }],
    }));
    const q = new QueueStore(dir, new EventLog(dir));
    const t = q.status("work").tasks[0]!;
    expect(t.startedAt).toBeUndefined();
    expect(t.endedAt).toBeUndefined();
  });

  it("markInProgress stamps startedAt once and never clobbers it on a later re-pickup", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 2 });
    const pushed = q.push("work", { prompt: "job" });
    expect(pushed.startedAt).toBeUndefined();

    const first = q.markInProgress(pushed.taskId, "agent-1");
    expect(typeof first.startedAt).toBe("number");
    const stamped = first.startedAt;

    const second = q.markInProgress(pushed.taskId, "agent-2");
    expect(second.startedAt).toBe(stamped); // retry re-entry must not overwrite
  });

  it("markDone stamps endedAt", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "job" });
    q.markInProgress(t.taskId, "agent-1");
    const done = q.markDone(t.taskId, "result");
    expect(typeof done.endedAt).toBe("number");
  });

  it("markFailed stamps endedAt", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "job" });
    q.markInProgress(t.taskId, "agent-1");
    const failed = q.markFailed(t.taskId, "boom");
    expect(typeof failed.endedAt).toBe("number");
  });

  it("computes queue latency (pushedAt -> startedAt) on a real task record", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const pushed = q.push("work", { prompt: "job" });
    const started = q.markInProgress(pushed.taskId, "agent-1");
    expect(started.pushedAt).toBeDefined();
    expect(started.startedAt).toBeDefined();
    const latency = started.startedAt! - started.pushedAt!;
    expect(latency).toBeGreaterThanOrEqual(0);
  });
});
