import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// TASK-EDIT-VERSIONING: the queue.editTask RPC — sparse in-place edit of a pending/blocked task
// with append-only version history. Drives it through the real Engine dispatcher (envelope parse +
// scheduler tick) rather than the QueueStore directly (that's covered by queues-edit.test.ts).

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" };

describe("queue.editTask (Engine RPC)", () => {
  it("edits a blocked task; once unblocked it spawns with the EDITED prompt", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 1 } });
    await e.handle("team.create", { spec: TEAM });
    const dep = (await e.handle("queue.push", { queue: "work", prompt: "gate" })) as TaskRecord;
    // Push the dependent BEFORE the dep can drain so it lands "blocked"; if the dep already ran,
    // it lands "pending" — either way editing it is allowed, and the assertion below still holds.
    const t = (await e.handle("queue.push", { queue: "work", prompt: "old", dependsOn: [dep.taskId] })) as TaskRecord;

    const edited = (await e.handle("queue.editTask", { taskId: t.taskId, patch: { prompt: "new brief" } })) as TaskRecord;
    expect(edited.prompt).toBe("new brief");
    expect(edited.versions).toHaveLength(1);
    expect(edited.versions[0]!.changedFields).toEqual(["prompt"]);

    await waitUntil(() => {
      const st = e.queues.status("work");
      return st.tasks.find((x) => x.taskId === t.taskId)?.state === "done";
    });
    const done = e.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    // SAFE-1 CACHE-PREFIX: fresh spawns get "Current teammates: ...\n\n" prepended to the
    // first user turn (scheduler.ts withTeamPreamble) — solo crew, so roster reads "none yet".
    expect(done.resultText).toBe("fake:new brief");   // the spawn consumed the edited prompt
  });

  it("stamps editedBy from the caller's agent identity (pushedBy-style seam)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "loose" } });   // unbound → stays pending
    const t = (await e.handle("queue.push", { queue: "loose", prompt: "x" })) as TaskRecord;
    // engine.handle forwards editedBy verbatim (the MCP layer is what stamps it from CHIMERA_AGENT_ID).
    const edited = (await e.handle("queue.editTask", { taskId: t.taskId, patch: { prompt: "y" }, editedBy: "agent-42" })) as TaskRecord;
    expect(edited.versions[0]!.editedBy).toBe("agent-42");
  });

  it("rejects an in_progress task with a protocol error", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 1 } });
    await e.handle("team.create", { spec: TEAM });
    const t = (await e.handle("queue.push", { queue: "work", prompt: "runs" })) as TaskRecord;
    await waitUntil(() => e.queues.status("work").counts.done === 1);   // reached a terminal state
    await expect(e.handle("queue.editTask", { taskId: t.taskId, patch: { prompt: "z" } }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects an empty patch (must set at least one field) and an unknown patch key", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "loose" } });
    const t = (await e.handle("queue.push", { queue: "loose", prompt: "x" })) as TaskRecord;
    await expect(e.handle("queue.editTask", { taskId: t.taskId, patch: {} })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("queue.editTask", { taskId: t.taskId, patch: { bogus: 1 } })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a workflow binding that names an unknown workflow (pre-persist guard)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "loose" } });
    const t = (await e.handle("queue.push", { queue: "loose", prompt: "x" })) as TaskRecord;
    await expect(e.handle("queue.editTask", { taskId: t.taskId, patch: { workflow: "does-not-exist" } }))
      .rejects.toMatchObject({ code: "protocol" });
    // The rejected edit persisted nothing — no version appended.
    expect(e.queues.status("loose").tasks.find((x) => x.taskId === t.taskId)!.versions).toHaveLength(0);
  });
});
