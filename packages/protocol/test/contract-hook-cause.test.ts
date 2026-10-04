import { describe, it, expect } from "vitest";
import { HookCauseSchema, AgentSpecSchema, TaskRecordSchema } from "@chimera/protocol";

// Coverage gap (HOOK-4): contract.test.ts locks TaskRecord.cause's `null` default (in the
// queue.push/requeue/workflow.run TaskRecord rows) but never HookCauseSchema's own field
// constraints nor AgentSpec.cause's matching default. Both `cause` fields are the causation
// stamp the loop-safety guards read back through records — a widened/dropped constraint here
// would let a malformed chain silently defeat the depth cap. These rows lock the schema.

describe("HookCauseSchema (HOOK-4 causation stamp)", () => {
  it("round-trips a valid cause", () => {
    const cause = { rule: "retry-on-fail", eventSeq: 12, chain: 2 };
    expect(HookCauseSchema.parse(cause)).toEqual(cause);
  });

  it("accepts eventSeq: 0 (nonnegative includes zero — an uncaused-event firing)", () => {
    expect(HookCauseSchema.parse({ rule: "r", eventSeq: 0, chain: 1 })).toMatchObject({ eventSeq: 0 });
  });

  it("rejects a negative eventSeq", () => {
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: -1, chain: 1 })).toThrow();
  });

  it("rejects a non-integer eventSeq", () => {
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: 1.5, chain: 1 })).toThrow();
  });

  it("rejects chain: 0 — depth is 1-based (1 = caused directly by an uncaused event)", () => {
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: 0, chain: 0 })).toThrow();
  });

  it("rejects a negative / non-integer chain", () => {
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: 0, chain: -2 })).toThrow();
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: 0, chain: 2.1 })).toThrow();
  });

  it("rejects an empty rule name", () => {
    expect(() => HookCauseSchema.parse({ rule: "", eventSeq: 0, chain: 1 })).toThrow();
  });

  it("rejects an unknown extra field (.strict())", () => {
    expect(() => HookCauseSchema.parse({ rule: "r", eventSeq: 0, chain: 1, bogus: 1 })).toThrow();
  });
});

describe("AgentSpec.cause default (HOOK-4)", () => {
  it("defaults cause to null for an ordinary spawn (mirrors TaskRecord.cause)", () => {
    const parsed = AgentSpecSchema.parse({ prompt: "do it", cwd: "/tmp" });
    expect(parsed.cause).toBeNull();
  });

  it("round-trips a HookEngine-stamped cause on a spawned spec", () => {
    const cause = { rule: "spawn-reviewer", eventSeq: 5, chain: 1 };
    const parsed = AgentSpecSchema.parse({ prompt: "review", cwd: "/tmp", cause });
    expect(parsed.cause).toEqual(cause);
  });

  it("rejects a malformed cause on a spec (chain: 0) — the record can't carry a stamp the guard can't read", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", cause: { rule: "r", eventSeq: 0, chain: 0 } })).toThrow();
  });

  it("TaskRecord.cause likewise defaults to null on a sparse-parsed row", () => {
    const parsed = TaskRecordSchema.parse({ taskId: "t1", queue: "work", prompt: "p", createdAt: 1 });
    expect(parsed.cause).toBeNull();
  });
});
