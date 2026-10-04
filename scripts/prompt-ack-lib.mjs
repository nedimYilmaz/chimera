// PROMPT-ACK-LIB — F09 QA (item 1): pure, side-effect-free derivation policy for the two
// prompt-ack constants, extracted out of scripts/prompt-ack-latency.mjs so packages/core's
// PROMPT_ACK_WAIT_MS / PROMPT_STALL_MS and the doc/plan artifacts are provably ONE computation,
// not two independently-typed numbers that can drift apart (the QA note's "artifact vs threshold
// contradiction" — a hand-picked promptAckWaitMs=4000 sitting next to a p90 of 8708ms in the same
// artifact). No top-level I/O, no imports — takes the `idle` bucket of the measurement report in,
// returns the `recommended` block out.

// The coverage-threshold buckets a run's idle latencies are pre-summarized into (idle.coverage
// keys) — must match scripts/prompt-ack-latency.mjs's COVERAGE_THRESHOLDS_MS.
const COVERAGE_THRESHOLDS_MS = [3000, 5000, 10000, 20000, 30000, 45000, 90000];

// Policy: PROMPT_STALL_MS is the smallest coverage bucket whose false-signal rate (1 - coverage)
// is at or under this ceiling. At the 2026-09-02 run this lands on 45000 (98% coverage, flat out
// to 90000 — waiting longer buys nothing), which is why the plan documents a 45s window.
const FALSE_SIGNAL_CEILING = 0.02;

// Policy: PROMPT_ACK_WAIT_MS is idle.p90, rounded to the nearest second — the ack wait should
// resolve "started" synchronously for ~90% of idle sends without over-fitting to the noisier
// p95/p99 tail (that tail is what PROMPT_STALL_MS exists to catch instead).
const ACK_WAIT_ROUND_MS = 1000;

/**
 * @param {{ n: number, p90: number, coverage: Record<string, number> }} idle
 */
export function recommend(idle) {
  let promptStallMs = COVERAGE_THRESHOLDS_MS[COVERAGE_THRESHOLDS_MS.length - 1];
  for (const ms of COVERAGE_THRESHOLDS_MS) {
    const covered = idle.coverage[String(ms)] ?? 0;
    // Rounded to 4dp before comparing: coverage values come from a division (n covered / n
    // total) and float noise (e.g. 1 - 0.98 = 0.020000000000000018) must not push a bucket that
    // is AT the ceiling into the next, coarser one.
    if (Number((1 - covered).toFixed(4)) <= FALSE_SIGNAL_CEILING) {
      promptStallMs = ms;
      break;
    }
  }
  const promptAckWaitMs = Math.round((idle.p90 ?? 0) / ACK_WAIT_ROUND_MS) * ACK_WAIT_ROUND_MS;
  const covered = idle.coverage[String(promptStallMs)] ?? 0;
  return {
    promptAckWaitMs,
    promptStallMs,
    falseSignalRateAtStall: idle.n === 0 ? 0 : Number((1 - covered).toFixed(4)),
  };
}
