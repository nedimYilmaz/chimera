import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCause } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";

// Regression coverage (HOOK-4, queues.ts): TaskPush.cause is the engine-internal provenance
// stamp HookEngine's `push` action carries onto the task it creates — it's what the causation
// chain-depth guard reads back via getTaskCause. An ordinary human/agent push leaves it null.
// This locks the stamp-through and the sparse default so a refactor can't silently drop the
// field the loop-safety guards depend on.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qcause-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore.push cause stamping (HOOK-4)", () => {
  it("stamps the provided HookCause onto the created TaskRecord.cause", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const cause: HookCause = { rule: "retry-on-fail", eventSeq: 12, chain: 2 };
    const t = q.push("work", { prompt: "child", cause });
    expect(t.cause).toEqual(cause);
    expect(q.getTask(t.taskId).cause).toEqual(cause);   // survives the read-back the guard uses
  });

  it("defaults cause to null for an ordinary (human/agent) push", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "seed" });
    expect(t.cause).toBeNull();
    expect(q.getTask(t.taskId).cause).toBeNull();
  });

  it("persists cause across a QueueStore reload from disk", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const cause: HookCause = { rule: "spawn-reviewer", eventSeq: 0, chain: 1 };
    const t = q.push("work", { prompt: "child", cause });

    const reloaded = new QueueStore(dir, events);
    expect(reloaded.getTask(t.taskId).cause).toEqual(cause);
  });
});
