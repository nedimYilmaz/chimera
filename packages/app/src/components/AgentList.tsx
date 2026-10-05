import { rememberFleetFilter, onFleetFilter, initialFleetFilter } from "../state/workspaceTools";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView, TeamColorId } from "@chimera/ui-state";
import { failureBadge, failureDetail, isKnownFailureCause, isUnseen, promptStallBadge, promptStallDetail, teamIcon, unseenAgentIds } from "@chimera/ui-state";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore, useStoreThrottled } from "../state/useStore";
import type { UiState } from "@chimera/ui-state";
import { latestCoordSeq, str, taskForAgent } from "../state/selectors.coord";
import { A2AIndicator } from "./A2AIndicator";
import {
  agentWorkflowStepDots, groupAgentListRowsByTask, JOB_GROUP_DEFAULT_VISIBLE, jobGroupRowId,
  groupRowId, latestStepEvent, overlayTaskStep, taskRowId, taskIdFromRowId, taskWorkflowBinding, visibleListRowIds, workflowFor,
  type AgentListRow, type AgentMetaForTask, type WorkflowDotState,
} from "../state/selectors.workflows";
import { groupAgentListRowsByJob } from "../state/selectors.jobGroups";
import { groupAgentListRowsByGroup } from "../state/selectors.groups";
import { AGENT_DND_MIME, agentCommands } from "../state/commands.agents";
import { getAgentTasksCommands, useAgentTasksLocal } from "../state/commands.agentTasks";
import { getWorkflowsCommands, useWorkflowsLocal } from "../state/commands.workflows";
import { getGroupsCommands } from "../state/commands.groups";
import {
  buildAgentRows,
  conductorLabel,
  derivedState,
  fleetSummary,
  fmtCost,
  fmtTokens,
  hiddenTerminalAgentCount,
  pauseSummary,
  isTerminalState,
  remoteEngine,
  secondaryLabel,
  stateVisual,
  type AgentRow,
  type FleetSummary,
} from "../state/selectors";
import { displayChord, keyLabel, registerActionHandler, runAction } from "../keymap";
import { useSystemLocal } from "../state/commands.system";
import { Panel, PanelFooter } from "./Panel";
import { SearchBox } from "./SearchBox";
import { WorkflowStepDots } from "./WorkflowStepDots";
import styles from "./AgentList.module.css";
import { HoverScrollText } from "./HoverScrollText";
import { ListOrderingContext, useAgentListOrdering } from "./useAgentListOrdering";

const agentTasksCmd = getAgentTasksCommands(rpcCall);
// DONE-AGENTS-HIDDEN-AFTER-RESTART: localStorage key for the persisted showDone toggle.
const SHOW_DONE_KEY = "chimera.agentList.showDone";
// F47: same persistence contract for the attention-only filter — a filter that silently
// reset on reload would read as "nothing needs attention", the opposite of what it means.
const UNSEEN_KEY = "chimera.agentList.unseenOnly";
// F08.UI: same persistence contract as UNSEEN_KEY above.
const NEEDS_OPERATOR_KEY = "chimera.agentList.needsOperatorOnly";
const workflowsCmd = getWorkflowsCommands(appStore, rpcCall);
const groupsCmd = getGroupsCommands(appStore, rpcCall);

// W3 — the left agents pane, rows 1:1 from the mock: column header, team
// group headers, indented tree rows, selection bar + fill, hover fill, remote
// ⇅ rows, fold ▾/▸. Every row is built by the PURE buildAgentRows selector;
// clicking dispatches the same store actions the keyboard does (PLAN §0.4).

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
};

function TitleSummary({ s }: { s: FleetSummary }) {
  return (
    <>
      agents <span className={styles.faint}>({s.total}) ·</span>
      {s.running > 0 && <span className={styles.toneSuccess}> ◐{s.running}</span>}
      {/* PAUSED-AGENTS-VISIBLE: its own chip, not folded into `waiting` — a paused agent
          isn't waiting on the operator (it's session-limited / crash-looping / recovering),
          and the "waiting" chip already means "pending question", a different signal. */}
      {s.paused > 0 && <span className={styles.toneWarn}> ⏸{s.paused}</span>}
      {s.done > 0 && <span className={styles.toneInfo}> ●{s.done}</span>}
      {(s.waiting > 0 || s.killed > 0) && (
        <span className={styles.toneWarn}>
          {s.waiting > 0 ? ` ◌${s.waiting}` : ""}
          {s.killed > 0 ? ` ⊘${s.killed}` : ""}
        </span>
      )}
      {s.failed > 0 && <span className={styles.toneDanger}> ✗{s.failed}</span>}
      {/* F47: fleet attention count, first among the chips because it is the one number that
          says whether the operator has anything to do at all. */}
      {s.unseen > 0 && <span className={styles.toneInfo}> {s.unseen} new</span>}
      {/* F08.UI: sits after ✗ because it is a SUBSET of it — how many of those failures no
          amount of engine retrying will clear. */}
      {s.needsOperator > 0 && <span className={styles.toneDanger}> {s.needsOperator} needs you</span>}
      <span className={styles.faint}> · {fmtCost(s.costUsd)}</span>
    </>
  );
}

// R2 (inline sub-agent/workflow surfacing, item 3): true for a shadow row carrying an inline SDK
// workflow (agent_task's workflowName, folded into shadowInfo) rather than a plain sub-agent
// (subagentType) — the "attached workflow" case gets a visually distinct ⧉ glyph + single-dot
// state, mirroring TaskRow's own chimera-native-workflow-task chrome (WorkflowStepDots.tsx's own
// dots, not a fake fixed-step model the SDK doesn't give us — see PLAN.md §8's "alternatives
// considered and rejected").
export function isAttachedWorkflowShadow(agent: AgentView): boolean {
  return agent.shadow === true && !!agent.shadowInfo?.workflowName;
}

// Maps an attached workflow shadow's live AgentState onto the single WorkflowStepDots dot it
// renders — there's no discrete step list for an inline SDK workflow (see PLAN.md §0), so this is
// ONE dot standing in for "the workflow's current live phase", not a fabricated N-step progression.
// Exported so AgentShadowPane's detail-card rendering uses the SAME mapping as the list row.
export function attachedWorkflowDotState(state: AgentView["state"]): WorkflowDotState {
  if (state === "running") return "current";
  if (state === "done") return "done";
  if (state === "failed" || state === "killed") return "failed";
  return "pending";
}

function GlyphCell({ agent }: { agent: AgentView }) {
  const engine = remoteEngine(agent.agentId);
  const icon = agent.conductor ? null : teamIcon(agent.membership?.team);
  return (
    // FIXED leftmost gutter — the marker never indents (user request: every
    // team/conductor mark lines up in one column at the row START; the tree
    // nesting indents the NAME, not the mark). No depth padding here.
    <div className={styles.glyphCol}>
      {/* LEADING marker column (user request: team mark goes HERE at the row
          start — aligned with the conductor ◆ — not trailing after the
          variable-width tokens column, which made rows look ragged). Priority:
          conductor ◆ > attached-workflow ⧉ > team glyph > remote ⇅. */}
      {agent.conductor ? (
        <span className={styles.conductorGlyph}>◆</span>
      ) : isAttachedWorkflowShadow(agent) ? (
        // RUNNING-STATE-PURPLE: was a FIXED --accent purple regardless of state, so a
        // running/paused/done/failed attached workflow all looked identical — toned by
        // the SAME stateVisual the plain state cell below uses (derivedState folds a
        // pending question into "waiting" first), so this glyph goes success-green while
        // actually running and warn-amber the moment it pauses, exactly like a plain row.
        <span className={toneClass[stateVisual(derivedState(agent)).tone]} title="attached workflow">⧉</span>
      ) : icon ? (
        <span className={TEAM_COLOR_CLASS[icon.color]} title={agent.membership?.team}>{icon.glyph}</span>
      ) : engine ? (
        <span className={styles.remoteGlyph} title="remote engine">⇅</span>
      ) : null}
    </div>
  );
}

// A2A-UX-OVERHAUL · PART 1: the ↗/↘ per-row a2a pulse markers are retired — live
// inter-agent traffic now surfaces as the ephemeral A2AIndicator at the BOTTOM of
// this panel (a single dedicated surface instead of transient per-row glyphs).

/** F09.UI: a 1 Hz clock that runs ONLY while `active`. Returns a fresh Date.now() on activation so
 *  the first paint is already correct rather than one second stale. */
function useTickWhileStalled(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Row({
  row, agent, name, selected, pinned, marked, workflowDots,
}: {
  row: Extract<AgentRow, { kind: "agent" }>;
  agent: AgentView;
  /** Resolved display name (conductorLabel: project-name/suffix aware). */
  name: string;
  selected: boolean;
  pinned: boolean;
  /** AGENT-MARK: passed DOWN rather than subscribed per row. A useStore call inside Row meant one
   *  store subscription per mounted agent — 378 of them on this operator's fleet, every one
   *  re-running on every event, for a boolean the parent already has in hand. */
  marked: boolean;
  /** F16 task-workflow step indicator (selectors.workflows.workflowStepDots)
   * — null for an agent whose current task carries no resolvable workflow
   * binding, in which case the cell renders the ordinary state glyph/word
   * exactly as before. */
  workflowDots: WorkflowDotState[] | null;
}) {
  const ordering = useContext(ListOrderingContext);
  const orderKey = `agent:${row.agentId}`;
  const st = derivedState(agent);
  const visual = stateVisual(st);
  const secondary = secondaryLabel(agent);
  // SOFT-TURN-LIMIT: a soft-policy agent past its nominal turn budget stays
  // "running" (fleetSummary/derivedState untouched, so counts stay correct) but
  // keeps its running/busy glyph and adds a separate warning. A budget warning
  // must not suppress activity animation or borrow the paused state color.
  const overBudget = agent.turnBudgetExceeded === true && agent.state === "running";
  // RUNNING-INDICATOR-PULSE: "running" alone doesn't say whether the agent is
  // actively streaming/tool-calling or just parked idle between turns — busy
  // (message_delta/tool_call -> turn_complete, see ui-state's reducer) is the
  // live signal. Only the plain glyph cell pulses; the workflow-dots/attached-
  // workflow branches above render a different state cell entirely.
  const busyRunning = agent.state === "running" && agent.busy === true;
  // F09.UI (QA U1): the unacknowledged-prompt badge showed promptStall.sinceMs — a ONE-SHOT
  // snapshot taken at detection — so a ten-minute stall still read "45s". Tick it. Gated on the
  // stall existing: an unconditional per-row interval would be a treadmill on a 378-agent fleet,
  // and a stalled row is rare (see the useStoreThrottled note on this list's render cost).
  const stallNow = useTickWhileStalled(!!agent.promptStall);
  // AGENT-STATE-VISUAL: the inline state WORD is gone (the glyph now carries
  // state on its own — see the .state cell below), so this label is the only
  // remaining state text; it lives in title+aria-label instead of being
  // painted, which also gives screen readers a state string that isn't
  // encoded by color alone.
  const stateLabel = [st, busyRunning ? "busy" : null, overBudget ? "over budget" : null]
    .filter(Boolean)
    .join(" — ");
  // OPERATOR-RENAME: inline, in place, the same shape the group box's own rename uses — a name is
  // read where it is read, so it should be corrected there too rather than behind a dialog.
  const [renamingAgent, setRenamingAgent] = useState(false);
  const [agentNameDraft, setAgentNameDraft] = useState(name);
  const commitRename = (): void => {
    const next = agentNameDraft.trim();
    setRenamingAgent(false);
    if (next && next !== name) void agentCommands(appStore, rpcCall).renameAgent(row.agentId, next);
  };
  return (
    <div
      className={selected ? styles.rowSelected : styles.row}
      // F47: the row's only DOM identity. Every other per-row hook (data-agent-action) renders
      // on the SELECTED row alone, so a filter assertion could count rows but never say WHICH
      // ones survived — exactly the thing an attention filter has to be trusted about.
      data-agent-row={row.agentId}
      onClick={() => appStore.dispatch({ type: "selectAgent", agentId: row.agentId })}
      draggable
      data-drop-position={ordering?.position(orderKey)}
      onDragStart={(e) => {
        if (ordering) ordering.start(e, orderKey);
        else { e.dataTransfer.setData(AGENT_DND_MIME, row.agentId); e.dataTransfer.effectAllowed = "copyMove"; }
      }}
      onDragEnd={() => ordering?.end()}
      onDragOver={(e) => ordering?.over(e, orderKey)}
      onDragLeave={(e) => ordering?.leave(e)}
      onDrop={(e) => ordering?.drop(e, orderKey)}
    >
      <GlyphCell agent={agent} />
      <div
        className={selected || agent.conductor ? styles.nameSelected : styles.name}
        // Tree nesting now indents the NAME (was the glyph gutter — which pushed
        // child MARKS out of the leading column). Marks stay aligned at the row
        // start; only the name+└ steps in per spawn depth.
        style={row.depth > 0 ? { paddingLeft: row.depth * 14 } : undefined}
      >
        {renamingAgent ? (
          <form
            className={styles.groupCreateForm}
            onSubmit={(e) => { e.preventDefault(); commitRename(); }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              className={styles.groupCreateInput}
              value={agentNameDraft}
              onChange={(e) => setAgentNameDraft(e.target.value)}
              onBlur={commitRename}
              // Escape abandons the edit — a rename you started by mistake must be leaveable
              // without committing whatever half-typed string is in the box.
              onKeyDown={(e) => { if (e.key === "Escape") { setAgentNameDraft(name); setRenamingAgent(false); } }}
              data-agent-rename-input={row.agentId}
            />
          </form>
        ) : (
          <HoverScrollText text={`${name}${secondary ? ` ${secondary}` : ""}`}>
            {row.depth > 0 ? "└ " : ""}{name}
            {row.collapsed && row.hiddenCount > 0 ? <span className={styles.faint}> +{row.hiddenCount}</span> : null}
            {secondary ? <span className={styles.id}> {secondary}</span> : null}
            {agent.pendingQuestion ? <span className={styles.question}> ?</span> : null}
          </HoverScrollText>
        )}
      </div>
      <div className={styles.state}>
        <span className={styles.stateValue}>
          {isAttachedWorkflowShadow(agent) ? (
            <WorkflowStepDots steps={[attachedWorkflowDotState(agent.state)]} />
          ) : workflowDots ? (
            <WorkflowStepDots steps={workflowDots} />
          ) : (
            <span
              className={
                busyRunning
                  ? `${styles.toneBusy} ${styles.busyPulse}`
                  : toneClass[visual.tone]
              }
              role="img"
              title={stateLabel}
              aria-label={stateLabel}
            >
              {visual.glyph}
            </span>
          )}
        </span>
        {/* AGENT-MARK: rendered OUTSIDE the selected-only action cluster, because a mark has to be
            visible from wherever the operator happens to be standing. Inside it, ticking a row and
            then selecting another made the tick vanish — the set existed but nothing on screen
            said which agents were in it, which is the one thing a batch action must show before
            it runs. Marked rows always show the box; unmarked ones only on the selected row, so
            an untouched list keeps its density. */}
        {(selected || marked) && (
          <button
            type="button"
            className={[styles.rowAction, styles.markAction, marked ? styles.markActionOn : ""].filter(Boolean).join(" ")}
            aria-label={marked ? "unmark agent" : "mark agent for batch actions"}
            aria-pressed={marked}
            title={marked ? "marked — click to unmark" : "mark for batch actions (send / kill / hold)"}
            data-agent-action="agents.mark"
            data-agent-marked={marked ? "1" : undefined}
            onClick={(ev) => {
              ev.stopPropagation();
              appStore.dispatch({ type: "toggleAgentMark", agentId: agent.agentId });
            }}
          >
            {marked ? "☑" : "☐"}
          </button>
        )}
        {selected ? (
          <span className={styles.rowActions}>
            <button
              type="button"
              className={styles.rowAction}
              aria-label={pinned ? "unpin selected agent" : "pin selected agent"}
              title={pinned ? "unpin agent" : "pin agent"}
              data-agent-action="system.pinSelected"
              onClick={(ev) => {
                ev.stopPropagation();
                runAction("system.pinSelected", appStore);
              }}
            >
              {pinned ? "★" : "☆"}
            </button>
            {/* OPERATOR-RENAME: only for a REAL agent — a shadow row is a projection of a
                sub-agent/workflow task with no record of its own to rename. */}
            {agent.shadow ? null : (
              <button
                type="button"
                className={styles.rowAction}
                aria-label="rename agent"
                title="rename agent"
                data-agent-action="agents.rename"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setAgentNameDraft(name);
                  setRenamingAgent(true);
                }}
              >
                ✎
              </button>
            )}
            {/* AGENT-RESUME-UI: on a FINISHED agent, and on a PAUSED one — the two states where
                "carry on" is a thing the operator can ask for. They take different routes (a
                held agent is released, a dead one is respawned into its session), but the button
                is one because the intent is one. Never on a running agent, where it would be a
                control whose only possible outcome is a refusal. Sits next to ✕ so what you can
                do with a stopped row is in one place: pick it up, or make it go away. */}
            {(isTerminalState(agent.state) || agent.state === "paused") && (
              <button
                type="button"
                className={styles.rowAction}
                aria-label={agent.state === "paused" ? "release held agent" : "resume finished agent"}
                title={agent.state === "paused"
                  ? "release — lift the hold and let this agent carry on"
                  : "resume — continue in the same worktree and session (composer text becomes the brief)"}
                data-agent-action="agents.resume"
                onClick={(ev) => {
                  ev.stopPropagation();
                  runAction("agents.resume", appStore);
                }}
              >
                ⟲
              </button>
            )}
            <button
              type="button"
              className={`${styles.rowAction} ${styles.killAction}`}
              // DISMISS-A-FINISHED-AGENT: the glyph does one thing — "make this go away" — but
              // what that MEANS differs, and a button labelled "kill" that actually forgets a
              // record would be lying about deleting history. Say which one it is.
              aria-label={isTerminalState(agent.state) ? "dismiss finished agent" : "kill selected agent"}
              title={isTerminalState(agent.state) ? "dismiss — forget this finished agent" : "kill agent"}
              data-agent-action="agents.kill"
              onClick={(ev) => {
                ev.stopPropagation();
                runAction("agents.kill", appStore);
              }}
            >
              ✕
            </button>
          </span>
        ) : null}
      </div>
      {/* R2 (item 1): a shadow's real costUsd/attempts stay 0/[] by design (its cost is rolled
          into the parent's total, not separately attributable) — "—" reads as "not tracked
          separately"; fmtCost(0) would misleadingly read as "cost nothing". Tokens DO have a real
          per-shadow figure (agent_task's usage.totalTokens, captured into shadowInfo) — show it
          instead of the "—" this row showed even when the daemon already had the data. */}
      <div className={styles.cost}>{agent.shadow ? "—" : fmtCost(agent.costUsd)}</div>
      <div className={styles.tokens}>
        {agent.shadow
          ? (agent.shadowInfo?.totalTokens !== undefined ? fmtTokens(agent.shadowInfo.totalTokens) : "—")
          : (agent.usage ? fmtTokens(agent.usage.input + agent.usage.output) : "—")}
      </div>
      {overBudget ? <span className={styles.toneWarn} title="Soft turn limit exceeded; the agent is still running"> ⚠ soft</span> : null}
      {/* PAUSED-AGENTS-VISIBLE: the WHY + WHEN badge — the ⏸ glyph on the state cell
          already flags a paused row, but a bare "paused" word doesn't tell the operator
          whether it'll resolve itself (session limit / reattach recovery) or is stuck
          retrying (crash loop), nor when to expect it back. */}
      {agent.state === "paused" ? (() => {
        // PAUSE-BADGE-NOISE: this trailing badge exists to carry the WHY — the ⏸ on the state
        // cell already flags the row as paused. With no reason worth the width (the benign
        // restart/idle holds, see pauseSummary) there is nothing left for it to say, and
        // drawing the bare glyph again just puts a second ⏸ at the end of the row.
        const why = pauseSummary(agent);
        return why ? <span className={styles.toneWarn}>{` ⏸ ${why}`}</span> : null;
      })() : null}
      {/* F08: the ✗ glyph on the state cell already flags a failed row — this trailing badge
          carries the WHY (rate-limited vs bad credential vs unretryable request), each of which
          implies a different operator action, so unlike the pause badge there is no "nothing
          worth the width" case here. */}
      {/* F08.UI: the badge says the class AND whose move it is next ("needs you" vs "retries
          spent"), because on a terminal row those two look identical otherwise; the full
          sentence — what to do, and the RULE that classified it — rides the tooltip so the row
          stays one line. An unknown cause from a newer daemon is drawn MUTED, not warn-toned: a
          raw wire string must not pass itself off as a curated label (F08.QA). */}
      {agent.state === "failed" && agent.failure ? (
        <span
          className={isKnownFailureCause(agent.failure.cause) ? styles.toneWarn : styles.toneMuted}
          title={failureDetail(agent.failure)}
          aria-label={failureDetail(agent.failure)}
          data-agent-failure={agent.failure.cause}
        >
          {` ${failureBadge(agent.failure)}`}
        </span>
      ) : null}
      {/* F09: the agent is idle with an unacknowledged message — NOT the fleet `stalled`
          (a running turn gone quiet, selectors.fleet.ts:43). Distinct wording on purpose.
          F09.UI: the badge IS the control (the F47 `new` badge's own rationale — the operator who
          just read the row is looking straight at it), and its duration ticks off `sinceTs`
          instead of freezing on the detection snapshot. */}
      {agent.promptStall ? (
        <button
          type="button"
          className={`${styles.rowAction} ${styles.toneWarn}`}
          data-agent-action="agents.resendPrompt"
          title={`${promptStallDetail(agent.promptStall, stallNow)} (click, or run “Resend unacknowledged prompt” from the command palette)`}
          aria-label={promptStallDetail(agent.promptStall, stallNow)}
          onClick={(ev) => {
            ev.stopPropagation();
            void agentCommands(appStore, rpcCall).resendStalledPrompt(row.agentId);
          }}
        >
          {`${promptStallBadge(agent.promptStall, stallNow)} · resend`}
        </button>
      ) : null}
      {/* F47: the per-row attention badge doubles as its own mark-read affordance — the operator
          who just read the row is looking straight at it, so making them travel to a header sweep
          (or remember a keybinding) to clear it is the one interaction that would make the badge
          annoying rather than useful. stopPropagation keeps the click from also re-selecting. */}
      <span className={styles.unseenSlot}>
        {isUnseen(agent) ? (
          <button
            type="button"
            className={styles.unseenBadge}
            data-agent-action="agents.markSeen"
            aria-label="Unread activity — mark read"
            title="Unread activity — mark read"
            onClick={(ev) => {
              ev.stopPropagation();
              void agentCommands(appStore, rpcCall).markSeen([row.agentId]);
            }}
          >
            <span className={styles.unseenDot} aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {/* team mark now renders LEADING in GlyphCell (row start), not here — see
          GlyphCell (user request: trailing badge after the variable-width tokens
          column made the list look shifted). */}
    </div>
  );
}

// WORKFLOW-TASK-VIEW-2: a workflow-bound task renders as ONE row, styled
// exactly like an ordinary agent row — leading ⧉ glyph, name, a state cell
// (step DOTS when the bound workflow definition has resolved, else the plain
// glyph/word fallback below — mirrors Row's own workflowDots-or-glyph split),
// summed cost/tokens. No fold, no nested rows: the step agents this task ran
// are not rows of their own (reachable via the stitched transcript instead —
// see TranscriptPanel's `workflow` mode). Mode-agnostic: renders identically
// whether the task ran one agent for every step (the pre-WF-8 norm) or several
// distinct step agents (WF-8's per-step role switch) — groupAgentListRowsByTask
// derives the summary from stepHistory, not a mode flag.
// Exported so TranscriptPanel's workflow-mode header (WORKFLOW-UI-2) reads the
// SAME glyph/tone mapping this row does — one task state, one visual, never two.
export const TASK_STATE_VISUAL: Record<string, { glyph: string; tone: string }> = {
  pending: { glyph: "○", tone: "muted" },
  blocked: { glyph: "○", tone: "muted" },
  in_progress: { glyph: "◐", tone: "success" },
  done: { glyph: "●", tone: "info" },
  failed: { glyph: "✗", tone: "danger" },
};

// RUNNING-STATE-PURPLE: task.state alone ("pending"/"in_progress"/"done"/"failed") stays
// "in_progress" straight through a session-limit pause on the current step agent (a
// non-terminal HOLD — see currentAgentState's doc comment on AgentListRow), so a paused
// step read as indistinguishable from a running one. Overriding to "warn" here — same tone
// a plain paused Row gets from stateVisual("paused") — before falling back to the task-level
// TASK_STATE_VISUAL keeps the paused case visually distinct instead of masquerading as running.
function taskRowTone(row: Extract<AgentListRow, { kind: "task" }>): string {
  if (row.currentAgentState === "paused") return "warn";
  return (TASK_STATE_VISUAL[row.state] ?? TASK_STATE_VISUAL["pending"]!).tone;
}

function TaskRow({ row, selected }: { row: Extract<AgentListRow, { kind: "task" }>; selected: boolean }) {
  const tone = taskRowTone(row);
  const glyph = TASK_STATE_VISUAL[row.state] ?? TASK_STATE_VISUAL["pending"]!;
  return (
    <div
      className={selected ? styles.rowSelected : styles.row}
      onClick={() => appStore.dispatch({ type: "selectAgent", agentId: taskRowId(row.taskId) })}
      data-task-row={row.taskId}
    >
      <div className={styles.glyphCol}>
        {/* RUNNING-STATE-PURPLE: was a FIXED --accent purple for every task state — see
            taskRowTone's doc comment. */}
        <span className={toneClass[tone]} title="workflow task">⧉</span>
      </div>
      <div
        className={selected ? styles.nameSelected : styles.name}
        style={row.depth > 0 ? { paddingLeft: row.depth * 14 } : undefined}
      >
        {row.depth > 0 ? "└ " : ""}
        {row.label}
      </div>
      <div className={styles.state}>
        {row.stepDots ? (
          <WorkflowStepDots steps={row.stepDots} />
        ) : (
          <span className={toneClass[glyph.tone]} role="img" title={row.state} aria-label={row.state}>
            {glyph.glyph}
          </span>
        )}
      </div>
      <div className={styles.cost}>{fmtCost(row.costUsd)}</div>
      <div className={styles.tokens}>{row.usage ? fmtTokens(row.usage.input + row.usage.output) : "—"}</div>
      <span className={styles.unseenSlot} aria-hidden="true" />
      {/* PAUSED-AGENTS-VISIBLE parity: a plain Row already carries this badge for a
          paused agent — a workflow task row folded its step agents away (WORKFLOW-TASK-
          VIEW-2), which silently dropped it for the current step agent. Same WHY+WHEN text
          (pauseSummary), same "last on the row" placement. */}
      {row.currentAgentPause ? <span className={styles.toneWarn}> ⏸ {pauseSummary(row.currentAgentPause)}</span> : null}
    </div>
  );
}

// JOB-FLEET-GROUPING: renders a scheduled job's collapsed run history — a header (name + run
// count) and a fixed-height SCROLLABLE body holding only the currently-LOADED member rows
// (JOB_GROUP_DEFAULT_VISIBLE=3 at rest), each an ordinary Row reused verbatim (same click-to-
// select/drag/kill affordances as any other agent). "load more" grows the loaded window —
// member rows beyond it are never mounted, so a job with hundreds of runs never puts hundreds
// of Row components in the DOM (the literal bug this exists to fix: lazy loading "isn't there").
// loadedCount resets to the default whenever a DIFFERENT job's row remounts here (React key is
// `jobgroup:<jobName>`, see the render loop) — deliberately not persisted across jobs.
function JobGroupRow({
  row, agents, selectedId, pins,
}: {
  row: Extract<AgentListRow, { kind: "jobGroup" }>;
  agents: Record<string, AgentView>;
  selectedId: string | null;
  pins: ReadonlyArray<{ type: string; id: string }>;
}) {
  // AGENT-MARK: one subscription for the whole group rather than one per member Row.
  const markedIds = useStore((st: UiState) => st.markedAgentIds);
  const [loaded, setLoaded] = useState(JOB_GROUP_DEFAULT_VISIBLE);
  const remaining = row.memberIds.length - loaded;
  return (
    <div className={styles.jobGroup} data-job-group={row.jobName}>
      <div className={styles.jobGroupHeader}>
        <div className={styles.glyphCol}>
          <span className={styles.jobGlyph} title="scheduled job">▤</span>
        </div>
        <div className={styles.name}>
          {row.jobName}
          <span className={styles.faint}> · {row.memberIds.length} runs</span>
        </div>
      </div>
      <div className={styles.jobGroupBody}>
        {row.memberIds.slice(0, loaded).map((agentId) => {
          const agent = agents[agentId];
          if (!agent) return null;
          const memberRow: AgentRow = {
            kind: "agent", agentId, depth: 0, collapsible: false, collapsed: false, hiddenCount: 0, section: "main",
          };
          return (
            <Row
              key={agentId}
              row={memberRow}
              agent={agent}
              name={conductorLabel(agents, agentId)}
              selected={agentId === selectedId}
              pinned={pins.some((pin) => pin.type === "agent" && pin.id === agentId)}
              marked={markedIds.includes(agentId)}
              workflowDots={null}
            />
          );
        })}
        {remaining > 0 ? (
          <button
            type="button"
            className={styles.jobGroupLoadMore}
            onClick={() => setLoaded((n) => Math.min(row.memberIds.length, n + 10))}
          >
            load {Math.min(10, remaining)} more · {remaining} older run{remaining === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// P3-T3 + icon-pack: teamIcon color id → the AgentList.module.css --team-* class.
const TEAM_COLOR_CLASS: Record<TeamColorId, string> = {
  blue: styles.teamBlue!, green: styles.teamGreen!, amber: styles.teamAmber!, purple: styles.teamPurple!,
  cyan: styles.teamCyan!, magenta: styles.teamMagenta!, red: styles.teamRed!, teal: styles.teamTeal!,
};
// AGENT-GROUPS Phase 1: the SAME 8 semantic ids as team badges (P3-T3), on the BORDER only —
// never row text/state cell/GlyphCell (merge 833c9e20 just fixed a workflow row that lost its
// state signal to a fixed accent color; this must not reintroduce that class of bug).
const GROUP_BORDER_CLASS: Record<TeamColorId, string> = {
  blue: styles.groupBorderBlue!, green: styles.groupBorderGreen!, amber: styles.groupBorderAmber!, purple: styles.groupBorderPurple!,
  cyan: styles.groupBorderCyan!, magenta: styles.groupBorderMagenta!, red: styles.groupBorderRed!, teal: styles.groupBorderTeal!,
};

// AGENT-GROUPS Phase 1: an operator-defined wrapper box — a coloured-border container (never
// on row text/state/GlyphCell) holding its members' rows NESTED at their real relative depth
// (unlike JobGroupRow, which flattens every member to depth 0 — a group's members can have
// real parent/child structure the box must preserve; see selectors.groups.ts's doc comment).
// Clicking the header toggles this group as the "active" one (spawn inheritance + a visual
// highlight) — mirrors selecting an agent, just for a box instead of a row.
function GroupBoxRow({
  row, agents, selectedId, pins, active,
}: {
  row: Extract<AgentListRow, { kind: "group" }>;
  agents: Record<string, AgentView>;
  selectedId: string | null;
  pins: ReadonlyArray<{ type: string; id: string }>;
  active: boolean;
}) {
  // AGENT-MARK: one subscription for the box rather than one per member Row.
  const markedIds = useStore((st: UiState) => st.markedAgentIds);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(row.name);
  // Lightweight "click again to confirm" instead of pulling in the full ConfirmCard machinery
  // — a group delete never touches an agent record (core/src/groups.ts's own contract), so the
  // blast radius of a mistaken click is low; still gated, never a single bare click.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const ordering = useContext(ListOrderingContext);
  const orderKey = `group:${row.groupId}`;
  return (
    <div
      className={`${styles.groupBox} ${GROUP_BORDER_CLASS[row.color]} ${active ? styles.groupBoxActive : ""}`}
      data-group-box={row.groupId}
      data-drop-position={ordering?.position(orderKey)}
      onDragOver={(e) => ordering?.over(e, orderKey, "group")}
      onDragLeave={(e) => ordering?.leave(e)}
      onDrop={(e) => ordering?.drop(e, orderKey, "group")}
    >
      <div className={styles.groupBoxHeader}
        draggable={!renaming}
        data-group-drag={row.groupId}
        title="drag to reorder group"
        onDragStart={(e) => ordering?.start(e, orderKey)}
        onDragEnd={() => ordering?.end()}>
        {renaming ? (
          <form
            className={styles.groupCreateForm}
            onSubmit={(e) => {
              e.preventDefault();
              const name = renameValue.trim();
              if (name && name !== row.name) void groupsCmd.renameGroup(row.groupId, name);
              setRenaming(false);
            }}
          >
            <input
              autoFocus
              className={styles.groupCreateInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => setRenaming(false)}
              data-group-rename-input
            />
          </form>
        ) : (
          <div
            className={styles.name}
            role="button"
            tabIndex={0}
            onClick={() => groupsCmd.setActiveGroup(active ? null : row.groupId)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") groupsCmd.setActiveGroup(active ? null : row.groupId); }}
          >
            {row.name}
            <span className={styles.faint}> · {row.liveCount}/{row.totalCount}</span>
          </div>
        )}
        <span className={styles.spacer} />
        <span
          className={styles.groupBoxAction}
          role="button"
          tabIndex={-1}
          title="rename group"
          onClick={() => { setRenameValue(row.name); setRenaming(true); }}
          data-group-rename={row.groupId}
        >
          ✎
        </span>
        <span
          className={styles.groupBoxAction}
          role="button"
          tabIndex={-1}
          title={deleteArmed ? "click again to confirm delete" : "delete group"}
          onClick={() => {
            if (deleteArmed) void groupsCmd.deleteGroup(row.groupId);
            else { setDeleteArmed(true); setTimeout(() => setDeleteArmed(false), 3000); }
          }}
          data-group-delete={row.groupId}
        >
          {deleteArmed ? "confirm ×" : "×"}
        </span>
      </div>
      <div className={styles.groupBoxBody}>
        {row.memberRows.map((r) => {
          if (r.kind !== "agent") return null; // Phase 1: only agent rows ever nest here
          const agent = agents[r.agentId];
          if (!agent) return null;
          return (
            <Row
              key={r.agentId}
              row={r}
              agent={agent}
              name={conductorLabel(agents, r.agentId)}
              selected={r.agentId === selectedId}
              pinned={pins.some((pin) => pin.type === "agent" && pin.id === r.agentId)}
              marked={markedIds.includes(r.agentId)}
              workflowDots={null}
            />
          );
        })}
        {row.memberRows.length === 0 ? <div className={styles.groupBoxEmpty}>no agents in this group yet</div> : null}
      </div>
    </div>
  );
}

export function AgentList() {
  // Slice subscriptions keep re-renders scoped (see useStore's doc comment);
  // rowsState re-picks exactly the slices buildAgentRows/fleetSummary read, so
  // NOTHING here reads appStore.getState() at render time (review finding 7 —
  // a render-time getState bypasses useSyncExternalStore: a slice this
  // component forgot to subscribe to, e.g. mainConductorId, could change
  // without a re-render / tear against the committed snapshot).
  // RENDER-TREADMILL: `agents` changes on EVERY event (usage, cost, state), and this list's
  // derivation from it is the most expensive in the app — a fresh agentMeta over every agent, then
  // three grouping passes over every row. Measured with 370 agents: 7.7 ms per single event, which
  // at this machine's peak of 101 events/sec is 778 ms of rendering per second before anything is
  // typed. Sampled instead: nothing is dropped (the trailing flush always renders the last value),
  // only the redundant paints between are.
  //
  // The others stay immediate on purpose. agentOrder/collapsed/teams/mainConductorId change when
  // the operator does something, not per event, so throttling them would only add lag; and
  // selectedAgentId drives the transcript, where any delay is felt directly as a slow click.
  const agents = useStoreThrottled((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  const collapsed = useStore((s) => s.collapsed);
  const teams = useStore((s) => s.teams);
  const mainConductorId = useStore((s) => s.mainConductorId);
  const selectedId = useStore((s) => s.selectedAgentId);
  // AGENT-MARK: one subscription for the list, passed down as a prop. Subscribing inside Row meant
  // one per mounted agent — 378 on this operator's fleet, all re-running on every event, for a
  // boolean the list already has.
  const markedIds = useStore((s) => s.markedAgentIds);
  const pins = useSystemLocal((s) => s.pins);
  // AGENT-GROUPS Phase 1: the registry (group.list) + which box is currently focused (view-
  // only, see UiState.activeGroupId's own doc comment) — loaded once on mount, refreshed
  // after local or external CRUD and reconnect via commands.groups.ts.
  const groupRegistry = useStore((s) => s.groups.items);
  const activeGroupId = useStore((s) => s.activeGroupId);
  useEffect(() => { void groupsCmd.loadGroups(); }, []);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const rowsState = useMemo(
    () => ({ agents, agentOrder, collapsed, teams, mainConductorId }),
    [agents, agentOrder, collapsed, teams, mainConductorId],
  );
  // SEARCH-AGENTS: per-tab free-text filter (mirrors EventsScreen). Matches +
  // ancestors so a deep match stays reachable in its tree — see
  // selectors.buildAgentRows's doc comment for the fold-override rationale.
  const [query, setQuery] = useState(() => initialFleetFilter()?.query ?? "");
  // AGENTS-HIDE-DONE: screen-local toggle (mirrors `query` above) — default
  // false hides terminal (done/failed/killed) agents/ancestors-only-of-active
  // out of buildAgentRows; a non-empty query always overrides it (search
  // reaches every terminal agent regardless of the toggle).
  // DONE-AGENTS-HIDDEN-AFTER-RESTART: persisted to localStorage (same pattern
  // as CommandPalette's recent/pinned keys) so a daemon/app restart — which
  // moves every agent behind this filter at once — doesn't also silently
  // reset the user's choice to reveal them.
  const [showDone, setShowDone] = useState<boolean>(() => {
    if(initialFleetFilter()) return initialFleetFilter()!.showDone;
    try { return localStorage.getItem(SHOW_DONE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (showDone) localStorage.setItem(SHOW_DONE_KEY, "1");
      else localStorage.removeItem(SHOW_DONE_KEY);
    } catch { /* storage unavailable (private mode, disabled) — toggle stays session-only */ }
  }, [showDone]);
  // F47: attention-only filter, persisted exactly like showDone above. Composes with it and
  // defers to a non-empty query for the same reason showDone does — search reaches everything.
  const [unseenOnly, setUnseenOnly] = useState<boolean>(() => {
    if(initialFleetFilter()) return initialFleetFilter()!.unseenOnly;
    try { return localStorage.getItem(UNSEEN_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (unseenOnly) localStorage.setItem(UNSEEN_KEY, "1");
      else localStorage.removeItem(UNSEEN_KEY);
    } catch { /* storage unavailable (private mode, disabled) — toggle stays session-only */ }
  }, [unseenOnly]);
  // F08.UI: "only the agents a human has to unblock" — persisted exactly like unseenOnly above.
  const [needsOperatorOnly, setNeedsOperatorOnly] = useState<boolean>(() => {
    if(initialFleetFilter()) return initialFleetFilter()!.needsOperatorOnly;
    try { return localStorage.getItem(NEEDS_OPERATOR_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      if (needsOperatorOnly) localStorage.setItem(NEEDS_OPERATOR_KEY, "1");
      else localStorage.removeItem(NEEDS_OPERATOR_KEY);
    } catch { /* storage unavailable (private mode, disabled) — toggle stays session-only */ }
  }, [needsOperatorOnly]);
  useEffect(() => { rememberFleetFilter({query,showDone,unseenOnly,needsOperatorOnly}); }, [query,showDone,unseenOnly,needsOperatorOnly]);
  useEffect(() => onFleetFilter(f => { setQuery(f.query); setShowDone(f.showDone); setUnseenOnly(f.unseenOnly); setNeedsOperatorOnly(f.needsOperatorOnly); }), []);

  const rows = useMemo(
    () => buildAgentRows(rowsState, query, showDone, unseenOnly, needsOperatorOnly),
    [rowsState, query, showDone, unseenOnly, needsOperatorOnly],
  );
  const summary = useMemo(() => fleetSummary(rowsState), [rowsState]);
  const hiddenDoneCount = useMemo(() => hiddenTerminalAgentCount(rowsState), [rowsState]);
  // The same figure while they are SHOWN, where none are hidden and hiddenTerminalAgentCount is
  // therefore 0 — the label needs a count in both states, not only when the fold is closed.
  const doneCount = useMemo(
    () => Object.values(rowsState.agents).filter((a) => !a.shadow && isTerminalState(derivedState(a))).length,
    [rowsState],
  );
  // PURGE-TERMINAL-SESSIONS: counts EVERY finished agent, not just the ones currently hidden by
  // the done-fold — the sweep is about what exists, not about what happens to be on screen.
  const terminalCount = useMemo(
    // Every TERMINAL state — matches supervisor.purgeTerminal exactly. A count that disagreed
    // with the daemon's own scope would promise a sweep it will not perform.
    () => Object.values(agents).filter((a) => a.state === "done" || a.state === "failed" || a.state === "killed").length,
    [agents],
  );
  // A2A-UX-OVERHAUL: the a2a feed / active-pair pulse decay that used to live here
  // is gone — the ephemeral A2AIndicator (bottom of this panel) owns its own feed +
  // lifecycle. `events` stays: the workflow-step overlay below reads it.
  const events = useStore((s) => s.events);
  // F16 task-workflow step indicator: every queue's tasks (agentTasksLocal)
  // + the workflow registry (workflowsLocal), loaded on mount and refreshed
  // whenever a coordination-relevant event lands (latestCoordSeq — same
  // trigger QueuesScreen's own drill refetch rides), no polling timers.
  const coordSeq = useStore((s) => latestCoordSeq(s.events));
  const tasks = useAgentTasksLocal((s) => s.tasks);
  const workflowItems = useWorkflowsLocal((s) => s.items);
  useEffect(() => { void workflowsCmd.loadWorkflows(); }, []);
  useEffect(() => { void agentTasksCmd.loadAgentTasks(); }, [coordSeq]);

  // WORKFLOW-TASK-VIEW-2: reshape the flat spawn-tree rows into task-grouped
  // rows — every workflow-bound task's step agents collapse into ONE row (see
  // groupAgentListRowsByTask's doc comment for why a single-agent task
  // collapses through the same path as a multi-agent one).
  const agentMeta = useMemo(() => {
    const m: Record<string, AgentMetaForTask> = {};
    for (const [id, a] of Object.entries(agents)) {
      m[id] = { costUsd: a.costUsd, usage: a.usage, pendingQuestion: a.pendingQuestion };
    }
    return m;
  }, [agents]);
  // JOB-FLEET-GROUPING: a second, independent reshape pass over the task-grouped rows —
  // every scheduled job's spawns collapse into one row at the end (see
  // groupAgentListRowsByJob's doc comment for why the two passes never contend for a row).
  // AGENT-GROUPS Phase 1: runs LAST — groupAgentListRowsByTask's input type is pinned to
  // ReadonlyArray<AgentRow> (agent-only rows), so it must see the RAW buildAgentRows output,
  // never a list that can already contain a "group" row. Consequence: a job-spawned or
  // task-bound agent that's ALSO in an operator group gets collapsed into its task/jobGroup
  // row first, same as any other agent — box grouping only ever sees whatever "agent" rows
  // survive those two passes. Acceptable for Phase 1 (the operator's own case is grouping
  // ordinary session/worker agents, not job fleets); see selectors.groups.ts's own doc
  // comment for the full contiguous-subtree contract.
  const groupedRows = useMemo(() => {
    const taskGrouped = groupAgentListRowsByTask(rows, tasks, agentMeta, workflowItems, agents);
    const jobGrouped = groupAgentListRowsByJob(taskGrouped, agents);
    return groupAgentListRowsByGroup(jobGrouped, agents, groupRegistry);
  }, [rows, agents, groupRegistry, tasks, agentMeta, workflowItems]);

  const ordering = useAgentListOrdering(groupedRows, groupsCmd);
  const listRows = ordering.rows;

  // SEARCH-AGENTS: ↑↓/←→ must step/fold over the FILTERED rows, not the
  // built-in dispatchAction's unfiltered buildAgentRows(state) (keymap.ts) —
  // registering here shadows it (runAction: last-registered wins) exactly
  // like FlowPane already does for the flow view. A ref keeps the handlers
  // reading the latest rows without re-registering every keystroke.
  const rowsRef = useRef(listRows);
  rowsRef.current = listRows;
  const idOf = (r: AgentListRow): string =>
    r.kind === "task" ? taskRowId(r.taskId)
      : r.kind === "jobGroup" ? jobGroupRowId(r.jobName)
      : r.kind === "group" ? groupRowId(r.groupId)
      : r.agentId;
  useEffect(() => {
    const move = (delta: number) => () => {
      const visible = visibleListRowIds(rowsRef.current);
      if (visible.length === 0) return;
      const sel = appStore.getState().selectedAgentId;
      const cur = sel ? Math.max(0, visible.indexOf(sel)) : 0;
      const next = Math.min(visible.length - 1, Math.max(0, cur + delta));
      appStore.dispatch({ type: "selectAgent", agentId: visible[next]! });
    };
    const fold = (open: boolean) => () => {
      const sel = appStore.getState().selectedAgentId;
      const row = sel ? rowsRef.current.find((r) => idOf(r) === sel) : undefined;
      // WORKFLOW-TASK-VIEW-2: a task row has no nested rows to fold anymore. JOB-FLEET-
      // GROUPING: nor does a jobGroup row — its "load more" is mouse-driven, not foldable.
      // AGENT-GROUPS Phase 1: nor a group box — `sel` never resolves to one anyway (see
      // visibleListRowIds' recursion into memberRows), kept only so `.collapsed` below
      // type-checks against every AgentListRow kind.
      if (!row || row.kind === "task" || row.kind === "jobGroup" || row.kind === "group") return;
      if (open ? row.collapsed : row.collapsible && !row.collapsed) {
        appStore.dispatch({ type: "collapse", agentId: sel! });
      }
    };
    const offs = [
      registerActionHandler("agents.up", move(-1)),
      registerActionHandler("agents.down", move(1)),
      registerActionHandler("agents.foldLeft", fold(false)),
      registerActionHandler("agents.foldRight", fold(true)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Clamp the selection when a query narrows the tree out from under it — the
  // previously-selected agent may no longer be a match/ancestor.
  useEffect(() => {
    // F47.QA2: the attention-only chip narrows the same rows without touching `query`, and marking
    // the SELECTED agent read (row badge / palette / the screen's `agents.markSeen`) drops its row
    // out from under the selection. Without unseenOnly here the selection strands on an undrawn
    // row and the next ↑/↓ teleports to the top (move()'s indexOf -> -1 -> index 0).
    if (listRows.length === 0) return;
    const current = appStore.getState();
    const currentId = current.selectedAgentId;
    const liveIds = new Set(current.agentOrder);
    // Read validity from the live roster, not the throttled rendering snapshot.
    if (!query.trim() && !unseenOnly && !needsOperatorOnly && currentId &&
        ((liveIds.has(currentId) && current.agents[currentId]) || taskIdFromRowId(currentId) !== null)) return;
    // SEARCH-SELECTION-PING-PONG: both halves of this go through visibleListRowIds — the ONE
    // definition of "ids the list can actually land on". It already skips a jobGroup/group box
    // header (no transcript to show) and recurses INTO a box's members.
    //
    // Doing it per-row with idOf instead was wrong twice, and the two mistakes compounded into an
    // unbounded loop. A group box's members are nested inside its row, so idOf never saw them:
    // an agent that WAS visible inside the box counted as missing, and the fallback then handed
    // selectAgent the box's own synthetic "group:<id>". AgentsScreen's validity effect knows no
    // such agent, bounces the selection to agentOrder[0], that agent does not match the query, and
    // this effect re-points at the box — forever, one rejected agent.status per cycle from every
    // consumer that refetches on selection. Reported as the app freezing the instant you type.
    const selectable = visibleListRowIds(listRows).filter((id) => (liveIds.has(id) && current.agents[id]) || taskIdFromRowId(id) !== null);
    if (currentId && selectable.includes(currentId)) return;
    const fallbackId = selectable[0];
    // Never re-dispatch the id that is ALREADY selected. Reaching here means the selection was not
    // found among the rows, so if the fallback resolves to that same id there is nothing this
    // effect can do — dispatching anyway just re-enters it. The store now ignores a no-op
    // selection too; this is the other half, so neither side alone has to hold the invariant.
    if (fallbackId && fallbackId !== currentId) appStore.dispatch({ type: "selectAgent", agentId: fallbackId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRows, query, unseenOnly, needsOperatorOnly, selectedId]);

  return (
    <ListOrderingContext.Provider value={ordering}>
    <Panel label={<TitleSummary s={summary} />} className={styles.pane}>
      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder="search agents (name · id · state · team)"
        count={{ shown: rows.length, total: summary.total, noun: "agents" }}
        dataAttr="agents-search"
      >
        <button
          type="button"
          className={styles.spawnButton}
          onClick={() => runAction("agents.spawnDefault", appStore)}
          data-agent-action="agents.spawnDefault"
          title="choose provider, account and model for a new chat"
        >
          + spawn
        </button>
        <button
          type="button"
          className={styles.doneToggle}
          onClick={() => runAction("agents.spawn", appStore)}
          data-agent-action="agents.spawn"
          title="spawn with options (form)"
        >
          ⋯
        </button>
        {/* SEARCHBOX-ACTION-ROW: the LIST's own chips, wrapped so they always occupy a row of
            their own. They used to sit loose in the search row and relied on its flex-wrap to
            push them down, so their position was an overflow artifact — it moved with the pane
            width and the wrapped line aligned to nothing. A basis of 100% makes the second row
            deliberate, with its own gap and a left edge matching the "/" above. */}
        <div className={styles.listActions}>
        {/* F47: the attention chrome hides entirely on an idle fleet — a standing "0 new" chip is
            a false alarm. The ONE exception is a filter the operator turned on and then emptied by
            reading everything: the toggle stays so it can be switched back off, because a narrowed
            list with no way out reads as "the fleet is gone". */}
        {/* F08.UI: same show-when-it-matters rule as the attention chip below — a standing
            "0 needs you" chip is a false alarm — with the same exception for a filter the
            operator turned on and then emptied by fixing everything. */}
        {summary.needsOperator > 0 || needsOperatorOnly ? (
          <button
            type="button"
            className={needsOperatorOnly ? `${styles.doneToggle} ${styles.doneToggleEmphasis}` : styles.doneToggle}
            onClick={() => setNeedsOperatorOnly((v) => !v)}
            data-agents-needs-operator-toggle=""
            title={
              needsOperatorOnly
                ? "show every agent again"
                : "show only agents that died a way the engine cannot retry its way out of"
            }
          >
            {/* SYMMETRIC-TOGGLE-LABEL, same COUNT · verb shape as the chips beside it. */}
            {needsOperatorOnly ? `⚠ ${summary.needsOperator} needs you · all` : `⚠ ${summary.needsOperator} needs you · only`}
          </button>
        ) : null}
        {summary.unseen > 0 || unseenOnly ? (
          <>
            <button
              type="button"
              className={unseenOnly ? `${styles.doneToggle} ${styles.doneToggleEmphasis}` : styles.doneToggle}
              onClick={() => setUnseenOnly((v) => !v)}
              data-agents-unseen-toggle=""
              /* "new" is the badge word, not a concept the operator can look up — spell out what
                 it counts. */
              title={unseenOnly ? "show every agent again" : "show only agents with activity you have not read"}
            >
              {/* Same COUNT · verb shape as the done toggle beside it (SYMMETRIC-TOGGLE-LABEL). */}
              {unseenOnly ? `◆ ${summary.unseen} new · all` : `◆ ${summary.unseen} new · only`}
            </button>
            {/* Calls the command DIRECTLY rather than through runAction: AgentList is mounted in
                tests (and could be reused) without AgentsScreen, whose registerActionHandler is
                what gives the action a body — the registry-miss fallback would silently no-op. */}
            {summary.unseen > 0 ? (
            <button
              type="button"
              className={styles.doneToggle}
              /* F47.FIX M-2: fleet sweep — skipUnknown, same reason as the palette action. */
              onClick={() => void agentCommands(appStore, rpcCall).markSeen(unseenAgentIds(rowsState), { skipUnknown: true })}
              data-agent-action="agents.markAllSeen"
              title="mark every agent read"
            >
              mark all seen
            </button>
          ) : null}
          </>
        ) : null}
        {/* AGENTS-HIDE-DONE: only worth showing when there's something the
            toggle actually affects — nothing to reveal AND not currently
            showing done would render a hollow "0 done" chip. */}
        {showDone || hiddenDoneCount > 0 ? (
          <button
            type="button"
            className={
              !showDone && hiddenDoneCount > rows.length
                ? `${styles.doneToggle} ${styles.doneToggleEmphasis}`
                : styles.doneToggle
            }
            onClick={() => setShowDone((v) => !v)}
            data-agents-done-toggle=""
          >
            {/* SYMMETRIC-TOGGLE-LABEL: both states read the same shape — a COUNT, then the verb
                that acts on it. "hide done" on its own is a bare verb with no count, and next to
                two sibling action buttons ("close all sessions", "clean up N finished") it reads
                just as easily as a STATE — "done are hidden" — which is the opposite of what it
                means. Reported as "why are done agents still visible, weren't we hiding them?"
                while the toggle was simply switched on. A label that can be read as either the
                current condition or the pending action cannot be fixed by explaining it. */}
            {showDone ? `◍ ${doneCount} done · hide` : `◍ ${hiddenDoneCount} done · show`}
          </button>
        ) : null}
        {/* Ad-hoc sessions design §6 "close all sessions" — only worth showing when
            there's at least one live session to batch-close. */}
        {Object.values(agents).some((a) => a.session && (a.state === "running" || a.state === "paused")) ? (
          <button
            type="button"
            className={styles.doneToggle}
            onClick={() => runAction("agents.closeAllSessions", appStore)}
            data-agent-action="agents.closeAllSessions"
          >
            close all sessions
          </button>
        ) : null}
        {/* PURGE-TERMINAL-SESSIONS: the housekeeping counterpart beside it — that button ENDS
            live sessions, this one FORGETS finished ones and reclaims their disk (the record,
            its archived copy and its mailbox). Shown only when there is actually something to
            sweep, and it names the count so the click is never a blind one. */}
        {terminalCount > 0 ? (
          <button
            type="button"
            className={styles.doneToggle}
            onClick={() => runAction("agents.purgeTerminalSessions", appStore)}
            data-agent-action="agents.purgeTerminalSessions"
            title="delete the records, archived copies and mailboxes of finished agents"
          >
            {`clean up ${terminalCount} finished`}
          </button>
        ) : null}
        {/* AGENT-GROUPS Phase 1: the one create affordance — a plain inline text input rather
            than a new card/modal component, since this is the entire CRUD surface Phase 1
            needs (rename/delete live on each box itself; assign lives in the detail panel). */}
        {creatingGroup ? (
          <form
            className={styles.groupCreateForm}
            onSubmit={(e) => {
              e.preventDefault();
              const name = newGroupName.trim();
              if (name) void groupsCmd.createGroup(name);
              setNewGroupName("");
              setCreatingGroup(false);
            }}
          >
            <input
              autoFocus
              className={styles.groupCreateInput}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onBlur={() => { if (!newGroupName.trim()) setCreatingGroup(false); }}
              placeholder="group name…"
              data-group-create-input
            />
          </form>
        ) : (
          <button
            type="button"
            className={styles.doneToggle}
            onClick={() => setCreatingGroup(true)}
            data-agent-action="groups.create"
            title="create a new operator group"
          >
            + group
          </button>
        )}
        </div>
      </SearchBox>
      <div className={styles.columns}>
        <div className={styles.colGlyph} />
        <div className={styles.colAgent}>agent</div>
        <div className={styles.colState}>state</div>
        <div className={styles.colCost}>cost</div>
        <div className={styles.colTokens}>tokens</div>
        <span className={styles.unseenSlot} aria-hidden="true" />
      </div>
      <div className={styles.body}>
        {listRows.map((row, i) => {
          if (row.kind === "task") {
            return <TaskRow key={`task:${row.taskId}`} row={row} selected={taskRowId(row.taskId) === selectedId} />;
          }
          if (row.kind === "jobGroup") {
            return (
              <JobGroupRow
                key={jobGroupRowId(row.jobName)}
                row={row}
                agents={agents}
                selectedId={selectedId}
                pins={pins}
              />
            );
          }
          if (row.kind === "group") {
            return (
              <GroupBoxRow
                key={groupRowId(row.groupId)}
                row={row}
                agents={agents}
                selectedId={selectedId}
                pins={pins}
                active={row.groupId === activeGroupId}
              />
            );
          }
          const agent = agents[row.agentId];
          if (!agent) return null;
          const task = taskForAgent(tasks, row.agentId);
          const overlaidRaw = task ? overlayTaskStep(task, latestStepEvent(events, str(task["taskId"]))) : null;
          const workflow = overlaidRaw ? workflowFor(taskWorkflowBinding(overlaidRaw), workflowItems) : null;
          const workflowDots = agentWorkflowStepDots(overlaidRaw, workflow, agent.pendingQuestion);
          // Ad-hoc sessions design §6: a one-line "sessions" heading immediately before the
          // first row whose section flips to "session" — the ONLY visual separator this list
          // needs (no synthetic divider row kind).
          const showSessionsHeading = row.section === "session" && !listRows.slice(0, i).some(r => r.kind === "agent" && r.section === "session");
          return (
            <div key={row.agentId}>
              {showSessionsHeading ? <div className={styles.columns}>sessions</div> : null}
              <Row
                row={row}
                agent={agent}
                name={conductorLabel(agents, row.agentId)}
                selected={row.agentId === selectedId}
                marked={markedIds.includes(row.agentId)}
                pinned={pins.some((pin) => pin.type === "agent" && pin.id === row.agentId)}
                workflowDots={workflowDots}
              />
            </div>
          );
        })}
        {listRows.length === 0 && (
          <div className={styles.empty}>
            {query.trim()
              ? "no agents match"
              /* F47: the attention filter empties itself the moment the operator catches up, and
                 the generic "no agents" line would then read as "the fleet is gone". Name the
                 filter and point at the way out — same shape as the hide-done line below. */
              : unseenOnly
                ? `nothing new — every agent has been read (toggle "all" above)`
                : !showDone && hiddenDoneCount > 0
                  ? `no active agents — ${hiddenDoneCount} done (toggle "show" above)`
                  : "no agents — the daemon has nothing running"}
          </div>
        )}
      </div>
      <div className={styles.ungroupDrop}
        data-ungroup-drop data-dragging={ordering.dragging || undefined}
        data-drop-position={ordering.position("ungrouped")}
        onDragOver={(e) => ordering.over(e, "ungrouped", "ungrouped")}
        onDragLeave={ordering.leave}
        onDrop={(e) => ordering.drop(e, "ungrouped", "ungrouped")}>
        ungrouped · drop here to remove from group
      </div>
      {/* A2A-UX-OVERHAUL · PART 2: the ephemeral live-traffic indicator — pinned to
          the bottom of the left panel, above the footer; animates in, holds ~4-5s,
          fades out (real CSS transitions), stacks max 3, never steals focus. */}
      <A2AIndicator />
      <PanelFooter>
        ↑↓ {keyLabel("up")} · ←→ {keyLabel("left")} · {displayChord("mod+o")} {keyLabel("mod+o")} · {displayChord("mod+shift+k")} {keyLabel("mod+shift+k")} · {displayChord("mod+r")} {keyLabel("mod+r")?.split(" ")[0]}
      </PanelFooter>
    </Panel>
    </ListOrderingContext.Provider>
  );
}
