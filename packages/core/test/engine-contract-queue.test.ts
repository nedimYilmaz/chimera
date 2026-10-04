import { describe, it, expect, vi } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { TaskExplainResultSchema } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

// FEATURE-8: exercises all 8 queue.* methods through Engine.handle()'s NEW RpcContract
// dispatch branch (see engine.ts's isContractMethod check ahead of the legacy switch).
// core/test/engine-coordination.test.ts and token-opt-p1-summary.test.ts already cover this
// same family in more end-to-end depth and are left completely unmodified — them staying
// green is the strongest evidence the contract-dispatch reroute changed nothing observable.
// This file's job is narrower: prove the reroute itself works for every migrated method in
// one place, including the two pre-persist "unknown workflow" guards that had to survive the
// case-body -> ContractHandlers move verbatim, and that handle()'s response now round-trips
// through spec.response.parse() without throwing (i.e. what each handler returns really does
// match what RPC_CONTRACT declares).
describe("Engine queue.* RpcContract dispatch (FEATURE-8)", () => {
  it("create -> push -> status -> statusSummary -> cancelTask -> update -> delete, end to end", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });

    const spec = await e.handle("queue.create", { spec: { name: "work", retryLimit: 1 } });
    expect(spec).toEqual({ name: "work", retryLimit: 1, workflow: null, paused: false });

    expect(await e.handle("queue.list", {})).toEqual([spec]);

    const task = await e.handle("queue.push", { queue: "work", prompt: "build it" }) as { taskId: string; state: string };
    expect(task.state).toBe("pending");
    expect(task.taskId).toBeTruthy();

    const status = await e.handle("queue.status", { queue: "work" }) as { counts: Record<string, number>; tasks: unknown[] };
    expect(status.counts.pending).toBe(1);
    expect(status.tasks).toHaveLength(1);

    const summary = await e.handle("queue.statusSummary", { queue: "work" }) as { counts: Record<string, number>; tasks: unknown[] };
    expect(summary.counts.pending).toBe(1);
    expect(summary.tasks).toEqual([{ id: task.taskId, state: "pending", subject: "build it" }]);

    expect(await e.handle("queue.cancelTask", { taskId: task.taskId })).toEqual({ cancelled: true });
    expect(await e.handle("queue.cancelTask", { taskId: task.taskId })).toEqual({ cancelled: false });   // idempotent, mirrors pre-FEATURE-8 behavior

    const updated = await e.handle("queue.update", { name: "work", patch: { retryLimit: 3 } });
    expect(updated).toEqual({ name: "work", retryLimit: 3, workflow: null, paused: false });

    // QUEUE-PAUSE: pause/resume round-trip through the SAME RpcContract dispatch.
    const paused = await e.handle("queue.pause", { queue: "work" });
    expect(paused).toEqual({ name: "work", retryLimit: 3, workflow: null, paused: true });
    const resumed = await e.handle("queue.resume", { queue: "work" });
    expect(resumed).toEqual({ name: "work", retryLimit: 3, workflow: null, paused: false });

    expect(await e.handle("queue.delete", { name: "work" })).toEqual({ deleted: true });
    expect(await e.handle("queue.delete", { name: "work" })).toEqual({ deleted: false });   // idempotent
  });

  it("queue.create refuses an unknown workflow binding BEFORE persisting the queue (guard carried over verbatim)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("queue.create", { spec: { name: "work", workflow: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(await e.handle("queue.list", {})).toEqual([]);   // nothing persisted
  });

  it("queue.push refuses an unknown per-task workflow override BEFORE persisting the task", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await expect(e.handle("queue.push", { queue: "work", prompt: "x", workflow: "ghost" }))
      .rejects.toMatchObject({ code: "protocol" });
    const status = await e.handle("queue.status", { queue: "work" }) as { tasks: unknown[] };
    expect(status.tasks).toEqual([]);   // nothing persisted
  });

  it("a malformed request still produces the pre-FEATURE-8 {code:'protocol'} shape (ZodError normalization inherited from handle()'s outer try/catch)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("queue.create", { spec: {} })).rejects.toMatchObject({ code: "protocol" });   // missing name
    await expect(e.handle("queue.push", { queue: "work" })).rejects.toMatchObject({ code: "protocol" });   // missing prompt
  });

  it("[F15.2] queue.explainTask round-trips through the contract dispatcher and validates against TaskExplainResultSchema", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "build it" }) as { taskId: string };
    const result = await e.handle("queue.explainTask", { taskId: task.taskId });
    expect(TaskExplainResultSchema.parse(result)).toBeTruthy();
  });

  it("[F15.2] queue.explainTask does not tick — explaining cannot change what drains", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = await e.handle("queue.push", { queue: "work", prompt: "build it" }) as { taskId: string };
    const tickSpy = vi.spyOn(e.scheduler, "tick");
    await e.handle("queue.explainTask", { taskId: task.taskId });
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it("an unmigrated method (e.g. workflow.create) is untouched by isContractMethod and still reaches the legacy switch", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const created = await e.handle("workflow.create", {
      spec: { name: "release", steps: [{ id: "s0", title: "ship", gate: { kind: "none" } }] },
    }) as { version: number };
    expect(created.version).toBe(1);
  });
});
