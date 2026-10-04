import { describe, it, expect } from "vitest";
import { EventKindSchema, DialogDecisionSchema, AnswerDialogParams, NormalizedEventSchema } from "@chimera/protocol";

describe("agent_dialog event kind (native-CLI-parity Phase 2, Task DLG1)", () => {
  it("accepts 'agent_dialog' as a valid EventKind", () => {
    expect(EventKindSchema.parse("agent_dialog")).toBe("agent_dialog");
  });

  it("still accepts an agent_dialog NormalizedEvent through the locked shape", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "agent_dialog",
      data: { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: { questions: [] } },
    });
    expect(ev.kind).toBe("agent_dialog");
    expect(ev.engineId).toBe("local"); // federation default still applies
  });

  it("rejects an EventKind string not in the enum", () => {
    expect.assertions(1);
    expect(() => EventKindSchema.parse("not_agent_dialog")).toThrow();
  });
});

describe("DialogDecisionSchema", () => {
  it("parses a completed decision with an arbitrary result payload", () => {
    expect(DialogDecisionSchema.parse({ behavior: "completed", result: { answers: { q: "a" } } }))
      .toEqual({ behavior: "completed", result: { answers: { q: "a" } } });
  });

  it("parses a completed decision whose result is a primitive (z.unknown accepts anything)", () => {
    expect(DialogDecisionSchema.parse({ behavior: "completed", result: "ok" }))
      .toEqual({ behavior: "completed", result: "ok" });
    expect(DialogDecisionSchema.parse({ behavior: "completed", result: null }))
      .toEqual({ behavior: "completed", result: null });
  });

  it("parses a cancelled decision", () => {
    expect(DialogDecisionSchema.parse({ behavior: "cancelled" })).toEqual({ behavior: "cancelled" });
  });

  it("rejects a completed decision missing 'result'", () => {
    expect.assertions(1);
    expect(() => DialogDecisionSchema.parse({ behavior: "completed" })).toThrow();
  });

  it("rejects a cancelled decision carrying an extra 'result' key (strict)", () => {
    expect.assertions(1);
    expect(() => DialogDecisionSchema.parse({ behavior: "cancelled", result: "x" })).toThrow();
  });

  it("rejects an unknown behavior value", () => {
    expect.assertions(1);
    expect(() => DialogDecisionSchema.parse({ behavior: "bogus" })).toThrow();
  });

  it("rejects a missing behavior discriminant", () => {
    expect.assertions(1);
    expect(() => DialogDecisionSchema.parse({ result: "x" })).toThrow();
  });
});

describe("AnswerDialogParams", () => {
  it("parses a completed decision", () => {
    const parsed = AnswerDialogParams.parse({ dialogId: "d1", decision: { behavior: "completed", result: { answers: {} } } });
    expect(parsed).toEqual({ dialogId: "d1", decision: { behavior: "completed", result: { answers: {} } } });
  });

  it("parses a cancelled decision", () => {
    const parsed = AnswerDialogParams.parse({ dialogId: "d1", decision: { behavior: "cancelled" } });
    expect(parsed).toEqual({ dialogId: "d1", decision: { behavior: "cancelled" } });
  });

  it("rejects a bad decision behavior", () => {
    expect.assertions(1);
    expect(() => AnswerDialogParams.parse({ dialogId: "d1", decision: { behavior: "maybe" } })).toThrow();
  });

  it("rejects an empty dialogId", () => {
    expect.assertions(1);
    expect(() => AnswerDialogParams.parse({ dialogId: "", decision: { behavior: "cancelled" } })).toThrow();
  });

  it("rejects a missing dialogId", () => {
    expect.assertions(1);
    expect(() => AnswerDialogParams.parse({ decision: { behavior: "cancelled" } })).toThrow();
  });

  it("rejects a missing decision", () => {
    expect.assertions(1);
    expect(() => AnswerDialogParams.parse({ dialogId: "d1" })).toThrow();
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect.assertions(1);
    expect(() => AnswerDialogParams.parse({ dialogId: "d1", decision: { behavior: "cancelled" }, bogus: true })).toThrow();
  });
});
