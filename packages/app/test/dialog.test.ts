import { describe, expect, it } from "vitest";
import { dialogAnswerValue, dialogQuestions, isAskQuestionDialog, type DialogQuestion } from "../src/state/dialog";

// Native-CLI-parity Phase 2 (Task DLG3) — DialogCard's pure parse/answer-shape
// helpers, carried over from the retired TUI's dialogQuestions coverage.

describe("dialogQuestions", () => {
  it("parses a well-formed AskUserQuestion payload (1-4 questions, options, multiSelect)", () => {
    const payload = {
      questions: [
        { question: "which env?", header: "deploy target", options: [{ label: "staging", description: "safe" }, { label: "prod" }] },
        { question: "notify who?", options: [{ label: "oncall" }, { label: "team" }], multiSelect: true },
      ],
    };
    expect(dialogQuestions(payload)).toEqual([
      { question: "which env?", header: "deploy target", options: [{ label: "staging", description: "safe" }, { label: "prod" }] },
      { question: "notify who?", options: [{ label: "oncall" }, { label: "team" }], multiSelect: true },
    ]);
  });
  it("drops non-array payloads and malformed entries instead of throwing (daemon field drift)", () => {
    expect(dialogQuestions({})).toEqual([]);
    expect(dialogQuestions({ questions: "not an array" })).toEqual([]);
    expect(dialogQuestions({ questions: [{ question: "ok" }, { noQuestion: true }, "garbage", null] })).toEqual([
      { question: "ok", options: [] },
    ]);
  });
  it("filters malformed option entries but keeps well-formed ones", () => {
    const payload = { questions: [{ question: "q", options: [{ label: "a" }, "bad", { label: "b", description: 5 }] }] };
    expect(dialogQuestions(payload)).toEqual([{ question: "q", options: [{ label: "a" }, { label: "b" }] }]);
  });
});

describe("isAskQuestionDialog", () => {
  it("true only for permission_ask_user_question, false for elicitation/anything else", () => {
    expect(isAskQuestionDialog("permission_ask_user_question")).toBe(true);
    expect(isAskQuestionDialog("elicitation_dialog")).toBe(false);
    expect(isAskQuestionDialog("elicitation_url_dialog")).toBe(false);
  });
});

describe("dialogAnswerValue", () => {
  const single: DialogQuestion = { question: "env?", options: [{ label: "staging" }, { label: "prod" }] };
  const multi: DialogQuestion = { question: "notify?", options: [{ label: "oncall" }, { label: "team" }], multiSelect: true };

  it("single-select: the option at selectedIndex", () => {
    expect(dialogAnswerValue(single, 1, new Set(), "")).toBe("prod");
  });
  it("multi-select: the labels of every selectedIds entry (index-as-id)", () => {
    expect(dialogAnswerValue(multi, 0, new Set(["0", "1"]), "")).toEqual(["oncall", "team"]);
  });
  it("multi-select with nothing toggled → undefined (caller omits it from answers)", () => {
    expect(dialogAnswerValue(multi, 0, new Set(), "")).toBeUndefined();
  });
  it("a typed custom answer (the implicit 'Other') wins over any selection", () => {
    expect(dialogAnswerValue(single, 1, new Set(), "  custom text  ")).toBe("custom text");
    expect(dialogAnswerValue(multi, 0, new Set(["0"]), "custom")).toBe("custom");
  });
  it("blank/whitespace-only custom text is NOT treated as an answer", () => {
    expect(dialogAnswerValue(single, 0, new Set(), "   ")).toBe("staging");
  });
});
