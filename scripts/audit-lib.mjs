// AUDIT-LIB — pure, side-effect-free (except readEvents' disk read) event-log reader shared by
// scripts/measurement-audit.mjs (F45) and F39's compaction-cost extension. No top-level I/O: every
// exported function except readEvents takes data in and returns data out, so it is testable with a
// synthetic in-memory event array and requires no tmpdir (plan §3).
//
// scripts/token-audit.mjs is the checked-in baseline instrument for the 2026-08-31 spec and is
// deliberately NOT modified or imported here — its numbers must stay byte-reproducible. The segment
// iterator below is lifted verbatim from token-audit.mjs:37-48.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

// packages/core/src/supervisor.ts:135 (buildCapabilityBlock) — the batching directive sentence.
// Commit 1e7412d4, authored 2026-09-01T01:06:19+03:00.
export const DIRECTIVE_TS = 1788213979000;

// packages/core/src/backends/tool-result.ts:11 — data.result is bounded at this many chars.
export const TOOL_RESULT_MAX_CHARS = 16_000;

export const Q3_THRESHOLD = 20; // gate: dollar-weighted chimera-reachable tool_result bytes, %
export const Q4_THRESHOLD = 15; // gate: generic-backend share of spend, %
export const L4_BOUND_CHARS = 8_000; // half the truncation cap, per plan §2.5

// packages/core/src/providers/registry.ts:110,116,127 register dedicated backends; every other
// provider id drives the kind-level openai-compat factory (:142) — "generic" by construction.
export const DEDICATED_PROVIDERS = new Set(["claude", "codex", "kimi"]);

// List prices per Mtok — lifted from scripts/token-audit.mjs:29-35 (same source, kept in sync by
// hand since token-audit.mjs is not imported).
export const PRICES = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
};
export const READ_RATE = 0.1;
export const WRITE_RATE = 1.25;

// A model id can carry a context-window beta suffix — `claude-opus-5[1m]` is the SAME model as
// `claude-opus-5` on the 1M-context beta, and agent_started.data.model keeps the suffix while
// usage.raw.event.message.model usually drops it. Without this, the two code paths that price a
// model (the spend ledger, which joins from raw.event, and Q3, which joins from agent_started)
// disagree and the Q3 side silently weights 32 opus conductors at $0 — which flipped the F40 gate.
// Pricing the suffixed id at the base rate makes it a FLOOR: the >200k long-context premium is not
// modelled, so a 1M-beta turn is billed at least this much and possibly more.
export function normalizeModel(model) {
  if (typeof model !== "string") return null;
  const i = model.indexOf("[");
  return i > 0 ? model.slice(0, i) : model;
}

// The single pricing entry point — both dollarsFor (spend ledger) and the Q3 dollar weighting
// go through it so they can never drift on normalization again. `misses` (a Set, optional) collects
// unpriced model ids so the caller can report them instead of silently charging $0.
export function priceFor(model, misses) {
  const id = normalizeModel(model);
  const price = id ? PRICES[id] : undefined;
  if (!price && id && misses) misses.add(id);
  return price;
}

// The 2026-08-31 spec's own numbers, hardcoded here for the baseline->now diff table (plan §2.6).
export const BASELINE = {
  source: "docs/superpowers/specs/2026-08-31-orchestration-token-efficiency.md",
  meanToolCallsPerTurn: 1.14,
  shareSingle: 0.897,
  toolCallingTurns: 23149,
  amplification: 466,
  cacheHitRate: 0.981,
  fixedPrefixShare: 0.312,
};

const CUTOFFS = [
  { label: "+0h", hours: 0 },
  { label: "+6h", hours: 6 },
  { label: "+24h", hours: 24 },
];

// l3.verdict thresholds (plan §2.2) — named/commented per the risk table's own instruction.
const L3_WORKED_RISE = 0.10; // spawn-cohort mean must rise >= 10% at ALL cutoffs to call it "worked"
const L3_NOEFFECT_MOVE = 0.03; // must move < 3% at ALL cutoffs to call it "no-effect"
const L3_MIN_TURNS = 200; // either window below this makes any verdict "inconclusive"

const ORCHESTRATION_TOOL_RE =
  /^mcp__chimera__(agent_result|agent_wait|agent_status|agent_tail|ask_agent|ask_team|my_team|queue_[a-z_]+)$/;

// ---------------------------------------------------------------------------------------------
// Segment iterator (disk-facing; everything downstream of this takes a plain iterable)
// ---------------------------------------------------------------------------------------------

export function* readEvents(home) {
  const dir = join(home, "events");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* a partial tail line is not a failure */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

// turnKey — tool calls sharing a key were emitted in one assistant message (one context read).
// data.turnId does not exist before commit d255113d (2026-08-31); raw.message.id is the fallback
// that is mandatory, not defensive — without it the L3 before-window is empty (plan §2.1 fact 1).
export function turnKey(e) {
  const t = e?.data?.turnId;
  if (typeof t === "string" && t.length > 0) return t;
  const id = e?.raw?.message?.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

// classifyTool — mechanical name rule (plan §2.4). agentTools (a Set of that agent's retained
// raw.tools names, when present) is accepted as the documented per-agent authority; the rule
// itself is name-based either way, so a present-vs-absent agentTools set yields the same result
// for a well-formed name (A8's two code paths agree).
export function classifyTool(toolName, _agentTools) {
  if (typeof toolName !== "string" || toolName.length === 0) return "unjoined";
  if (!toolName.startsWith("mcp__")) return "sdk-native";
  if (toolName === "mcp__chimera__mcp_store_call") return "foreign-via-chimera";
  if (toolName.startsWith("mcp__chimera__")) return "chimera-served";
  return "foreign-direct";
}

// Every metric below is written twice-over as an ACCUMULATOR (`{add(e), finish()}`) with a thin
// array-taking wrapper around it. The accumulator is what buildReport's two streaming passes feed,
// so no pass ever holds the event array (plan §6: "streaming line-by-line, two passes, and only a
// toolUseId -> toolName map plus per-agent counters held in memory"). The wrappers exist because
// plan §2.6 names indexAgents/perAgentCallTimes/buildSpendLedger as F39/F41 handoff primitives —
// their signatures must not change. There is exactly ONE implementation of each metric, so the
// array path and the streaming path cannot drift.

// indexAgents — one row per agentId from its (first-seen) agent_started event.
function agentIndexAcc() {
  const agents = new Map();
  return {
    add(e) {
      if (e?.kind !== "agent_started" || agents.has(e.agentId)) return;
      const d = e.data ?? {};
      const raw = e.raw ?? {};
      agents.set(e.agentId, {
        agentId: e.agentId,
        ts: e.ts,
        provider: typeof d.provider === "string" ? d.provider : "?",
        conductor: !!d.conductor,
        depth: typeof d.depth === "number" ? d.depth : null,
        treeId: d.treeId ?? null,
        model: typeof d.model === "string" ? d.model : null,
        mcpServers: Array.isArray(d.mcpServers) ? d.mcpServers : [],
        skills: Array.isArray(d.skills) ? d.skills : [],
        slashCommands: Array.isArray(d.slashCommands) ? d.slashCommands : [],
        effectiveContextLimit: d.effectiveContextLimit ?? null,
        tools: Array.isArray(raw.tools) ? new Set(raw.tools) : null,
        cliVersion: typeof raw.claude_code_version === "string" ? raw.claude_code_version : null,
      });
    },
    finish: () => agents,
  };
}

export function indexAgents(events) {
  const acc = agentIndexAcc();
  for (const e of events) acc.add(e);
  return acc.finish();
}

function roleOf(agent) {
  if (!agent) return "unknown";
  if (agent.conductor) return "conductor";
  return agent.depth === 0 ? "worker-d0" : "worker-dN";
}

// usageOf — normalize a single usage-bearing event's token fields. All three usage-bearing kinds
// (`usage`, `turn_complete`, `result`) put the SDK's usage object at the same path, so one read
// covers every provider; the field NAMES are the Anthropic ones and codex/generic already emit
// them under those names. Shared primitive named in plan §2.6 for F39 to build on.
export function usageOf(e) {
  const u = e?.data?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    read: u.cache_read_input_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    fresh: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

// perAgentCallTimes — sorted ts array of CONTEXT READS per agent (one entry per model turn, not
// per usage event). Shared primitive named in plan §2.6; also used for Q3's dollar-weighting
// lookback, where "a result is paid for once per subsequent context read" only holds if a turn
// contributes one entry. claude double-emits `usage` (message_start opens the turn, message_delta
// re-emits the same read/write/fresh with output ticking up — claude.ts:1012-1021), so counting
// both would double every dollar figure. A raw-less usage event (the post-compaction reset at
// claude.ts:867, or a synthetic test event) is its own turn, matching the spend ledger's rule.
function callTimesAcc() {
  const byAgent = new Map();
  return {
    add(e) {
      if (e?.kind === "usage" && e?.raw?.event?.type === "message_delta") return;
      if (e?.kind === "usage" || e?.kind === "turn_complete" || e?.kind === "result") {
        if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
        byAgent.get(e.agentId).push(e.ts);
      }
    },
    finish() {
      for (const arr of byAgent.values()) arr.sort((a, b) => a - b);
      return byAgent;
    },
  };
}

export function perAgentCallTimes(events) {
  const acc = callTimesAcc();
  for (const e of events) acc.add(e);
  return acc.finish();
}

function countAfter(sortedTs, ts) {
  let lo = 0;
  let hi = sortedTs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTs[mid] <= ts) lo = mid + 1;
    else hi = mid;
  }
  return sortedTs.length - lo;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------------------------
// L3 — batching directive
// ---------------------------------------------------------------------------------------------

function l3Acc(agents, directiveTs) {
  let ungrouped = 0;
  // `${agentId}\u0000${key}` -> {agentId, ts, count, hasParent}. NUL is the separator because it
  // is the one byte an agentId or a turn/message id can never contain.
  const turns = new Map();
  return {
    add(e) {
      if (e?.kind !== "tool_call") return;
      const key = turnKey(e);
      if (key === null) {
        ungrouped++;
        return;
      }
      const gkey = `${e.agentId}\u0000${key}`;
      let t = turns.get(gkey);
      if (!t) {
        t = { agentId: e.agentId, ts: e.ts, count: 0, hasParent: false };
        turns.set(gkey, t);
      }
      t.count++;
      if (e.ts < t.ts) t.ts = e.ts;
      if (e.data?.parentToolUseId) t.hasParent = true;
    },
    finish: () => finishL3([...turns.values()], ungrouped, agents, directiveTs),
  };
}

function finishL3(allTurns, ungrouped, agents, directiveTs) {

  function summarize(turnList) {
    const histogram = { "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0 };
    let toolCalls = 0;
    let shadow = 0;
    const agentSet = new Set();
    for (const t of turnList) {
      const bucket = t.count >= 5 ? "5+" : String(t.count);
      histogram[bucket]++;
      toolCalls += t.count;
      agentSet.add(t.agentId);
      if (t.hasParent) shadow++;
    }
    const models = {};
    const cliVersions = {};
    for (const aid of agentSet) {
      const a = agents.get(aid);
      const m = a?.model ?? "unattributed";
      const v = a?.cliVersion ?? "unattributed";
      models[m] = (models[m] ?? 0) + 1;
      cliVersions[v] = (cliVersions[v] ?? 0) + 1;
    }
    const turnsN = turnList.length;
    return {
      turns: turnsN,
      toolCalls,
      mean: turnsN > 0 ? toolCalls / turnsN : 0,
      shareSingle: turnsN > 0 ? histogram["1"] / turnsN : 0,
      histogram,
      agents: agentSet.size,
      callsSaved: toolCalls - turnsN,
      models,
      cliVersions,
      shadowShare: turnsN > 0 ? shadow / turnsN : 0,
    };
  }

  const cohortOf = (agentId, cutoffTs) => {
    const spawnTs = agents.get(agentId)?.ts ?? -Infinity;
    return spawnTs < cutoffTs ? "before" : "after";
  };

  const cutoffs = CUTOFFS.map(({ label, hours }) => {
    const cutoffTs = directiveTs + hours * 3600 * 1000;
    const byEventTsBefore = [];
    const byEventTsAfter = [];
    const bySpawnBefore = [];
    const bySpawnAfter = [];
    for (const t of allTurns) {
      if (t.ts < cutoffTs) byEventTsBefore.push(t);
      else byEventTsAfter.push(t);
      if (cohortOf(t.agentId, cutoffTs) === "before") bySpawnBefore.push(t);
      else bySpawnAfter.push(t);
    }
    return {
      label,
      ts: cutoffTs,
      byEventTs: { before: summarize(byEventTsBefore), after: summarize(byEventTsAfter) },
      bySpawnCohort: { before: summarize(bySpawnBefore), after: summarize(bySpawnAfter) },
    };
  });

  // byRole — aggregate over the whole retained log (not cutoff-split); the frozen shape (plan
  // §2.6) nests byRole directly under l3, not under a cutoff.
  const byRole = {};
  for (const role of ["conductor", "worker-d0", "worker-dN"]) {
    byRole[role] = summarize(allTurns.filter((t) => roleOf(agents.get(t.agentId)) === role));
  }

  const thinWindow = cutoffs.some(
    (c) => c.bySpawnCohort.before.turns < L3_MIN_TURNS || c.bySpawnCohort.after.turns < L3_MIN_TURNS,
  );
  const rises = cutoffs.map((c) => {
    const before = c.bySpawnCohort.before.mean;
    const after = c.bySpawnCohort.after.mean;
    return before > 0 ? (after - before) / before : 0;
  });
  let verdict;
  if (thinWindow) verdict = "inconclusive";
  else if (rises.every((r) => r >= L3_WORKED_RISE)) verdict = "worked";
  else if (rises.every((r) => Math.abs(r) < L3_NOEFFECT_MOVE)) verdict = "no-effect";
  else verdict = "inconclusive";

  const first = cutoffs[0];
  const realizedMultiplier =
    first && first.bySpawnCohort.before.mean > 0
      ? first.bySpawnCohort.after.mean / first.bySpawnCohort.before.mean
      : 0;

  return {
    directive: { commit: "1e7412d4", authoredTs: DIRECTIVE_TS, site: "packages/core/src/supervisor.ts:135" },
    cutoffs,
    byRole,
    ungrouped,
    shadowShare: allTurns.length ? allTurns.filter((t) => t.hasParent).length / allTurns.length : 0,
    realizedMultiplier,
    verdict,
    thinWindow,
  };
}

// ---------------------------------------------------------------------------------------------
// Spend ledger (Q4 denominator)
// ---------------------------------------------------------------------------------------------

// `rates` defaults to the module's own READ_RATE/WRITE_RATE so every existing call site (and the
// A6a self-check, which depends on the real and simulated paths sharing identical arithmetic) is
// byte-identical. Only F39.QA-B's sensitivity grid (M-3) passes an override, to see how far
// netMultiplier moves if the ~2.6x list-vs-billed bias isn't the uniform scalar it's assumed to be.
function dollarsFor(usage, price, rates = { read: READ_RATE, write: WRITE_RATE }) {
  return (
    (usage.read / 1e6) * price.input * rates.read +
    (usage.write / 1e6) * price.input * rates.write +
    (usage.fresh / 1e6) * price.input +
    (usage.output / 1e6) * price.output
  );
}

// The model-resolving entry point onto the SAME arithmetic. F39's counterfactual replay must price
// a SIMULATED call exactly as the real one is priced — if the two ever diverge, the replay's
// `netMultiplier(Infinity) === 1.0` self-check stops being a check and becomes a coincidence — so
// it goes through dollarsFor rather than repeating the four terms.
// All cache writes bill at WRITE_RATE (the 5m rate): the log carries a
// `usage.cache_creation.ephemeral_1h_input_tokens` breakdown that this ledger has never used, and
// consistency with the ledger the replay is cross-checked against beats a second rate table.
export function priceUsage(usage, model, priceMisses, rates) {
  const price = priceFor(model, priceMisses);
  return price ? dollarsFor(usage, price, rates) : 0;
}

// claudeTurns — ONE ROW PER REAL MODEL CALL for one claude agent's events, in event order.
//
// Backend `usage` is DOUBLE-EMITTED: message_start carries the turn's real read/write/fresh
// baseline, message_delta re-emits the SAME read/write/fresh with only output_tokens ticking up
// (claude.ts:1012-1021 — "input/cache stay pinned to the message_start baseline"). Summing every
// usage event double-counts every context figure ~2x. This accumulator collapses the pair:
// message_start opens a row, a following message_delta only advances its `output`, and the row
// flushes on the next opener or at end of stream — which also keeps the ACCURATE output count,
// because message_start's own output_tokens is a placeholder (measured 2026-09-02 over 2,000
// turns: median 3 on message_start against 488 on message_delta, a 100x undercount if a reader
// takes message_start's figure). Both facts are why this is a merge and not a filter.
//
// `streamEventType` is carried through so a consumer that wants strictly-real model calls can ask
// for `=== "message_start"`: a usage event with no raw.event is NOT an API call (the
// post-compaction baseline reset at claude.ts:867, marked `synthetic:"compaction-baseline"` since
// F39.0) and opens its own singleton row here only so the ledger's behaviour is unchanged.
//
// TWIN: spendAcc's claude branch below applies the same merge rule ONE EVENT AT A TIME, because
// F45.QA-A made the ledger streaming (O(agents) state, never a per-agent event list) while this
// function needs the rows themselves, not their sum. The duplication is deliberate and pinned:
// compaction-audit.test.ts case 15 fails if the two ever disagree on a fixture.
export function claudeTurns(evs, fallbackModel = null) {
  const rows = [];
  let current = null;
  const flush = () => {
    if (current) rows.push(current);
    current = null;
  };
  for (const e of evs) {
    if (e?.kind !== "usage") continue;
    const u = e.data?.usage;
    if (!u || typeof u !== "object") continue;
    const type = e.raw?.event?.type;
    if (type === "message_delta" && current) {
      current.output = u.output_tokens ?? current.output;
      continue;
    }
    flush();
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const fresh = u.input_tokens ?? 0;
    current = {
      ts: e.ts,
      seq: e.seq,
      agentId: e.agentId,
      read,
      write,
      fresh,
      output: u.output_tokens ?? 0,
      ctx: read + write + fresh,
      model: e.raw?.event?.message?.model ?? fallbackModel,
      streamEventType: typeof type === "string" ? type : null,
      synthetic: typeof e.data?.synthetic === "string" ? e.data.synthetic : null,
      afterCompaction: e.data?.afterCompaction === true,
    };
  }
  flush();
  return rows;
}

function spendAcc(agents) {
  const byProviderClass = { claude: 0, codex: 0, generic: 0 };
  // plan §2.3: "every id seen, WITH AGENT COUNTS" — the Q4 mitigation is that a reader sees the
  // true n beside the share, so this must count agent_started rows, not the subset that happened
  // to emit a usage/result event (an agent that died before its first turn is still an agent).
  const observedProviders = {};
  for (const a of agents.values()) observedProviders[a.provider] = (observedProviders[a.provider] ?? 0) + 1;
  const priceMisses = new Set();

  // Per-agent STATE, not a per-agent event list: the claude merge below only ever needs the turn
  // currently open, so the ledger costs O(agents) instead of O(usage events) — and a usage/result
  // event drags its whole `raw` SDK envelope along, which is most of the log's bytes (plan §6).
  const state = new Map();
  // F45.QA-B leftover #1: the synthetic-usage exclusion below (marker check, F39.QA) was invisible
  // in the artifact — a reader had no way to see how much phantom spend was actually dropped.
  let syntheticUsageEvents = 0;
  let syntheticInputTokens = 0;
  const stateFor = (agentId) => {
    let s = state.get(agentId);
    if (!s) {
      const agent = agents.get(agentId);
      s = {
        provider: agent?.provider ?? "?",
        // Agents whose agent_started was pruned out of the retained window: they contribute spend
        // with no provider attribution, so they get their own bucket rather than a silent "?".
        unattributed: !agent,
        agentModel: agent?.model ?? null,
        current: null, // claude: the turn being merged
        modelledUsd: 0, // claude: this agent's spend priced from the PRICES list table
        modelledTurns: 0,
        missedModels: null, // models this agent burned turns on that PRICES has no row for
        maxCostUsd: 0, // costUsd is cumulative, so max wins — for claude too, not just codex
        sawCostUsd: false,
        kimiTurns: 0,
      };
      state.set(agentId, s);
    }
    return s;
  };
  const flushClaudeTurn = (s) => {
    if (!s.current) return;
    s.modelledTurns++;
    const price = priceFor(s.current.model, priceMisses);
    if (price) s.modelledUsd += dollarsFor(s.current, price);
    else (s.missedModels ??= new Set()).add(normalizeModel(s.current.model) ?? "unattributed");
    s.current = null;
  };

  return {
    add(e) {
      if (e?.kind !== "usage" && e?.kind !== "result" && e?.kind !== "turn_complete") return;
      const s = stateFor(e.agentId);

      if (s.provider === "kimi") {
        if (e.kind === "result") s.kimiTurns++;
        return;
      }

      if (s.provider === "claude") {
        // QA finding 7: the SDK's own `total_cost_usd` is what claude actually billed, and it is
        // CUMULATIVE per run (same shape codex/generic already use), so max-per-agent wins. The
        // list-price model below still runs for every claude agent, but only as the labelled
        // second column — mixing a modelled numerator with SDK-reported codex/generic figures in
        // one ratio is what made genericSharePct ~3x too small.
        if (e.kind === "result" && typeof e.data?.costUsd === "number") {
          s.sawCostUsd = true;
          s.maxCostUsd = Math.max(s.maxCostUsd, e.data.costUsd);
          return;
        }
        // Backend `usage` is DOUBLE-EMITTED: message_start carries the turn's real read/write/fresh
        // baseline, message_delta re-emits the SAME read/write/fresh with only output_tokens ticking
        // up (claude.ts:1012-1021 — "input/cache stay pinned to the message_start baseline").
        // Summing every usage event double-counts every spend figure. Fix: accumulate one merged
        // record per turn (message_start opens it, message_delta only updates its output), flush on
        // the next message_start or at end-of-stream. A synthetic event with no raw.event.type
        // (tests, or the post-compaction reset at claude.ts:867) is its own singleton turn.
        if (e.kind !== "usage") return;
        const u = e.data?.usage;
        if (!u || typeof u !== "object") return;
        // F39.QA (plan R2/M9): claude.ts sinks a `usage` event after every compact_boundary purely
        // to reset the live ctx meter to post_tokens — NOT an API call. Billing its input_tokens at
        // the full fresh-input rate is phantom spend that grows in exact lockstep with compaction
        // count, i.e. with what the 120k L1 default just multiplied ~38x. buildCompactionReport
        // already drops it; this ledger did not, so its modelledList/modelledFallback figures were
        // the last place the bug survived. Keyed on the EXPLICIT marker, never on "no raw.event" —
        // a fixture row without a stream type is a real turn here and must keep counting.
        if (typeof e.data?.synthetic === "string") {
          syntheticUsageEvents++;
          syntheticInputTokens += u.input_tokens ?? 0;
          return;
        }
        const type = e.raw?.event?.type;
        const model = e.raw?.event?.message?.model ?? s.agentModel;
        if (type === "message_delta" && s.current) {
          s.current.output = u.output_tokens ?? s.current.output;
        } else {
          flushClaudeTurn(s);
          s.current = {
            read: u.cache_read_input_tokens ?? 0,
            write: u.cache_creation_input_tokens ?? 0,
            fresh: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            model,
          };
        }
        return;
      }

      // codex, and every non-{claude,codex,kimi} provider id ("generic") — result.data.costUsd is
      // CUMULATIVE over the whole run (codex.ts:559-563, generic.ts:337), so take the max per
      // agent; summing every result event double-counts.
      if (e.kind === "result" && typeof e.data?.costUsd === "number") {
        s.sawCostUsd = true;
        s.maxCostUsd = Math.max(s.maxCostUsd, e.data.costUsd);
      }
    },

    finish() {
      let unattributedSpendAgents = 0;
      let kimiAgents = 0;
      let kimiTurns = 0;
      // The claude figure has two units. `sdk*` is what the SDK billed; `modelledFallback*` is the
      // list-price stand-in for agents whose result row never arrived (killed, still running, or
      // pruned out of the retained window); `modelledListUsd` is EVERY claude agent priced from
      // the list table — the old single-unit number, kept as the labelled second column.
      let sdkUsd = 0;
      let sdkAgents = 0;
      let modelledFallbackUsd = 0;
      let modelledFallbackAgents = 0;
      let modelledListUsd = 0;
      // The same agents priced BOTH ways. Their ratio is the only in-log evidence of how far the
      // list-price model sits from what claude actually billed, and it is the honest scale factor
      // for reading the modelled fallback that no result row can correct.
      let modelledUsdForSdkAgents = 0;
      // Only a miss on a FALLBACK agent can make the primary claude figure a floor; a miss on an
      // SDK-priced agent affects the second column alone.
      const fallbackMisses = new Set();

      for (const s of state.values()) {
        if (s.unattributed) unattributedSpendAgents++;
        if (s.provider === "kimi") {
          kimiAgents++;
          kimiTurns += s.kimiTurns;
          continue;
        }
        if (s.provider === "claude") {
          flushClaudeTurn(s);
          modelledListUsd += s.modelledUsd;
          if (s.sawCostUsd) {
            sdkUsd += s.maxCostUsd;
            sdkAgents++;
            modelledUsdForSdkAgents += s.modelledUsd;
            byProviderClass.claude += s.maxCostUsd;
          } else if (s.modelledTurns > 0) {
            modelledFallbackUsd += s.modelledUsd;
            modelledFallbackAgents++;
            byProviderClass.claude += s.modelledUsd;
            for (const m of s.missedModels ?? []) fallbackMisses.add(m);
          }
          continue;
        }
        if (s.sawCostUsd) byProviderClass[s.provider === "codex" ? "codex" : "generic"] += s.maxCostUsd;
      }

      const unmeasurable = [];
      if (kimiAgents > 0) unmeasurable.push({ provider: "kimi", agents: kimiAgents, turns: kimiTurns });

      const denom = byProviderClass.claude + byProviderClass.codex + byProviderClass.generic;
      const genericSharePct = denom > 0 ? (byProviderClass.generic / denom) * 100 : 0;

      return {
        byProviderClass,
        genericSharePct,
        modelledListUsd,
        claudeSpend: {
          sdkUsd,
          sdkAgents,
          modelledFallbackUsd,
          modelledFallbackAgents,
          modelledUsdForSdkAgents,
          modelledOverSdkRatio: sdkUsd > 0 ? modelledUsdForSdkAgents / sdkUsd : null,
          fallbackPriceTableMisses: [...fallbackMisses],
        },
        observedProviders,
        unattributedSpendAgents,
        unmeasurable,
        priceTableMisses: [...priceMisses],
        syntheticUsageEvents,
        syntheticInputTokens,
      };
    },
  };
}

export function buildSpendLedger(events, agents) {
  const acc = spendAcc(agents);
  for (const e of events) acc.add(e);
  return acc.finish();
}

// ---------------------------------------------------------------------------------------------
// Q3 — tool_result bytes by originating tool
// ---------------------------------------------------------------------------------------------

// The `toolUseId -> toolName` map plan §6 budgets for. It deliberately does NOT retain
// `data.input`: only L4's chimera_call unwrapping reads it, and only its `.tool` string, so
// keeping the whole input object would pin every tool call's arguments (prompts included) in
// memory for the life of the report.
function toolCallIndexAcc() {
  const idx = new Map(); // toolUseId -> {toolName, agentId, wrapped}
  return {
    add(e) {
      if (e?.kind !== "tool_call") return;
      const id = e.data?.toolUseId;
      if (typeof id !== "string") return;
      const input = e.data?.input;
      const wrapped =
        e.data?.toolName === "mcp__chimera__chimera_call" && input && typeof input === "object" && typeof input.tool === "string"
          ? input.tool
          : null;
      idx.set(id, { toolName: e.data?.toolName, agentId: e.agentId, wrapped });
    },
    finish: () => idx,
  };
}

function q3Acc(agents, toolCallIndex, callTimesByAgent) {
  const subsequentCalls = (agentId, ts) => {
    const arr = callTimesByAgent.get(agentId);
    return arr ? countAfter(arr, ts) : 0;
  };

  const classes = ["sdk-native", "chimera-served", "foreign-via-chimera", "foreign-direct"];
  const byClass = {};
  for (const c of classes) {
    byClass[c] = { chars: 0, results: 0, volumePct: 0, dollarUsd: 0, dollarPct: 0, truncatedCount: 0, truncatedChars: 0 };
  }
  let unjoinedResults = 0;
  let unjoinedChars = 0;
  let totalChars = 0;
  const topToolsMap = new Map();
  const unpriced = { results: 0, chars: 0 };
  const unpricedByClass = {};
  const unpricedModels = new Set();

  const add = (e) => {
    if (e?.kind !== "tool_result") return;
    const result = typeof e.data?.result === "string" ? e.data.result : "";
    const chars = result.length;
    const toolId = e.data?.toolId;
    const match = typeof toolId === "string" ? toolCallIndex.get(toolId) : undefined;
    if (!match) {
      unjoinedResults++;
      unjoinedChars += chars;
      return;
    }
    const agent = agents.get(match.agentId);
    const cls = classifyTool(match.toolName, agent?.tools ?? undefined);
    const row = byClass[cls];
    if (!row) return; // classifyTool never returns "unjoined" for a joined result
    totalChars += chars;
    row.chars += chars;
    row.results++;
    if (chars >= TOOL_RESULT_MAX_CHARS) {
      row.truncatedCount++;
      row.truncatedChars += chars;
    }
    const price = priceFor(agent?.model, unpricedModels);
    let dollarUsd = 0;
    if (price) {
      const tokens = chars / 4;
      const sub = subsequentCalls(match.agentId, e.ts);
      dollarUsd = ((tokens * sub) / 1e6) * price.input * READ_RATE;
    } else {
      // NOT silent: a result whose agent's model has no price row contributes $0 to the gate's
      // denominator. The exclusion is not uniform across classes (conductors on the 1M-context
      // beta drive most chimera-served bytes), so it BIASES the share and must be reported.
      // An agent with no retained agent_started has no model at all — record it as its own bucket
      // rather than letting priceFor's null-model early-out drop it from the reported id list.
      unpricedModels.add(normalizeModel(agent?.model) ?? "unattributed");
      unpriced.results++;
      unpriced.chars += chars;
      unpricedByClass[cls] = (unpricedByClass[cls] ?? 0) + chars;
    }
    row.dollarUsd += dollarUsd;
    const key = match.toolName ?? "unknown";
    const tt = topToolsMap.get(key) ?? { toolName: key, chars: 0, dollarUsd: 0 };
    tt.chars += chars;
    tt.dollarUsd += dollarUsd;
    topToolsMap.set(key, tt);
  };

  const finish = () => {
    for (const c of classes) byClass[c].volumePct = totalChars > 0 ? (byClass[c].chars / totalChars) * 100 : 0;
    const totalDollar = classes.reduce((n, c) => n + byClass[c].dollarUsd, 0);
    for (const c of classes) byClass[c].dollarPct = totalDollar > 0 ? (byClass[c].dollarUsd / totalDollar) * 100 : 0;
    const reachableDollar = byClass["chimera-served"].dollarUsd + byClass["foreign-via-chimera"].dollarUsd;
    const reachableDollarPct = totalDollar > 0 ? (reachableDollar / totalDollar) * 100 : 0;
    const topTools = [...topToolsMap.values()].sort((a, b) => b.chars - a.chars).slice(0, 10);

    return {
      byClass,
      reachableDollarPct,
      unjoined: { results: unjoinedResults, chars: unjoinedChars },
      unpriced: { ...unpriced, byClass: unpricedByClass, models: [...unpricedModels] },
      topTools,
    };
  };

  return { add, finish };
}

// ---------------------------------------------------------------------------------------------
// L4 — orchestration hygiene
// ---------------------------------------------------------------------------------------------

// One L4 scope (conductors-only or all-agents). It keeps per-agent byte totals plus the sizes of
// ORCHESTRATION returns only — never a row per tool_result. The orchestration returns are a small
// minority of results, so the retained array is bounded far below the log's result count.
function l4ScopeAcc(boundChars) {
  const sizes = [];
  const totalByAgent = new Map();
  const orchByAgent = new Map();
  let truncatedCount = 0;
  const overBound = [];

  return {
    add(agentId, toolName, chars) {
      totalByAgent.set(agentId, (totalByAgent.get(agentId) ?? 0) + chars);
      if (!ORCHESTRATION_TOOL_RE.test(toolName ?? "")) return;
      sizes.push(chars);
      orchByAgent.set(agentId, (orchByAgent.get(agentId) ?? 0) + chars);
      if (chars >= TOOL_RESULT_MAX_CHARS) truncatedCount++;
      if (chars > boundChars) overBound.push({ agentId, toolName, chars });
    },
    finish() {
      sizes.sort((a, b) => a - b);
      const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : 0);
      let orchTotal = 0;
      let allTotal = 0;
      for (const [aid, t] of totalByAgent) {
        allTotal += t;
        orchTotal += orchByAgent.get(aid) ?? 0;
      }
      return {
        orchestrationSharePct: allTotal > 0 ? (orchTotal / allTotal) * 100 : 0,
        p50: pct(0.5),
        p95: pct(0.95),
        max: sizes.length ? sizes[sizes.length - 1] : 0,
        truncatedCount,
        overBound,
      };
    },
  };
}

function l4Acc(agents, toolCallIndex, boundChars) {
  const conductorScope = l4ScopeAcc(boundChars);
  const allScope = l4ScopeAcc(boundChars);

  return {
    add(e) {
      if (e?.kind !== "tool_result") return;
      const toolId = e.data?.toolId;
      const match = typeof toolId === "string" ? toolCallIndex.get(toolId) : undefined;
      if (!match) return;
      // chimera_call wraps an arbitrary tool; classify by what it wrapped (plan §2.5).
      const toolName = match.wrapped ?? match.toolName;
      const chars = typeof e.data?.result === "string" ? e.data.result.length : 0;
      if (agents.get(match.agentId)?.conductor) conductorScope.add(match.agentId, toolName, chars);
      allScope.add(match.agentId, toolName, chars);
    },
    finish() {
      const conductors = conductorScope.finish();
      const allAgents = allScope.finish();
      const leaking =
        conductors.truncatedCount > 0 || allAgents.truncatedCount > 0 || conductors.p95 > boundChars || allAgents.p95 > boundChars;
      return { conductors, allAgents, boundChars, verdict: leaking ? "leaking" : "clean" };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Surface — tool-surface cache-write gate (feeds F41/F51)
// ---------------------------------------------------------------------------------------------

function surfaceAcc(agents) {
  const firstCacheWrite = new Map();
  const approxTokensList = [];

  const add = (e) => {
    if (e?.kind === "status") {
      const t = e.data?.toolSurface?.approxTokens;
      if (typeof t === "number") approxTokensList.push(t);
      return;
    }
    if (e?.kind !== "usage" && e?.kind !== "turn_complete") return;
    if (firstCacheWrite.has(e.agentId)) return;
    const u = e.data?.usage;
    if (!u || typeof u !== "object") return;
    firstCacheWrite.set(e.agentId, u.cache_creation_input_tokens ?? 0);
  };

  const finish = () => {
  const chimeraEstimateTokens = median(approxTokensList);

  const bucketOf = (n) => (n === 0 ? "0" : n === 1 ? "1" : n <= 5 ? "2-5" : n <= 15 ? "6-15" : "16+");
  // Sort by the bucket's lower bound: a plain string sort puts "16+" before "2-5", so the scorecard
  // table reads as a dose-response ladder that isn't actually ordered.
  const BUCKET_ORDER = { "0": 0, "1": 1, "2-5": 2, "6-15": 6, "16+": 16 };
  const buckets = new Map();
  const serverAgents = new Map();
  const allAgentIds = new Set();

  for (const [agentId, tokens] of firstCacheWrite) {
    const agent = agents.get(agentId);
    const names = (agent?.mcpServers ?? []).map((s) => s?.name).filter((n) => typeof n === "string");
    allAgentIds.add(agentId);
    const bucket = bucketOf(names.length);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(tokens);
    for (const name of names) {
      if (!serverAgents.has(name)) serverAgents.set(name, new Set());
      serverAgents.get(name).add(agentId);
    }
  }

  const byServerCount = [...buckets.entries()]
    .map(([bucket, tokensArr]) => ({ bucket, n: tokensArr.length, lowN: tokensArr.length < 5, medianFirstCacheWrite: median(tokensArr) }))
    .sort((a, b) => (BUCKET_ORDER[a.bucket] ?? 99) - (BUCKET_ORDER[b.bucket] ?? 99));

  const allTokens = [...firstCacheWrite.values()];
  const medianFirstCacheWrite = median(allTokens);

  // Observational contrast only — servers co-occur, so this is a hint, not a controlled estimate.
  const perServerMarginal = [...serverAgents.entries()].map(([server, withSet]) => {
    const withArr = [...withSet].map((a) => firstCacheWrite.get(a)).filter((v) => v !== undefined);
    const withoutArr = [...allAgentIds].filter((a) => !withSet.has(a)).map((a) => firstCacheWrite.get(a)).filter((v) => v !== undefined);
    return {
      server,
      nWith: withArr.length,
      nWithout: withoutArr.length,
      medianDeltaTokens: median(withArr) - median(withoutArr),
      lowN: withArr.length < 5 || withoutArr.length < 5,
    };
  });

  return {
    byServerCount,
    perServerMarginal,
    chimeraEstimateTokens,
    medianFirstCacheWrite,
    estimateVsRealPct: medianFirstCacheWrite > 0 ? (chimeraEstimateTokens / medianFirstCacheWrite) * 100 : 0,
  };
  };

  return { add, finish };
}

// ---------------------------------------------------------------------------------------------
// F39 — compaction cost: counterfactual threshold replay
// ---------------------------------------------------------------------------------------------

// The candidate set of §2.4.4 rule 1. Every entry is >= CLAUDE_AUTO_COMPACT_WINDOW_MIN (100_000,
// packages/protocol/src/pricing.ts:251), because claude.ts:520 silently clamps anything below it
// UP to that window — a "recommendation" under the clamp would not be the threshold that fires.
export const THRESHOLD_SWEEP = [120_000, 150_000, 180_000, 200_000, 250_000, 300_000, 400_000, 500_000];

// Post-compaction context is a near-constant FLOOR, not a ratio of the pre size: measured
// 2026-09-02, after.tokens spans 7,435..23,526 while before.tokens spans 89,848..1,001,292 — no
// correlation. These are the fallback floors for a log with no compaction events at all; a real
// run derives {min, median, max} from its OWN observed after.tokens (observed.floors) so the
// sweep never reports a number fitted to a different fleet than the one it measured.
export const POST_COMPACTION_FLOORS = { min: 8_912, median: 13_545, max: 23_526 };

// §2.4.3: the D07 window. 30 tool calls after a boundary is the plan's constant.
export const POST_COMPACTION_WINDOW_CALLS = 30;

// §2.4.4 rules 2 and 4. A lever worth less than 10% of the bill does not justify a fleet-wide
// behaviour change, and among survivors the LARGEST threshold within 5% of the best wins —
// information-loss risk is monotone in tightness and 5% of the bill does not buy it.
export const MIN_NET_MULTIPLIER = 1.10;
export const NEAR_BEST_TOLERANCE = 0.05;

// F39.QA-B M-2: actual.usd vs buildSpendLedger.modelledListUsd is a genuinely independent
// arithmetic path (event-streaming spendAcc vs. row-array claudeTurns), unlike the T=Infinity
// self-check which just proves the replay's own scale-path is neutral. Floating-point summation
// order differs between the two paths even when both are "correct", so the cross-check needs a
// tolerance rather than exact equality — 1e-6 is far below a cent and only trips on a real
// divergence, not float noise.
export const LEDGER_CROSS_CHECK_TOLERANCE_USD = 1e-6;

// F39.QA-B M-3: the grid the sensitivity block recomputes netMultiplier across, to see how far
// the recommendation moves if the ~2.6x list-vs-billed bias (calibration.modelledOverSdkRatio)
// isn't the uniform scalar the old calibration.note assumed. READ_RATE/WRITE_RATE are the
// baseline; the other cells bracket "read caching turns out cheaper/pricier than modelled" and
// "cache writes bill at something other than the flat 5m rate this ledger assumes everywhere".
export const SENSITIVITY_READ_RATES = [0.05, 0.1, 0.2];
export const SENSITIVITY_WRITE_RATES = [1.25, 2.0];

// M-3 (F39.FIX): the SHIPPED fleet default, mirroring DEFAULT_COMPACTION_THRESHOLD.claude in
// packages/protocol/src/pricing.ts — a .mjs run by `node` cannot import the TS const, so the two
// are kept in sync by hand and pinned by compaction-audit.test.ts. The sensitivity grid is
// evaluated at BOTH the recommended threshold and this one: the recommendation moves with the
// retained window, but the number actually shipped to every agent is this one, and "does the
// default clear the bar" is the question the grid exists to answer.
export const FLEET_DEFAULT_THRESHOLD = 120_000;

// A path is "read" by any of these; the Bash arm exists because this fleet reads files through the
// shell, not through the Read tool (measured 2026-09-02: 925 Read calls against 15,779 Bash, of
// which 11,376 contain a reader). A Read-only classifier observes <=6% of the reads and would
// report a confident zero.
const BASH_READ_RE = /\b(?:cat|head|tail|less|sed\s+-n)\b\s+([^|;&<>]+)/g;

function extractBashPaths(command) {
  if (typeof command !== "string") return [];
  const out = [];
  for (const m of command.matchAll(BASH_READ_RE)) {
    for (const tok of m[1].split(/\s+/)) {
      // Deliberately crude (plan §2.4.3): flags, numeric args to `head -n 20` and quoted globs are
      // dropped, anything else is treated as a path. Its false-positive surface is reported beside
      // the number rather than hidden.
      if (!tok || tok.startsWith("-") || /^\d+$/.test(tok)) continue;
      out.push(tok.replace(/^['"]|['"]$/g, ""));
    }
  }
  return out;
}

// pathsReadBy — every path a tool_call reads, across the four shapes that read one.
function pathsReadBy(data) {
  const name = data?.toolName;
  const input = data?.input ?? {};
  if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit") {
    return typeof input.file_path === "string" ? [input.file_path] : [];
  }
  if (name === "mcp__ekb__file") return typeof input.path === "string" ? [input.path] : [];
  if (name === "Bash") return extractBashPaths(input.command);
  return [];
}

const CHRONICLE_TOOLS = new Set(["mcp__chimera__chronicle_search", "mcp__chimera__chronicle_get"]);

function isChronicleCall(data) {
  const name = data?.toolName;
  if (typeof name !== "string") return false;
  if (CHRONICLE_TOOLS.has(name)) return true;
  // chronicle_* is a DEFERRED tool for most agents, so it usually arrives wrapped — a classifier
  // that only matches the direct name reports zero for a fleet that used it heavily via the wrapper.
  if (name === "mcp__chimera__chimera_call") {
    const inner = data?.input?.tool;
    return typeof inner === "string" && inner.startsWith("chronicle_");
  }
  return false;
}

// indexCompactions — every compaction event, completions and `phase:"start"` separated. A start
// event carries no sizes by construction (claude.ts emits it before the SDK reports them), so it
// is counted and then excluded from every size-derived figure.
export function indexCompactions(events) {
  const completions = [];
  const starts = [];
  for (const e of events) {
    if (e?.kind !== "compaction") continue;
    const d = e.data ?? {};
    const row = {
      ts: e.ts,
      seq: e.seq,
      agentId: e.agentId,
      owner: typeof d.owner === "string" ? d.owner : "?",
      trigger: typeof d.trigger === "string" ? d.trigger : null,
      before: typeof d.before?.tokens === "number" ? d.before.tokens : null,
      after: typeof d.after?.tokens === "number" ? d.after.tokens : null,
      // F39.0 fields — absent on every event emitted before 2026-09-02, so `undefined` here means
      // "older than the instrumentation", never "no threshold".
      thresholdInForce: d.thresholdInForce,
      thresholdSource: typeof d.thresholdSource === "string" ? d.thresholdSource : undefined,
      model: typeof d.model === "string" ? d.model : undefined,
      provider: typeof d.provider === "string" ? d.provider : undefined,
      costUsd: typeof d.costUsd === "number" ? d.costUsd : undefined,
    };
    if (d.phase === "start") starts.push(row);
    else completions.push(row);
  }
  return { completions, starts };
}

// buildCallSeries — per claude agent, the ordered series of REAL model calls the replay walks.
// `streamEventType === "message_start"` is the admission rule (A0): it is exactly one row per API
// call, and it also excludes the synthetic post-compaction reset, which carries no raw.event.
// The `synthetic` guard is belt-and-braces on purpose — excluding a phantom charge by the ABSENCE
// of a field is luck, and the next backend to sink a usage event without a raw.event silently
// re-opens the bug.
export function buildCallSeries(events, agents, priceMisses) {
  const byAgent = new Map();
  for (const e of events) {
    if (e?.kind !== "usage") continue;
    if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
    byAgent.get(e.agentId).push(e);
  }
  const series = new Map();
  let usageEvents = 0;
  let deltaReemissions = 0;
  let syntheticUsageEvents = 0;
  let syntheticInputTokens = 0;
  let markedSynthetic = 0;
  // F39.QA: A3's `afterCompaction:true` marker is the ONLY place an SDK compaction's real price is
  // observable (M10: the prefix-cache rewrite the next real call pays, not the boundary event).
  // The replay charges a MODELLED rewrite of the post-compaction floor; without these two numbers
  // nothing ever compares that model against a measurement, and the marker claude.ts pays a latch
  // to emit is written and never read. 0 on any log written before F39.0 landed — that is the
  // point: a re-run in a fortnight is what turns the fitted floor into a measured one.
  let afterCompactionCalls = 0;
  let afterCompactionWriteTokens = 0;
  // M-2 (F39.QA-B): buildSpendLedger is NOT keyed on the "no raw.event" absence this loop excludes
  // on — it bills an unmarked row (no `synthetic` string) as a real turn regardless of streamEventType
  // (compaction-audit.test.ts case 18). Every row excluded here for that reason, NOT because it
  // carries the explicit `synthetic:"compaction-baseline"` marker, is a dollar the ledger still
  // charges that `series` (and therefore actual.usd) never sees. Summing it lets selfCheck's ledger
  // cross-check (A6b) tell "series is fine, the gap is this known asymmetry" apart from "series is
  // wrong" instead of comparing actual.usd to the ledger raw and always finding a mismatch.
  let excludedLedgerBillableUsd = 0;
  // M-2 (F39.FIX): the OPPOSITE asymmetry, and the one that made the A6b check false-fire on every
  // real log. The guard below is `if (agent && ...)`: an agent whose `agent_started` was pruned out
  // of the retained window has NO record, so its usage is admitted here and billed into actual.usd.
  // buildSpendLedger's stateFor gives that same agent `provider:"?"`/`unattributed:true`, which
  // routes it out of the claude branch and out of modelledListUsd entirely. Summing its dollars
  // lets expectedLedgerUsd subtract them back out; without this term the cross-check reports a
  // mismatch on any log old enough to have rolled a segment (measured: -$18.87 on 2026-09-05).
  let unattributedSeriesUsd = 0;
  for (const [agentId, evs] of byAgent) {
    const agent = agents.get(agentId);
    usageEvents += evs.length;
    for (const e of evs) {
      if (e?.raw?.event?.type === "message_delta") deltaReemissions++;
    }
    if (agent && agent.provider !== "claude") continue;
    const rows = claudeTurns(evs, agent?.model ?? null);
    const real = [];
    for (const r of rows) {
      if (!agent && !r.synthetic) unattributedSeriesUsd += priceUsage(r, r.model, priceMisses);
      if (r.synthetic || r.streamEventType !== "message_start") {
        if (r.synthetic || r.streamEventType === null) {
          syntheticUsageEvents++;
          syntheticInputTokens += r.fresh;
          if (r.synthetic) markedSynthetic++;
        }
        if (!r.synthetic) excludedLedgerBillableUsd += priceUsage(r, r.model, priceMisses);
        continue;
      }
      if (r.afterCompaction) {
        afterCompactionCalls++;
        afterCompactionWriteTokens += r.write;
      }
      real.push(r);
    }
    if (real.length) series.set(agentId, real);
  }
  return {
    series, usageEvents, deltaReemissions, syntheticUsageEvents, syntheticInputTokens, markedSynthetic,
    afterCompactionCalls, afterCompactionWriteTokens, excludedLedgerBillableUsd, unattributedSeriesUsd,
  };
}

// replayThreshold — §2.4.2. Walk one agent's real calls, grow the simulated context by the REAL
// per-call delta, fire a compaction when it crosses T, charge a full cache rewrite of the
// post-compaction floor, and continue.
//
// ONE DEVIATION FROM THE PLAN'S PSEUDOCODE, and it is load-bearing: the plan writes
// `sim += max(0, ctx[i] - ctx[i-1])`, which never lets `sim` fall. Real context DOES fall — at
// every real compaction (10 in this log, 1M -> 14k). With sim pinned high and ctx collapsed,
// `scale = sim/ctx` reaches ~70x and the T=Infinity self-check (A6) fails on real data while
// passing on any monotone-growing fixture. `sim` is therefore clamped to the real context: the
// simulation can never be holding MORE than the real run held. At T=Infinity this makes
// sim === ctx at every step, scale exactly 1.0, and the replay bit-identical to the actual bill.
//
// M-2 (F39.QA-B): this clamp is also why `usd`'s netMultiplier is structurally >= 1 — `sim` can
// never outgrow the real context, so a threshold at which capping costs more than it saves (real:
// see the ~70x blowup above) has no way to show up in this number. `usdUncapped` runs the exact
// same walk on the plan's ORIGINAL, un-clamped pseudocode instead, purely as a diagnostic: it can
// legitimately exceed `usd` (and diverge from actual.usd at T=Infinity, for the reason above), so
// it is never wired into the A6a self-check — only exposed per-sweep-row so the losing case is
// visible somewhere.
export function replayThreshold(series, T, floor, priceMisses, rates) {
  let sim = 0;
  let compactions = 0;
  let usd = 0;
  let compactionCostUsd = 0;
  let freshAfterCompaction = false;
  let simUncapped = 0;
  let usdUncapped = 0;
  let freshAfterCompactionUncapped = false;
  for (let i = 0; i < series.length; i++) {
    const r = series[i];
    const ctx = r.ctx;
    const prevCtx = i === 0 ? 0 : series[i - 1].ctx;
    const grow = i === 0 ? Math.min(ctx, T) : Math.min(sim + Math.max(0, ctx - prevCtx), ctx);
    sim = grow;
    if (sim > T) {
      compactions++;
      const rewrite = priceUsage({ read: 0, write: floor, fresh: 0, output: 0 }, r.model, priceMisses, rates);
      compactionCostUsd += rewrite;
      usd += rewrite;
      sim = Math.min(floor + (i === 0 ? 0 : Math.max(0, ctx - prevCtx)), ctx);
      freshAfterCompaction = true;
    }
    const scale = ctx > 0 ? sim / ctx : 0;
    // One accumulation per call, in the real series' order: the T=Infinity path must be bit-equal
    // to the direct actual sum, and splitting the add would reassociate the floating point.
    let callUsd;
    if (freshAfterCompaction) {
      callUsd = priceUsage({ read: 0, write: sim, fresh: 0, output: r.output }, r.model, priceMisses, rates);
      freshAfterCompaction = false;
    } else {
      callUsd = priceUsage(
        { read: r.read * scale, write: r.write * scale, fresh: r.fresh * scale, output: r.output },
        r.model,
        priceMisses,
        rates,
      );
    }
    usd += callUsd;

    // Uncapped twin (M-2): no ceiling at `ctx` here, growing or on the post-compaction reset — a
    // real context collapse (a genuine compaction) can leave this sim sitting well above the real
    // context, `scale` above 1, and this call priced above what the real call cost.
    const growUncapped = i === 0 ? Math.min(ctx, T) : simUncapped + Math.max(0, ctx - prevCtx);
    simUncapped = growUncapped;
    if (simUncapped > T) {
      const rewriteUncapped = priceUsage({ read: 0, write: floor, fresh: 0, output: 0 }, r.model, priceMisses, rates);
      usdUncapped += rewriteUncapped;
      simUncapped = floor + (i === 0 ? 0 : Math.max(0, ctx - prevCtx));
      freshAfterCompactionUncapped = true;
    }
    const scaleUncapped = ctx > 0 ? simUncapped / ctx : 0;
    let callUsdUncapped;
    if (freshAfterCompactionUncapped) {
      callUsdUncapped = priceUsage({ read: 0, write: simUncapped, fresh: 0, output: r.output }, r.model, priceMisses, rates);
      freshAfterCompactionUncapped = false;
    } else {
      callUsdUncapped = priceUsage(
        {
          read: r.read * scaleUncapped,
          write: r.write * scaleUncapped,
          fresh: r.fresh * scaleUncapped,
          output: r.output,
        },
        r.model,
        priceMisses,
        rates,
      );
    }
    usdUncapped += callUsdUncapped;
  }
  return { usd, compactions, compactionCostUsd, usdUncapped };
}

// classifyPostCompactionCalls — the D07 half (§2.4.3). Reported with its denominator and with n
// stamped on it; EXCLUDED from the threshold decision by design.
export function classifyPostCompactionCalls(events, completions, windowCalls = POST_COMPACTION_WINDOW_CALLS) {
  const toolCallsByAgent = new Map();
  for (const e of events) {
    if (e?.kind !== "tool_call") continue;
    if (!toolCallsByAgent.has(e.agentId)) toolCallsByAgent.set(e.agentId, []);
    toolCallsByAgent.get(e.agentId).push(e);
  }
  for (const arr of toolCallsByAgent.values()) arr.sort((a, b) => (a.seq ?? a.ts) - (b.seq ?? b.ts));

  let chronicleCalls = 0;
  let denominator = 0;
  let reReads = 0;
  let bashPathsExtracted = 0;
  const reReadsByTool = { Read: 0, Bash: 0, Edit: 0, mcp__ekb__file: 0 };

  for (const c of completions) {
    const arr = toolCallsByAgent.get(c.agentId) ?? [];
    const before = new Set();
    const after = [];
    for (const e of arr) {
      if (e.ts <= c.ts) {
        for (const path of pathsReadBy(e.data)) before.add(path);
      } else if (after.length < windowCalls) {
        after.push(e);
      }
    }
    denominator += after.length;
    for (const e of after) {
      if (isChronicleCall(e.data)) chronicleCalls++;
      const name = e.data?.toolName;
      const paths = pathsReadBy(e.data);
      if (name === "Bash") bashPathsExtracted += paths.length;
      if (paths.some((path) => before.has(path))) {
        reReads++;
        if (name in reReadsByTool) reReadsByTool[name] += 1;
      }
    }
  }

  return {
    windowCalls,
    n: completions.length,
    chronicleCalls,
    chronicleDenominator: denominator,
    reReads,
    reReadsByTool,
    bashPathsExtracted,
    note: `n=${completions.length}; excluded from the threshold decision by design`,
  };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

// firstCacheWrites — mirrors computeSurface's first-usage-per-agent rule deliberately rather than
// widening F45's frozen `surface` shape: §2.4.4 rule 3 needs the p95, and `surface` publishes only
// the median.
function firstCacheWrites(evs) {
  const seen = new Map();
  for (const e of evs) {
    if (e?.kind !== "usage" && e?.kind !== "turn_complete") continue;
    if (seen.has(e.agentId)) continue;
    const u = e.data?.usage;
    if (!u || typeof u !== "object") continue;
    seen.set(e.agentId, u.cache_creation_input_tokens ?? 0);
  }
  return [...seen.values()];
}

const COVERAGE_REASONS = {
  claude: null,
  codex: "emits no usage and no compaction event (codex.ts:21-27, CODEX-COMPACTION-GAP)",
  kimi: "costUsd hardcoded 0 (kimi.ts:1002); compaction event carries no sizes (kimi.ts:462)",
  generic: "no per-call usage — only a cumulative result.costUsd per run (generic.ts:337), so a single compaction cannot be priced",
};

// buildCompactionReport — the artifact shape of plan §2.7. Pure: no Date; I/O only if `events` is a
// factory, and then only re-reading the same log the CLI already named — the CLI stamps generatedAt
// so a given `events` input always produces the same object.
//
// F45.QA-B leftover #3: `events` is a RE-ITERABLE, same contract as `buildReport`'s `source` — either
// a `() => Iterable` factory (what the CLI now passes, re-reading the log per pass instead of holding
// the whole materialized array) or an array (what the synthetic unit tests pass, and what F39/F41 may
// still hand in). A bare one-shot iterator is still accepted and materialized once via `reIterable`.
export function buildCompactionReport(events, opts = {}) {
  const evs = reIterable(events);
  const agents = indexAgents(evs());
  const thresholds = Array.isArray(opts.thresholds) ? opts.thresholds : THRESHOLD_SWEEP;

  let firstTs = Infinity;
  let lastTs = -Infinity;
  for (const e of evs()) {
    if (typeof e?.ts !== "number") continue;
    if (e.ts < firstTs) firstTs = e.ts;
    if (e.ts > lastTs) lastTs = e.ts;
  }
  if (!isFinite(firstTs)) firstTs = 0;
  if (!isFinite(lastTs)) lastTs = 0;

  const {
    series, usageEvents, deltaReemissions, syntheticUsageEvents, syntheticInputTokens, markedSynthetic,
    afterCompactionCalls, afterCompactionWriteTokens, excludedLedgerBillableUsd, unattributedSeriesUsd,
  } = buildCallSeries(evs(), agents);

  let modelCalls = 0;
  let ctxSum = 0;
  for (const rows of series.values()) {
    modelCalls += rows.length;
    for (const r of rows) ctxSum += r.ctx;
  }

  const { completions, starts } = indexCompactions(evs());
  const afterTokens = completions.map((c) => c.after).filter((n) => typeof n === "number");
  const beforeTokens = completions.map((c) => c.before).filter((n) => typeof n === "number");
  const floors = afterTokens.length
    ? { min: Math.min(...afterTokens), median: median(afterTokens), max: Math.max(...afterTokens) }
    : { ...POST_COMPACTION_FLOORS };

  const byOwner = {};
  const byTrigger = {};
  for (const c of completions) {
    byOwner[c.owner] = (byOwner[c.owner] ?? 0) + 1;
    if (c.trigger) byTrigger[c.trigger] = (byTrigger[c.trigger] ?? 0) + 1;
  }

  // coverage — one row per backend class, with the CODE reason a class cannot be priced.
  const coverage = {};
  for (const cls of ["claude", "codex", "kimi", "generic"]) {
    coverage[cls] = { agents: 0, compactions: 0, canPriceCompaction: cls === "claude" };
    if (COVERAGE_REASONS[cls]) coverage[cls].reason = COVERAGE_REASONS[cls];
  }
  const classOf = (provider) => (DEDICATED_PROVIDERS.has(provider) ? provider : "generic");
  for (const a of agents.values()) {
    const cls = classOf(a.provider);
    if (coverage[cls]) coverage[cls].agents += 1;
  }
  for (const c of completions) {
    const cls = classOf(agents.get(c.agentId)?.provider ?? "?");
    if (coverage[cls]) coverage[cls].compactions += 1;
  }

  const priceMisses = new Set();
  // actual.usd is the direct per-call sum. replayThreshold(Infinity) must reproduce it EXACTLY —
  // but that equality (selfCheck.exact, A6a) only proves the replay's scale-path arithmetic is
  // neutral at T=Infinity: a `series` built from the wrong rows would still satisfy it, because
  // simulatedUsd(Infinity) and actualUsd are both derived from the SAME series. The genuine
  // independent check is selfCheck.ledgerCrossCheck (A6b) below, which compares actualUsd against
  // buildSpendLedger's separately-implemented modelledListUsd.
  // Accumulate PER AGENT and then across agents, in the same order and grouping the sweep uses:
  // floating-point addition is not associative, so a flat sum over all calls differs from the
  // sweep's per-agent subtotals in the last bits and turns an exact self-check into a near-miss.
  let actualUsd = 0;
  for (const rows of series.values()) {
    let agentUsd = 0;
    for (const r of rows) agentUsd += priceUsage(r, r.model, priceMisses);
    actualUsd += agentUsd;
  }

  const sweepThresholds = [...thresholds, Infinity];
  const floorLabels = ["min", "median", "max"];
  const sweep = [];
  const spanDays = lastTs > firstTs ? (lastTs - firstTs) / 86_400_000 : 0;
  const agentsCovered = series.size;
  for (const T of sweepThresholds) {
    for (const label of floorLabels) {
      const floor = floors[label];
      let simulatedUsd = 0;
      let simulatedUsdUncapped = 0;
      let compactions = 0;
      let compactionCostUsd = 0;
      for (const rows of series.values()) {
        const r = replayThreshold(rows, T, floor, priceMisses);
        simulatedUsd += r.usd;
        simulatedUsdUncapped += r.usdUncapped;
        compactions += r.compactions;
        compactionCostUsd += r.compactionCostUsd;
      }
      sweep.push({
        threshold: T === Infinity ? null : T,
        floor,
        floorLabel: label,
        simulatedUsd,
        netMultiplier: simulatedUsd > 0 ? actualUsd / simulatedUsd : 0,
        // The uncapped counterfactual (M-2): simulatedUsd clamps a simulated agent's context to
        // never exceed the real one, which makes netMultiplier >= 1 structurally guaranteed and
        // hides the "capping costs more than it saves" scenario R7 requires stay reachable.
        // simulatedUsdUncapped removes that clamp so netMultiplierUncapped can fall below 1.
        simulatedUsdUncapped,
        netMultiplierUncapped: simulatedUsdUncapped > 0 ? actualUsd / simulatedUsdUncapped : 0,
        compactions,
        compactionCostUsd,
        compactionsPerAgentDay: agentsCovered > 0 && spanDays > 0 ? compactions / (agentsCovered * spanDays) : 0,
        agentsCovered,
      });
      if (T === Infinity) break; // the self-check is floor-independent: no compaction ever fires
    }
  }

  // Built before selfCheck (not where F45.QA-A originally placed it, right before calibration)
  // because M-2's ledgerCrossCheck needs modelledListUsd as part of the self-check itself.
  const ledger = buildSpendLedger(evs(), agents);

  const infinityRow = sweep.find((r) => r.threshold === null);
  // A6b (F39.QA-B M-2): actualUsd and ledger.modelledListUsd are built by two independent code
  // paths (buildCallSeries's event-streaming admission vs. buildSpendLedger's spendAcc), so their
  // agreement is real evidence the series is right — unlike A6a above, which only shows the
  // replay's own arithmetic is internally consistent. The two are expected to differ by exactly
  // excludedLedgerBillableUsd: rows buildCallSeries drops from `series` for reasons other than the
  // explicit synthetic marker, which the ledger still bills as real turns (case 18) — MINUS
  // unattributedSeriesUsd, the pruned-`agent_started` agents this side bills and the ledger books
  // to its `unattributed` bucket instead (case 22). Both terms are known asymmetries, so what is
  // left over is the only thing this check is meant to catch: a series built from the wrong rows.
  const expectedLedgerUsd = actualUsd + excludedLedgerBillableUsd - unattributedSeriesUsd;
  const ledgerDeltaUsd = ledger.modelledListUsd - expectedLedgerUsd;
  const selfCheck = {
    netMultiplierAtInfinity: infinityRow ? infinityRow.netMultiplier : 0,
    exact: infinityRow ? infinityRow.simulatedUsd === actualUsd : false,
    ledgerCrossCheck: {
      excludedLedgerBillableUsd,
      unattributedSeriesUsd,
      modelledListUsd: ledger.modelledListUsd,
      expectedUsd: expectedLedgerUsd,
      deltaUsd: ledgerDeltaUsd,
      withinTolerance: Math.abs(ledgerDeltaUsd) <= LEDGER_CROSS_CHECK_TOLERANCE_USD,
    },
  };

  // CALIBRATION (F45.QA-A): the ledger now reports claude spend in TWO units — what the SDK
  // actually billed (result.costUsd) and the list-price model. actual.usd here is the list-price
  // model, because the replay has to re-price counterfactual calls and the SDK cannot be asked
  // about a call that never happened. netMultiplier is a RATIO of two modelled figures, which only
  // cancels the bias if it is a uniform scalar across read/write/fresh pricing — the caveats below
  // (flat WRITE_RATE for every cache write, no >200k premium) say it is NOT, so this is reported as
  // a scale factor to watch, not a cancellation guarantee. See `sensitivity` for the measured effect.
  const calibration = {
    sdkUsd: ledger.claudeSpend.sdkUsd,
    sdkAgents: ledger.claudeSpend.sdkAgents,
    modelledUsdForSdkAgents: ledger.claudeSpend.modelledUsdForSdkAgents,
    modelledOverSdkRatio: ledger.claudeSpend.modelledOverSdkRatio,
    note: "actual.usd and every simulatedUsd are list-price modelled; netMultiplier is their ratio, but the bias only cancels if it is uniform across read/write/fresh pricing, which it is not verified to be — see `sensitivity` for the measured spread",
  };

  const writes = firstCacheWrites(evs());
  const medianFirstCacheWrite = median(writes);
  const p95FirstCacheWrite = percentile(writes, 95);

  // §2.4.4, evaluated at the PESSIMISTIC (max) floor for both the 1.10 bar and the within-5% tie
  // break — a recommendation that only holds at the median floor is not recommendable (A7).
  const atMax = new Map();
  for (const row of sweep) {
    if (row.floorLabel === "max" && row.threshold !== null) atMax.set(row.threshold, row);
  }
  const prefixBar = 2 * p95FirstCacheWrite;
  const survivors = [];
  const rejected = [];
  for (const T of thresholds) {
    const row = atMax.get(T);
    const net = row ? row.netMultiplier : 0;
    if (net < MIN_NET_MULTIPLIER) {
      rejected.push({ threshold: T, netAtPessimisticFloor: net, reason: `netMultiplier < ${MIN_NET_MULTIPLIER} at the pessimistic floor` });
      continue;
    }
    if (T < prefixBar) {
      rejected.push({ threshold: T, netAtPessimisticFloor: net, reason: `below 2x the p95 first-turn cache write (${prefixBar})` });
      continue;
    }
    survivors.push({ threshold: T, netAtPessimisticFloor: net });
  }
  let recommendation;
  if (!survivors.length) {
    recommendation = {
      threshold: null,
      rule: "§2.4.4",
      netAtMedianFloor: 0,
      netAtPessimisticFloor: 0,
      survivors: [],
      rejected,
      prefixBar,
      verdict: "no-default",
    };
  } else {
    const best = Math.max(...survivors.map((s) => s.netAtPessimisticFloor));
    const nearBest = survivors.filter((s) => s.netAtPessimisticFloor >= best * (1 - NEAR_BEST_TOLERANCE));
    const chosen = nearBest.reduce((a, b) => (b.threshold > a.threshold ? b : a));
    const medianRow = sweep.find((r) => r.threshold === chosen.threshold && r.floorLabel === "median");
    // How much unmodelled cost would have to exist to flip this decision. The SDK's own
    // summarization is invisible (A8), so the honest question is not "is it invisible" but "how
    // big would it have to be" — this states the answer in dollars per compaction instead of
    // leaving the reader to compute it from the sweep.
    const chosenMaxRow = atMax.get(chosen.threshold);
    const usdToBar = actualUsd / MIN_NET_MULTIPLIER - (chosenMaxRow ? chosenMaxRow.simulatedUsd : 0);
    recommendation = {
      threshold: chosen.threshold,
      rule: "§2.4.4",
      netAtMedianFloor: medianRow ? medianRow.netMultiplier : 0,
      netAtPessimisticFloor: chosen.netAtPessimisticFloor,
      best,
      survivors,
      rejected,
      prefixBar,
      marginToBar: {
        extraUsdToFlip: usdToBar,
        compactionsAtChoice: chosenMaxRow ? chosenMaxRow.compactions : 0,
        extraUsdPerCompactionToFlip: chosenMaxRow && chosenMaxRow.compactions > 0 ? usdToBar / chosenMaxRow.compactions : 0,
      },
      verdict: "set",
    };
  }

  // M-3 (F39.QA-B): recompute netMultiplier at the CHOSEN threshold, pessimistic floor, across a
  // rates grid — this is the direct answer to "does the decision survive if the ~2.6x list-vs-SDK
  // bias isn't the uniform scalar calibration.note used to assume". Skipped when there is no
  // recommended threshold (verdict "no-default") — there is nothing to stress-test.
  const gridAt = (T, floor) => {
    const grid = [];
    for (const readRate of SENSITIVITY_READ_RATES) {
      for (const writeRate of SENSITIVITY_WRITE_RATES) {
        const rates = { read: readRate, write: writeRate };
        let cellActualUsd = 0;
        let cellSimulatedUsd = 0;
        for (const rows of series.values()) {
          for (const r of rows) cellActualUsd += priceUsage(r, r.model, priceMisses, rates);
          cellSimulatedUsd += replayThreshold(rows, T, floor, priceMisses, rates).usd;
        }
        grid.push({
          readRate,
          writeRate,
          actualUsd: cellActualUsd,
          simulatedUsd: cellSimulatedUsd,
          netMultiplier: cellSimulatedUsd > 0 ? cellActualUsd / cellSimulatedUsd : 0,
        });
      }
    }
    const netMultipliers = grid.map((c) => c.netMultiplier);
    // allClearBar is a deliberately brutal reading of the grid, and on its own it over-reports.
    // SENSITIVITY_READ_RATES includes 0.05 — HALF the cache-read multiplier Anthropic actually
    // charges (READ_RATE = 0.1, scripts/audit-lib.mjs:39). A 0.05 cell dipping under the bar is a
    // ROBUSTNESS BOUND ("how wrong would the modelled read price have to be"), not evidence that
    // the threshold loses money at the prices really billed. These two fields separate the
    // questions allClearBar conflates: does the threshold clear the bar at the rates we are in
    // fact charged (clearsAtBaseline — the bar in §2.4.4 step 2 is defined there), and does it
    // stay profitable at all anywhere in the grid (minAboveBreakeven). Both true => the sub-bar
    // cells are the stress bound doing its job, and the decision is settled, not open.
    const baselineCell = grid.find((c) => c.readRate === READ_RATE && c.writeRate === WRITE_RATE);
    return {
      thresholdEvaluated: T,
      floorEvaluated: floor,
      grid,
      minNetMultiplier: Math.min(...netMultipliers),
      maxNetMultiplier: Math.max(...netMultipliers),
      allClearBar: netMultipliers.every((n) => n >= MIN_NET_MULTIPLIER),
      clearsAtBaseline: baselineCell ? baselineCell.netMultiplier >= MIN_NET_MULTIPLIER : false,
      minAboveBreakeven: Math.min(...netMultipliers) >= 1.0,
    };
  };

  let sensitivity = null;
  if (recommendation.threshold !== null) {
    sensitivity = {
      ...gridAt(recommendation.threshold, floors.max),
      baseline: { readRate: READ_RATE, writeRate: WRITE_RATE },
      // Always emitted, even when it duplicates the block above (recommendation === 120k), so the
      // artifact's shape does not depend on which threshold happened to win this window.
      fleetDefault: gridAt(FLEET_DEFAULT_THRESHOLD, floors.max),
    };
  }

  const caveats = [
    "the SDK's own summarization output tokens are invisible to chimera (owner:\"sdk\", packages/protocol/src/index.ts:1887-1889), so every simulated saving here is an UPPER BOUND on the real one",
    `the post-compaction floor is fitted to n=${completions.length} observed compactions; it is swept over {min, median, max} of the observed after.tokens rather than fixed, and a threshold is only recommended if it wins at the max (pessimistic) floor`,
    "each simulated compaction is charged twice over: a full cache rewrite of the floor AND a full cache write on the next call. The double charge is deliberate pessimism standing in for the SDK summarization call this audit cannot see",
    "all cache writes bill at WRITE_RATE (the 5m rate); the log carries an ephemeral_1h breakdown that neither this replay nor F45's ledger uses",
    "the >200k long-context premium is not in PRICES (see normalizeModel), so a 1M-beta turn is under-priced — this biases the estimate AGAINST tighter thresholds, the opposite direction to the upper-bound caveat above",
    "an agent whose early calls fell out of the retained window starts the replay mid-session, so it is never charged for reaching the cap the first time",
  ];
  if (priceMisses.size) {
    caveats.push(`unpriced models make both actual and simulated spend a floor: ${[...priceMisses].join(", ")}`);
  }
  if (syntheticUsageEvents > 0) {
    caveats.push(
      `${syntheticUsageEvents} synthetic post-compaction usage events (${syntheticInputTokens} input tokens, ${markedSynthetic} of them carrying the F39.0 synthetic:"compaction-baseline" marker) are excluded from actual.usd here; F45's buildSpendLedger (F45.QA-B) also excludes them now and reports the count as spend.syntheticUsageEvents/syntheticInputTokens`,
    );
  }
  if (!selfCheck.exact) {
    caveats.push("SELF-CHECK FAILED: replay at T=Infinity did not reproduce the actual bill exactly — every number below is suspect");
  }
  if (!selfCheck.ledgerCrossCheck.withinTolerance) {
    caveats.push(
      `SELF-CHECK FAILED: actual.usd + excludedLedgerBillableUsd - unattributedSeriesUsd ($${selfCheck.ledgerCrossCheck.expectedUsd.toFixed(6)}) does not match ` +
        `buildSpendLedger.modelledListUsd ($${selfCheck.ledgerCrossCheck.modelledListUsd.toFixed(6)}), delta $${selfCheck.ledgerCrossCheck.deltaUsd.toFixed(6)} — the series may be built from the wrong rows`,
    );
  }
  // F39.THRESHOLD-DECISION: a sub-bar cell is only an ALARM when it says something about the
  // prices we are actually charged. Split the two readings so the artifact stops re-opening a
  // settled ruling every run: baseline-clearing + above-breakeven-everywhere is reported as a
  // finding ("the sub-bar cells are the 0.05-read stress bound"), not as an open question.
  const sensitivityCaveat = (g, subject, unsettledTail) => {
    if (g.allClearBar) return null;
    const range = `netMultiplier ranges ${g.minNetMultiplier.toFixed(2)}..${g.maxNetMultiplier.toFixed(2)} across the read/write rate grid`;
    if (!g.clearsAtBaseline || !g.minAboveBreakeven) {
      return `SENSITIVITY: at ${subject}, ${range} — it does NOT clear ${MIN_NET_MULTIPLIER} in every cell, and ${
        g.clearsAtBaseline
          ? `the grid drops BELOW break-even (1.0) somewhere, so the threshold can cost more than it saves under the modelled bias`
          : `it misses the bar at the BASELINE rates (readRate ${READ_RATE}/writeRate ${WRITE_RATE}) themselves`
      } — ${unsettledTail}`;
    }
    const baselineCell = g.grid.find((c) => c.readRate === READ_RATE && c.writeRate === WRITE_RATE);
    return `SENSITIVITY (informational, decision settled): at ${subject}, ${range}; it clears ${MIN_NET_MULTIPLIER} at the BASELINE rates ` +
      `(readRate ${READ_RATE}/writeRate ${WRITE_RATE}, netMultiplier ${baselineCell.netMultiplier.toFixed(4)}) — where the §2.4.4 step-2 bar is defined — and never falls below ` +
      `break-even (grid min ${g.minNetMultiplier.toFixed(4)} ≥ 1.0). The only sub-bar cells assume readRate 0.05, HALF the cache-read multiplier Anthropic ` +
      `actually charges, so they are a robustness bound rather than a scenario. No revision required.`;
  };
  if (sensitivity) {
    const recCaveat = sensitivityCaveat(
      sensitivity,
      `the recommended threshold (${sensitivity.thresholdEvaluated})`,
      "the recommendation is sensitive to the list-vs-billed pricing bias",
    );
    if (recCaveat) caveats.push(recCaveat);
    const fdCaveat = sensitivityCaveat(
      sensitivity.fleetDefault,
      `the SHIPPED fleet default (${FLEET_DEFAULT_THRESHOLD})`,
      "DEFAULT_COMPACTION_THRESHOLD needs revisiting against this window rather than being treated as settled",
    );
    if (fdCaveat) caveats.push(fdCaveat);
  }

  return {
    schemaVersion: 1,
    eventsHome: typeof opts.eventsHome === "string" ? opts.eventsHome : null,
    window: {
      firstTs,
      lastTs,
      segments: typeof opts.segments === "number" ? opts.segments : 0,
      agents: agents.size,
      modelCalls,
      usageEvents,
      deltaReemissions,
    },
    coverage,
    observed: {
      compactions: completions.length,
      startEvents: starts.length,
      byOwner,
      byTrigger,
      beforeTokens,
      afterTokens,
      floors,
      syntheticUsageEvents,
      syntheticInputTokens,
      markedSynthetic,
      afterCompactionCalls,
      afterCompactionWriteTokens,
      // The measured counterpart of every sweep row's compactionCostUsd, which is modelled from
      // the floor. Equal counts + a rewrite in the same order of magnitude as the floor is the
      // evidence the replay's compaction charge is calibrated rather than asserted.
      afterCompactionMeanWriteTokens: afterCompactionCalls > 0 ? afterCompactionWriteTokens / afterCompactionCalls : 0,
    },
    actual: {
      usd: actualUsd,
      usdFloorNote: "claude only; unpriced models and the >200k premium make this a floor",
      priceTableMisses: [...priceMisses],
      meanCtx: modelCalls > 0 ? ctxSum / modelCalls : 0,
      modelCalls,
      agentsCovered,
      medianFirstCacheWrite,
      p95FirstCacheWrite,
      calibration,
    },
    selfCheck,
    sweep,
    d07: classifyPostCompactionCalls(evs(), completions, opts.windowCalls),
    recommendation,
    sensitivity,
    caveats,
  };
}

// ---------------------------------------------------------------------------------------------
// buildReport — the frozen top-level shape (plan §2.6). Pure: no Date/Math.random, no I/O.
// `generatedAt` is deliberately NOT a key here — the CLI stamps it after calling this function,
// keeping buildReport reproducible for a given `events` input.
// ---------------------------------------------------------------------------------------------

// `source` is a RE-ITERABLE: either a `() => Iterable` factory (what the CLI passes —
// `() => readEvents(home)`, re-reading the segments per pass) or an array (what the tests pass, and
// what F39/F41 hand in). A bare one-shot iterator is still accepted and materialized once, because
// that was the pre-streaming behaviour and dropping it would break any caller passing
// `readEvents(home)` directly — but it forfeits the memory win, which is the whole point.
function reIterable(source) {
  if (typeof source === "function") return source;
  if (Array.isArray(source)) return () => source;
  const materialized = [...source];
  return () => materialized;
}

export function buildReport(source, opts = {}) {
  const events = reIterable(source);
  const directiveTs = typeof opts.since === "number" ? opts.since : DIRECTIVE_TS;
  // Number.isFinite, not typeof: `--l4-bound abc` becomes NaN, and every `chars > NaN` comparison
  // is false — which silently empties overBound and reports a "clean" L4 instead of failing.
  const l4Bound = Number.isFinite(opts.l4BoundChars) ? opts.l4BoundChars : L4_BOUND_CHARS;

  // PASS 1 — everything the pass-2 metrics need as a whole-log index: the agent rows, the
  // toolUseId join map, the per-agent context-read times Q3 looks back over, and the window.
  // It is deliberately ONE loop: three separate iterations would re-read and re-parse the whole
  // 616 MB log three times when `source` is a factory.
  const agentsAcc = agentIndexAcc();
  const toolCallsAcc = toolCallIndexAcc();
  const timesAcc = callTimesAcc();
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let eventCount = 0;
  for (const e of events()) {
    eventCount++;
    if (typeof e?.ts === "number") {
      if (e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    agentsAcc.add(e);
    toolCallsAcc.add(e);
    timesAcc.add(e);
  }
  if (!isFinite(firstTs)) firstTs = 0;
  if (!isFinite(lastTs)) lastTs = 0;

  const agents = agentsAcc.finish();
  const toolCallIndex = toolCallsAcc.finish();
  const callTimesByAgent = timesAcc.finish();

  const window = {
    firstTs,
    lastTs,
    segments: typeof opts.segments === "number" ? opts.segments : 0,
    events: eventCount,
    agents: agents.size,
  };

  // PASS 2 — every per-metric accumulator over one more iteration. Nothing here retains an event.
  const l3A = l3Acc(agents, directiveTs);
  const spendA = spendAcc(agents);
  const q3A = q3Acc(agents, toolCallIndex, callTimesByAgent);
  const l4A = l4Acc(agents, toolCallIndex, l4Bound);
  const surfaceA = surfaceAcc(agents);
  for (const e of events()) {
    l3A.add(e);
    spendA.add(e);
    q3A.add(e);
    l4A.add(e);
    surfaceA.add(e);
  }

  const l3 = l3A.finish();
  const spend = spendA.finish();
  const q3 = q3A.finish();
  const l4 = l4A.finish();
  const surface = surfaceA.finish();

  const caveats = [];
  const anyTruncated = Object.values(q3.byClass).some((c) => c.truncatedCount > 0);
  if (anyTruncated) caveats.push(`tool_result truncation at ${TOOL_RESULT_MAX_CHARS} chars makes the affected Q3/L4 shares floors, not exact values`);
  // QA finding 7: the ratio's two sides are measured differently, and a reader who only sees one
  // number cannot tell. Name both units explicitly, with the n behind each.
  caveats.push(
    `spend.byProviderClass.claude MIXES UNITS: the SDK's own result.costUsd for the ${spend.claudeSpend.sdkAgents} agents that reported one ` +
      `($${spend.claudeSpend.sdkUsd.toFixed(2)}) plus a list-price model for the ${spend.claudeSpend.modelledFallbackAgents} that did not ` +
      `($${spend.claudeSpend.modelledFallbackUsd.toFixed(2)}). codex/generic are SDK result.costUsd throughout, so genericSharePct is now ` +
      `SDK-vs-SDK for ${spend.claudeSpend.sdkAgents}/${spend.claudeSpend.sdkAgents + spend.claudeSpend.modelledFallbackAgents} of the claude denominator. ` +
      `spend.modelledListUsd ($${spend.modelledListUsd.toFixed(2)}) is the same claude spend priced ENTIRELY from the 3-row list table — it is a different unit, not a correction.`,
  );
  // The scale of the gap, measured rather than asserted: the SDK-priced agents are the only ones
  // priced BOTH ways, so their ratio is what the modelled fallback should be read against.
  if (spend.claudeSpend.modelledOverSdkRatio !== null)
    caveats.push(
      `on the ${spend.claudeSpend.sdkAgents} claude agents priced both ways the list-price model runs ` +
        `${spend.claudeSpend.modelledOverSdkRatio.toFixed(2)}x the SDK's own cost ` +
        `($${spend.claudeSpend.modelledUsdForSdkAgents.toFixed(2)} vs $${spend.claudeSpend.sdkUsd.toFixed(2)}), so the ` +
        `$${spend.claudeSpend.modelledFallbackUsd.toFixed(2)} modelled fallback is likely overstated by about that factor — ` +
        `which makes genericSharePct a LOWER bound, i.e. the q4 close verdict is the conservative reading`,
    );
  if (spend.claudeSpend.fallbackPriceTableMisses.length)
    caveats.push(
      `unpriced models make the modelled claude FALLBACK a floor (and so the q4 gate value): ${spend.claudeSpend.fallbackPriceTableMisses.join(", ")}`,
    );
  if (spend.priceTableMisses.length) caveats.push(`unpriced models make spend.modelledListUsd a floor: ${spend.priceTableMisses.join(", ")}`);
  if (spend.unmeasurable.length) caveats.push("kimi spend is unmeasurable (costUsd hardcoded 0) and is excluded from the spend denominator, not counted as $0");
  if (q3.unpriced.results > 0)
    caveats.push(
      `Q3 dollar weighting excludes ${q3.unpriced.results} tool_results (${q3.unpriced.chars} chars) from agents on unpriced models [${q3.unpriced.models.join(", ")}] — they carry $0 weight, and the exclusion is not uniform across classes, so reachableDollarPct is biased`,
    );
  caveats.push("Q3 dollar weighting assumes a tool_result stays in context for every subsequent call — an upper bound that ignores compaction evicting it");
  if (l3.thinWindow) caveats.push("L3 has fewer than 200 turns in one or more before/after windows — the verdict is inconclusive by construction");

  const q4Verdict = spend.genericSharePct >= Q4_THRESHOLD - 1e-9 ? "reopen" : "close";
  const q3Verdict = q3.reachableDollarPct >= Q3_THRESHOLD - 1e-9 ? "reopen" : "close";
  // plan §6 risk table: an unpriced model makes claude spend a floor, so the gate value derived
  // from it is a floor too and the verdict must SAY so rather than read as an exact measurement.
  // Scoped to the FALLBACK misses since QA finding 7: most of the claude denominator is now the
  // SDK's own cost, which the price table cannot miss — annotating the gate off the full
  // priceTableMisses list would mark it a floor for models that no longer feed it.
  const q4Floor = spend.claudeSpend.fallbackPriceTableMisses.length > 0;
  const q3Floor = q3.unpriced.results > 0;

  return {
    schemaVersion: 1,
    eventsHome: typeof opts.eventsHome === "string" ? opts.eventsHome : null,
    window,
    baseline: BASELINE,
    l3,
    l4,
    spend,
    q3,
    surface,
    gates: {
      q4: { question: "generic-backend share of spend", value: spend.genericSharePct, threshold: Q4_THRESHOLD, verdict: q4Verdict, decides: "F38", floor: q4Floor },
      q3: { question: "dollar-weighted chimera-reachable tool_result bytes", value: q3.reachableDollarPct, threshold: Q3_THRESHOLD, verdict: q3Verdict, decides: "F40", floor: q3Floor },
    },
    caveats,
  };
}
