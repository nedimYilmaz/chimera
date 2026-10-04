#!/usr/bin/env node
// PROMPT-ACK-LATENCY (F09 Task 0) — measures the real idle-agent send→turn-start latency
// distribution from the retained event log, BEFORE any stall threshold exists (plan §2.1). No
// runtime change: this only reads events.*.jsonl and is not imported by packages/*/src. The
// `recommended` block below is computed by prompt-ack-lib.mjs's coverage-threshold policy (F09
// QA item 1) — packages/core/src/prompt-ack.ts's two constants are copied from the committed JSON
// sidecar's `recommended` block by hand, with a comment citing this artifact's path, n and
// percentiles; they are not independently re-derived.
//
//   node scripts/prompt-ack-latency.mjs [--events <dir>] [--out <dir>] [--date YYYY-MM-DD]
//
// Streams each segment line-by-line (node:readline over a read stream) — a segment is never
// loaded into memory whole, so this stays cheap against a multi-hundred-MB retained log.

import { createReadStream, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { recommend } from "./prompt-ack-lib.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_EVENTS_DIR = join(homedir(), ".chimera", "events");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "docs/superpowers/measurements");

// F09/J4-adjacent: the same membership as turn-kinds.ts (Task 1). Duplicated here on purpose —
// this script has zero dependency on packages/*/src (plan §2.1 OUT: "no runtime dependency on a
// doc" cuts both ways, core must not depend on this script and this script must not depend on
// core's not-yet-existing turn-kinds module).
const TURN_OPENING_KINDS = new Set([
  "message_delta", "message_complete", "tool_call", "tool_result",
  "permission_request", "agent_question", "agent_dialog", "agent_task",
]);
const TURN_CLOSING_KINDS = new Set(["turn_complete", "result", "error", "agent_started"]);
// Stream kinds = the union above plus these four (plan §2.1 method).
const STREAM_KINDS = new Set([
  ...TURN_OPENING_KINDS,
  ...TURN_CLOSING_KINDS,
  "compaction", "turn_timeout", "failover", "commands_changed",
]);

const COVERAGE_THRESHOLDS_MS = [3000, 5000, 10000, 20000, 30000, 45000, 90000];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`prompt-ack-latency — F09 idle send-to-turn-start latency measurement

Usage: node scripts/prompt-ack-latency.mjs [options]

  --events <dir>      events segment directory, default ${DEFAULT_EVENTS_DIR}
                       (the directory that directly contains the .jsonl segments)
  --out <dir>          output directory, default docs/superpowers/measurements
  --date <YYYY-MM-DD>  artifact date stamp, default today (local). Re-running the same date
                        overwrites both artifacts (idempotent, never appends).
  --stdout             print the JSON sidecar to stdout instead of writing the two artifact files
  --help               show this message

Exits non-zero if --events has no .jsonl segments.`);
  process.exit(0);
}

const EVENTS_DIR = resolve(flag("events", DEFAULT_EVENTS_DIR));
const OUT_DIR = resolve(flag("out", DEFAULT_OUT_DIR));
const DATE = flag("date", todayLocal());
const TO_STDOUT = args.includes("--stdout");

function todayLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Segments are named events.<startSeq>-<endSeq>.jsonl — sort numerically by startSeq so seq
// order holds even once digit widths diverge (alphabetic sort would not).
function listSegmentsInSeqOrder(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const files = entries.filter((f) => f.endsWith(".jsonl"));
  files.sort((a, b) => {
    const na = Number(a.match(/(\d+)/)?.[1] ?? NaN);
    const nb = Number(b.match(/(\d+)/)?.[1] ?? NaN);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  return files;
}

async function* streamEvents(dir, files) {
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(dir, f), "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // a partial tail line (mid-write segment) is not a failure
      }
    }
  }
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const coverage = {};
  for (const t of COVERAGE_THRESHOLDS_MS) {
    coverage[String(t)] = sorted.length === 0 ? 0 : sorted.filter((v) => v <= t).length / sorted.length;
  }
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    coverage,
  };
}

// The core measurement pass (plan §2.1 method). Pure: takes an async/sync iterable of parsed
// events, returns the report — testable without touching disk.
async function analyze(events) {
  const lastStreamKind = new Map(); // agentId -> kind
  // agentId -> array of { ts, classification } pending resolution by the agent's next stream event
  const pending = new Map();

  const idleLatencies = [];
  const midTurnLatencies = [];
  const noPriorLatencies = [];
  let orphanFromIdle = 0;
  let orphanFromMidTurn = 0;
  let orphanFromNoPrior = 0;

  let firstTs = null;
  let lastTs = null;
  let eventCount = 0;
  const agents = new Set();

  for await (const e of events) {
    if (!e || typeof e.ts !== "number" || typeof e.kind !== "string" || typeof e.agentId !== "string") continue;
    eventCount++;
    if (firstTs === null || e.ts < firstTs) firstTs = e.ts;
    if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
    agents.add(e.agentId);

    if (e.kind === "status" && e.data?.delivered === true) {
      const prevKind = lastStreamKind.get(e.agentId);
      const classification = prevKind === undefined
        ? "noPrior"
        : TURN_CLOSING_KINDS.has(prevKind)
          ? "idle"
          : "midTurn";
      const list = pending.get(e.agentId) ?? [];
      list.push({ ts: e.ts, classification });
      pending.set(e.agentId, list);
      continue;
    }

    if (STREAM_KINDS.has(e.kind)) {
      const list = pending.get(e.agentId);
      if (list && list.length) {
        for (const p of list) {
          const latency = e.ts - p.ts;
          if (p.classification === "idle") idleLatencies.push(latency);
          else if (p.classification === "midTurn") midTurnLatencies.push(latency);
          else noPriorLatencies.push(latency);
        }
        pending.set(e.agentId, []);
      }
      lastStreamKind.set(e.agentId, e.kind);
    }
  }

  // Whatever is left pending at end-of-stream never saw a following stream event: orphans.
  for (const list of pending.values()) {
    for (const p of list) {
      if (p.classification === "idle") orphanFromIdle++;
      else if (p.classification === "midTurn") orphanFromMidTurn++;
      else orphanFromNoPrior++;
    }
  }

  return {
    window: {
      firstTs: firstTs ?? 0,
      lastTs: lastTs ?? 0,
      events: eventCount,
      agents: agents.size,
    },
    idle: summarize(idleLatencies),
    midTurn: summarize(midTurnLatencies),
    noPrior: summarize(noPriorLatencies),
    orphans: {
      total: orphanFromIdle + orphanFromMidTurn + orphanFromNoPrior,
      fromIdle: orphanFromIdle,
      fromMidTurn: orphanFromMidTurn,
    },
  };
}

function iso(ts) {
  return typeof ts === "number" && ts > 0 ? new Date(ts).toISOString() : "n/a";
}
function fmt(n) {
  return (n ?? 0).toLocaleString("en-US");
}
function pct(n) {
  return `${((n ?? 0) * 100).toFixed(2)}%`;
}

function renderPopulationTable(rows) {
  const lines = [];
  lines.push("| population | n | p50 | p90 | p95 | p99 | max |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [label, s] of rows) {
    lines.push(`| ${label} | ${fmt(s.n)} | ${fmt(s.p50)} ms | ${fmt(s.p90)} ms | ${fmt(s.p95)} ms | ${fmt(s.p99)} ms | ${fmt(s.max)} ms |`);
  }
  return lines.join("\n");
}

function renderCoverageTable(idle) {
  const lines = [];
  lines.push("| threshold | covered | would false-alarm on |");
  lines.push("|---|---|---|");
  for (const t of COVERAGE_THRESHOLDS_MS) {
    const cov = idle.coverage[String(t)] ?? 0;
    const falseCount = idle.n - Math.round(cov * idle.n);
    lines.push(`| ${fmt(t / 1000)} s | ${pct(cov)} | ${falseCount} / ${fmt(idle.n)} = ${pct(idle.n === 0 ? 0 : falseCount / idle.n)} |`);
  }
  return lines.join("\n");
}

function renderMarkdown(report, recommended, opts) {
  const { idle, midTurn, noPrior, orphans, window: win } = report;
  const lines = [];
  lines.push(`# F09 prompt-ack latency measurement — ${opts.date}`);
  lines.push("");
  lines.push(
    "Idle-agent send→turn-start latency, measured from the retained event log per plan " +
      "`docs/superpowers/research/harness-2026-09/plans/F09-prompt-effect-verification.md` §2.1, " +
      "before any stall threshold exists.",
  );
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "Stream `events.*.jsonl` in seq order. For each agent keep the last *stream* event kind. On a " +
      "`status` event with `data.delivered === true`, classify the delivery by that kind: " +
      "`turn_complete`/`result`/`error`/`agent_started` ⇒ **between-turns idle**; a turn-opening kind " +
      "⇒ **mid-turn**; no prior stream event for the agent ⇒ **no prior stream event**. Latency is " +
      "`ts(next stream event for that agent) − ts(delivered event)`. A delivery with no following " +
      "stream event is an **orphan**. Stream kinds = the union of TURN_OPENING_KINDS and " +
      "TURN_CLOSING_KINDS plus `compaction`, `turn_timeout`, `failover`, `commands_changed`.",
  );
  lines.push("");
  lines.push("## Run window");
  lines.push("");
  lines.push(`- events dir: \`${opts.eventsDir}\``);
  lines.push(`- segments: ${fmt(opts.segments)}, events: ${fmt(win.events)}, agents: ${fmt(win.agents)}`);
  lines.push(`- window ts: ${fmt(win.firstTs)} → ${fmt(win.lastTs)} (${iso(win.firstTs)} → ${iso(win.lastTs)})`);
  lines.push("");
  lines.push("## Populations");
  lines.push("");
  lines.push(renderPopulationTable([
    ["**between-turns idle** (prev = closing kind)", idle],
    ["mid-turn (prev = a turn-opening kind)", midTurn],
    ["no prior stream event", noPrior],
  ]));
  lines.push("");
  lines.push("## Idle-population threshold coverage");
  lines.push("");
  lines.push(renderCoverageTable(idle));
  lines.push("");
  lines.push("## Orphans");
  lines.push("");
  lines.push(
    `- total: **${fmt(orphans.total)}** deliveries never saw a following stream event at all ` +
      `(${fmt(orphans.fromIdle)} from a between-turns idle state, ${fmt(orphans.fromMidTurn)} from mid-turn).`,
  );
  lines.push("");
  lines.push("## Recommended constants");
  lines.push("");
  lines.push(
    `- \`PROMPT_STALL_MS = ${fmt(recommended.promptStallMs)}\` — false-signal rate ` +
      `${pct(recommended.falseSignalRateAtStall)} on the idle population above.`,
  );
  lines.push(`- \`PROMPT_ACK_WAIT_MS = ${fmt(recommended.promptAckWaitMs)}\``);
  lines.push("");
  lines.push("Reproduce with:");
  lines.push("");
  lines.push(`\`\`\`\nnode scripts/prompt-ack-latency.mjs --date ${opts.date}\n\`\`\``);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const files = listSegmentsInSeqOrder(EVENTS_DIR);
  if (files === null) {
    console.error(`prompt-ack-latency: events directory not found: ${EVENTS_DIR}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`prompt-ack-latency: no .jsonl segments under ${EVENTS_DIR}`);
    process.exit(1);
  }

  const report = await analyze(streamEvents(EVENTS_DIR, files));
  const recommended = recommend(report.idle);

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    eventsHome: EVENTS_DIR,
    window: {
      firstTs: report.window.firstTs,
      lastTs: report.window.lastTs,
      segments: files.length,
      events: report.window.events,
    },
    idle: report.idle,
    midTurn: report.midTurn,
    orphans: report.orphans,
    recommended,
  };

  const markdown = renderMarkdown(report, recommended, { date: DATE, eventsDir: EVENTS_DIR, segments: files.length });

  if (TO_STDOUT) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = join(OUT_DIR, `${DATE}-prompt-ack-latency.md`);
  const jsonPath = join(OUT_DIR, `${DATE}-prompt-ack-latency.json`);
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`prompt-ack-latency: wrote ${mdPath}`);
  console.log(`prompt-ack-latency: wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
