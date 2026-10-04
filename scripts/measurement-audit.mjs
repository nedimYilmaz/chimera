#!/usr/bin/env node
// MEASUREMENT-AUDIT (F45) — CLI over scripts/audit-lib.mjs. Renders the dated markdown scorecard
// and writes the frozen JSON sidecar (plan §2.6) that F39/F41 code against. No runtime change, no
// new instrumentation — this only reads the existing event log (plan §1 OUT).
//
//   node scripts/measurement-audit.mjs [--home ~/.chimera] [--date YYYY-MM-DD] [--out <dir>]
//                                       [--since <ms|ISO>] [--l4-bound <chars>] [--json] [--stdout]

import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readEvents, buildReport, PRICES, TOOL_RESULT_MAX_CHARS } from "./audit-lib.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "docs/superpowers/measurements");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`measurement-audit — F45 L3/L4 scorecard + JSON sidecar over ~/.chimera/events

Usage: node scripts/measurement-audit.mjs [options]

  --home <dir>       events home, default ~/.chimera (reads <home>/events/*.jsonl)
  --date <YYYY-MM-DD> artifact date stamp, default today (local). Re-running the same date
                      overwrites both artifacts (idempotent), it never appends.
  --out <dir>         output directory, default docs/superpowers/measurements
  --since <ms|ISO>    override the L3 batching-directive cutoff (default: the directive's own
                      authored timestamp, DIRECTIVE_TS in audit-lib.mjs)
  --l4-bound <chars>  override the L4 orchestration-return size bound, default 8000
  --json              with --stdout, print the JSON sidecar instead of the markdown scorecard
  --stdout            print to stdout instead of writing the two artifact files
  --help              show this message

Exits non-zero if <home>/events is missing or has no .jsonl segments.`);
  process.exit(0);
}

const HOME = flag("home", join(homedir(), ".chimera"));
const DATE = flag("date", todayLocal());
const OUT_DIR = flag("out", DEFAULT_OUT_DIR);
const SINCE = parseSince(flag("since", undefined));
const L4_BOUND = flag("l4-bound", undefined);
const AS_JSON = args.includes("--json");
const TO_STDOUT = args.includes("--stdout");

function todayLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseSince(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() !== "" && !Number.isNaN(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

const eventsDir = join(HOME, "events");
let segmentFiles;
try {
  segmentFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
} catch {
  console.error(`measurement-audit: events directory not found: ${eventsDir}`);
  process.exit(1);
}
if (segmentFiles.length === 0) {
  console.error(`measurement-audit: no .jsonl segments under ${eventsDir}`);
  process.exit(1);
}

// A FACTORY, not an array: buildReport streams two passes over it and never materializes the log.
// Spreading readEvents here is what made a 616 MB log cost 1.4 GB of peak RSS (plan §6).
const report = buildReport(() => readEvents(HOME), {
  since: SINCE,
  l4BoundChars: L4_BOUND !== undefined ? Number(L4_BOUND) : undefined,
  eventsHome: HOME,
  segments: segmentFiles.length,
});

const output = {
  schemaVersion: report.schemaVersion,
  generatedAt: new Date().toISOString(),
  eventsHome: report.eventsHome,
  window: report.window,
  baseline: report.baseline,
  l3: report.l3,
  l4: report.l4,
  spend: report.spend,
  q3: report.q3,
  surface: report.surface,
  gates: report.gates,
  caveats: report.caveats,
};

const markdown = renderMarkdown(output);

if (TO_STDOUT) {
  process.stdout.write(AS_JSON ? `${JSON.stringify(output, null, 2)}\n` : markdown);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = join(OUT_DIR, `${DATE}-measurement-audit.md`);
  const jsonPath = join(OUT_DIR, `${DATE}-measurement-audit.json`);
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`measurement-audit: wrote ${mdPath}`);
  console.log(`measurement-audit: wrote ${jsonPath}`);
}

// -------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------

function pct(n) {
  return `${(n ?? 0).toFixed(1)}%`;
}
function usd(n) {
  return `$${(n ?? 0).toFixed(2)}`;
}
function fmt(n) {
  return (n ?? 0).toLocaleString("en-US");
}
function iso(ts) {
  return typeof ts === "number" && ts > 0 ? new Date(ts).toISOString() : "n/a";
}
function mixStr(mix) {
  const entries = Object.entries(mix ?? {});
  if (!entries.length) return "—";
  return entries.map(([k, v]) => `${k}:${v}`).join(", ");
}

function renderWindowTable(title, before, after) {
  const lines = [];
  lines.push(`**${title}**`);
  lines.push("");
  lines.push("| | turns | toolCalls | mean | shareSingle | 1 | 2 | 3 | 4 | 5+ | agents | callsSaved | models | cliVersions |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [label, w] of [["before", before], ["after", after]]) {
    lines.push(
      `| ${label} | ${fmt(w.turns)} | ${fmt(w.toolCalls)} | ${w.mean.toFixed(2)} | ${pct(w.shareSingle * 100)} | ` +
        `${w.histogram["1"]} | ${w.histogram["2"]} | ${w.histogram["3"]} | ${w.histogram["4"]} | ${w.histogram["5+"]} | ` +
        `${w.agents} | ${w.callsSaved} | ${mixStr(w.models)} | ${mixStr(w.cliVersions)} |`,
    );
  }
  return lines.join("\n");
}

function renderL3(l3) {
  const lines = [];
  lines.push("## L3 — did the batching directive work");
  lines.push("");
  lines.push(
    `- directive: commit \`${l3.directive.commit}\` at ${iso(l3.directive.authoredTs)} (\`${l3.directive.site}\`)`,
  );
  lines.push(`- verdict: **${l3.verdict}**${l3.thinWindow ? " (thin window — < 200 turns in some before/after split)" : ""}`);
  lines.push(`- realizedMultiplier (+0h, bySpawnCohort): ${l3.realizedMultiplier.toFixed(3)}x`);
  lines.push(`  — spec's modelled table: 2/turn ⇒ 1.26x, 3/turn ⇒ 1.43x, 4/turn ⇒ 1.53x`);
  lines.push(`- ungrouped tool_calls (no turnId, no raw.message.id): ${fmt(l3.ungrouped)}`);
  lines.push(`- shadowShare (turns with a non-null parentToolUseId): ${pct(l3.shadowShare * 100)}`);
  lines.push("");
  for (const c of l3.cutoffs) {
    lines.push(`### Cutoff ${c.label} (${iso(c.ts)})`);
    lines.push("");
    lines.push(renderWindowTable("byEventTs split (naive, edge-polluted)", c.byEventTs.before, c.byEventTs.after));
    lines.push("");
    lines.push(renderWindowTable("bySpawnCohort split (honest — an agent keeps its spawn-time cohort)", c.bySpawnCohort.before, c.bySpawnCohort.after));
    lines.push("");
  }
  lines.push("### By role (whole retained log, not cutoff-split)");
  lines.push("");
  lines.push("| role | turns | toolCalls | mean | shareSingle | agents |");
  lines.push("|---|---|---|---|---|---|");
  for (const role of ["conductor", "worker-d0", "worker-dN"]) {
    const w = l3.byRole[role];
    lines.push(`| ${role} | ${fmt(w.turns)} | ${fmt(w.toolCalls)} | ${w.mean.toFixed(2)} | ${pct(w.shareSingle * 100)} | ${w.agents} |`);
  }
  return lines.join("\n");
}

function renderL4Scope(name, scope) {
  const lines = [];
  lines.push(`**${name}**`);
  lines.push("");
  lines.push(`- orchestrationSharePct: ${pct(scope.orchestrationSharePct)}`);
  lines.push(`- p50: ${fmt(scope.p50)} chars, p95: ${fmt(scope.p95)} chars, max: ${fmt(scope.max)} chars`);
  if (scope.truncatedCount > 0) {
    lines.push(`- ⚠ truncatedCount: **${scope.truncatedCount}** orchestration returns hit the ${fmt(TOOL_RESULT_MAX_CHARS)}-char cap — a full transcript was pasted and then cut`);
  } else {
    lines.push(`- truncatedCount: 0`);
  }
  if (scope.overBound.length) {
    lines.push(`- overBound (> bound): ${scope.overBound.length} returns`);
    for (const r of scope.overBound.slice(0, 10)) {
      lines.push(`  - ${r.agentId} · ${r.toolName} · ${fmt(r.chars)} chars`);
    }
    if (scope.overBound.length > 10) lines.push(`  - … and ${scope.overBound.length - 10} more`);
  } else {
    lines.push(`- overBound: none`);
  }
  return lines.join("\n");
}

function renderL4(l4) {
  const lines = [];
  lines.push("## L4 — orchestration hygiene");
  lines.push("");
  lines.push(`- bound: ${fmt(l4.boundChars)} chars`);
  lines.push(`- verdict: **${l4.verdict}**`);
  lines.push("");
  lines.push(renderL4Scope("conductors", l4.conductors));
  lines.push("");
  lines.push(renderL4Scope("allAgents", l4.allAgents));
  return lines.join("\n");
}

function renderSpend(spend) {
  const lines = [];
  lines.push("## Spend ledger");
  lines.push("");
  // Two units, two columns. The primary column is the SDK's own cost wherever the provider
  // reported one; modelledListUsd is the same claude spend priced from the 3-row list table, and
  // it is a DIFFERENT UNIT — printing only one of them is what let the ~3x gap go unnoticed.
  const cs = spend.claudeSpend ?? { sdkUsd: 0, sdkAgents: 0, modelledFallbackUsd: 0, modelledFallbackAgents: 0 };
  lines.push("| class | USD (primary — SDK `result.costUsd` where reported) | modelled list price |");
  lines.push("|---|---|---|");
  lines.push(`| claude | ${usd(spend.byProviderClass.claude)} | ${usd(spend.modelledListUsd)} |`);
  lines.push(`| codex | ${usd(spend.byProviderClass.codex)} | — (SDK-reported) |`);
  lines.push(`| generic | ${usd(spend.byProviderClass.generic)} | — (SDK-reported) |`);
  lines.push("");
  lines.push(
    `- claude primary = ${usd(cs.sdkUsd)} SDK-reported across ${fmt(cs.sdkAgents)} agents + ${usd(cs.modelledFallbackUsd)} list-price ` +
      `modelled across ${fmt(cs.modelledFallbackAgents)} agents that never emitted a \`result.costUsd\``,
  );
  lines.push(
    `- \`modelledListUsd\` prices **every** claude agent from the ${Object.keys(PRICES).length}-row list table — it is a second unit for ` +
      `comparison, not a correction of the primary column`,
  );
  if (cs.modelledOverSdkRatio !== null && cs.modelledOverSdkRatio !== undefined) {
    lines.push(
      `- on the ${fmt(cs.sdkAgents)} agents priced **both** ways the list-price model runs **${cs.modelledOverSdkRatio.toFixed(2)}x** the ` +
        `SDK's own cost (${usd(cs.modelledUsdForSdkAgents)} vs ${usd(cs.sdkUsd)}) — read the ${usd(cs.modelledFallbackUsd)} fallback against that`,
    );
  }
  lines.push("");
  lines.push(`- generic-backend share of spend: **${pct(spend.genericSharePct)}**`);
  lines.push("");
  lines.push("observedProviders (agent counts):");
  lines.push("");
  const provs = Object.entries(spend.observedProviders);
  if (provs.length) {
    lines.push("| provider | agents |");
    lines.push("|---|---|");
    for (const [p, n] of provs) lines.push(`| ${p} | ${n} |`);
  } else {
    lines.push("(none observed)");
  }
  if (spend.unmeasurable.length) {
    lines.push("");
    lines.push("unmeasurable (excluded from the denominator, not counted as $0):");
    for (const u of spend.unmeasurable) lines.push(`- ${u.provider}: ${u.agents} agents, ${u.turns} turns`);
  }
  if (spend.priceTableMisses.length) {
    lines.push("");
    lines.push(`priceTableMisses (claude spend is a floor for these models): ${spend.priceTableMisses.join(", ")}`);
  }
  if (spend.syntheticUsageEvents) {
    lines.push("");
    lines.push(
      `synthetic post-compaction usage events excluded from spend: ${fmt(spend.syntheticUsageEvents)} events, ` +
        `${fmt(spend.syntheticInputTokens)} input tokens`,
    );
  }
  return lines.join("\n");
}

function renderQ3(q3) {
  const lines = [];
  lines.push("## Q3 — tool_result bytes by originating tool");
  lines.push("");
  lines.push(
    "Dollar-weighted share is an **upper bound** — it assumes a result stays in context for every " +
      "subsequent call, ignoring compaction evicting it. A class with any truncated result is also a " +
      "**lower bound** on its true byte share, since `data.result` is capped at " +
      `${fmt(TOOL_RESULT_MAX_CHARS)} chars.`,
  );
  lines.push("");
  lines.push("| class | chars | results | volumePct | dollarUsd | dollarPct | truncatedCount | truncatedChars |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const [cls, row] of Object.entries(q3.byClass)) {
    lines.push(
      `| ${cls} | ${fmt(row.chars)} | ${fmt(row.results)} | ${pct(row.volumePct)} | ${usd(row.dollarUsd)} | ${pct(row.dollarPct)} | ${row.truncatedCount} | ${fmt(row.truncatedChars)} |`,
    );
  }
  lines.push("");
  lines.push(`- reachableDollarPct (chimera-served + foreign-via-chimera): **${pct(q3.reachableDollarPct)}**`);
  lines.push(`- unjoined (no retained tool_call): ${fmt(q3.unjoined.results)} results, ${fmt(q3.unjoined.chars)} chars`);
  // The exclusion is class-biased, not uniform, so it belongs beside the share it distorts.
  if (q3.unpriced?.results) {
    const byClass = Object.entries(q3.unpriced.byClass).map(([c, n]) => `${c} ${fmt(n)}`).join(", ");
    lines.push(
      `- unpriced-model results excluded from the dollar denominator (**biases reachableDollarPct**): ${fmt(q3.unpriced.results)} results, ${fmt(q3.unpriced.chars)} chars [${q3.unpriced.models.join(", ")}] — by class: ${byClass}`,
    );
  }
  if (q3.topTools.length) {
    lines.push("");
    lines.push("topTools:");
    lines.push("");
    lines.push("| toolName | chars | dollarUsd |");
    lines.push("|---|---|---|");
    for (const t of q3.topTools) lines.push(`| ${t.toolName} | ${fmt(t.chars)} | ${usd(t.dollarUsd)} |`);
  }
  return lines.join("\n");
}

function renderSurface(surface) {
  const lines = [];
  lines.push("## Tool-surface cache-write gate (feeds F41/F51)");
  lines.push("");
  lines.push(`- chimeraEstimateTokens: ${fmt(surface.chimeraEstimateTokens)}`);
  lines.push(`- medianFirstCacheWrite: ${fmt(surface.medianFirstCacheWrite)}`);
  lines.push(`- estimateVsRealPct: **${pct(surface.estimateVsRealPct)}**`);
  lines.push("");
  lines.push("byServerCount:");
  lines.push("");
  lines.push("| bucket | n | lowN | medianFirstCacheWrite |");
  lines.push("|---|---|---|---|");
  for (const b of surface.byServerCount) {
    lines.push(`| ${b.bucket} | ${b.n} | ${b.lowN} | ${fmt(b.medianFirstCacheWrite)} |`);
  }
  if (surface.perServerMarginal.length) {
    lines.push("");
    lines.push("perServerMarginal (observational contrast, not a controlled estimate — servers co-occur):");
    lines.push("");
    lines.push("| server | nWith | nWithout | medianDeltaTokens | lowN |");
    lines.push("|---|---|---|---|---|");
    for (const s of surface.perServerMarginal) {
      lines.push(`| ${s.server} | ${s.nWith} | ${s.nWithout} | ${fmt(s.medianDeltaTokens)} | ${s.lowN} |`);
    }
  }
  return lines.join("\n");
}

function renderBaseline(baseline, l3) {
  let now = { turns: 0, toolCalls: 0, single: 0 };
  for (const w of Object.values(l3.byRole)) {
    now.turns += w.turns;
    now.toolCalls += w.toolCalls;
    now.single += w.histogram["1"];
  }
  const nowMean = now.turns ? now.toolCalls / now.turns : 0;
  const nowShareSingle = now.turns ? now.single / now.turns : 0;
  const notRecomputed = "not recomputed by this audit — see token-audit.mjs";

  const lines = [];
  lines.push("## Baseline → now");
  lines.push("");
  lines.push(`(baseline: ${baseline.source})`);
  lines.push("");
  lines.push("| metric | baseline | now |");
  lines.push("|---|---|---|");
  lines.push(`| meanToolCallsPerTurn | ${baseline.meanToolCallsPerTurn.toFixed(2)} | ${nowMean.toFixed(2)} |`);
  lines.push(`| shareSingle | ${pct(baseline.shareSingle * 100)} | ${pct(nowShareSingle * 100)} |`);
  lines.push(`| toolCallingTurns | ${fmt(baseline.toolCallingTurns)} | ${fmt(now.turns)} |`);
  lines.push(`| amplification | ${baseline.amplification}x | ${notRecomputed} |`);
  lines.push(`| cacheHitRate | ${pct(baseline.cacheHitRate * 100)} | ${notRecomputed} |`);
  lines.push(`| fixedPrefixShare | ${pct(baseline.fixedPrefixShare * 100)} | ${notRecomputed} |`);
  return lines.join("\n");
}

function renderGates(gates, spend) {
  const cs = spend.claudeSpend ?? { sdkAgents: 0, modelledFallbackAgents: 0 };
  const modelledDenom = spend.modelledListUsd + spend.byProviderClass.codex + spend.byProviderClass.generic;
  const modelledShare = modelledDenom > 0 ? (spend.byProviderClass.generic / modelledDenom) * 100 : 0;
  const lines = [];
  lines.push("## Gate verdicts");
  lines.push("");
  // plan §6: a non-empty priceTableMisses makes the value a floor, and the verdict must say so
  // inline — a reader who only skims the gate line must not read it as an exact measurement.
  const floorNote = (g) => (g.floor ? " _(value is a **floor** — unpriced models excluded; see caveats)_" : "");
  lines.push(
    `- **gates.q4** (${gates.q4.question}, decides ${gates.q4.decides}): ${pct(gates.q4.value)} vs threshold ${gates.q4.threshold}% ⇒ **${gates.q4.verdict.toUpperCase()}**${floorNote(gates.q4)}`,
  );
  // QA finding 7: the reader of this one line must not have to dig into caveats[] to learn that
  // the ratio's numerator and denominator are not measured the same way.
  lines.push(
    `  - unit note: the denominator is SDK \`result.costUsd\` for codex/generic and for ${fmt(cs.sdkAgents)} claude agents, ` +
      `list-price modelled for ${fmt(cs.modelledFallbackAgents)} claude agents with no result row. Priced entirely from the list ` +
      `table instead, claude would be ${usd(spend.modelledListUsd)} and this share would read ${pct(modelledShare)}.`,
  );
  lines.push(
    `- **gates.q3** (${gates.q3.question}, decides ${gates.q3.decides}): ${pct(gates.q3.value)} vs threshold ${gates.q3.threshold}% ⇒ **${gates.q3.verdict.toUpperCase()}**${floorNote(gates.q3)}`,
  );
  return lines.join("\n");
}

function renderMarkdown(o) {
  const sections = [];
  sections.push(`# Measurement audit — ${DATE}`);
  sections.push("");
  sections.push(`generatedAt: ${o.generatedAt}`);
  sections.push("");
  sections.push("## Run window");
  sections.push("");
  sections.push(`- events home: \`${o.eventsHome}\``);
  sections.push(`- segments: ${fmt(o.window.segments)}, events: ${fmt(o.window.events)}, agents: ${fmt(o.window.agents)}`);
  sections.push(`- first event: ${iso(o.window.firstTs)}, last event: ${iso(o.window.lastTs)}`);
  sections.push("");
  sections.push(renderBaseline(o.baseline, o.l3));
  sections.push("");
  sections.push(renderL3(o.l3));
  sections.push("");
  sections.push(renderL4(o.l4));
  sections.push("");
  sections.push(renderSpend(o.spend));
  sections.push("");
  sections.push(renderQ3(o.q3));
  sections.push("");
  sections.push(renderSurface(o.surface));
  sections.push("");
  sections.push(renderGates(o.gates, o.spend));
  sections.push("");
  sections.push("## Caveats");
  sections.push("");
  if (o.caveats.length) {
    for (const c of o.caveats) sections.push(`- ${c}`);
  } else {
    sections.push("(none)");
  }
  sections.push("");
  return sections.join("\n");
}
