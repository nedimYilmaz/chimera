import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { WorkflowSpec, WorkflowRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const STEPS: WorkflowSpec["steps"] = [{ id: "s0", title: "plan", gate: { kind: "none" } }];

// FEATURE-11: exercises all 4 workflow.* methods through Engine.handle()'s RpcContract
// dispatch (see engine.ts's isContractMethod check) now that their handler bodies live in
// packages/core/src/rpc/workflow-rpc.ts's WorkflowRpc, not engine.ts's switch. core/test/
// engine-workflows.test.ts already covers this family in far more depth (the step machine
// driving a real workflow task through every gate kind) and is left completely unmodified —
// it staying green is the strongest evidence the extraction changed nothing observable. This
// file's job is narrower: prove the reroute itself works for every migrated method in one
// place, including the unknown-workflow-reference guard on queue.* that depends on
// this.workflows staying wired the same way through WorkflowRpc.
describe("Engine workflow.* RpcContract dispatch (FEATURE-11)", () => {
  it("create -> list -> update -> delete lifecycle, versioned", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });

    const created = await e.handle("workflow.create", { spec: { name: "release", steps: STEPS } }) as WorkflowRecord;
    expect(created).toMatchObject({ name: "release", version: 1 });

    const listed = await e.handle("workflow.list", {}) as WorkflowRecord[];
    expect(listed.map((w) => w.name)).toEqual(["release"]);

    const updated = await e.handle("workflow.update", { name: "release", patch: { retryLimit: 3 } }) as WorkflowRecord;
    expect(updated).toMatchObject({ version: 2, retryLimit: 3 });

    expect(await e.handle("workflow.delete", { name: "release" })).toEqual({ deleted: true });
    expect(await e.handle("workflow.delete", { name: "release" })).toEqual({ deleted: false });   // idempotent
    expect(await e.handle("workflow.list", {})).toEqual([]);
  });

  it("workflow.create rejects a name collision with a typed error", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("workflow.create", { spec: { name: "release", steps: STEPS } });
    await expect(e.handle("workflow.create", { spec: { name: "release", steps: STEPS } }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("queue.create/update/push still reject an unknown workflow reference before persisting (this.workflows wiring unaffected by the WorkflowRpc extraction)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("queue.create", { spec: { name: "work", workflow: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    await e.handle("queue.create", { spec: { name: "work" } });
    await expect(e.handle("queue.update", { name: "work", patch: { workflow: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("queue.push", { queue: "work", prompt: "x", workflow: "ghost" }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
