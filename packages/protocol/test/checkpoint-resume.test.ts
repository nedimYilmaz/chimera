import { describe, it, expect } from "vitest";
import { EventKindSchema, TaskRecordSchema, TaskStepCheckpointSchema } from "@chimera/protocol";

// FEATURE-2 (durable checkpoint-resume): distinct from D16's checkpoint.create/checkpoint.status
// (agent-requested git-ref snapshots, packages/core/src/checkpoints.ts) — this is the
// workflow-step durable-resume checkpoint threaded through scheduler.ts/queues.ts/reattach.ts.

const VALID_CHECKPOINT = {
  stepIndex: 1,
  idempotencyKey: "task-1:step-1",
  workdirKey: "task-task-1",
  branch: "chimera/task-tas",
  commitSha: "abc123def456",
  gateAttempts: 0,
  capturedAt: 1000,
};

describe("TaskStepCheckpointSchema", () => {
  it("parses a full valid checkpoint", () => {
    // VALID_CHECKPOINT omits the newer mainRepo field, which the schema fills with its null default.
    expect(TaskStepCheckpointSchema.parse(VALID_CHECKPOINT)).toEqual({ ...VALID_CHECKPOINT, mainRepo: null });
  });

  it("rejects an unknown key (strict)", () => {
    expect(() => TaskStepCheckpointSchema.parse({ ...VALID_CHECKPOINT, extra: "nope" })).toThrow();
  });

  it("workdirKey/branch/commitSha independently accept null (isolation:none shape)", () => {
    const parsed = TaskStepCheckpointSchema.parse({ ...VALID_CHECKPOINT, workdirKey: null, branch: null, commitSha: null });
    expect(parsed.workdirKey).toBeNull();
    expect(parsed.branch).toBeNull();
    expect(parsed.commitSha).toBeNull();
  });

  it("rejects an empty idempotencyKey", () => {
    expect(() => TaskStepCheckpointSchema.parse({ ...VALID_CHECKPOINT, idempotencyKey: "" })).toThrow();
  });

  it("mainRepo round-trips an explicit path (worktree task's land target)", () => {
    const parsed = TaskStepCheckpointSchema.parse({ ...VALID_CHECKPOINT, mainRepo: "/repos/proj" });
    expect(parsed.mainRepo).toBe("/repos/proj");
  });

  // REVIEW-ROOM-UNBOUND-TASKS backward-compat: mainRepo is a NEW field. Every checkpoint persisted
  // before it existed has no mainRepo key at all — the schema's `.default(null)` must sparse-parse
  // those legacy rows to mainRepo:null rather than rejecting them (VALID_CHECKPOINT itself omits it).
  it("defaults mainRepo to null for a legacy checkpoint with no mainRepo key (sparse-parse compat)", () => {
    expect(VALID_CHECKPOINT).not.toHaveProperty("mainRepo");   // guards the fixture stays legacy-shaped
    const parsed = TaskStepCheckpointSchema.parse(VALID_CHECKPOINT);
    expect(parsed.mainRepo).toBeNull();
  });
});

describe("TaskRecordSchema.checkpoint", () => {
  it("defaults to null when absent — sparse pre-existing record parses unchanged", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "work", prompt: "do", createdAt: 123 });
    expect(t.checkpoint).toBeNull();
  });

  it("round-trips an explicit checkpoint value", () => {
    const t = TaskRecordSchema.parse({ taskId: "t1", queue: "work", prompt: "do", createdAt: 123, checkpoint: VALID_CHECKPOINT });
    expect(t.checkpoint).toEqual({ ...VALID_CHECKPOINT, mainRepo: null });   // nested schema applies the same mainRepo default
  });
});

describe("EventKindSchema", () => {
  it("accepts \"workflow_step_checkpoint\"", () => {
    expect(EventKindSchema.parse("workflow_step_checkpoint")).toBe("workflow_step_checkpoint");
  });
});
