import { describe, expect, it } from "vitest";
import { MCP_TOOL_TABLE } from "../src/mcp-tools.js";

// TASK-EDIT-VERSIONING: queue_edit_task forwards a sparse patch to the
// queue.editTask RPC and stamps the editor's principal (editedBy) from the
// caller's own identity (ctx.agentId) -- exactly mirroring queue_push's
// pushedBy. These pin the resolver seam directly (the engine-side forwarding is
// proven separately); ctx.agentId presence/absence is the whole contract.
const editTask = () => MCP_TOOL_TABLE.find((t) => t.name === "queue_edit_task")!;

describe("queue_edit_task resolver (TASK-EDIT-VERSIONING)", () => {
  it("maps to the queue.editTask RPC, forwarding taskId + patch verbatim", () => {
    const result = editTask().resolve(
      { taskId: "t7", patch: { prompt: "fix the brief" } },
      { depth: 0 },
    );
    expect(result).toEqual({
      kind: "rpc",
      method: "queue.editTask",
      params: { taskId: "t7", patch: { prompt: "fix the brief" } },
    });
  });

  it("stamps editedBy from ctx.agentId when present", () => {
    const result = editTask().resolve(
      { taskId: "t7", patch: { priority: 5 } },
      { agentId: "conductor", depth: 0 },
    ) as { kind: "rpc"; method: string; params: Record<string, unknown> };
    expect(result.method).toBe("queue.editTask");
    expect(result.params).toEqual({ taskId: "t7", patch: { priority: 5 }, editedBy: "conductor" });
  });

  it("omits editedBy entirely when ctx carries no agentId (byte-identical to an un-stamped call)", () => {
    const result = editTask().resolve(
      { taskId: "t7", patch: { role: null } },
      { depth: 0 },
    ) as { kind: "rpc"; params: Record<string, unknown> };
    expect("editedBy" in result.params).toBe(false);
  });

  it("carries a multi-field sparse patch through untouched alongside the stamp", () => {
    const patch = { prompt: "redo", role: "qa", priority: 2, workflow: "review", overrides: { model: "opus" } };
    const result = editTask().resolve(
      { taskId: "t9", patch },
      { agentId: "a1", depth: 0 },
    ) as { kind: "rpc"; params: { patch: Record<string, unknown>; editedBy: string } };
    expect(result.params.patch).toEqual(patch);
    expect(result.params.editedBy).toBe("a1");
  });
});
