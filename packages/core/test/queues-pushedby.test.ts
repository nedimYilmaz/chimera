import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRecordSchema } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// WD Stage 1 (coverage B9, task inspector "pushed by"): TaskRecord.pushedBy/pushedAt —
// additive provenance stamps on queue.push, threaded engine → QueueStore and stamped
// by the chimera MCP's queue_push from CHIMERA_AGENT_ID (that hop is pinned in
// packages/mcp/test/mcp-pushedby.test.ts; this file covers the store + engine layers).

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-q-pushedby-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore pushedBy/pushedAt (WD Stage 1)", () => {
  it("stamps pushedAt with the SAME instant as createdAt and defaults pushedBy to null", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "job" });
    expect(t.pushedBy).toBeNull();
    expect(t.pushedAt).toBe(t.createdAt);           // "createdAt semantics", literally one Date.now()
  });

  it("carries a caller-supplied pushedBy onto the record and through persistence", () => {
    const { dir, q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "job", pushedBy: "agent-7" });
    expect(t.pushedBy).toBe("agent-7");
    // persisted verbatim in queues.json, and a fresh store re-parses it back
    const raw = JSON.parse(readFileSync(join(dir, "queues.json"), "utf8")) as { tasks: Array<{ pushedBy: string | null; pushedAt: number }> };
    expect(raw.tasks[0]!.pushedBy).toBe("agent-7");
    expect(raw.tasks[0]!.pushedAt).toBe(t.createdAt);
    const reloaded = new QueueStore(dir, new EventLog(mkdtempSync(join(tmpdir(), "chimera-q-ev-"))));
    expect(reloaded.status("work").tasks[0]!.pushedBy).toBe("agent-7");
  });

  it("persists resolved conductor ownership separately from the immediate pusher", () => {
    const { dir, events, q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "job", pushedBy: "child-7", originConductorId: "conductor-1" });
    expect(t).toMatchObject({ pushedBy: "child-7", originConductorId: "conductor-1" });
    const reloaded = new QueueStore(dir, events);
    expect(reloaded.status("work").tasks[0]).toMatchObject({ pushedBy: "child-7", originConductorId: "conductor-1" });
  });

  it("a PRE-EXISTING persisted task (no pushedBy/pushedAt keys) still parses: pushedBy null, pushedAt absent", () => {
    // the additive-schema contract: old queues.json files written before Stage 1 must
    // load byte-identically — pushedBy defaults to null, pushedAt stays undefined
    // (readers fall back to createdAt).
    const legacy = TaskRecordSchema.parse({
      taskId: "t-old", queue: "work", prompt: "old", createdAt: 123,
    });
    expect(legacy.pushedBy).toBeNull();
    expect(legacy.pushedAt).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "chimera-q-legacy-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "queues.json"), JSON.stringify({
      queues: [{ name: "work", retryLimit: 1 }],
      tasks: [{ taskId: "t-old", queue: "work", prompt: "old", createdAt: 123 }],
    }));
    const q = new QueueStore(dir, new EventLog(dir));
    const t = q.status("work").tasks[0]!;
    expect(t.pushedBy).toBeNull();
    expect(t.pushedAt).toBeUndefined();
  });
});

describe("Engine queue.push pushedBy threading (WD Stage 1)", () => {
  const engine = () => new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });

  it("threads params.pushedBy onto the TaskRecord", async () => {
    const e = engine();
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 0 } });
    const t = (await e.handle("queue.push", { queue: "work", prompt: "job", pushedBy: "agent-9" })) as { pushedBy: string | null; pushedAt: number; createdAt: number };
    expect(t.pushedBy).toBe("agent-9");
    expect(t.pushedAt).toBe(t.createdAt);
  });

  it("omitted pushedBy → null (a direct/human push carries no agent identity)", async () => {
    const e = engine();
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 0 } });
    const t = (await e.handle("queue.push", { queue: "work", prompt: "job" })) as { pushedBy: string | null };
    expect(t.pushedBy).toBeNull();
  });

  it("rejects an empty-string pushedBy at the param schema (min(1) — an empty id is a caller bug)", async () => {
    const e = engine();
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 0 } });
    await expect(e.handle("queue.push", { queue: "work", prompt: "job", pushedBy: "" }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
