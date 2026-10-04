#!/usr/bin/env node
// COMPACTION-AUDIT (F39) — CLI over scripts/audit-lib.mjs. Answers "what would the bill have been
// at compaction threshold X" from the retained event log, dollar-weighted, with the compaction's
// own cost subtracted and the post-compaction floor swept. No runtime change and no new
// instrumentation: this only READS ~/.chimera/events (plan §1 OUT).
//
// Deliberately a SEPARATE artifact pair from F45's measurement-audit, in the same directory and
// under the same --date idempotence rule, so re-running one audit never overwrites the other's
// numbers (plan §2.7).
//
//   node scripts/compaction-audit.mjs [--home ~/.chimera] [--date YYYY-MM-DD] [--out <dir>]
//                                     [--thresholds a,b,c] [--window-calls 30] [--json] [--stdout]

import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readEvents, buildCompactionReport, THRESHOLD_SWEEP, MIN_NET_MULTIPLIER, NEAR_BEST_TOLERANCE, FLEET_DEFAULT_THRESHOLD } from "./audit-lib.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "docs/superpowers/measurements");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`compaction-audit — F39 counterfactual threshold replay over ~/.chimera/events

Usage: node scripts/compaction-audit.mjs [options]

  --home <dir>        events home, default ~/.chimera (reads <home>/events/*.jsonl)
  --date <YYYY-MM-DD> artifact date stamp, default today (local). Re-running the same date
                      overwrites both artifacts (idempotent), it never appends.
  --out <dir>         output directory, default docs/superpowers/measurements
  --thresholds <list> comma-separated candidate thresholds, default ${THRESHOLD_SWEEP.join(",")}
  --window-calls <n>  D07 post-compaction tool-call window, default 30
  --json              with --stdout, print the JSON sidecar instead of the markdown report
  --stdout            print to stdout instead of writing the two artifact files
  --force             overwrite an existing dated artifact (refused by default, see below)
  --help              show this message

The replay grows a simulated context by each real call's own delta, fires a compaction when it
crosses the threshold, charges a full cache rewrite of the post-compaction floor, and reports
netMultiplier = actualUsd / simulatedUsd. netMultiplier at threshold=none is exactly 1.0 BY
CONSTRUCTION (the replay clamps sim to the real context), so it only proves the replay's own
arithmetic is consistent — it cannot catch a wrong series. The check with teeth is the ledger
cross-check below it, which compares actual.usd against buildSpendLedger's independently-built
modelledListUsd.

Exits non-zero if <home>/events is missing or has no .jsonl segments.`);
  process.exit(0);
}

const HOME = flag("home", join(homedir(), ".chimera"));
const DATE = flag("date", todayLocal());
const OUT_DIR = flag("out", DEFAULT_OUT_DIR);
const THRESHOLDS = parseThresholds(flag("thresholds", undefined));
const WINDOW_CALLS = flag("window-calls", undefined);
const AS_JSON = args.includes("--json");
const FORCE = args.includes("--force");
const TO_STDOUT = args.includes("--stdout");

function todayLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseThresholds(v) {
  if (v === undefined) return undefined;
  // Number.isFinite, not typeof: `--thresholds 120k` becomes NaN, and a NaN threshold silently
  // never fires a compaction — the sweep would print a row that reads as "no saving available".
  const list = v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return list.length ? list : undefined;
}

const eventsDir = join(HOME, "events");
let segmentFiles;
try {
  segmentFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
} catch {
  console.error(`compaction-audit: events directory not found: ${eventsDir}`);
  process.exit(1);
}
if (segmentFiles.length === 0) {
  console.error(`compaction-audit: no .jsonl segments under ${eventsDir}`);
  process.exit(1);
}

// F45.QA-B leftover #3: pass a re-iterable factory, not a materialized array — buildCompactionReport
// re-reads the log once per internal pass instead of holding all ~300k events in memory at once
// (plan §6's streaming mitigation; mirrors measurement-audit.mjs's buildReport(() => readEvents(...))).
const report = buildCompactionReport(() => readEvents(HOME), {
  eventsHome: HOME,
  segments: segmentFiles.length,
  thresholds: THRESHOLDS,
  windowCalls: WINDOW_CALLS !== undefined ? Number(WINDOW_CALLS) : undefined,
});

const output = {
  schemaVersion: report.schemaVersion,
  generatedAt: new Date().toISOString(),
  eventsHome: report.eventsHome,
  window: report.window,
  coverage: report.coverage,
  observed: report.observed,
  actual: report.actual,
  selfCheck: report.selfCheck,
  sweep: report.sweep,
  d07: report.d07,
  recommendation: report.recommendation,
  sensitivity: report.sensitivity,
  caveats: report.caveats,
};

const markdown = renderMarkdown(output);

if (TO_STDOUT) {
  process.stdout.write(AS_JSON ? `${JSON.stringify(output, null, 2)}\n` : markdown);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = join(OUT_DIR, `${DATE}-compaction-audit.md`);
  const jsonPath = join(OUT_DIR, `${DATE}-compaction-audit.json`);
  // F39.QA: the dated artifact is FROZEN EVIDENCE — pricing.ts's DEFAULT_COMPACTION_THRESHOLD
  // comment cites it by path and quotes its numbers, and plan A16 makes "commit 3's diff contains
  // the artifact commit 2 created" the only enforcement of the landing order. But the input is a
  // ROLLING window: ~/.chimera/events rotates, so re-running the very command that comment prints
  // (`--date 2026-09-02`) produces DIFFERENT numbers on the same date and used to silently replace
  // the evidence with them (measured 2026-09-02 15:57 against the 14:24 artifact: $5,615.43 vs
  // $5,724.70, 19,787 vs 19,761 calls — the 120k recommendation reproduced, the numbers did not).
  // Refuse instead: a reader following the reproduction instructions must not be able to destroy
  // the thing being reproduced.
  if (!FORCE && (existsSync(mdPath) || existsSync(jsonPath))) {
    console.error(`compaction-audit: ${DATE} artifact already exists and is cited as frozen evidence — refusing to overwrite.`);
    console.error(`  compare instead:  node scripts/compaction-audit.mjs --stdout --json > /tmp/rerun.json`);
    console.error(`  or replace it:    node scripts/compaction-audit.mjs --date ${DATE} --force`);
    process.exit(2);
  }
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`compaction-audit: wrote ${mdPath}`);
  console.log(`compaction-audit: wrote ${jsonPath}`);
}

// -------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------

function usd(n) {
  return `$${(n ?? 0).toFixed(2)}`;
}
function fmt(n) {
  return (n ?? 0).toLocaleString("en-US");
}
function iso(ts) {
  return typeof ts === "number" && ts > 0 ? new Date(ts).toISOString() : "n/a";
}
function mult(n) {
  return `${(n ?? 0).toFixed(3)}x`;
}

function renderWindow(o) {
  const lines = [];
  lines.push("## Run window");
  lines.push("");
  lines.push(`- events home: \`${o.eventsHome}\``);
  lines.push(`- segments: ${fmt(o.window.segments)}, agents: ${fmt(o.window.agents)}`);
  lines.push(`- first event: ${iso(o.window.firstTs)}, last event: ${iso(o.window.lastTs)}`);
  lines.push("");
  // modelCalls beside usageEvents is the A0/R1 regression alarm: if a future reader drops the
  // turn dedupe these two converge, and a doubled bill would otherwise announce itself nowhere.
  lines.push("| metric | value |");
  lines.push("|---|---|");
  lines.push(`| modelCalls (real API calls, deduped) | ${fmt(o.window.modelCalls)} |`);
  lines.push(`| usageEvents (raw \`usage\` rows) | ${fmt(o.window.usageEvents)} |`);
  lines.push(`| deltaReemissions (\`message_delta\` repeats) | ${fmt(o.window.deltaReemissions)} |`);
  lines.push("");
  lines.push(
    o.window.modelCalls === o.window.usageEvents
      ? "> ⚠ **modelCalls == usageEvents** — the turn dedupe is not running and every absolute figure below is ~2x."
      : "> modelCalls < usageEvents, as it must be: claude double-emits `usage` per turn.",
  );
  return lines.join("\n");
}

function renderCoverage(coverage) {
  const lines = [];
  lines.push("## Backend coverage");
  lines.push("");
  lines.push("| backend | agents | compactions | priceable | why not |");
  lines.push("|---|---|---|---|---|");
  for (const [cls, row] of Object.entries(coverage)) {
    lines.push(
      `| ${cls} | ${fmt(row.agents)} | ${fmt(row.compactions)} | ${row.canPriceCompaction ? "yes" : "**no**"} | ${row.reason ?? "—"} |`,
    );
  }
  return lines.join("\n");
}

function renderObserved(observed) {
  const lines = [];
  lines.push("## Observed compactions");
  lines.push("");
  lines.push(`- completions: **${observed.compactions}** (plus ${observed.startEvents} \`phase:"start"\` events, which carry no sizes)`);
  lines.push(`- byOwner: ${Object.entries(observed.byOwner).map(([k, v]) => `${k}:${v}`).join(", ") || "—"}`);
  lines.push(`- byTrigger: ${Object.entries(observed.byTrigger).map(([k, v]) => `${k}:${v}`).join(", ") || "—"}`);
  lines.push(`- before.tokens: ${observed.beforeTokens.map(fmt).join(", ") || "—"}`);
  lines.push(`- after.tokens: ${observed.afterTokens.map(fmt).join(", ") || "—"}`);
  lines.push(`- swept floors: min ${fmt(observed.floors.min)}, median ${fmt(observed.floors.median)}, max ${fmt(observed.floors.max)}`);
  lines.push(
    `- synthetic post-compaction usage events: ${observed.syntheticUsageEvents} (${fmt(observed.syntheticInputTokens)} phantom input tokens; ${observed.markedSynthetic} carry the F39.0 \`synthetic:"compaction-baseline"\` marker)`,
    // F39.QA: the MEASURED counterpart of the modelled compactionCostUsd in every sweep row. Zero
    // on a log written before F39.0 landed the latch — printed anyway, because a silently omitted
    // section reads as "not applicable" when it means "not instrumented yet".
    `- calls marked \`afterCompaction:true\` (the measured prefix-cache rewrite, F39.0's latch): ${observed.afterCompactionCalls}, ${fmt(observed.afterCompactionWriteTokens)} cache_creation tokens (mean ${fmt(Math.round(observed.afterCompactionMeanWriteTokens))}) — compare against the swept floors above, which the replay charges instead`,
  );
  return lines.join("\n");
}

function renderActual(actual, selfCheck) {
  const lines = [];
  lines.push("## Actual bill (claude, deduped)");
  lines.push("");
  lines.push(`- actual.usd: **${usd(actual.usd)}** over ${fmt(actual.modelCalls)} model calls across ${fmt(actual.agentsCovered)} agents`);
  lines.push(`- mean context per call: ${fmt(Math.round(actual.meanCtx))} tokens`);
  lines.push(`- first-turn cache write: median ${fmt(actual.medianFirstCacheWrite)}, p95 ${fmt(actual.p95FirstCacheWrite)} tokens`);
  lines.push(`- ${actual.usdFloorNote}`);
  if (actual.priceTableMisses.length) lines.push(`- priceTableMisses: ${actual.priceTableMisses.join(", ")}`);
  const c = actual.calibration;
  lines.push(
    `- calibration vs the SDK's own billing (F45.QA-A): ${fmt(c.sdkAgents)} agents reported \`result.costUsd\` totalling ${usd(c.sdkUsd)}; ` +
      `the same agents priced from the list table come to ${usd(c.modelledUsdForSdkAgents)} — a ${c.modelledOverSdkRatio === null ? "n/a" : `${c.modelledOverSdkRatio.toFixed(3)}x`} model-over-SDK factor. ` +
      `${c.note}.`,
  );
  lines.push("");
  lines.push(
    selfCheck.exact
      ? `- **self-check PASSED**: replay at threshold=none reproduces the actual bill exactly (netMultiplier ${selfCheck.netMultiplierAtInfinity.toFixed(6)}).`
      : `- ⚠ **self-check FAILED**: replay at threshold=none returned ${mult(selfCheck.netMultiplierAtInfinity)} instead of exactly 1.0 — every number below is suspect.`,
  );
  lines.push(
    `  (this one is tautological by construction — see the ledger cross-check below for the check that can actually fail.)`,
  );
  const lc = selfCheck.ledgerCrossCheck;
  lines.push(
    lc.withinTolerance
      ? `- **ledger cross-check PASSED**: actual.usd + excludedLedgerBillableUsd (${usd(lc.excludedLedgerBillableUsd)}) - unattributedSeriesUsd (${usd(lc.unattributedSeriesUsd)}) = ${usd(lc.expectedUsd)}, matching buildSpendLedger.modelledListUsd (${usd(lc.modelledListUsd)}), delta ${lc.deltaUsd.toFixed(6)} — this is an independently-built figure agreeing with actual.usd, unlike the self-check above.`
      : `- ⚠ **ledger cross-check FAILED**: actual.usd + excludedLedgerBillableUsd (${usd(lc.excludedLedgerBillableUsd)}) - unattributedSeriesUsd (${usd(lc.unattributedSeriesUsd)}) = ${usd(lc.expectedUsd)} vs buildSpendLedger.modelledListUsd (${usd(lc.modelledListUsd)}), delta ${lc.deltaUsd.toFixed(6)} — the series may be built from the wrong rows.`,
  );
  return lines.join("\n");
}

function renderSweep(sweep) {
  const lines = [];
  lines.push("## Sweep — what the bill would have been");
  lines.push("");
  lines.push("| threshold | floor | floorLabel | simulatedUsd | netMultiplier | compactions | compactionCostUsd | compactions/agent-day |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of sweep) {
    lines.push(
      `| ${r.threshold === null ? "none (self-check)" : fmt(r.threshold)} | ${fmt(r.floor)} | ${r.floorLabel} | ${usd(r.simulatedUsd)} | **${mult(r.netMultiplier)}** | ${fmt(r.compactions)} | ${usd(r.compactionCostUsd)} | ${r.compactionsPerAgentDay.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

function renderD07(d07) {
  const lines = [];
  lines.push("## D07 — post-compaction behaviour (reported, NOT used to decide the threshold)");
  lines.push("");
  lines.push(`- n = ${d07.n} compactions, window = ${d07.windowCalls} tool calls each`);
  lines.push(`- chronicle calls after a compaction: **${d07.chronicleCalls}/${d07.chronicleDenominator}**`);
  lines.push(`- re-reads of a path already read before the boundary: **${d07.reReads}**`);
  lines.push(`  - by tool: ${Object.entries(d07.reReadsByTool).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  lines.push(
    `- the Bash arm extracted ${fmt(d07.bashPathsExtracted)} candidate paths with a deliberately crude \`cat|head|tail|less|sed -n\` regex — its false positives inflate the re-read count, never deflate it`,
  );
  lines.push(`- ${d07.note}`);
  return lines.join("\n");
}

function renderRecommendation(rec) {
  const lines = [];
  lines.push("## Recommendation");
  lines.push("");
  lines.push(
    `Rule ${rec.rule}: drop any threshold whose netMultiplier at the **pessimistic (max) floor** is < ${MIN_NET_MULTIPLIER}, ` +
      `drop any below 2x the p95 first-turn cache write (${fmt(rec.prefixBar)}), then take the **largest** survivor within ` +
      `${NEAR_BEST_TOLERANCE * 100}% of the best.`,
  );
  lines.push("");
  if (rec.verdict === "no-default") {
    lines.push("**verdict: `no-default`** — no candidate threshold cleared its bar on this window.");
    lines.push("");
    lines.push("This is a complete, reportable outcome (§2.4.4 rule 5), not a failed measurement: L1 measured below its bar here.");
  } else {
    lines.push(`**verdict: \`set\` — ${fmt(rec.threshold)}**`);
    lines.push("");
    lines.push(`- netMultiplier at the median floor: ${mult(rec.netAtMedianFloor)}`);
    lines.push(`- netMultiplier at the pessimistic floor: ${mult(rec.netAtPessimisticFloor)} (best survivor: ${mult(rec.best)})`);
    lines.push(
      `- margin to the ${MIN_NET_MULTIPLIER} bar: the unmodelled SDK summarization would have to cost ${usd(rec.marginToBar.extraUsdToFlip)} ` +
        `across ${fmt(rec.marginToBar.compactionsAtChoice)} simulated compactions — **${usd(rec.marginToBar.extraUsdPerCompactionToFlip)} each** — to flip this verdict`,
    );
  }
  lines.push("");
  lines.push("| threshold | netMultiplier @ max floor | outcome |");
  lines.push("|---|---|---|");
  for (const s of rec.survivors) lines.push(`| ${fmt(s.threshold)} | ${mult(s.netAtPessimisticFloor)} | survives |`);
  for (const r of rec.rejected) lines.push(`| ${fmt(r.threshold)} | ${mult(r.netAtPessimisticFloor)} | dropped — ${r.reason} |`);
  return lines.join("\n");
}

function renderSensitivity(sensitivity) {
  const lines = [];
  lines.push("## Sensitivity (F39.QA-B M-3)");
  lines.push("");
  if (!sensitivity) {
    lines.push("Not evaluated — the recommendation was `no-default`, so there is no threshold to stress-test.");
    return lines.join("\n");
  }
  lines.push(
    `netMultiplier recomputed at the recommended threshold (${fmt(sensitivity.thresholdEvaluated)}) and pessimistic floor ` +
      `(${fmt(sensitivity.floorEvaluated)}) across a READ_RATE x WRITE_RATE grid, to check whether the decision survives if the ` +
      `~2.6x list-vs-billed pricing bias (\`actual.calibration.modelledOverSdkRatio\`) isn't the uniform scalar the old \`calibration.note\` assumed. ` +
      `Baseline is READ_RATE=${sensitivity.baseline.readRate}, WRITE_RATE=${sensitivity.baseline.writeRate}.`,
  );
  lines.push("");
  lines.push("| readRate | writeRate | netMultiplier |");
  lines.push("|---|---|---|");
  for (const c of sensitivity.grid) lines.push(`| ${c.readRate} | ${c.writeRate} | ${mult(c.netMultiplier)} |`);
  lines.push("");
  lines.push(
    sensitivity.allClearBar
      ? `- **clears the ${MIN_NET_MULTIPLIER} bar in every cell**: netMultiplier ranges ${mult(sensitivity.minNetMultiplier)}..${mult(sensitivity.maxNetMultiplier)}.`
      : `- ⚠ **does NOT clear the ${MIN_NET_MULTIPLIER} bar in every cell**: netMultiplier ranges ${mult(sensitivity.minNetMultiplier)}..${mult(sensitivity.maxNetMultiplier)} — the recommendation is sensitive to the list-vs-billed pricing bias.`,
  );
  // The recommendation moves with the retained window; the number actually shipped to every agent
  // does not. Both grids are rendered so the artifact answers "does the DEFAULT clear the bar".
  const fd = sensitivity.fleetDefault;
  lines.push("");
  lines.push(`The same grid at the shipped fleet default (\`DEFAULT_COMPACTION_THRESHOLD.claude\` = ${fmt(fd.thresholdEvaluated)}):`);
  lines.push("");
  lines.push("| readRate | writeRate | netMultiplier |");
  lines.push("|---|---|---|");
  for (const c of fd.grid) lines.push(`| ${c.readRate} | ${c.writeRate} | ${mult(c.netMultiplier)} |`);
  lines.push("");
  lines.push(
    fd.allClearBar
      ? `- **the shipped default clears the ${MIN_NET_MULTIPLIER} bar in every cell**: netMultiplier ranges ${mult(fd.minNetMultiplier)}..${mult(fd.maxNetMultiplier)} — the "bias cancels out" assertion holds here, so it is evidence rather than an assumption.`
      : `- ⚠ **the shipped default does NOT clear the ${MIN_NET_MULTIPLIER} bar in every cell**: netMultiplier ranges ${mult(fd.minNetMultiplier)}..${mult(fd.maxNetMultiplier)} — the "bias cancels out of netMultiplier" assertion does not hold on this window, so ${fmt(FLEET_DEFAULT_THRESHOLD)} needs revisiting rather than being treated as settled.`,
  );
  return lines.join("\n");
}

function renderMarkdown(o) {
  const sections = [];
  sections.push(`# Compaction audit — ${DATE}`);
  sections.push("");
  sections.push(`generatedAt: ${o.generatedAt}`);
  sections.push("");
  // The artifact must carry the command that produced it — a committed number nobody can re-derive
  // is a claim, not a measurement.
  sections.push(`reproduce: \`node scripts/compaction-audit.mjs${args.length ? ` ${args.join(" ")}` : ""}\``);
  sections.push("");
  sections.push(
    "Counterfactual replay over retained events (F39 plan §2.4): what the bill would have been at " +
      "compaction threshold X. This report takes **no action** — it does not set a default.",
  );
  sections.push("");
  sections.push(renderWindow(o));
  sections.push("");
  sections.push(renderCoverage(o.coverage));
  sections.push("");
  sections.push(renderObserved(o.observed));
  sections.push("");
  sections.push(renderActual(o.actual, o.selfCheck));
  sections.push("");
  sections.push(renderSweep(o.sweep));
  sections.push("");
  sections.push(renderD07(o.d07));
  sections.push("");
  sections.push(renderRecommendation(o.recommendation));
  sections.push("");
  sections.push(renderSensitivity(o.sensitivity));
  sections.push("");
  sections.push("## Caveats");
  sections.push("");
  for (const c of o.caveats) sections.push(`- ${c}`);
  sections.push("");
  return sections.join("\n");
}
