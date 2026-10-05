import { BranchNotice } from "./ForkAgentOverlay";
import { onOpenBookmark } from "../state/workspaceTools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView, UiState } from "@chimera/ui-state";
import { worktreeLeaseChips } from "@chimera/ui-state";
import type { ChronicleSearchHit, ChronicleSearchResponse, NormalizedEvent } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { VoiceConversationPanel } from "./VoiceConversationPanel";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { requestOlderHistoryPage } from "../state/history";
import { errorText } from "../state/errorText";
import {
  canInterruptSelected,
  composerLocal,
  useAgentStatus,
  useComposerLocal,
  useProviderDefaultModels,
  type QuoteSlot,
} from "../state/commands.agents";
import { resolveActiveTargets } from "./Composer";
import { conductorLabel, derivedState, displayName, effectiveContextLimitForAgent, fmtClock, fmtDurationSec, fullContextTokens, pushRing, stateVisual, transcriptEmptyState, type Tone } from "../state/selectors";
import { str, taskRowView } from "../state/selectors.coord";
import { SearchBox } from "./SearchBox";
import {
  liveTaskStepAgentId,
  taskAgentTotals,
  taskStepAgentIds,
  taskWorkflowBinding,
  workflowFlowBarView,
  type AgentMetaForTask,
  type StitchedStepSection,
  type WorkflowRow,
} from "../state/selectors.workflows";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { getGroupsCommands } from "../state/commands.groups";
import { TASK_STATE_VISUAL } from "./AgentList";
import { Collapse } from "./Collapse";
import { MessageBody } from "./MessageBody";
import { Panel } from "./Panel";
import {
  StreamGlow,
  TranscriptSegment,
  useTranscriptCopyOnSelect,
  useTranscriptKeyboard,
  useTranscriptRawRegistry,
  useTranscriptScroll,
} from "./TranscriptSegment";
import { TranscriptHeader } from "./TranscriptHeader";
import { AgentTerminal } from "./AgentTerminal";
import { WorkflowFlowBar } from "./WorkflowFlowBar";
import { ComputerUseMonitor } from "./ComputerUseMonitor";
import { useSystemLocal } from "../state/commands.system";
import { runAction } from "../keymap";
import styles from "./TranscriptPanel.module.css";
import { registerActionHandler } from "../keymap";
import { setHighlightQuery } from "../state/transcriptHighlight";
import { applyMatchCursor, matchElements, nextMatchIndex } from "../state/transcriptFind";

// W3 — the right transcript pane; W4 adds: Markdown assistant/result bodies,
// the inline ToolDetailCard (mod+e / ToolStrip click — it renders IN PLACE
// of the inspected strip, the mock's showToolDetail/n_toolDetail pair),
// clickable image chips, local-echo timestamps (commands.agents.ts echo
// registry), and the esc-interrupt hint gated on the SAME predicate the esc
// chain's interrupt tier uses (B4: the hint shows iff esc would interrupt).
//
// WORKFLOW-UI-3: the per-agent block-rendering machinery (tsList, lineage,
// artifacts/mentions, tool-detail, Block itself) now lives in
// TranscriptSegment.tsx, shared verbatim with this panel's own per-step
// sections — this file keeps only what's genuinely panel-level: header,
// scroll region, keyboard shortcuts, TaskPromptCard.
//
// WORKFLOW-UI-4 — the final fold: StitchedTranscriptPanel is gone. A task-row
// selection (AgentsScreen) now passes the `workflow` prop instead of mounting
// a second component; this panel switches its whole body between "one agent,
// no chrome" and "task chrome (WorkflowFlowBar + summed header) + N stitched
// step sections" off `workflow !== undefined`, but the header/scroll/keyboard
// plumbing is a single code path either way — a task is just several agents'
// transcripts glued into one scroller instead of one agent's.

// Exported so a workflow header can track the CURRENT live step agent's token
// rate with the same sparkline math the plain single-agent header uses.
export function useTokenRing(agentKey: string, total: number | null, measuredAt?: number): number[] {
  const ref = useRef<{ key: string; total: number | null; ts: number; ring: number[] }>({ key: "", total: null, ts: 0, ring: [] });
  const [ring, setRing] = useState<number[]>([]);
  useEffect(() => {
    const ts = measuredAt ?? 0;
    const previous = ref.current;
    // Loading history and switching agents establish a baseline, never throughput.
    // Event time measures consumption; render time only measures how fast history loaded.
    const reset = previous.key !== agentKey || total === null || previous.total === null
      || !ts || !previous.ts || Date.now() - ts > 60000 || ts < previous.ts || total < previous.total;
    if (reset) {
      ref.current = { key: agentKey, total, ts, ring: [] };
      setRing([]);
      return;
    }
    if (ts === previous.ts || total === previous.total) return;
    const next = pushRing(previous.ring, (total - previous.total!) * 60000 / (ts - previous.ts));
    ref.current = { key: agentKey, total, ts, ring: next };
    setRing(next);
  }, [agentKey, total, measuredAt]);
  useEffect(() => {
    if (!ring.length || !measuredAt) return;
    const timer = setTimeout(() => { ref.current = { ...ref.current, total: null, ring: [] }; setRing([]); }, Math.max(0, measuredAt + 60000 - Date.now()));
    return () => clearTimeout(timer);
  }, [ring, measuredAt]);
  return ring;
}

// TASK-PROMPT (user request): the FIRST thing a spawned agent's transcript
// shows is the TASK it was given + WHO gave it — the transcript otherwise opens
// on the agent's own first reply, with the actual assignment invisible. Data
// comes from agent.status (spec.prompt + parentId/principal/membership); the
// attribution prefers the real spawner (parentId → its display name), then a
// schedule ("job:X"), then the team·role the scheduler drained it for. Long
// task prompts (team briefs run to KBs) start COLLAPSED to a one-line preview;
// clicking toggles the full markdown-rendered prompt. Single-agent mode only —
// a task's own per-step assignment is already shown by StepHeader below.
function TaskPromptCard({ status, agents }: {
  status: Record<string, unknown>;
  agents: Record<string, AgentView>;
}) {
  const [open, setOpen] = useState(false);
  const spec = status["spec"] && typeof status["spec"] === "object" ? (status["spec"] as Record<string, unknown>) : null;
  const prompt = spec && typeof spec["prompt"] === "string" ? (spec["prompt"] as string).trim() : "";
  if (!prompt) return null;
  const parentId = typeof status["parentId"] === "string" ? (status["parentId"] as string) : null;
  // CROSS-PROVIDER-HANDOFF: the reverse edge from parentId — this agent's context was BUILT
  // FROM handoffFrom's, not spawned by it calling agent.spawn. Same attribution priority slot
  // as parentId (a handoff target never has both set — see supervisor.handoff).
  const handoffFrom = typeof status["handoffFrom"] === "string" ? (status["handoffFrom"] as string) : null;
  const handoffTo = typeof status["handoffTo"] === "string" ? (status["handoffTo"] as string) : null;
  const principal = typeof status["principal"] === "string" ? (status["principal"] as string) : "";
  const membership = status["membership"] && typeof status["membership"] === "object" ? (status["membership"] as Record<string, unknown>) : null;
  const from = parentId
    ? conductorLabel(agents, parentId)
    : handoffFrom
      ? `${conductorLabel(agents, handoffFrom)} (handoff)`
      : principal.startsWith("job:")
        ? `schedule ${principal.slice(4)}`
        : membership && typeof membership["team"] === "string"
          ? `team ${membership["team"]}${typeof membership["role"] === "string" ? ` · ${membership["role"]}` : ""}`
          : principal || "local";
  const preview = prompt.split("\n")[0]!.slice(0, 160);
  return (
    <div className={styles.taskCard} data-task-prompt>
      <div className={styles.taskHead} role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}>
        <span className={styles.taskGlyph}>{open ? "▾" : "▸"}</span> task
        <span className={styles.taskFrom}> · from {from}</span>
      </div>
      {/* CROSS-PROVIDER-HANDOFF badge, source side: this agent settled "done" by handing off
          to a fresh agent elsewhere — without this the row just looks like an ordinary
          completion and the destination is invisible (design's explicit "no vanishing agent"
          ask). A one-line badge, not a graph — see handoffFrom above for the target side. */}
      {handoffTo ? (
        <div className={styles.taskFrom} data-handoff-to>↦ handed off to {conductorLabel(agents, handoffTo)}</div>
      ) : null}
      {open ? (
        <div className={styles.taskBody}>
          <MessageBody text={prompt} done rawView={false} />
        </div>
      ) : (
        <div className={styles.taskPreview} onClick={() => setOpen(true)}>{preview}{prompt.length > preview.length ? "…" : ""}</div>
      )}
    </div>
  );
}

// WORKFLOW-TASK-VIEW (moved from the retired StitchedTranscriptPanel) — one
// stitched step's own header line: index/title/role/agent, the pass/fail
// gate glyph + duration, and (on a handoff boundary) a collapsible summary.
function StepHeader({ section, agentName, stepCount }: { section: StitchedStepSection; agentName: string | null; stepCount: number | null }) {
  const total = stepCount !== null ? `/${stepCount}` : "";
  const gateGlyph = section.outcome === "failed" ? "✗" : section.outcome === "passed" ? "✓" : section.outcome === "retried" ? "↻" : "◐";
  const duration = section.durationMs !== null ? fmtDurationSec(section.durationMs) : null;
  const [handoffOpen, setHandoffOpen] = useState(false);
  return (
    <div
      className={section.outcome === "failed" ? styles.stepHeaderFailed : styles.stepHeader}
      data-step-header={section.key}
    >
      <span>
        — step {section.stepIndex + 1}{total} · {section.stepTitle ?? section.stepId}
        {section.role ? ` (${section.role})` : ""} · {agentName ?? "—"}
        {section.outcome ? ` · gate ${gateGlyph} ${section.outcome}` : ""}
        {duration ? ` · ${duration}` : ""} —
        {section.reason ? <span className={styles.stepFail}> {section.reason}</span> : null}
      </span>
      {section.isHandoffBoundary ? (
        <span
          className={styles.handoffToggle}
          role="button"
          tabIndex={0}
          data-handoff-marker={section.key}
          onClick={() => setHandoffOpen((o) => !o)}
        >
          {" "}⇄ handoff{section.handoffSummary ? (handoffOpen ? " ▾" : " ▸") : ""}
        </span>
      ) : null}
      {section.isHandoffBoundary && handoffOpen && section.handoffSummary ? (
        <div className={styles.handoffBody}>{section.handoffSummary}</div>
      ) : null}
    </div>
  );
}

/** A step section with no messages in its time window — mirrors the retired
 * StepTranscript's own placeholder text exactly (agent not yet resolved vs.
 * resolved-but-genuinely-empty-so-far). */
function StepEmpty({ agent }: { agent: AgentView | undefined }) {
  if (!agent) return <div className={styles.taskEmptyHint}>agent unavailable</div>;
  return <div className={styles.taskEmptyHint}>{agent.historyLoaded || agent.transcript.length > 0 ? "no messages in this step" : "loading…"}</div>;
}

/** TRANSCRIPT-LOADING-STATE: a few message-shaped placeholder bars — reads as
 * "content is coming here" better than a bare spinner. `aria-hidden` since it
 * carries no information a screen reader needs (the pane's real content
 * replaces it once the fetch resolves). Pulses via CSS; prefers-reduced-motion
 * turns the pulse off but keeps the bars themselves — same posture as
 * AgentList.module.css's `.busyPulse` (turn off motion, keep the thing that
 * actually distinguishes this from the "no messages yet" empty state: the
 * bars' presence, not their animation). */
function TranscriptSkeleton() {
  return (
    <div className={styles.skeleton} data-transcript-skeleton aria-hidden="true">
      <div className={styles.skeletonBlock}>
        <div className={`${styles.skeletonLine} ${styles.skeletonLineWide}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineFull}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineMed}`} />
      </div>
      <div className={styles.skeletonBlock}>
        <div className={`${styles.skeletonLine} ${styles.skeletonLineNarrow}`} />
      </div>
      <div className={styles.skeletonBlock}>
        <div className={`${styles.skeletonLine} ${styles.skeletonLineFull}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineMed}`} />
      </div>
    </div>
  );
}

/** TRANSCRIPT-LOADING-STATE: single-agent mode's `renderEmpty` — distinguishes
 * the three states transcriptEmptyState derives (see its own doc comment)
 * instead of the flat "loading…"/"no messages" StepEmpty above renders for
 * task mode. A permanently-shimmering skeleton on a load that actually failed
 * is a worse lie than a blank pane, so "failed" gets its own line instead of
 * falling through to the skeleton. */
function TranscriptEmptyBody({ agent }: { agent: AgentView }) {
  const empty = transcriptEmptyState(agent);
  if (empty === "loading") return <TranscriptSkeleton />;
  if (empty === "failed") {
    return (
      <div className={styles.emptyHint} data-transcript-load-failed>
        history failed to load{agent.historyLoadError ? `: ${agent.historyLoadError}` : ""} — reselect this agent to retry
      </div>
    );
  }
  return <div className={styles.emptyHint} data-transcript-load-empty>no messages yet</div>;
}

/** The same `{raw, workflow, sections}` triple StitchedTranscriptPanel used to
 * derive itself — the caller (AgentsScreen) now derives it via the same
 * selectors (taskWorkflowBinding/workflowFor/stitchedStepSections) and passes
 * it down, since it's already re-derived on every task-list/workflow-list
 * change regardless of which pane renders it. */
export type TranscriptWorkflowData = {
  raw: Record<string, unknown> | null;
  workflow: WorkflowRow | null;
  sections: StitchedStepSection[];
};

// TRANSCRIPT-WINDOWING (part C): search this agent's FULL on-disk history —
// not just what's currently resident in `agent.transcript` — via the same
// events.search RPC + {hits, nextCursor} shape EventsScreen already uses
// (packages/app/src/screens/EventsScreen.tsx's runSearch), scoped to this one
// agent via `scope.agentIds` so it never surfaces another agent's turns.
// Single-agent mode only (isTaskMode gate at the call site) — a task's
// per-step transcripts are each their own agent id anyway, so searching from
// here already covers them individually once selected.
function TranscriptSearchBar({ agentId, onJumpTo }: { agentId: string; onJumpTo: (hit: ChronicleSearchHit) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChronicleSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  // TRANSCRIPT-FIND: the count and the cursor over the matches RENDERED IN THE TRANSCRIPT — a
  // different question from `hits` above, which is the history index's answer. The bar used to
  // show the latter and read "0 hits" with the word marked a dozen times on screen.
  const [matchTotal, setMatchTotal] = useState(0);
  const [matchAt, setMatchAt] = useState(-1);

  // TRANSCRIPT-SEARCH: ⌘F opens it. The chord was already swallowed as BROWSER_RESERVED so the
  // webview's own find never opened over the app — it just went nowhere. Registered here rather
  // than on the screen so the handler lives with the state it drives, and re-focusing while
  // already open is what a second ⌘F should do.
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => registerActionHandler("transcript.search", () => {
    setOpen(true);
    // A microtask, not a layout effect: the input does not exist yet on the frame that opens it.
    queueMicrotask(() => inputRef.current?.select());
  }), []);

  // TRANSCRIPT-HIGHLIGHT: publish what the transcript should mark. Cleared on close and on unmount
  // — a highlight left behind after the box is gone is a mark with nothing to explain it.
  useEffect(() => {
    setHighlightQuery(open ? query : "");
    return () => setHighlightQuery("");
  }, [open, query]);

  // Closing must return focus somewhere sane, not strand it on the input
  // that's about to unmount — send it back to the toggle that reopens search.
  useEffect(() => {
    if (!open && wasOpenRef.current) toggleButtonRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  // The transcript scroller — looked up rather than passed, because this bar renders inside the
  // panel header while the marks live in the body below it.
  const scrollRoot = useCallback(
    (): ParentNode | null => (typeof document === "undefined" ? null : document.querySelector("[data-transcript-body]")),
    [],
  );

  // Recount whenever the query changes AND whenever the transcript itself does: a streamed delta,
  // an expanded fold or an older page loading all change how many matches exist, and a tally that
  // silently goes stale is the bug this replaced.
  useEffect(() => {
    if (!open || !query.trim()) { setMatchTotal(0); setMatchAt(-1); return undefined; }
    const root = scrollRoot();
    if (!root) return undefined;
    let frame = 0;
    const recount = (): void => {
      frame = 0;
      setMatchTotal(matchElements(root).length);
    };
    recount();
    // rAF-coalesced: a streaming turn mutates this subtree many times per frame, and counting
    // marks on each one would make typing in the box stutter.
    const obs = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(recount);
    });
    obs.observe(root as Node, { subtree: true, childList: true, characterData: true });
    return () => { obs.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [open, query, scrollRoot]);

  /** Step the cursor and bring that match into view. Enter goes UP (toward older turns): reading
   *  back through a transcript is what searching one is for. */
  const step = useCallback((delta: number): void => {
    const root = scrollRoot();
    const total = matchElements(root).length;
    setMatchTotal(total);
    const next = nextMatchIndex(matchAt, total, delta);
    setMatchAt(applyMatchCursor(root, next));
  }, [matchAt, scrollRoot]);

  const runSearch = useCallback((cursor?: string): void => {
    const q = query.trim();
    if (!q) return;
    setSearching(true); setError(null);
    void rpcCall<ChronicleSearchResponse>("events.search", {
      query: q, scope: { agentIds: [agentId] }, limit: 20, ...(cursor ? { cursor } : {}),
    })
      .then((res) => { setHits((old) => (cursor ? [...old, ...res.hits] : res.hits)); setNextCursor(res.nextCursor); })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setSearching(false));
  }, [query, agentId]);

  useEffect(() => {
    if (!open) return undefined;
    if (!query.trim()) { setHits([]); setNextCursor(null); setError(null); return undefined; }
    const timer = setTimeout(() => runSearch(), 180);
    return () => clearTimeout(timer);
  }, [query, open, runSearch]);

  if (!open) {
    return (
      <button
        ref={toggleButtonRef}
        type="button"
        className={styles.searchToggle}
        onClick={() => setOpen(true)}
        data-transcript-search-toggle
      >
        ⌕ search this agent's history
      </button>
    );
  }
  return (
    <div className={styles.searchBar} data-transcript-search-bar>
      <SearchBox
        inputRef={inputRef}
        value={query}
        onChange={setQuery}
        placeholder="search this agent's full history — including evicted/never-loaded content"
        // "3 of 12 matches" — the cursor within what is on screen. Before any step it reads the
        // bare total, so an unstepped search does not claim to be sitting on a match.
        count={query.trim() ? (matchAt >= 0
          ? { shown: matchAt + 1, total: matchTotal, noun: "matches" }
          : { shown: matchTotal, total: matchTotal, noun: "matches" }) : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          step(e.shiftKey ? 1 : -1);
        }}
        dataAttr="transcript-search"
        autoFocus
      >
        <button type="button" onClick={() => { setOpen(false); setQuery(""); }} aria-label="close search">✕</button>
      </SearchBox>
      {error ? <div className={styles.emptyHint}>{error}</div> : null}
      {query.trim() && !searching && hits.length === 0 && matchTotal === 0 && !error
        ? <div className={styles.emptyHint}>no matches</div> : null}
      {/* The history results are a SEPARATE answer from the count above — they reach turns that
          were evicted or never loaded, which nothing on screen can. Labelled so the two numbers
          are never read as one disagreeing with itself. */}
      {hits.length > 0 ? <div className={styles.faint}>{hits.length} more in full history</div> : null}
      {hits.map((hit) => (
        <div
          key={`${hit.engineId}:${hit.seq}`}
          className={styles.searchHit}
          data-search-hit={hit.seq}
          onClick={() => onJumpTo(hit)}
        >
          <span className={styles.faint}>{fmtClock(hit.ts)}</span> {hit.snippet}
        </div>
      ))}
      {nextCursor ? (
        <button type="button" onClick={() => runSearch(nextCursor)} disabled={searching}>load more results</button>
      ) : null}
    </div>
  );
}

const groupsCmd = getGroupsCommands(appStore, rpcCall);

export function TranscriptPanel({ agent: liveAgent, workflow }: { agent: AgentView | undefined; workflow?: TranscriptWorkflowData }) {
  const replay = useSystemLocal((state) => state.replay);
  const agentKey = liveAgent?.agentId ?? "";
  const agent = replay.active && replay.projection && agentKey ? replay.projection.agents[agentKey] : liveAgent;
  const isTaskMode = workflow !== undefined;
  const raw = workflow?.raw ?? null;
  const wf = workflow?.workflow ?? null;
  const sections = workflow?.sections ?? [];

  const liveAgents = useStore((s: UiState) => s.agents);
  const agents = replay.active && replay.projection ? replay.projection.agents : liveAgents;

  // WORKFLOW-TASK-VIEW: every step agent's transcript needs its OWN history
  // backfill — the single-selection watcher (history.ts) only ever covers ONE
  // agentId at a time (the real selectedAgentId), which for a task row is the
  // synthetic "task:<id>" string, not a real agent. Mirrors
  // installHistoryBackfill's once-per-agent contract, fanned out over every
  // section's agentId. Single-agent mode needs none of this (its one agent is
  // already covered by the normal selection watcher).
  const requestedRef = useRef<Set<string>>(new Set());
  // The RAW agent.tail reply per backfilled agentId — kept alongside the
  // dispatch (which only stores the PROJECTED transcript) because per-step
  // segmentation needs each item's real ts, and state.events (the live ring)
  // never carries a backfilled agent's historical events (backfillHistory
  // projects them from a throwaway scratch state). A currently-live agent
  // (never tailed) falls back to the live ring itself.
  const tailEventsRef = useRef<Map<string, NormalizedEvent[]>>(new Map());
  useEffect(() => {
    if (!isTaskMode || replay.active) return;
    for (const s of sections) {
      const id = s.agentId;
      if (!id) continue;
      const a = agents[id];
      if (!a || a.state === "unknown" || a.historyLoaded || a.transcript.length > 0 || requestedRef.current.has(id)) continue;
      requestedRef.current.add(id);
      void rpcCall<NormalizedEvent[]>("agent.tail", { agentId: id, n: 1000 })
        .then((tailEvents) => {
          const arr = Array.isArray(tailEvents) ? tailEvents : [];
          tailEventsRef.current.set(id, arr);
          appStore.dispatch({ type: "backfillHistory", agentId: id, events: arr });
        })
        .catch((err: unknown) => console.warn("[chimera] stitched transcript backfill failed:", err));
    }
  }, [isTaskMode, sections, agents, replay.active]);
  const storeEvents = useStore((s: UiState) => s.events);
  const liveEvents = replay.active && replay.projection ? replay.projection.events : storeEvents;
  const eventsForAgent = (agentId: string): readonly NormalizedEvent[] => tailEventsRef.current.get(agentId) ?? liveEvents;

  // R2 UI FIX: a flow-bar step's agent click OPENS that agent's own page
  // (same effect as clicking it in AgentList / TaskInspector's onOpenAgent —
  // coord.openAgent's `selectAgent` dispatch) rather than just scrolling to
  // its section within the current stitched view. AgentsScreen already
  // switches TranscriptPanel out of task-stitched mode the instant
  // selectedAgentId stops being a "task:<id>" string, so this dispatch alone
  // is enough to navigate.
  const openStepAgent = (agentId: string): void => {
    appStore.dispatch({ type: "selectAgent", agentId });
  };

  // WORKFLOW-UI-2 (header parity): a task's header tracks the CURRENT live
  // step agent — falls back to the last section's agent once the task is
  // done, so a finished task's header still reads its last runner's
  // model/account/ctx instead of going blank.
  const currentAgentId = isTaskMode
    ? (raw ? (liveTaskStepAgentId(raw) ?? sections[sections.length - 1]?.agentId ?? null) : null)
    : (agentKey || null);
  const currentAgent = isTaskMode ? (currentAgentId ? agents[currentAgentId] : undefined) : agent;
  const [voiceHistoryOpenFor, setVoiceHistoryOpenFor] = useState<string | null>(null);
  const voiceHistoryOpen = !!currentAgentId && voiceHistoryOpenFor === currentAgentId;

  // F22.UI: hand-off candidates — every OTHER agent still alive enough to write. A dead agent
  // can hold a lease (that is what release --force is for) but must never be handed one.
  const leaseTargets = useMemo(
    () => Object.values(agents)
      .filter((a) => a.agentId !== currentAgentId && !["exited", "failed", "killed"].includes(derivedState(a)))
      .map((a) => ({ agentId: a.agentId, label: `${displayName(a)} · ${a.agentId.slice(0, 8)}` })),
    [agents, currentAgentId],
  );


  // AGENT-GROUPS Phase 1: the registry the detail panel's assign-to-group control offers —
  // loaded on mount and invalidated by registry events/reconnect (see commands.groups.ts).
  const groupRegistry = useStore((s) => s.groups.items);
  useEffect(() => { void groupsCmd.loadGroups(); }, []);

  const local = useComposerLocal((s) => s);
  // AGENT-INFO-PANEL: the header-click inspector — scoped by agentId (like
  // toolDetail), so switching the selected agent/task implicitly closes it and
  // the on-demand agent.status fetch only runs while it's actually open.
  const agentDetailOpen = currentAgentId !== null && local.agentDetail?.agentId === currentAgentId;
  const agentStatus = useAgentStatus(agentDetailOpen ? currentAgentId : null, rpcCall);
  const providerDefaultModels = useProviderDefaultModels(rpcCall);
  // TASK-PROMPT: the spawn prompt + attribution for the header card — fetched
  // for every selected NON-conductor agent in single-agent mode only (a task's
  // per-step assignment is already shown by StepHeader).
  const taskStatus = useAgentStatus(!isTaskMode && agent && !agent.conductor ? agentKey : null, rpcCall);
  const outboxCount = useStore((s: UiState) => {
    const ids = resolveActiveTargets(s, composerLocal.getState().target);
    return s.outbox.filter((o) => ids.includes(o.agentId)).length;
  });
  // B4: ONE predicate for the hint AND the esc tier (commands.agents.ts).
  const canInterrupt = useStore((s: UiState) => canInterruptSelected(s, local, outboxCount));

  const usageTotal = currentAgent?.usage ? currentAgent.usage.input + currentAgent.usage.output : null;
  // R2: the ctx meter's own basis (input+cacheRead+cacheCreation) — distinct from usageTotal
  // (input+output, the tokens-column display figure) now that cache is tracked separately.
  // CTX-VS-BILLABLE: only the dedicated context snapshot can drive occupancy. When it has not
  // arrived, the honest state is unknown; the billable tally may span many turns.
  const ctxSource = currentAgent?.ctxUsage ?? null;
  const fullContext = ctxSource ? fullContextTokens(ctxSource) : null;
  // R2 (ctx meter effective-limit): an operator-configured compactionThreshold when set, else
  // the model's native window — undefined currentAgent falls back to effectiveContextLimitFor's
  // own model:undefined/limit:undefined handling (DEFAULT_CONTEXT_WINDOW).
  const limit = effectiveContextLimitForAgent(currentAgent ?? {});
  const ring = useTokenRing(currentAgentId ?? "", usageTotal, currentAgent?.usageMeasuredAt);

  // WORKFLOW-UI-3: the per-agent raw-copy/quote registry + the shared scroll/
  // keyboard machinery live in TranscriptSegment.tsx — single-agent mode wires
  // ONE agent's transcript into them, task mode wires N (one per section).
  const { onRegisterTranscript, rawLookup, resolveQuote } = useTranscriptRawRegistry();
  const applyQuote = useCallback((slot: QuoteSlot): void => {
    const hadQuote = composerLocal.getState().quote !== null;
    composerLocal.set({ quote: slot });
    if (hadQuote) {
      const from = agents[slot.agentId];
      appStore.dispatch({ type: "notice", message: `quote replaced — now quoting @${from ? displayName(from) : slot.agentId}` });
    }
  }, [agents]);
  const onQuote = useCallback((quoteAgentId: string, absIndex: number): void => {
    const slot = resolveQuote(`${quoteAgentId}#${absIndex}`);
    if (slot) applyQuote(slot);
  }, [resolveQuote, applyQuote]);

  const taskId = raw ? str(raw["taskId"]) : "";
  // TRANSCRIPT-LAZY-OLDER: scroll-to-top pages in ONE older history batch for
  // the selected agent — see history.ts's requestOlderHistoryPage doc comment.
  // Task mode has no single "selected agent" transcript to page (it stitches
  // multiple agents' sections), so older-paging is single-agent-mode only.
  const onNearTop = useCallback(() => {
    if (isTaskMode || !agentKey) return;
    void requestOlderHistoryPage(appStore, agentKey, rpcCall);
  }, [isTaskMode, agentKey]);
  // TRANSCRIPT-EVICT-OLD: mirror the operator's at-bottom pin into ui-state so
  // the reducer can gate eviction on it — single-agent mode only, same
  // restriction as onNearTop above (task mode stitches multiple agents'
  // sections, no single transcript to cap/evict).
  const onAtBottomChange = useCallback((atBottom: boolean) => {
    if (isTaskMode || !agentKey) return;
    appStore.dispatch({ type: "transcriptAtBottom", agentId: agentKey, atBottom });
  }, [isTaskMode, agentKey]);
  const { bodyRef, onScroll, hint } = useTranscriptScroll(isTaskMode ? taskId : agentKey, isTaskMode ? agents : agent?.transcript, onNearTop, onAtBottomChange);
  useTranscriptKeyboard(bodyRef, rawLookup, resolveQuote, applyQuote);
  useTranscriptCopyOnSelect(bodyRef, isTaskMode ? sections.length > 0 : agent !== undefined, rawLookup);

  // TRANSCRIPT-WINDOWING (part C, ported onto TRANSCRIPT-LAZY-OLDER): a search
  // hit's seq may be OLDER than anything currently resident (agent.historyMinSeq)
  // — reachability means walking requestOlderHistoryPage backward (the SAME
  // on-demand page loader the scroll-to-top trigger above uses) until it's
  // folded in, then scrolling to it. Bounded by a generous safety cap since
  // this is a rare, explicit, user-initiated action, not a background sweep.
  //
  // Matching the hit to a rendered DOM block: `ts` alone isn't reliable here —
  // transcriptTimestamps only derives an item's ts by correlating against the
  // LIVE event ring (state.events), which historical/backfilled content
  // (exactly what this feature reaches for) generally is NOT part of. Snippet
  // text is the more robust signal for exactly that reason, with ts used only
  // to break a tie between multiple textual matches.
  const JUMP_PAGE_CAP = 200;
  const jumpToHit = useCallback((hit: Pick<ChronicleSearchHit, "seq" | "ts" | "snippet">): void => {
    if (isTaskMode || !agentKey) return;
    void (async () => {
      let a = appStore.getState().agents[agentKey];
      let steps = 0;
      while (a && a.historyMinSeq !== null && hit.seq < a.historyMinSeq && !a.historyOlderExhausted && steps < JUMP_PAGE_CAP) {
        await requestOlderHistoryPage(appStore, agentKey, rpcCall);
        a = appStore.getState().agents[agentKey];
        steps += 1;
      }
      if (a && a.historyMinSeq !== null && hit.seq < a.historyMinSeq) {
        appStore.dispatch({ type: "notice", message: "couldn't load far enough back in history to reach that result" });
        return;
      }
      const needle = hit.snippet.trim().slice(0, 40);
      const scrollToHit = (): void => {
        const body = bodyRef.current as (HTMLElement & { querySelectorAll?: typeof document.querySelectorAll }) | null;
        const nodes = body?.querySelectorAll?.("[data-block]");
        if (!nodes || nodes.length === 0) return;
        let seqMatch: Element | null = null;
        let textMatch: Element | null = null;
        let bestTsMatch: Element | null = null;
        let bestTsDelta = Number.POSITIVE_INFINITY;
        nodes.forEach((n) => {
          if(n.getAttribute("data-seq")===String(hit.seq)) seqMatch=n;
          if (needle && !textMatch && (n.textContent ?? "").includes(needle)) textMatch = n;
          const tsAttr = n.getAttribute("data-ts");
          if (tsAttr !== null) {
            const delta = Math.abs(Number(tsAttr) - hit.ts);
            if (delta < bestTsDelta) { bestTsDelta = delta; bestTsMatch = n; }
          }
        });
        const target = (seqMatch as Element | null) ?? (textMatch as Element | null) ?? (bestTsMatch as Element | null);
        target?.scrollIntoView?.({ block: "center" });
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(scrollToHit);
      else setTimeout(scrollToHit, 0);
    })();
  }, [isTaskMode, agentKey, bodyRef]);
  useEffect(() => onOpenBookmark(b => { if(b.agentId===agentKey) jumpToHit({seq:b.seq,ts:b.ts,snippet:b.text}); }), [agentKey,jumpToHit]);

  // agentMeta/agentMeta-derived totals only matter in task mode (the header's
  // summed cost/usage across every distinct step agent — WORKFLOW-UI-2).
  const agentMeta = useMemo(() => {
    const m: Record<string, AgentMetaForTask> = {};
    if (!raw) return m;
    for (const id of taskStepAgentIds(raw)) {
      const a = agents[id];
      if (a) m[id] = { costUsd: a.costUsd, usage: a.usage, pendingQuestion: a.pendingQuestion };
    }
    return m;
  }, [raw, agents]);

  const flowBarView = useMemo(() => (raw ? workflowFlowBarView(raw, wf, sections) : null), [raw, wf, sections]);
  const binding = useMemo(() => (raw ? taskWorkflowBinding(raw) : null), [raw]);

  if (isTaskMode) {
    if (!raw) {
      return (
        <Panel label="transcript" className={styles.pane}>
          <div className={styles.taskEmptyPane}>
            <div className={styles.taskEmptyHint}>task not found — it may have drained out of the queue view</div>
          </div>
        </Panel>
      );
    }
  } else if (!agent) {
    return (
      <Panel label="transcript" className={styles.pane}>
        <div className={styles.emptyPane}>
          <div className={styles.emptyGlyph}>◆</div>
          <div className={styles.emptyHint}>select an agent</div>
        </div>
      </Panel>
    );
  }

  // SOFT-TURN-LIMIT: mirrors AgentList's Row — stays "running" (counts/derived
  // state untouched), with the budget warning separate from its state chip.
  const overBudget = currentAgent?.turnBudgetExceeded === true && currentAgent?.state === "running";

  let panelLabel: string;
  let headerName: string;
  let headerFullId: string;
  let headerState: string;
  let headerTone: Tone;
  let headerCostUsd: number;
  let liveSectionKey: string | null = null;
  let task: ReturnType<typeof taskRowView> | null = null;
  if (isTaskMode && raw) {
    task = taskRowView(raw);
    panelLabel = `⧉ task ${task.taskId}`;
    const taskVisual = TASK_STATE_VISUAL[task.state] ?? TASK_STATE_VISUAL["pending"]!;
    headerName = binding ? binding.name : (currentAgent ? displayName(currentAgent) : task.taskId);
    headerFullId = currentAgentId ?? task.taskId;
    headerState = `${taskVisual.glyph} ${task.state}`;
    headerTone = taskVisual.tone as Tone;
    headerCostUsd = taskAgentTotals(raw, agentMeta).costUsd;
    liveSectionKey = sections.length > 0 ? sections[sections.length - 1]!.key : null;
  } else {
    const st = derivedState(agent!);
    const visual = stateVisual(st);
    panelLabel = "transcript";
    headerName = conductorLabel(agents, agent!.agentId);
    headerFullId = agent!.agentId;
    headerState = `${visual.glyph} ${st}`;
    headerTone = visual.tone;
    headerCostUsd = agent!.costUsd;
  }

  return (
    <div className={styles.transcriptShell}>
    <div className={styles.transcriptLayout}>
    <Panel label={panelLabel} className={styles.pane}>
      <TranscriptHeader
        name={headerName}
        fullId={headerFullId}
        state={headerState}
        tone={headerTone}
        overBudget={overBudget}
        model={currentAgent?.model}
        effort={currentAgent?.effort}
        account={currentAgent?.account}
        permissionProfile={currentAgent?.permissionProfile}
        permissionRequest={currentAgent?.permissionRequest}
        permissionAppliedToRunningProcess={currentAgent?.permissionAppliedToRunningProcess}
        toolPolicyDenied={currentAgent?.toolPolicyDenied}
        lastToolPolicyDenial={currentAgent?.lastToolPolicyDenial}
        leaseChips={currentAgent ? worktreeLeaseChips(currentAgent) : []}
        costUsd={headerCostUsd}
        usageTotal={usageTotal}
        usage={currentAgent?.sessionUsage ?? currentAgent?.usage}
        fullContext={fullContext}
        compactions={currentAgent?.compactions ?? 0}
        compacting={currentAgent?.compacting ?? false}
        {...(currentAgent?.lastCompactedAt !== undefined ? { lastCompactedAt: currentAgent.lastCompactedAt } : {})}
        limit={limit}
        contextLimits={currentAgent?.provider === "codex" ? currentAgent.contextLimits ?? { source: "codex" } : undefined}
        ring={ring}
        hint={hint}
        detailOpen={agentDetailOpen}
        onToggleDetail={() => {
          if (!currentAgentId) return;
          composerLocal.set({ agentDetail: agentDetailOpen ? null : { agentId: currentAgentId } });
        }}
        onAction={(actionId) => runAction(actionId, appStore)}
        chipsInteractive={!isTaskMode || liveTaskStepAgentId(raw) !== null}
        voiceHistoryOpen={voiceHistoryOpen}
        onToggleVoiceHistory={!isTaskMode && currentAgent?.provider === "codex" && currentAgentId
          ? () => setVoiceHistoryOpenFor(voiceHistoryOpen ? null : currentAgentId) : undefined}
      />
      {currentAgentId && <BranchNotice agentId={currentAgentId} />}
      <Collapse open={agentDetailOpen}>
        {agentDetailOpen && currentAgent ? (
          <AgentDetailPanel
            agent={currentAgent}
            status={agentStatus.status}
            loading={agentStatus.loading}
            providerDefaultModels={providerDefaultModels}
            groups={groupRegistry}
            onSetGroup={(groupId) => { if (currentAgentId) void groupsCmd.setAgentGroup(currentAgentId, groupId); }}
            onClose={() => composerLocal.set({ agentDetail: null })}
            leaseTargets={leaseTargets}
            onLeaseHandoff={(workdirKey, toAgentId) => {
              const target = agents[toAgentId];
              appStore.dispatch({ type: "confirm", confirm: { kind: "worktreeLeaseHandoff", agentId: currentAgent.agentId, workdirKey, toAgentId,
                label: target ? displayName(target) : toAgentId.slice(0, 8),
                ownerLabel: displayName(currentAgent) } });
            }}
            onLeaseRelease={(workdirKey) => {
              appStore.dispatch({ type: "confirm", confirm: { kind: "worktreeLeaseRelease", agentId: currentAgent.agentId, workdirKey, force: false,
                ownerLabel: displayName(currentAgent) } });
            }}
            onSpawnAnotherLikeThis={(role) => {
              appStore.dispatch({ type: "selectTab", tab: "agents" });
              composerLocal.set({ agentDetail: null, spawnOpen: true, spawnPrefillRole: role });
            }}
          />
        ) : null}
      </Collapse>
      {isTaskMode && flowBarView ? <WorkflowFlowBar view={flowBarView} agents={agents} onStepClick={openStepAgent} /> : null}
      {/* TERMINAL-RUNTIME: an agent running as a real CLI has no transcript to search or scroll —
          its screen IS the transcript. The HEADER above stays exactly as it is (same chips, same
          actions, which for this agent are typed into the session instead of sent as an RPC); only
          the body below is replaced. */}
      {!isTaskMode && currentAgent?.terminal ? (
        <AgentTerminal
          agentId={currentAgentId!}
          workdir={currentAgent.workdir ?? null}
          session={currentAgent.terminal.session}
          attach={currentAgent.terminal.attach}
        />
      ) : (
      <>
      {!isTaskMode && agentKey ? <TranscriptSearchBar agentId={agentKey} onJumpTo={jumpToHit} /> : null}
      <div className={styles.bodyFrame}>
      {/* DESKTOP-PREVIEW: floats over the scroll area (not the header chips or composer) and renders
          only while THIS transcript's agent holds the desktop lease. A task shows it for its live
          step agent only — a finished task has no agent acting on its behalf — and never while a
          replay projection stands in for live state. */}
      {replay.active ? null : <ComputerUseMonitor agentId={isTaskMode ? liveTaskStepAgentId(raw) : (agentKey || null)} />}
      <div
        className={isTaskMode ? `${styles.body} ${styles.bodyTask}` : styles.body}
        ref={bodyRef}
        onScroll={onScroll}
        data-transcript-body
      >
        <div className={styles.bodyInner}>
          {isTaskMode ? (
            sections.length === 0 ? (
              <div className={styles.taskEmptyHint}>this task hasn't started its first step yet</div>
            ) : (
              sections.map((s) => {
                const sectionAgent = s.agentId ? agents[s.agentId] : undefined;
                return (
                  <div key={s.key}>
                    <StepHeader
                      section={s}
                      agentName={s.agentId ? conductorLabel(agents, s.agentId) : null}
                      stepCount={wf?.steps.length ?? null}
                    />
                    {sectionAgent && s.agentId ? (
                      <TranscriptSegment
                        agent={sectionAgent}
                        timeWindow={{ startedAt: s.startedAt, endedAt: s.endedAt }}
                        events={eventsForAgent(s.agentId)}
                        canInterrupt={canInterrupt}
                        isLive={s.key === liveSectionKey}
                        segmentKey={`${s.agentId}#${s.key}`}
                        onRegisterTranscript={onRegisterTranscript}
                        onQuote={onQuote}
                        renderEmpty={() => <StepEmpty agent={sectionAgent} />}
                      />
                    ) : (
                      <StepEmpty agent={undefined} />
                    )}
                  </div>
                );
              })
            )
          ) : (
            <>
              {/* TRANSCRIPT-TAIL-FIRST: the newest page has already painted by the
                  time this can ever show (blocks.length===0 sends single-agent
                  mode through TranscriptEmptyBody's OWN "loading" skeleton
                  instead, above) — this is the on-demand OLDER-page fetch
                  (TRANSCRIPT-WINDOWING: fired by scroll-near-top, not a
                  background walk) still running behind content that's already
                  visible, so it is a thin top-of-list line, never a full-pane
                  skeleton over real content. */}
              {agent && agent.historyOlderLoadState === "loading" ? (
                <div className={styles.emptyHint} data-transcript-loading-older>loading older history…</div>
              ) : null}
              {/* TRANSCRIPT-WINDOWING: no silent truncation — a rejected
                  older-page fetch says so (scrolling near the top again
                  retries; the guard in loadNextOlderHistoryPage only blocks
                  on "loading" or exhausted, never on "failed"). */}
              {agent && agent.historyOlderLoadState === "failed" ? (
                <div className={styles.emptyHint} data-transcript-loading-older-failed>
                  couldn't load older history{agent.historyOlderLoadError ? `: ${agent.historyOlderLoadError}` : ""} — scroll up to retry
                </div>
              ) : null}
              {agent && agent.historyOlderExhausted ? (
                <div className={styles.emptyHint} data-transcript-history-beginning>— beginning of history —</div>
              ) : null}
              {/* TASK-PROMPT: the assignment this agent was spawned with + who
                  gave it — pinned as the transcript's first block (user
                  request). */}
              {taskStatus.status ? <TaskPromptCard status={taskStatus.status} agents={agents} /> : null}
              <TranscriptSegment
                agent={agent!}
                canInterrupt={canInterrupt}
                isLive
                onRegisterTranscript={onRegisterTranscript}
                onQuote={onQuote}
                renderEmpty={() => <TranscriptEmptyBody agent={agent!} />}
              />
            </>
          )}
        </div>
      </div>
      </div>
      </>
      )}
      {currentAgent?.busy ? <StreamGlow /> : null}
    </Panel>
    {!isTaskMode && currentAgent?.provider === "codex" && currentAgentId ? <VoiceConversationPanel key={currentAgentId} agentId={currentAgentId} open={voiceHistoryOpen} onClose={() => setVoiceHistoryOpenFor(null)} /> : null}
    </div>
    </div>
  );
}
