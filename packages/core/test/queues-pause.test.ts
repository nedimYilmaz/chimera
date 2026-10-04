import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore, UnknownQueueError } from "@chimera/core/queues";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-pause-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

// QUEUE-PAUSE: QueueStore.pause()/resume() — the persistence + event half of the feature.
// scheduler.test.ts (or its sibling) covers the DRAIN-skip half.
describe("QueueStore pause/resume", () => {
  it("pause() flips paused:true, persists it, and emits queue_paused", () => {
    const { q, events } = rig();
    q.create({ name: "work" });
    expect(q.get("work").paused).toBe(false);

    const spec = q.pause("work");
    expect(spec.paused).toBe(true);
    expect(q.get("work").paused).toBe(true);

    const ev = events.tail("queue:work", 10).filter((e) => e.kind === "queue_paused").at(-1)!;
    expect(ev.data).toEqual({ queue: "work" });
  });

  it("resume() flips paused:false and emits queue_resumed", () => {
    const { q, events } = rig();
    q.create({ name: "work" });
    q.pause("work");

    const spec = q.resume("work");
    expect(spec.paused).toBe(false);
    expect(q.get("work").paused).toBe(false);

    const ev = events.tail("queue:work", 10).filter((e) => e.kind === "queue_resumed").at(-1)!;
    expect(ev.data).toEqual({ queue: "work" });
  });

  it("pause()/resume() throw UnknownQueueError for a missing queue", () => {
    const { q } = rig();
    expect(() => q.pause("ghost")).toThrow(UnknownQueueError);
    expect(() => q.resume("ghost")).toThrow(UnknownQueueError);
  });

  it("re-pausing an already-paused queue is a no-op on the flag but still emits (idempotent-safe, mirrors update())", () => {
    const { q, events } = rig();
    q.create({ name: "work" });
    q.pause("work");
    const spec = q.pause("work");
    expect(spec.paused).toBe(true);
    expect(events.tail("queue:work", 10).filter((e) => e.kind === "queue_paused")).toHaveLength(2);
  });

  it("pause survives a daemon restart: a fresh QueueStore over the same dir reloads paused:true", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work" });
    q.pause("work");

    const q2 = new QueueStore(dir, events);   // simulated daemon restart
    expect(q2.get("work").paused).toBe(true);
  });

  it("an unpaused queue also round-trips paused:false across a restart", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work" });

    const q2 = new QueueStore(dir, events);
    expect(q2.get("work").paused).toBe(false);
  });

  it("pausing does not affect push/nextPending at the QueueStore level (the scheduler enforces the drain skip, not QueueStore)", () => {
    const { q } = rig();
    q.create({ name: "work" });
    q.pause("work");
    const t = q.push("work", { prompt: "still pending" });
    expect(t.state).toBe("pending");
    expect(q.nextPending("work")!.taskId).toBe(t.taskId);   // QueueStore itself stays paused-agnostic
  });
});
