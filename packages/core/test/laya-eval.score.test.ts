import { describe, it, expect } from "vitest";
import type { LayaDecision } from "../src/laya-decision.js";
import { LAYA_EVAL_CASES, validateLayaEvalCases, type LayaEvalCase } from "./laya-eval.cases.js";
import { breakdown, classify, diffRuns, summarize, summarizeLatency, sweepFloors, wilson, type LayaEvalRecord } from "./laya-eval.score.js";

const dec = (choice: string | null, answerConfidence: number | null, over: Partial<LayaDecision> = {}): LayaDecision => ({
  choice, probabilities: choice ? { [choice]: answerConfidence ?? 0 } : {}, answerConfidence, confidence: null,
  abstention: null, abstentionThreshold: null, lowConfidence: false, model: "english", device: "cpu", latencyMs: 10, ...over,
});
const rec = (caseId: string, expected: string | null, decision: LayaDecision | null, over: Partial<LayaEvalRecord> = {}): LayaEvalRecord => ({
  caseId, lang: "en", group: expected === null ? "ambiguous" : "valid-next", expected, actions: ["click", "wait", "close"], decision, wallMs: 5, ...over,
});
const FLOOR = { floor: 0.9 };

describe("the shipped case set", () => {
  it("is structurally sound", () => {
    expect(validateLayaEvalCases(LAYA_EVAL_CASES)).toEqual([]);
  });
  it("covers every required behaviour in both languages", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const group of ["valid-next", "wrong-window", "stale-target", "ambiguous"] as const) {
        expect(LAYA_EVAL_CASES.filter(c => c.lang === lang && c.group === group).length, `${lang}/${group}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it("the validator catches the mistakes that would silently skew a score", () => {
    const ok = LAYA_EVAL_CASES[0]!;
    const bad = (over: Partial<LayaEvalCase>) => validateLayaEvalCases([{ ...ok, ...over }]);
    expect(bad({ expected: "nope" })[0]).toContain("not an offered action");
    expect(bad({ expected: null })[0]).toContain("only ambiguous");
    expect(bad({ group: "ambiguous" })[0]).toContain("only ambiguous");
    expect(bad({ actions: { click: "x" } })[0]).toContain("at least two");
    expect(bad({ actions: { Click: "x", wait: "y" }, expected: "wait" })[0]).toContain("snake_case");
    expect(bad({ lang: "tr" })[0]).toContain("language");
    expect(bad({ task: " " })[0]).toContain("empty");
    expect(validateLayaEvalCases([ok, ok])[0]).toContain("duplicate");
  });
});

describe("classify uses the gated decision, not the raw argmax", () => {
  it("correct / wrong on an answerable case", () => {
    expect(classify(rec("a", "click", dec("click", 0.95)), FLOOR)).toBe("correct");
    expect(classify(rec("a", "click", dec("wait", 0.95)), FLOOR)).toBe("wrong");
  });
  it("a confident answer on an ambiguous case is overconfident; a handoff there is the goal", () => {
    expect(classify(rec("a", null, dec("click", 0.99)), FLOOR)).toBe("overconfident");
    expect(classify(rec("a", null, dec("click", 0.6)), FLOOR)).toBe("handoff-ok");
  });
  it("a right-but-unsure answer is a missed handoff, not a wrong action", () => {
    expect(classify(rec("a", "click", dec("click", 0.6)), FLOOR)).toBe("handoff-missed");
  });
  it("a server abstention overrides the local floor", () => {
    const abstained = dec("click", 0.97, { abstention: "abstained", lowConfidence: true });
    expect(classify(rec("a", "click", abstained), FLOOR)).toBe("handoff-missed");
    expect(classify(rec("a", "click", abstained), { floor: 0.9, localOnly: true })).toBe("correct");
  });
  it("an out-of-set choice or an unparseable answer never executes", () => {
    expect(classify(rec("a", "click", dec("format_disk", 1)), FLOOR)).toBe("handoff-missed");
    expect(classify(rec("a", "click", null), FLOOR)).toBe("handoff-missed");
    expect(classify(rec("a", null, null), FLOOR)).toBe("handoff-ok");
  });
});

describe("summarize", () => {
  const records = [
    rec("ok1", "click", dec("click", 0.97)),
    rec("ok2", "wait", dec("wait", 0.93)),
    rec("bad", "click", dec("wait", 0.95)),
    rec("slow", "click", dec("click", 0.5)),
    rec("amb-ok", null, dec("click", 0.55)),
    rec("amb-bad", null, dec("click", 0.99)),
  ];
  const s = summarize(records, FLOOR);
  it("counts every outcome exactly once", () => {
    expect(s).toMatchObject({ n: 6, executed: 4, correct: 2, wrong: 1, overconfident: 1, handoffOk: 1, handoffMissed: 1 });
    expect(s.correct + s.wrong + s.overconfident + s.handoffOk + s.handoffMissed).toBe(s.n);
  });
  it("derives the rates from those counts", () => {
    expect(s.coverage).toBeCloseTo(4 / 6);
    expect(s.executedPrecision).toBeCloseTo(2 / 4);
    expect(s.wrongActionRate).toBeCloseTo(2 / 6);
    expect(s).toMatchObject({ ambiguous: 2, abstentionRecall: 0.5 });
  });
  it("raw accuracy ignores the gate and the ambiguous cases", () => {
    // argmax right on ok1, ok2, slow (the gate held "slow" back); wrong on "bad".
    expect(s).toMatchObject({ answerable: 4, rawCorrect: 3, rawAccuracy: 0.75 });
  });
  it("returns null rates instead of dividing by zero", () => {
    expect(summarize([], FLOOR)).toMatchObject({ n: 0, coverage: 0, executedPrecision: null, abstentionRecall: null, rawAccuracy: null });
    expect(summarize([rec("x", "click", dec("click", 0.1))], FLOOR).executedPrecision).toBeNull();
    expect(summarize([rec("x", "click", dec("click", 0.99))], FLOOR).abstentionRecall).toBeNull();
  });
  it("counts unparseable answers", () => {
    expect(summarize([rec("x", "click", null)], FLOOR)).toMatchObject({ unparseable: 1, handoffMissed: 1, executed: 0 });
  });
  it("breaks down per group and per language", () => {
    const mixed = [
      rec("a", "click", dec("click", 0.99), { lang: "en", group: "valid-next" }),
      rec("b", "click", dec("wait", 0.99), { lang: "tr", group: "wrong-window" }),
      rec("c", null, dec("click", 0.4), { lang: "tr", group: "ambiguous" }),
    ];
    const b = breakdown(mixed, FLOOR);
    expect(b.byLang.en).toMatchObject({ n: 1, correct: 1 });
    expect(b.byLang.tr).toMatchObject({ n: 2, wrong: 1, handoffOk: 1 });
    expect(Object.keys(b.byGroup).sort()).toEqual(["ambiguous", "valid-next", "wrong-window"]);
    expect(b.overall.n).toBe(3);
  });
});

describe("wilson", () => {
  it("is wide for 38 cases and degenerate-safe at the edges", () => {
    const [lo, hi] = wilson(34, 38)!;
    expect(lo).toBeGreaterThan(0.75);
    expect(hi).toBeLessThan(0.98);
    expect(wilson(0, 10)![0]).toBe(0);
    expect(wilson(10, 10)![1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("summarizeLatency", () => {
  it("uses nearest-rank percentiles so p95 is an observed value", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(summarizeLatency(xs)).toEqual({ n: 20, min: 1, p50: 10, p95: 19, max: 20, mean: 10.5 });
  });
  it("handles one sample, unsorted input and non-finite values", () => {
    expect(summarizeLatency([7])).toMatchObject({ n: 1, p50: 7, p95: 7 });
    expect(summarizeLatency([3, 1, 2, Number.NaN])).toMatchObject({ n: 3, min: 1, max: 3, p50: 2 });
    expect(summarizeLatency([])).toBeNull();
  });
});

describe("diffRuns", () => {
  const a = [rec("x", "click", dec("click", 0.97)), rec("y", null, dec("wait", 0.7))];
  it("reports identical runs as identical", () => {
    expect(diffRuns(a, structuredClone(a), FLOOR)).toEqual({ compared: 2, unmatched: [], choiceDiffs: [], gateDiffs: [], maxConfidenceDelta: 0, probabilitiesIdentical: true });
  });
  it("separates a changed choice, a changed gate and a probability drift", () => {
    const b = [rec("x", "click", dec("wait", 0.97)), rec("y", null, dec("wait", 0.95, { probabilities: { wait: 0.95 } }))];
    const d = diffRuns(a, b, FLOOR);
    expect(d.choiceDiffs).toEqual([{ caseId: "x", a: "click", b: "wait" }]);
    expect(d.gateDiffs).toEqual([
      { caseId: "x", a: "execute:click", b: "execute:wait" },
      { caseId: "y", a: "fallback:below-threshold", b: "execute:wait" },
    ]);
    expect(d.maxConfidenceDelta).toBeCloseTo(0.25);
    expect(d.probabilitiesIdentical).toBe(false);
  });
  it("flags cases present on one side only", () => {
    const d = diffRuns(a, [a[0]!, rec("z", "click", dec("click", 0.9))], FLOOR);
    expect(d.unmatched.sort()).toEqual(["y", "z"]);
    expect(d.compared).toBe(1);
  });
  it("leaves the delta null when no case had a number on both sides", () => {
    expect(diffRuns([rec("x", "click", null)], [rec("x", "click", null)], FLOOR).maxConfidenceDelta).toBeNull();
  });
});

describe("sweepFloors", () => {
  const records = [
    rec("ok", "click", dec("click", 0.99)),
    rec("mid", "click", dec("click", 0.8)),
    rec("bad", "click", dec("wait", 0.7)),
    rec("amb", null, dec("click", 0.85)),
    // Server flags are stripped in a sweep: this one would be a handoff at the request floor.
    rec("flagged", "click", dec("click", 0.97, { abstention: "abstained", lowConfidence: true })),
  ];
  const rows = sweepFloors(records, [0, 0.75, 0.9, 1]);
  it("coverage never rises with the floor, and a floor of 1 executes nothing", () => {
    expect(rows.map(r => r.executed)).toEqual([5, 4, 2, 0]);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.coverage).toBeLessThanOrEqual(rows[i - 1]!.coverage);
  });
  it("the wrong-action rate only comes down as the floor goes up", () => {
    expect(rows.map(r => r.wrong + r.overconfident)).toEqual([2, 1, 0, 0]);
  });
  it("is local-only: the stripped server flag is why 'flagged' still executes at 0.9", () => {
    expect(rows[2]!.executed).toBe(2); // ok + flagged
  });
});
