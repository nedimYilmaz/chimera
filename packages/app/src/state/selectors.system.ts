// W6 — PURE selectors/formatters for the system surfaces (help projection,
// budget-pause detection, result-card meta, account-row spend). No React, no
// store imports — unit-testable exactly like selectors.ts.
import type { AgentResultDetail, AgentView, PeerStatus, UiState } from "@chimera/ui-state";
import { displayChord, type KeymapRow } from "../keymap";
import { fmtCost, fmtTokens } from "./selectors";

// ---------------------------------------------------------------------------
// help columns (coverage B11: "keymap tablosundan ÜRETİLİR — elle liste yasak")
// ---------------------------------------------------------------------------

export type HelpEntry = { chord: string; label: string };
export type HelpColumn = { title: string; entries: HelpEntry[] };

const CHORD_GLYPHS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/** Arrow keys render as glyphs; everything else (incl. every mod+letter row)
 * renders via displayChord — "⌘e" on macOS, "Ctrl+e" elsewhere (KEYMAP-REDESIGN
 * rule 1). Live navigator read, not baked at build time, so the same HelpScreen
 * bundle shows the right modifier on whichever OS runs it. */
function prettyChord(chord: string): string {
  return CHORD_GLYPHS[chord] ?? displayChord(chord);
}

/** The three help columns (mock s_help: global · agents · panes & mouse),
 * generated FROM the keymap rows — never a hand list. Rules, all mechanical:
 *  - unbound rows are skipped (B11: every chord shown resolves to a handler);
 *  - the numeric tab rows collapse into one "1-N jump to tab" range entry;
 *  - consecutive same-scope rows sharing a label merge chords ("↑↓ select");
 *  - column 3 folds the four coordination scopes, then merges rows sharing a
 *    chord across scopes by joining their labels ("new team / push task"). */
export function helpColumns(rows: readonly KeymapRow[]): HelpColumn[] {
  const bound = rows.filter((r) => !r.unbound);

  const mergeConsecutive = (list: readonly KeymapRow[]): HelpEntry[] => {
    const out: HelpEntry[] = [];
    for (const r of list) {
      const prev = out[out.length - 1];
      const chord = prettyChord(r.chord);
      if (prev && prev.label === r.label) {
        // arrow pairs join glyph-tight ("↑↓"); everything else " / "
        prev.chord = /^[↑↓←→]$/.test(chord) && /^[↑↓←→]+$/.test(prev.chord)
          ? prev.chord + chord
          : `${prev.chord} / ${chord}`;
        continue;
      }
      out.push({ chord, label: r.label });
    }
    return out;
  };

  // column 1 — global scope; numeric tab chords collapse into one range row.
  const globalRows = bound.filter((r) => r.scope === "global");
  const tabDigits = globalRows.filter((r) => /^\d$/.test(r.chord) && r.action.startsWith("tab."));
  const globalRest = globalRows.filter((r) => !tabDigits.includes(r));
  const globalEntries: HelpEntry[] = [];
  if (tabDigits.length > 0) {
    const digits = tabDigits.map((r) => Number(r.chord)).sort((a, b) => a - b);
    globalEntries.push({
      chord: digits.length > 1 ? `${digits[0]}-${digits[digits.length - 1]}` : String(digits[0]),
      label: "jump to tab",
    });
  }
  globalEntries.push(...mergeConsecutive(globalRest));

  // column 2 — agents scope.
  const agentEntries = mergeConsecutive(bound.filter((r) => r.scope === "agents"));

  // column 3 — the coordination scopes, cross-scope chord fold.
  const coordScopes = new Set(["teams", "queues", "events", "memory"]);
  const perScope = mergeConsecutive(bound.filter((r) => coordScopes.has(r.scope)));
  const byChord = new Map<string, HelpEntry>();
  for (const e of perScope) {
    const prev = byChord.get(e.chord);
    if (!prev) byChord.set(e.chord, { ...e });
    else if (!prev.label.split(" / ").includes(e.label)) prev.label = `${prev.label} / ${e.label}`;
  }

  return [
    { title: "global", entries: globalEntries },
    { title: "agents", entries: agentEntries },
    { title: "panes & mouse", entries: [...byChord.values()] },
  ];
}

// ---------------------------------------------------------------------------
// budget pause (coverage A6-3 / B7 banner): the supervisor emits a status
// event {paused:true, reason:"budget", treeId, totalCostUsd, maxBudgetUsd} on
// agentId=treeId when a tree first breaches its cap. A genuine over-cap pause
// is released only by the operator-only `budget.resume` RPC (see the app's
// resume button), but a PROVISIONAL live-estimate pause can self-reconcile —
// the supervisor then emits {paused:false, reason:"budget", treeId} on the
// same tree (see BUDGET-UNPAUSE-INVISIBLE note on budgetPauseForSelected
// below).
// ---------------------------------------------------------------------------

export type BudgetPause = {
  treeId: string;
  maxBudgetUsd: number;
  totalCostUsd: number;
  estimatedUsd: number;
  afterResume: boolean;
};

/** Latest budget-pause event for the SELECTED agent's tree, else null. Scans
 * the (bounded, 200-slot) event ring newest-first; a pause older than the
 * ring's window is out of sight until re-selected data arrives — documented
 * residual (the daemon holds the authoritative pausedTrees set).
 *
 * BUDGET-UNPAUSE-INVISIBLE: applyCostToNode (supervisor.ts) emits a REAL
 * {paused:false, reason:"budget", treeId} event when a provisional
 * over-estimate reconciles back under budget — this is not rare, it's the
 * normal outcome of BUDGET-LIVE-ESTIMATE-REVERSIBLE. Must stop at the first
 * paused:false for this tree, else a long-since-resumed tree still renders
 * the "paused, needs a daemon restart" banner off a stale paused:true. */
export function budgetPauseForSelected(state: UiState): BudgetPause | null {
  const sel = state.selectedAgentId;
  if (!sel) return null;
  const view = state.agents[sel];
  const treeId = view?.treeId ?? sel;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]!;
    if (e.kind !== "status") continue;
    if (e.data["reason"] !== "budget") continue;
    const eventTree = typeof e.data["treeId"] === "string" ? (e.data["treeId"] as string) : e.agentId;
    if (eventTree !== treeId) continue;
    if (e.data["paused"] === false) return null;
    if (e.data["paused"] !== true) continue;
    return {
      treeId,
      maxBudgetUsd: Number(e.data["maxBudgetUsd"] ?? 0),
      totalCostUsd: Number(e.data["totalCostUsd"] ?? 0),
      estimatedUsd: Number(e.data["estimatedUsd"] ?? 0),
      afterResume: e.data["afterResume"] === true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// hold pause (idea-backlog "pause reasons invisible in UI"): supervisor.ts's
// parkPaused() emits status{state:"paused", paused:true, reason, resumeScheduledAt,
// ...} for THREE non-budget HOLDs — session-limit, crash-loop-backoff, reattach-
// recovery — but until now the reducer treated every non-terminal status state
// (STATUS_TERMINAL_STATE in reducer.ts deliberately excludes "paused") as a no-op,
// so only reason:"budget" ever got a banner (budgetPauseForSelected above). Unlike
// a budget pause (released only via the operator's budget.resume), these three auto-resume — the
// resume path re-emits status{state:"running", resumed:true} — so this scan must
// stop at whichever status event is NEWEST for the agent, pause or resume/terminal,
// not just the newest pause (else a long-resumed agent would show "paused" forever).
// ---------------------------------------------------------------------------

const HOLD_PAUSE_REASONS = new Set(["session-limit", "crash-loop-backoff", "reattach-recovery"]);

export type HoldPauseReason = "session-limit" | "crash-loop-backoff" | "reattach-recovery" | "daemon-restart" | "idle-timeout";
export type HoldPause = {
  agentId: string;
  reason: HoldPauseReason;
  resumeScheduledAt: number | null;
  detail: string | null;
};

/** Latest active session-limit/crash-loop/reattach HOLD for the SELECTED agent,
 * else null. Scans the event ring newest-first (same bounded-window residual as
 * budgetPauseForSelected) for this agentId's own status events. */
export function holdPauseForSelected(state: UiState): HoldPause | null {
  const sel = state.selectedAgentId;
  if (!sel) return null;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]!;
    if (e.kind !== "status" || e.agentId !== sel) continue;
    const reason = e.data["reason"];
    if (e.data["paused"] === true && typeof reason === "string" && HOLD_PAUSE_REASONS.has(reason)) {
      return {
        agentId: sel,
        reason: reason as HoldPauseReason,
        resumeScheduledAt: typeof e.data["resumeScheduledAt"] === "number" ? e.data["resumeScheduledAt"] : null,
        detail: typeof e.data["detail"] === "string" ? e.data["detail"] : null,
      };
    }
    // Any other status carrying a terminal or running state for this agent means the
    // HOLD (if any preceded it) already cleared — stop here rather than scanning past it.
    if (e.data["state"] === "running" || e.data["state"] === "failed" || e.data["state"] === "killed") return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// result card meta (mock line 354: "$0.31 · 2.4k tok · 4 turns · 1m 48s")
// ---------------------------------------------------------------------------

/** "1m 48s" — whole-second m/s duration (mock's result-card style). */
export function fmtDurationLong(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** The header meta parts, best-effort over what the wire actually carries:
 * $ from agent.result's costUsd; tokens from the AgentView usage tally; turns
 * from the agent's last result EVENT (num_turns rides the event, not the
 * record); duration from the status record's createdAt → lastEventTs. Absent
 * parts are simply omitted (never a fabricated number). */
export function resultMetaParts(
  detail: AgentResultDetail,
  agent: Pick<AgentView, "usage" | "lastEventTs">,
  events: UiState["events"],
  agentKey: string,
): string[] {
  // costUsd read defensively — an agent.result reply without it must not
  // crash the card (re-verify minor; pre-existing W6 gap).
  const parts: string[] = typeof detail.result.costUsd === "number" ? [fmtCost(detail.result.costUsd)] : [];
  if (agent.usage) parts.push(`${fmtTokens(agent.usage.input + agent.usage.output)} tok`);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.agentId !== agentKey || e.kind !== "result") continue;
    const turns = e.data["num_turns"] ?? e.data["numTurns"];
    if (typeof turns === "number") parts.push(`${turns} turns`);
    break;
  }
  // Duration basis: createdAt → lastEventTs when sane; when the status
  // snapshot's createdAt POSTDATES the last event (a restored/re-attached
  // record — W6 review minor: the card silently lost its duration), fall back
  // to the events ring's own first→last span for this agent. Still omitted
  // when neither basis yields a positive span (never a fabricated number).
  const createdAt = detail.status["createdAt"];
  if (typeof createdAt === "number" && agent.lastEventTs > createdAt) {
    parts.push(fmtDurationLong(agent.lastEventTs - createdAt));
  } else {
    let first: number | null = null;
    let last: number | null = null;
    for (const e of events) {
      if (e.agentId !== agentKey) continue;
      if (first === null) first = e.ts;
      last = e.ts;
    }
    if (first !== null && last !== null && last > first) parts.push(fmtDurationLong(last - first));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// accounts card rows (coverage B7 row 1)
// ---------------------------------------------------------------------------

/** Spend-today column: from the daemon.status account record when the field
 * is present (WD ledger is engine-total today, not yet per-account), else the
 * documented '—'. Read defensively off the raw record. */
export function accountSpendLabel(record: Record<string, unknown>): string {
  const v = record["spendTodayUsd"];
  return typeof v === "number" ? fmtCost(v) : "—";
}

// ---------------------------------------------------------------------------
// peer chip aggregation (F01 · coverage B1: "N>1 → ⇅ 2 peers")
// ---------------------------------------------------------------------------

export type PeerChipModel =
  /** Exactly one peer — today's per-peer form ("⇅ studio 0 out"). */
  | { kind: "single"; engineId: string; partitioned: boolean; outboxPending: number }
  /** N>1 peers collapse into ONE chip ("⇅ 2 peers"); danger tone when ANY
   * peer is partitioned; `title` lists every peer for the hover tooltip. */
  | { kind: "aggregate"; count: number; partitioned: boolean; outboxPending: number; title: string };

/** Model for the top-bar ⇅ peer chip(s). null = unfederated (render nothing).
 * A peer is partitioned whenever its state ≠ "connected" (the daemon.status
 * vocabulary). Pure — the component maps the model to markup/tone. */
export function peerChipModel(peers: readonly PeerStatus[]): PeerChipModel | null {
  if (peers.length === 0) return null;
  if (peers.length === 1) {
    const p = peers[0]!;
    return {
      kind: "single",
      engineId: p.engineId,
      partitioned: p.state !== "connected",
      outboxPending: p.outboxPending,
    };
  }
  const partitioned = peers.some((p) => p.state !== "connected");
  const outboxPending = peers.reduce((n, p) => n + p.outboxPending, 0);
  const title = peers
    .map((p) => `⇅ ${p.engineId} ${p.state}${p.outboxPending > 0 ? ` · ${p.outboxPending} out` : ""}`)
    .join(" · ");
  return { kind: "aggregate", count: peers.length, partitioned, outboxPending, title };
}

// ---------------------------------------------------------------------------
// toast single slot (F01: "one slot" — notice + lastError never stack)
// ---------------------------------------------------------------------------

export type ToastPick = { channel: "error" | "note"; message: string } | null;

/** The ONE toast the slot shows. An error outranks a notice whenever both are
 * live (errors are actionable — the "mod+u accounts" hint); with no error the
 * current notice shows; nothing when both are clear. Pure — the two channels
 * self-dismiss independently in the component, so "latest wins" among them
 * reduces to error-outranks-notice on the two surviving values. */
export function pickToast(notice: string | null, lastError: string | null): ToastPick {
  if (lastError !== null) return { channel: "error", message: lastError };
  if (notice !== null) return { channel: "note", message: notice };
  return null;
}
