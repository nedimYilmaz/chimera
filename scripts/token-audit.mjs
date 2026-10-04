#!/usr/bin/env node
// TOKEN-AUDIT — where an engine's input tokens actually go.
//
// Written because the obvious answers were all wrong. Prompt caching looked like the lever and is
// already at 98% hit rate; per-agent spawn overhead looked like the orchestration tax and is 0.3%
// of first calls (but ~39% once you count that the fixed prefix is re-read on EVERY call); deep
// fan-out looked like the cost centre and is 2.7%. None of that is guessable — it is only
// measurable, and this is the instrument.
//
// It is checked in so a change can be argued about with numbers: run it, change one thing, run it
// again. A claimed improvement that this cannot show is not an improvement.
//
//   node scripts/token-audit.mjs [--home ~/.chimera] [--agent <id>] [--json]

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const HOME = flag("home", join(homedir(), ".chimera"));
const ONLY = flag("agent", null);
const AS_JSON = args.includes("--json");

// List prices per Mtok. Cache reads bill at 10% of input and cache writes at 1.25x (5m TTL), which
// is the whole reason read VOLUME dominates the bill while output barely registers.
const PRICES = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
};
const READ_RATE = 0.1;
const WRITE_RATE = 1.25;

function* events() {
  const dir = join(HOME, "events");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    let text;
    try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* a partial tail line is not a failure */ }
    }
  }
}

const M = (n) => `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
const K = (n) => `${Math.round(n / 1000)}k`;

const meta = new Map();          // agentId -> what it was spawned with
const perAgent = new Map();      // agentId -> token counters
const perModel = new Map();
const content = new Map();       // event kind -> characters that ever entered a context
const callCtx = [];              // every call's context size, for the cap counterfactual
const callsRaw = [];             // {aid, ctx} per call — paired with its agent's prefix after the pass
const bump = (map, key, field, n) => {
  let row = map.get(key);
  if (!row) { row = {}; map.set(key, row); }
  row[field] = (row[field] ?? 0) + n;
};

for (const e of events()) {
  const aid = e.agentId;
  if (ONLY && aid !== ONLY && e.kind === "usage") continue;

  if (e.kind === "agent_started" && !meta.has(aid)) {
    const d = e.data ?? {};
    meta.set(aid, {
      conductor: !!d.conductor, depth: d.depth ?? null, provider: d.provider ?? "?",
      model: typeof d.model === "string" ? d.model : null,
      mcpServers: Array.isArray(d.mcpServers) ? d.mcpServers.length : null,
      skills: Array.isArray(d.skills) ? d.skills.length : null,
      slashCommands: Array.isArray(d.slashCommands) ? d.slashCommands.length : null,
      contextLimit: d.effectiveContextLimit ?? null,
    });
  }

  // What ORIGINAL material ever entered a context. The ratio of this to input read below is the
  // amplification factor, and it is the number the whole problem reduces to.
  if (e.kind === "tool_result") bump(content, "tool_result", "chars", String(e.data?.result ?? "").length);
  else if (e.kind === "tool_call") bump(content, "tool_call", "chars", JSON.stringify(e.data?.input ?? {}).length);
  else if (e.kind === "message_complete") bump(content, "assistant_text", "chars", String(e.data?.text ?? "").length);

  if (e.kind !== "usage") continue;
  const u = e.data?.usage;
  if (!u) continue;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const fresh = u.input_tokens ?? 0;
  const ctx = read + write + fresh;
  if (ctx <= 0) continue;

  for (const [f, v] of [["read", read], ["write", write], ["fresh", fresh], ["output", u.output_tokens ?? 0], ["calls", 1]]) {
    bump(perAgent, aid, f, v);
  }
  const row = perAgent.get(aid);
  // MIN over calls, not the FIRST retained call. The log is pruned, so for exactly the long-lived
  // agents that dominate the total, the real session start is gone and the earliest surviving call
  // is already deep into a grown conversation — which would record a 150k "prefix" and then
  // multiply that error by every one of that agent's calls.
  //
  // Min is a strictly tighter bound: context only shrinks at a compaction, and a post-compaction
  // context is prefix + summary, so min sits at or above the true prefix and at or below the
  // first retained call.
  row.minCtx = row.minCtx === undefined ? ctx : Math.min(row.minCtx, ctx);
  row.ctxSum = (row.ctxSum ?? 0) + ctx;
  callCtx.push(ctx);
  callsRaw.push({ aid, ctx });

  // The raw stream event carries a model on message_start only; every other usage-bearing event
  // has none. Falling back to what the agent was SPAWNED with turns "49% unattributed" into a real
  // denominator, which is what a cost decision needs.
  const model = e.raw?.event?.message?.model ?? meta.get(aid)?.model ?? "unattributed";
  for (const [f, v] of [["read", read], ["write", write], ["fresh", fresh], ["output", u.output_tokens ?? 0], ["calls", 1]]) {
    bump(perModel, model, f, v);
  }
}

const agents = [...perAgent.entries()];
const sum = (f) => agents.reduce((n, [, r]) => n + (r[f] ?? 0), 0);
const totalInput = sum("read") + sum("write") + sum("fresh");
const totalCalls = sum("calls");
// Every call re-reads the fixed prefix, so its true share is prefix x calls — not prefix x agents.
const fixedShare = agents.reduce((n, [, r]) => n + (r.minCtx ?? 0) * (r.calls ?? 0), 0);
const contentChars = [...content.values()].reduce((n, r) => n + r.chars, 0);
const contentTokens = contentChars / 4;

const dollars = (row, model) => {
  const p = PRICES[model];
  if (!p) return null;
  return (row.read ?? 0) / 1e6 * p.input * READ_RATE
    + (row.write ?? 0) / 1e6 * p.input * WRITE_RATE
    + (row.fresh ?? 0) / 1e6 * p.input
    + (row.output ?? 0) / 1e6 * p.output;
};

const roles = new Map();
for (const [aid, r] of agents) {
  const m = meta.get(aid);
  const key = !m ? "unknown" : m.conductor ? "conductor" : `worker d${m.depth}`;
  bump(roles, key, "input", (r.read ?? 0) + (r.write ?? 0) + (r.fresh ?? 0));
  bump(roles, key, "agents", 1);
}

const report = {
  agents: agents.length,
  calls: totalCalls,
  inputTokens: totalInput,
  outputTokens: sum("output"),
  cacheHitRate: sum("read") / Math.max(totalInput, 1),
  fixedPrefixShare: fixedShare / Math.max(totalInput, 1),
  medianFirstCallCtx: agents.map(([, r]) => r.minCtx ?? 0).sort((a, b) => a - b)[Math.floor(agents.length / 2)] ?? 0,
  originalContentTokens: contentTokens,
  amplification: totalInput / Math.max(contentTokens, 1),
};

if (AS_JSON) {
  console.log(JSON.stringify({ ...report, roles: Object.fromEntries(roles), models: Object.fromEntries(perModel) }, null, 2));
  process.exit(0);
}

console.log(`agents ${report.agents} · model calls ${report.calls}\n`);
console.log("INPUT COMPOSITION");
console.log(`  cache read   ${M(sum("read")).padStart(9)}  ${(100 * report.cacheHitRate).toFixed(1)}%`);
console.log(`  cache write  ${M(sum("write")).padStart(9)}`);
console.log(`  fresh        ${M(sum("fresh")).padStart(9)}`);
console.log(`  output       ${M(sum("output")).padStart(9)}`);

console.log("\nTHE TWO NUMBERS THAT MATTER");
console.log(`  original content that ever entered a context : ${M(contentTokens)} tokens`);
console.log(`  input tokens actually read                   : ${M(totalInput)} tokens`);
console.log(`  AMPLIFICATION                                : ${report.amplification.toFixed(0)}x`);
console.log(`  fixed prefix (median ${K(report.medianFirstCallCtx)}), re-read every call: ${(100 * report.fixedPrefixShare).toFixed(1)}% of all input`);

console.log("\nBY ROLE");
for (const [role, r] of [...roles].sort((a, b) => b[1].input - a[1].input)) {
  console.log(`  ${role.padEnd(14)} ${M(r.input).padStart(9)}  ${(100 * r.input / totalInput).toFixed(1)}%  over ${r.agents} agents`);
}

console.log("\nBY MODEL (list prices; unattributed calls carry no model in the raw payload)");
let billed = 0;
for (const [model, r] of [...perModel].sort((a, b) => (b[1].read ?? 0) - (a[1].read ?? 0))) {
  const d = dollars(r, model);
  if (d !== null) billed += d;
  console.log(`  ${model.padEnd(20)} ${String(r.calls).padStart(6)} calls  ${M(r.read).padStart(9)} read  ${d === null ? "     n/a" : `$${d.toFixed(0)}`.padStart(8)}`);
}
console.log(`  attributed spend: $${billed.toFixed(0)}`);

console.log("\nCOUNTERFACTUAL — the same run with context held under a cap");
console.log("  (a ceiling, not a forecast: it ignores the extra compactions a cap would cause)");
for (const cap of [50_000, 100_000, 200_000]) {
  // Per CALL, not per agent average: an agent that ramps to 900k spends most of its calls far
  // above its own mean, and capping the mean would quietly understate what a cap actually saves.
  const capped = callCtx.reduce((n, c) => n + Math.min(c, cap), 0);
  console.log(`  cap ${K(cap).padStart(5)}: ${M(capped).padStart(9)}  (${(100 * capped / totalInput).toFixed(0)}% of actual, ${(totalInput / Math.max(capped, 1)).toFixed(1)}x less)`);
}

// The counterfactual above caps TOTAL context, which is not something you can configure: the fixed
// prefix is inside every call and cannot be compacted away. With a 54k prefix a "50k cap" is not
// merely optimistic, it is unreachable. This models the two levers as they actually compose —
// shrink the prefix, and cap the CONVERSATION that rides on top of it.
console.log("\nCOMBINED — a smaller fixed prefix AND a conversation cap (the reachable version)");
console.log(`  ${"prefix".padStart(8)} ${"conv cap".padStart(9)} ${"total".padStart(10)} ${"vs actual".padStart(10)}`);
for (const prefix of [54_000, 25_000, 15_000]) {
  for (const conv of [100_000, 50_000, 25_000]) {
    // Per call: the new prefix, plus this call's conversation capped. The agent's OWN measured
    // prefix is subtracted first, so this is the conversation that actually rode on top of it.
    let modelled = 0;
    for (const c of callsRaw) {
      const conversation = Math.max(0, c.ctx - (perAgent.get(c.aid)?.minCtx ?? 0));
      modelled += prefix + Math.min(conversation, conv);
    }
    const x = totalInput / Math.max(modelled, 1);
    console.log(`  ${K(prefix).padStart(8)} ${K(conv).padStart(9)} ${M(modelled).padStart(10)} ${(x.toFixed(1) + "x").padStart(10)}`);
  }
}

const surfaced = [...meta.values()].filter((m) => m.mcpServers !== null);
if (surfaced.length) {
  const med = (f, rows) => rows.map((m) => m[f] ?? 0).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;
  console.log("\nWHAT THE FIXED PREFIX IS MADE OF (median, at spawn)");
  for (const [label, rows] of [["conductor", surfaced.filter((m) => m.conductor)], ["worker", surfaced.filter((m) => !m.conductor)]]) {
    if (!rows.length) continue;
    console.log(`  ${label.padEnd(10)} mcpServers ${String(med("mcpServers", rows)).padStart(3)}  skills ${String(med("skills", rows)).padStart(4)}  slashCommands ${String(med("slashCommands", rows)).padStart(4)}  ctxLimit ${K(med("contextLimit", rows))}`);
  }
}
