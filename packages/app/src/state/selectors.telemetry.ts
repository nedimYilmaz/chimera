import type { AgentView, UiState } from "@chimera/ui-state";
import { effectiveContextLimitForAgent, fullContextTokens, isTerminalState } from "./selectors";

// FLEET-TELEMETRY: the pure half of the live dashboard — every number it draws is computed here,
// so the panel component stays a renderer and the arithmetic is unit-testable without a DOM.
//
// Everything comes from state the store already holds (the event stream keeps it current); there
// is no new RPC and no daemon change. What this file adds is SHAPE: turning ~1000 agent views
// into the handful of aggregates a human can actually read at a glance, plus a fixed-size time
// series so the panel can animate without accumulating memory for the life of the window.

/** A live agent is one that could still do work — terminal states are history, not fleet. */
export function isLiveAgent(a: AgentView): boolean {
  return !a.shadow && !isTerminalState(a.state) && a.state !== "unknown";
}

export function usageTotal(u: AgentView["usage"]): number {
  if (!u) return 0;
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}

export type Bucket = { key: string; agents: number; tokens: number; costUsd: number };

export type FleetTelemetry = {
  /** live = running + paused; busy = actually mid-turn right now. */
  live: number;
  busy: number;
  paused: number;
  /** THE headline: what share of the open fleet is actually working. A fleet of 20 agents with
   * 3 busy is 15% — the number that says "you are paying attention to capacity that is idle".
   * 0 when nothing is live, never NaN (a 0/0 ratio rendered as "NaN%" is how a dashboard loses
   * the reader's trust on its very first empty moment). */
  busyRatio: number;
  queued: number;
  tokens: number;
  costUsd: number;
  /** Summed across live agents only — a finished agent's context is not occupying anything. */
  ctxUsed: number;
  ctxLimit: number;
  byModel: Bucket[];
  byEffort: Bucket[];
  /** Live agents by cost, richest first — the "what is this run costing me" list. */
  topCost: Array<{ agentId: string; label: string; costUsd: number; tokens: number; ctxPct: number }>;
  /** TOOL-METRICS: what the fleet is actually DOING, split by where the tool comes from.
   * An MCP tool is identifiable by its own name — the `mcp__<server>__<tool>` convention — so
   * the split needs no extra plumbing, and "which MCP servers are earning their keep" becomes a
   * question the dashboard can answer instead of one you infer from transcripts. */
  tools: Bucket[];
  mcpServers: Bucket[];
  toolCalls: number;
  mcpCalls: number;
  /** COMPACTION-VISIBLE-STATE: how many live agents have compacted at least once, and how many
   * compactions there have been in total this session. Answers "is compaction actually
   * happening?" — a question the transcript banner alone cannot, since it scrolls away. */
  compactedAgents: number;
  compactions: number;
  /** The most context-pressured live agents, fullest first — who is about to compact. */
  ctxPressure: Array<{ agentId: string; label: string; pct: number; used: number; limit: number; known: boolean; compactions: number }>;
};

const bucketize = (rows: Array<{ key: string; tokens: number; costUsd: number }>): Bucket[] => {
  const by = new Map<string, Bucket>();
  for (const r of rows) {
    const b = by.get(r.key) ?? { key: r.key, agents: 0, tokens: 0, costUsd: 0 };
    b.agents += 1; b.tokens += r.tokens; b.costUsd += r.costUsd;
    by.set(r.key, b);
  }
  // Biggest consumer first: a distribution chart sorted by name makes the reader do the ranking.
  return [...by.values()].sort((a, b) => b.tokens - a.tokens || b.agents - a.agents);
};

// TOOL-METRICS: call counts reuse the Bucket shape so the same bar renderer draws them; `tokens`
// carries the CALL count here (that is what the bar is proportional to) and `costUsd` stays 0 —
// a tool call has no cost of its own, and inventing one would be worse than omitting it.
const toBuckets = (m: Map<string, { calls: number; agents: Set<string> }>): Bucket[] =>
  [...m.entries()]
    .map(([key, e]) => ({ key, agents: e.agents.size, tokens: e.calls, costUsd: 0 }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));

// mcp__<server>__<tool>: the server is the middle segment, the tool the last.
const MCP_TOOL_NAME = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

// TOOL-METRICS-BASH-BREAKDOWN: "Bash ×140" is the least informative row a fleet dashboard can
// show — it is the shell, not the work. What an operator actually wants to know is whether those
// 140 calls were git, grep, aws or gcloud, because that is the difference between an agent
// reading code and an agent touching cloud infrastructure.
//
// The leading executable is the honest answer, and getting to it means stepping over the noise
// agents habitually put in front of it: a `cd <dir> &&` prefix, `sudo`, `env -u FOO`, and inline
// VAR=value assignments. A pipeline is attributed to its FIRST command — imperfect for
// `cat x | grep y`, but the first command is the intent-bearing one far more often than not, and
// splitting a pipeline across several buckets would inflate the totals into something that no
// longer counts calls.
const SHELL_PREFIXES = new Set(["sudo", "command", "nohup", "time", "exec"]);

export function bashCommandName(command: string): string | null {
  let rest = command.trim();
  // `cd /somewhere && real-command ...` — take what runs, not the navigation.
  for (;;) {
    const cd = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(rest);
    if (!cd) break;
    rest = rest.slice(cd[0].length);
  }
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }        // VAR=value ... 
    if (SHELL_PREFIXES.has(t)) { i++; continue; }
    if (t === "env") {                                                 // env -u FOO -u BAR cmd
      i++;
      while (i < tokens.length && (tokens[i] === "-u" || tokens[i] === "-i")) i += tokens[i] === "-u" ? 2 : 1;
      continue;
    }
    break;
  }
  const head = tokens[i];
  if (!head) return null;
  // /usr/bin/git -> git; a bare "(" or similar punctuation is not a command name.
  const name = head.split("/").pop() ?? head;
  return /^[A-Za-z0-9_.@+-]+$/.test(name) ? name : null;
}

// The label a tool call is counted under. Bash splits by the CLI it ran; an MCP tool is shown as
// "server · tool" because the raw mcp__a__b names are long enough that the panel truncated four
// different tools into four identical-looking "mcp__plugin…" rows.
function toolBucketLabel(call: { toolName: string; input?: unknown }): string {
  if (call.toolName === "Bash") {
    const input = call.input as { command?: unknown } | undefined;
    const command = typeof input?.command === "string" ? bashCommandName(input.command) : null;
    return command ? `Bash · ${command}` : "Bash";
  }
  const mcp = MCP_TOOL_NAME.exec(call.toolName);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : call.toolName;
}

export function fleetTelemetry(state: UiState): FleetTelemetry {
  const agents = Object.values(state.agents).filter(isLiveAgent);
  let busy = 0, paused = 0, tokens = 0, costUsd = 0, ctxUsed = 0, ctxLimit = 0;
  let compactedAgents = 0, compactions = 0;
  // TOOL-METRICS: counted per CALL, not per agent — "Bash ×400" is the useful figure, and the
  // agent count rides along so a tool used heavily by one agent is distinguishable from one used
  // lightly by twenty.
  const toolCounts = new Map<string, { calls: number; agents: Set<string> }>();
  const mcpCounts = new Map<string, { calls: number; agents: Set<string> }>();
  const pressure: FleetTelemetry["ctxPressure"] = [];
  const modelRows: Array<{ key: string; tokens: number; costUsd: number }> = [];
  const effortRows: Array<{ key: string; tokens: number; costUsd: number }> = [];
  const cost: FleetTelemetry["topCost"] = [];

  for (const a of agents) {
    const t = usageTotal(a.usage);
    const c = a.costUsd || 0;
    if (a.busy) busy++;
    if (a.state === "paused") paused++;
    tokens += t; costUsd += c;
    const limit = effectiveContextLimitForAgent(a);
    // CTX-BASIS: context occupancy is input+cacheRead+cacheCreation (fullContextTokens), NOT the
    // billable total — `output` is billed for the turn that produced it but is not what fills the
    // window going in. Using usageTotal here would overstate every bar, and inconsistently so
    // (a chatty agent more than a terse one at the same real occupancy).
    // CTX-VS-BILLABLE: the dedicated ctx baseline when present — `usage`'s `result` source is
    // cumulative and would climb past the window (observed live: 471k against a 200k limit).
    const known = a.ctxUsage != null && limit > 0;
    const ctx = known ? fullContextTokens(a.ctxUsage!) : 0;
    if (known) { ctxUsed += ctx; ctxLimit += limit; }
    if ((a.compactions ?? 0) > 0) { compactedAgents++; compactions += a.compactions ?? 0; }
    pressure.push({
      agentId: a.agentId, label: a.displayLabel?.trim() || a.agentId.slice(0, 8),
      pct: limit > 0 ? Math.min(100, (ctx / limit) * 100) : 0,
      used: ctx, limit, known, compactions: a.compactions ?? 0,
    });
    for (const call of a.tools ?? []) {
      const bump = (m: Map<string, { calls: number; agents: Set<string> }>, key: string) => {
        const e = m.get(key) ?? { calls: 0, agents: new Set<string>() };
        e.calls++; e.agents.add(a.agentId); m.set(key, e);
      };
      bump(toolCounts, toolBucketLabel(call));
      // mcp__<server>__<tool> — the server is the middle segment.
      const mcp = MCP_TOOL_NAME.exec(call.toolName);
      if (mcp) bump(mcpCounts, mcp[1]!);
    }
    modelRows.push({ key: a.model ?? "—", tokens: t, costUsd: c });
    // An agent with no explicit effort is running the provider's own default — say so rather
    // than inventing a level it never asked for.
    effortRows.push({ key: a.effort ?? "default", tokens: t, costUsd: c });
    cost.push({
      agentId: a.agentId,
      label: a.displayLabel?.trim() || a.agentId.slice(0, 8),
      costUsd: c, tokens: t,
      ctxPct: limit > 0 ? Math.min(100, (ctx / limit) * 100) : 0,
    });
  }

  const queued = state.queues.items.reduce((n, q) => {
    const counts = (q as { counts?: Record<string, number> }).counts;
    return n + (counts?.["pending"] ?? 0) + (counts?.["blocked"] ?? 0);
  }, 0);

  return {
    live: agents.length,
    busy, paused,
    busyRatio: agents.length > 0 ? busy / agents.length : 0,
    queued, tokens, costUsd, ctxUsed, ctxLimit,
    byModel: bucketize(modelRows),
    byEffort: bucketize(effortRows),
    topCost: cost.sort((a, b) => b.costUsd - a.costUsd).slice(0, 5),
    compactedAgents, compactions,
    tools: toBuckets(toolCounts),
    mcpServers: toBuckets(mcpCounts),
    toolCalls: [...toolCounts.values()].reduce((n, e) => n + e.calls, 0),
    mcpCalls: [...mcpCounts.values()].reduce((n, e) => n + e.calls, 0),
    ctxPressure: pressure.sort((a, b) => b.pct - a.pct).slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// rolling series
// ---------------------------------------------------------------------------
// FLEET-TELEMETRY: a FIXED-length ring, not a growing array. The panel animates a few minutes of
// history; keeping every sample for the life of the window would leak steadily in exactly the
// long-lived session this app is built for.

export type Sample = { t: number; tokens: number; costUsd: number; busy: number; live: number };
export const SERIES_CAPACITY = 120;   // at the 1Hz sampler below: two minutes of history

export function pushSample(series: readonly Sample[], s: Sample, capacity = SERIES_CAPACITY): Sample[] {
  const next = [...series, s];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** Per-second RATE between consecutive samples, since `tokens`/`costUsd` are cumulative totals.
 * A drop (a purge, an agent going terminal) yields 0 rather than a negative spike — the reader
 * should see "nothing happened", not a downward cliff that looks like data loss. */
export function rates(series: readonly Sample[]): Array<{ t: number; tokensPerSec: number; costPerSec: number }> {
  const out: Array<{ t: number; tokensPerSec: number; costPerSec: number }> = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]!, b = series[i]!;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    out.push({
      t: b.t,
      tokensPerSec: Math.max(0, (b.tokens - a.tokens) / dt),
      costPerSec: Math.max(0, (b.costUsd - a.costUsd) / dt),
    });
  }
  return out;
}

/** Points → an SVG polyline path, scaled to the box. Flat/empty input renders a flat baseline
 * rather than dividing by a zero range. */
export function sparkPath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)},${(height - ((v - min) / span) * height).toFixed(2)}`)
    .join(" ");
}
