import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { TaskEvidence, TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("Engine evidence.get RPC (FEATURE-10, RpcContract dispatch)", () => {
  it("rejects an unknown taskId with a protocol error, same as every other taskId RPC", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("evidence.get", { taskId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a malformed request (missing taskId) via the RpcContract's request schema", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("evidence.get", {})).rejects.toMatchObject({ code: "protocol" });
  });

  it("round-trips through the real RPC dispatch for a plain (non-workflow, not-yet-picked-up) task", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = (await e.handle("queue.push", { queue: "work", prompt: "hello" })) as TaskRecord;

    const evidence = (await e.handle("evidence.get", { taskId: task.taskId })) as TaskEvidence;
    expect(evidence).toMatchObject({ taskId: task.taskId, queue: "work", state: "pending", workflow: null, steps: [], artifacts: [], provenance: [] });
  });

  // REVIEW-ROOM-UNBOUND-TASKS: the accept/request-changes flow must persist against a PLAIN
  // (workflow: null) task's evidence exactly as it does for a workflow task — the review store is
  // keyed purely on taskId and assumes no workflow fields, so a plain task round-trips identically.
  it("persists a review decision + finding against a plain (non-workflow) task's evidence", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    const task = (await e.handle("queue.push", { queue: "work", prompt: "hello" })) as TaskRecord;

    await e.handle("review.finding.add", { taskId: task.taskId, path: "a.ts", severity: "blocking", body: "needs a test" });
    await e.handle("review.decide", { taskId: task.taskId, status: "changes_requested", summary: "address open findings" });

    const session = (await e.handle("review.get", { taskId: task.taskId })) as { findings: unknown[]; decision: { status: string } | null };
    expect(session.findings).toHaveLength(1);
    expect(session.decision?.status).toBe("changes_requested");
  });
});
