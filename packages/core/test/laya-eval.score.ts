// Pure scoring for the Laya evaluation (laya-eval.live.ts): turns per-case server answers into the
// numbers the quality report quotes. No I/O, so every metric is unit-tested on hand-built records.
//
// What is measured is the GATED decision Chimera would act on (gateLayaDecision), not the raw model
// argmax -- an action is only ever executed after the finite-set check, the server abstention and
// the local floor. Each case therefore lands in exactly one outcome:
//   correct          executed the expected action
//   wrong            executed an action other than the expected one
//   overconfident    executed anything on an AMBIGUOUS case (expected: null) -- it should have handed over
//   handoff-ok       fell back to the LLM on an ambiguous case (the desired behaviour)
//   handoff-missed   fell back to the LLM on a case that had a right answer (safe, but costs an LLM call)
import { gateLayaDecision, type LayaDecision } from "../src/laya-decision.js";
import type { LayaEvalGroup } from "./laya-eval.cases.js";

export type LayaEvalRecord = {
  caseId: string;
  lang: "en" | "tr";
  group: LayaEvalGroup;
  expected: string | null;
  /** The offered action keys; the gate validates the choice against these. */
  actions: string[];
  /** null = the tool errored or its answer could not be parsed. */
  decision: LayaDecision | null;
  /** Client-side wall time of the MCP call through the Chimera route. */
  wallMs: number | null;
};

export type Outcome = "correct" | "wrong" | "overconfident" | "handoff-ok" | "handoff-missed";

export type ScoreOptions = {
  floor: number;
  /**
   * Ignore the server's abstention / low_confidence flags and gate on `answer_confidence >= floor`
   * alone. The floor sweep needs this: the server verdict is computed at the floor the request was
   * sent with, so it would otherwise override every lower floor in the sweep.
   */
  localOnly?: boolean;
};

export function gateRecord(r: LayaEvalRecord, o: ScoreOptions) {
  const d = o.localOnly && r.decision ? { ...r.decision, abstention: null, lowConfidence: false } : r.decision;
  return gateLayaDecision(d, r.actions, { minConfidence: o.floor });
}

export function classify(r: LayaEvalRecord, o: ScoreOptions): Outcome {
  const gate = gateRecord(r, o);
  if ("fallback" in gate) return r.expected === null ? "handoff-ok" : "handoff-missed";
  if (r.expected === null) return "overconfident";
  return gate.execute === r.expected ? "correct" : "wrong";
}

export type Slice = {
  n: number;
  executed: number;
  correct: number;
  wrong: number;
  overconfident: number;
  handoffOk: number;
  handoffMissed: number;
  /** executed / n: how often Laya's answer is acted on without an LLM call. */
  coverage: number;
  /** correct / executed; null when nothing was executed. */
  executedPrecision: number | null;
  /** (wrong + overconfident) / n: executed actions that should not have been. The number to keep at 0. */
  wrongActionRate: number;
  /** handoff-ok / ambiguous cases; null when the slice has none. */
  abstentionRecall: number | null;
  ambiguous: number;
  /** Raw argmax == expected over the non-ambiguous cases, ignoring every gate; null when there are none. */
  rawAccuracy: number | null;
  rawCorrect: number;
  answerable: number;
  /** Cases with no parseable answer (tool error); they count as handoffs. */
  unparseable: number;
};

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function summarize(records: readonly LayaEvalRecord[], o: ScoreOptions): Slice {
  const c: Record<Outcome, number> = { correct: 0, wrong: 0, overconfident: 0, "handoff-ok": 0, "handoff-missed": 0 };
  let rawCorrect = 0;
  let answerable = 0;
  let unparseable = 0;
  for (const r of records) {
    c[classify(r, o)]++;
    if (!r.decision) unparseable++;
    if (r.expected !== null) { answerable++; if (r.decision?.choice === r.expected) rawCorrect++; }
  }
  const n = records.length;
  const executed = c.correct + c.wrong + c.overconfident;
  const ambiguous = c["handoff-ok"] + c.overconfident;
  return {
    n, executed, correct: c.correct, wrong: c.wrong, overconfident: c.overconfident,
    handoffOk: c["handoff-ok"], handoffMissed: c["handoff-missed"],
    coverage: n === 0 ? 0 : executed / n,
    executedPrecision: ratio(c.correct, executed),
    wrongActionRate: n === 0 ? 0 : (c.wrong + c.overconfident) / n,
    abstentionRecall: ratio(c["handoff-ok"], ambiguous),
    ambiguous,
    rawAccuracy: ratio(rawCorrect, answerable), rawCorrect, answerable, unparseable,
  };
}

export type Breakdown = { overall: Slice; byGroup: Partial<Record<LayaEvalGroup, Slice>>; byLang: Partial<Record<"en" | "tr", Slice>> };

export function breakdown(records: readonly LayaEvalRecord[], o: ScoreOptions): Breakdown {
  const by = <K extends string>(key: (r: LayaEvalRecord) => K) => {
    const groups = new Map<K, LayaEvalRecord[]>();
    for (const r of records) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return Object.fromEntries([...groups].map(([k, rs]) => [k, summarize(rs, o)])) as Partial<Record<K, Slice>>;
  };
  return { overall: summarize(records, o), byGroup: by(r => r.group), byLang: by(r => r.lang) };
}

/** 95 % Wilson score interval. With 38 cases the intervals are wide -- that is the point of printing them. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export type LatencySummary = { n: number; min: number; p50: number; p95: number; max: number; mean: number };

/** Nearest-rank percentiles (no interpolation) so a reported p95 is always a latency that was observed. */
export function summarizeLatency(ms: readonly number[]): LatencySummary | null {
  const xs = ms.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))]!;
  return { n: xs.length, min: xs[0]!, p50: rank(50), p95: rank(95), max: xs[xs.length - 1]!, mean: xs.reduce((s, x) => s + x, 0) / xs.length };
}

const gateKey = (r: LayaEvalRecord, o: ScoreOptions) => {
  const g = gateRecord(r, o);
  return "execute" in g ? `execute:${g.execute}` : `fallback:${g.reason}`;
};

export type RunDiff = {
  compared: number;
  /** Case ids present in one run only (a harness bug if non-empty). */
  unmatched: string[];
  choiceDiffs: { caseId: string; a: string | null; b: string | null }[];
  gateDiffs: { caseId: string; a: string; b: string }[];
  /** Largest |Δ answer_confidence| over matched cases; null when none had a number on both sides. */
  maxConfidenceDelta: number | null;
  /** Every per-action probability matched exactly (same checkpoint, same input => same distribution). */
  probabilitiesIdentical: boolean;
};

/** Case-by-case comparison of two runs: two package versions, or two trials of the same one. */
export function diffRuns(a: readonly LayaEvalRecord[], b: readonly LayaEvalRecord[], o: ScoreOptions): RunDiff {
  const bById = new Map(b.map(r => [r.caseId, r]));
  const aIds = new Set(a.map(r => r.caseId));
  const out: RunDiff = {
    compared: 0, unmatched: [...a.filter(r => !bById.has(r.caseId)).map(r => r.caseId), ...b.filter(r => !aIds.has(r.caseId)).map(r => r.caseId)],
    choiceDiffs: [], gateDiffs: [], maxConfidenceDelta: null, probabilitiesIdentical: true,
  };
  for (const ra of a) {
    const rb = bById.get(ra.caseId);
    if (!rb) continue;
    out.compared++;
    const [ca, cb] = [ra.decision?.choice ?? null, rb.decision?.choice ?? null];
    if (ca !== cb) out.choiceDiffs.push({ caseId: ra.caseId, a: ca, b: cb });
    const [ga, gb] = [gateKey(ra, o), gateKey(rb, o)];
    if (ga !== gb) out.gateDiffs.push({ caseId: ra.caseId, a: ga, b: gb });
    const [pa, pb] = [ra.decision?.probabilities, rb.decision?.probabilities];
    if (JSON.stringify(pa) !== JSON.stringify(pb)) out.probabilitiesIdentical = false;
    const [xa, xb] = [ra.decision?.answerConfidence, rb.decision?.answerConfidence];
    if (typeof xa === "number" && typeof xb === "number") out.maxConfidenceDelta = Math.max(out.maxConfidenceDelta ?? 0, Math.abs(xa - xb));
  }
  return out;
}

export type SweepRow = { floor: number } & Pick<Slice, "coverage" | "executedPrecision" | "wrongActionRate" | "abstentionRecall" | "executed" | "wrong" | "overconfident">;

/** Operating points of the LOCAL floor alone (server verdict stripped); shows the coverage/safety trade. */
export function sweepFloors(records: readonly LayaEvalRecord[], floors: readonly number[]): SweepRow[] {
  return floors.map(floor => {
    const s = summarize(records, { floor, localOnly: true });
    return { floor, executed: s.executed, coverage: s.coverage, executedPrecision: s.executedPrecision, wrong: s.wrong, overconfident: s.overconfident, wrongActionRate: s.wrongActionRate, abstentionRecall: s.abstentionRecall };
  });
}
