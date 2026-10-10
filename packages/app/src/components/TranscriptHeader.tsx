import type { PermissionApplication } from "@chimera/protocol";
import { useState } from "react";
import { useAgentResources, type ResourceRequest } from "../state/agentResources";
import { AgentResourceDetails } from "./AgentResources";
import type { CodexContextLimits } from "@chimera/protocol";
import { ContextLimitsInfo } from "./ContextLimitsInfo";
import type { TokenUsage, WorktreeLeaseChip } from "@chimera/ui-state";
import type { Tone } from "../state/selectors";
import { displayChord, actionChord } from "../keymap";
import { accountToneVar, ctxPct, fmtCost, fmtTokens, sparkline } from "../state/selectors";
import type { ScrollHint } from "../state/selectors";
import styles from "./TranscriptPanel.module.css";

// Both single-agent and stitched workflow transcripts use this chrome.
const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
};

export function TranscriptHeader({
  resourceAgentId,
  resourceRequest,
  metricsAttribution,
  name,
  fullId,
  state,
  tone,
  overBudget,
  model,
  effort,
  account,
  executionMode,
  permissionProfile,
  permissionRequest,
  permissionAppliedToRunningProcess,
  permissionApplication,
  toolPolicyDenied,
  lastToolPolicyDenial,
  leaseChips,
  costUsd,
  usageTotal,
  usage,
  fullContext,
  compactions,
  compacting,
  lastCompactedAt,
  limit,
  contextLimits,
  ring,
  hint,
  detailOpen,
  onToggleDetail,
  onAction,
  chipsInteractive = true,
  voiceHistoryOpen = false,
  onToggleVoiceHistory,
}: {
  resourceAgentId?: string;
  resourceRequest?: ResourceRequest;
  metricsAttribution?: string;
  name: string;
  fullId: string;
  state: string;
  tone: Tone;
  overBudget: boolean;
  model?: string;
  effort?: string;
  account?: string;
  // CONDUCTOR-FULL-ACCESS: the agent's LIVE permission scope (profile + request-routing mode),
  // projected onto AgentView from agent.list's spec + the live permissionChanged event. Shown as
  // a header chip so a conductor's "full" access is visible at a glance; changed live via the
  // agent_set_permission command-palette form (commands.system.ts) or mod+p's coupled toggle.
  executionMode?: "plan" | "execute" | "auto";
  permissionProfile?: string;
  permissionRequest?: string;
  permissionApplication?: PermissionApplication;
  permissionAppliedToRunningProcess?: boolean;
  // DENIED-TOOL-CALL-INVISIBLE: a host-tool-policy deny used to leave no trace the operator
  // could see without scrolling the raw event feed at the right moment. This chip mirrors the
  // permission chip above (same header row, same danger tone as a not-applied permission
  // change) so a denial is a proactive, always-visible signal instead of one an operator has to
  // go looking for. `lastToolPolicyDenial` (only present when the FULL agent.list snapshot was
  // polled) adds the tool/profile to the chip text; the boolean alone still renders a bare warning.
  toolPolicyDenied?: boolean;
  lastToolPolicyDenial?: { tool: string; profile: string | null; profileUnresolved?: boolean };
  // F22.UI (single-writer worktree lease): the chips are BUILT in ui-state (worktreeLease.ts)
  // so the TUI's AgentDetail renders the identical label/title text — this component only picks
  // the tone. The held chip carries the lease key and the OBSERVED enforcement mode; the
  // configured mode ("off" in particular) is unobservable from the event stream.
  leaseChips?: ReadonlyArray<WorktreeLeaseChip>;
  costUsd: number;
  usageTotal: number | null;
  usage?: TokenUsage | null;
  // R2: input+cacheRead+cacheCreation (fullContextTokens) — the ctx meter's own basis, kept
  // separate from usageTotal (input+output, the tokens-column display figure) since the two
  // now measure different things. Stays unknown when the caller doesn't have a
  // separately-computed value (keeps every non-agent caller, e.g. a stitched workflow
  // transcript with no per-agent usage, working unchanged).
  fullContext?: number | null;
  // COMPACTION-VISIBLE: how many times this agent's context has been compacted, and when last.
  // The transcript already gets a one-off banner per compaction, but it scrolls away — so it
  // could never answer "did this just compact?" or "has it ever?" from the header, which is the
  // one place an operator is already watching the context fill up.
  compactions?: number;
  // COMPACTION-IN-PROGRESS: true while a compaction is actually running (see AgentView).
  compacting?: boolean;
  lastCompactedAt?: number;
  // R2 (ctx meter effective-limit): the ctx meter's denominator, pre-resolved by the caller
  // (effectiveContextLimitForAgent — an operator-configured compactionThreshold when set, else
  // the model's native window) — kept as a plain number here so this shared component never
  // needs a @chimera/protocol import of its own.
  limit: number;
  contextLimits?: CodexContextLimits;
  ring: readonly number[];
  hint: ScrollHint;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onAction: (actionId: string) => void;
  // WORKFLOW-HEADER-CHIPS-DEAD: model/effort/account are per-AGENT settings — in a
  // workflow's stitched view they only apply while the CURRENT step's agent is actually
  // live (overlayTargetAgentId's own "in_progress" gate; a finished/pending step has no
  // running process to change). false renders the chips as plain non-interactive text
  // instead of a `▾` button connected to nothing. Always true for single-agent mode.
  chipsInteractive?: boolean;
  voiceHistoryOpen?: boolean;
  onToggleVoiceHistory?: () => void;
}) {
  // Exec acknowledges submitted options, but does not report effective policy. That is
  // a capability limit, not a failed permission change; keep it inspectable without an alarm.
  const permissionWarning = permissionApplication
    ? permissionApplication.profileStatus === "failed" ? "apply failed" : permissionApplication.profileStatus !== "pending" && permissionApplication.routingStatus !== "applied" && permissionApplication.requestedRouting !== "auto" ? "routing unavailable" : ""
    : permissionAppliedToRunningProcess === false ? "not applied" : "";
  const permissionInfo = permissionApplication?.profileStatus === "pending" ? "next turn pending"
    : permissionApplication?.profileStatus === "unverified" ? "profile unverified" : "";
  const permissionDetail = permissionApplication
    ? `Requested: ${permissionApplication.requestedProfile}; effective: ${permissionApplication.effectiveProfile ?? "unknown"}. ${permissionApplication.profileStatus === "pending" ? "Awaiting the next invocation; existing in-flight work retains its prior posture." : permissionApplication.profileStatus === "unverified" ? `Exec submitted ${permissionApplication.submittedProfile ?? "profile options"}${permissionApplication.submittedVersion === undefined ? "" : ` (generation ${permissionApplication.submittedVersion})`}; effective native policy is not reported.` : permissionApplication.profileStatus === "failed" ? `Application failed: ${permissionApplication.error ?? "request rejected"}.` : "Native profile acknowledged."} Approval routing: ${permissionApplication.routingStatus}${permissionApplication.nativeApprovals ? "" : " (no native approval hooks)"}.`
    : "Recorded but not confirmed applied to the running process.";
  const resources = useAgentResources(resourceAgentId, !!resourceAgentId, resourceRequest);
  const [metricsOpenFor, setMetricsOpenFor] = useState<string | null>(null);
  const metricsKey = resourceAgentId ?? fullId;
  const metricsOpen = metricsOpenFor === metricsKey;
  const osKnown = resources.sample?.state === "ok" || resources.sample?.state === "stale";
  const osState = !resources.connected ? "disconnected" : resources.stale ? "stale" : resources.loadState.unsupported || resources.sample?.state === "unavailable" || resources.loadState.error ? "unavailable" : "measuring";
  const ctxBasis = fullContext ?? null;
  const contextKnown = ctxBasis !== null && limit > 0;
  const contextPercent = contextKnown ? ctxPct(ctxBasis, limit) : null;
  return (
    <div className={styles.header} data-transcript-header>
      <div className={styles.headerTop}>
        <button
          type="button"
          className={styles.nameButton}
          aria-expanded={detailOpen}
          aria-label={`${name} — ${detailOpen ? "hide" : "show"} agent detail`}
          title="agent detail"
          data-agent-detail-toggle
          onClick={onToggleDetail}
        >
          <span className={styles.name}>{name}</span>
          <span className={styles.fullId}>{fullId}</span>
          <span className={styles.detailGlyph}>{detailOpen ? "▾" : "▸"}</span>
        </button>
        <div className={styles.headerActions}>
        {onToggleVoiceHistory && <button
          type="button"
          className={styles.headerAction}
          aria-label={voiceHistoryOpen ? "Hide voice history" : "Show voice history"}
          title={voiceHistoryOpen ? "Hide voice history" : "Show voice history"}
          aria-pressed={voiceHistoryOpen}
          onClick={onToggleVoiceHistory}
        >Voice</button>}
        <button
          type="button"
          className={styles.headerAction}
          aria-label="remote control"
          title="remote control"
          data-transcript-action="system.remoteControl"
          onClick={() => onAction("system.remoteControl")}
        >
          ⇄
        </button>
        {/* COMPACTION-OBSERVABILITY: manual compact-now trigger. No card/overlay (unlike remote
            control) -- compact takes no params beyond the agent, so this fires the RPC directly
            and surfaces the result (applied/queued/refused) as a toast. */}
        <button
          type="button"
          className={styles.headerAction}
          aria-label="compact context now"
          title="compact context now"
          data-transcript-action="system.compact"
          onClick={() => onAction("system.compact")}
        >
          ⇥
        </button>
        {/* IN-APP-TERMINAL Task 6: opens/closes the terminal dock below the transcript —
            "terminal.toggle" is a registerActionHandler'd id (TerminalDock.tsx), not a
            KEYMAP-routed one, so the mouse and ⌘J affordances share one dispatch point. */}
        <button
          type="button"
          className={styles.headerAction}
          aria-label="toggle terminal"
          title={`terminal (${actionChord("terminal.toggle")})`}
          data-transcript-action="terminal.toggle"
          onClick={() => onAction("terminal.toggle")}
        >
          ⌨
        </button>
        </div>
        <span className={`${styles.stateChip} ${toneClass[tone] ?? ""}`}>
          {state}
        </span>
        {overBudget ? <span className={styles.toneWarn} data-soft-limit-warning title="Soft turn limit exceeded; this does not pause the agent">⚠ soft limit exceeded</span> : null}
      </div>
      <div className={styles.chipRow}>
        {model ? (
          chipsInteractive ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.actionChip}`}
              data-transcript-action="system.model"
              onClick={() => onAction("system.model")}
            >
              model: {model} ▾
            </button>
          ) : (
            <span className={styles.chip} title="this step has finished — no live agent to change" data-transcript-static="system.model">
              model: {model}
            </span>
          )
        ) : null}
        {/* AGENT-RECONFIGURE: every setting in one panel. The model/effort/account chips beside it
            stay — they are the one-click path for the three settings changed most often — but each
            of those is its own respawn, so changing several is what the panel is for. */}
        {chipsInteractive ? (
          <button
            type="button"
            className={`${styles.chip} ${styles.actionChip}`}
            title="change this agent's settings — applied in one restart, its session and context survive"
            data-transcript-action="system.agentSettings"
            onClick={() => onAction("system.agentSettings")}
          >
            ⚙ settings
          </button>
        ) : null}

        {executionMode && <button type="button" className={`${styles.chip} ${styles.actionChip}`}
          data-execution-mode={executionMode} disabled={!chipsInteractive}
          title="Native Claude execution mode — change in agent settings"
          onClick={() => onAction("system.agentSettings")}>{executionMode === "plan" ? "plan mode" : executionMode === "auto" ? "auto mode" : "execute mode"}</button>}
        {/* CONDUCTOR-FULL-ACCESS: the live permission chip. Warn-toned when a full-access agent
            runs unattended ("auto" routing), else neutral — a full conductor is intentional, so
            not danger. Hidden until a snapshot/event carries the profile (older daemon renders as
            before). Click the chip name to open the agent detail inspector; change it live via the
            agent_set_permission palette form or mod+p. */}
        {permissionProfile ? (
          <span
            data-permission-tone={permissionWarning ? "warning" : permissionInfo ? "info" : "normal"}
            className={`${styles.chip} ${
              permissionWarning.length > 0
                ? styles.toneDanger
                : !permissionInfo && permissionProfile === "full" && permissionRequest === "auto"
                  ? styles.toneWarn
                  : ""
            }`}
            title={
              permissionApplication || permissionWarning.length > 0
                ? permissionDetail
                : `permission scope (change via agent_set_permission or ${displayChord("mod+p")})`
            }
          >
            {permissionProfile}
            {permissionRequest ? `·${permissionRequest}` : ""}
            {permissionInfo ? ` · ${permissionInfo}` : ""}
            {permissionWarning ? ` ⚠ ${permissionWarning}` : ""}
          </span>
        ) : null}
        {toolPolicyDenied ? (
          <span
            className={`${styles.chip} ${styles.toneDanger}`}
            title={
              lastToolPolicyDenial
                ? `denied by host-tool policy: ${lastToolPolicyDenial.tool}${
                    lastToolPolicyDenial.profile !== null && lastToolPolicyDenial.profile !== undefined
                      ? ` (profile "${lastToolPolicyDenial.profile}"${lastToolPolicyDenial.profileUnresolved ? " — looks unresolved" : ""})`
                      : " (no profile detected in the command)"
                  }`
                : "this agent hit a host-tool-policy deny — see agent.status for detail"
            }
          >
            {`⚠ policy denied${lastToolPolicyDenial ? `: ${lastToolPolicyDenial.tool}` : ""}`}
          </span>
        ) : null}
        {(leaseChips ?? []).map((c) => (
          <span
            key={c.kind}
            className={c.kind === "held" ? styles.chip : `${styles.chip} ${styles.toneDanger}`}
            title={c.title}
            data-lease-chip={c.kind}
          >
            {c.label}
          </span>
        ))}
        <details className={styles.metricsDisclosure} data-transcript-metrics key={metricsKey}
          onToggle={e => setMetricsOpenFor(e.currentTarget.open ? metricsKey : null)}
          onKeyDown={e => {
            if (e.key !== "Escape" || !e.currentTarget.open) return;
            e.preventDefault(); e.stopPropagation(); e.currentTarget.open = false;
            e.currentTarget.querySelector("summary")?.focus();
          }}>
        <summary className={styles.metricsSummary}>
        {metricsAttribution && <span data-metrics-source>Step</span>}

        <span className={styles.ctx} title={contextLimits ? "Current prompt, including cache, against the caller-resolved effective context limit. Actual session window, model maximum and compaction setting are shown separately." : "Current prompt, including cache, against the effective context limit. This is not cumulative usage."} data-context-meter={contextKnown ? "known" : "unknown"}>
          ctx{" "}
          <span className={compacting ? styles.ctxTrackBusy : styles.ctxTrack}>
            <span
              className={
                compacting ? styles.ctxFillCompacting
                : (contextPercent ?? 0) >= 90 ? styles.ctxFillDanger : (contextPercent ?? 0) >= 70 ? styles.ctxFillWarn : styles.ctxFill
              }
              style={{ width: `${contextKnown ? Math.max(ctxBasis ? 1 : 0, contextPercent ?? 0) : 0}%` }}
            />
          </span>{" "}
          {contextKnown ? <>{contextPercent}%</> : "unknown"}{" "}
          {/* COMPACTION-VISIBLE: the mark pulses for a short window right after a compaction (the
              moment the bar drops, which otherwise looks like the meter glitched) and then
              settles into a quiet count. */}
          {/* COMPACTION-IN-PROGRESS: the state that was previously invisible. Auto-compaction
              used to announce itself only once it had already finished, so the operator saw the
              bar drop with no explanation; this labels the drop while it is happening, and keeps
              the percentage visible beside it because that number is WHY it is happening. */}
          {compacting ? (
            <span className={styles.compacting} title="compacting this agent's context now">
              ⇥ compacting…
            </span>
          ) : null}{" "}
          {(compactions ?? 0) > 0 ? (
            <span
              className={lastCompactedAt !== undefined && Date.now() - lastCompactedAt < 20_000
                ? styles.compactFresh : styles.compactMark}
              title={`context compacted ${compactions}×${lastCompactedAt ? ` · last ${new Date(lastCompactedAt).toLocaleTimeString()}` : ""}`}
              data-compactions={compactions}
            >
              ⇥{compactions}
            </span>
          ) : null}{" "}
        </span>
        {resourceAgentId && <span className={styles.resourceSummary} data-resource-summary data-resource-state={osKnown ? resources.stale || !resources.connected ? "stale" : "ok" : osState}>
          <span>CPU {osKnown && resources.sample!.totals.cpuPct !== null ? `${resources.sample!.totals.cpuPct.toFixed(1)}%` : osKnown ? "measuring" : osState}</span>
          <span>RAM {osKnown && resources.sample!.totals.rssBytes !== null ? `${(resources.sample!.totals.rssBytes / 1024 ** 2).toFixed(0)} MiB` : osKnown || osState === "measuring" ? "unavailable" : osState}</span>
          {osKnown && osState !== "measuring" && <span>{osState}</span>}
          {resources.sample?.truncated && <span>partial</span>}
        </span>}
        <span className={styles.metricsLabel}>Details</span>
        </summary>
        <div className={styles.metricsDetails} inert={!metricsOpen} tabIndex={0} aria-label="Transcript metric details">
        {metricsAttribution && <div data-metrics-attribution>{metricsAttribution}</div>}
        <div className={styles.detailSettings}>
        {effort ? (
          chipsInteractive ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.actionChip}`}
              data-transcript-action="system.effort"
              onClick={() => onAction("system.effort")}
            >
              effort: {effort} ▾
            </button>
          ) : (
            <span className={styles.chip} title="this step has finished — no live agent to change" data-transcript-static="system.effort">
              effort: {effort}
            </span>
          )
        ) : null}
        {account ? (
          chipsInteractive ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.actionChip}`}
              data-transcript-action="system.accountSwitch"
              onClick={() => onAction("system.accountSwitch")}
            >
              <span style={{ color: `var(${accountToneVar(account)})` }}>▪</span> account: {account} ▾
            </button>
          ) : (
            <span className={styles.chip} title="this step has finished — no live agent to change" data-transcript-static="system.accountSwitch">
              <span style={{ color: `var(${accountToneVar(account)})` }}>▪</span> account: {account}
            </span>
          )
        ) : null}
        <span className={styles.chip}>{fmtCost(costUsd)}</span>
        </div>
        <div>{name} · {fullId}</div>
        {model && <div>Model: {model}{account ? ` · account ${account}` : ""}{effort ? ` · effort ${effort}` : ""}</div>}
        {permissionProfile && <div>Permissions: {permissionProfile}{permissionRequest ? ` · ${permissionRequest}` : ""}{permissionApplication || permissionWarning ? ` · ${permissionDetail}` : ""}</div>}
        {toolPolicyDenied && <div>Host-tool policy denied {lastToolPolicyDenial?.tool ?? "a tool"}{lastToolPolicyDenial?.profile ? ` · profile ${lastToolPolicyDenial.profile}` : ""}</div>}
        {(leaseChips ?? []).map(c => <div key={c.kind}>{c.label} · {c.title}</div>)}
        <div data-context-detail>Current prompt <span>{ctxBasis !== null ? fmtTokens(ctxBasis) : "unknown"}</span> / effective context limit <span>{limit > 0 ? fmtTokens(limit) : "unknown"}</span> · includes cached input; separate from cumulative usage.</div>
        <ContextLimitsInfo limits={contextLimits} />
        <span className={styles.metric} data-token-total title="Cumulative input and output processed in the provider session (current run if session totals are unavailable), including cached input; may exceed the context window.">total <b>{fmtTokens(usage ? usage.input + usage.output + usage.cacheRead + usage.cacheCreation : usageTotal)}</b></span>
        {usage && <>
          <span className={styles.metric} data-token-fresh>fresh <b>{fmtTokens(usage.input)}</b></span>
          <span className={styles.metric} data-token-cache-read>cache read <b>{fmtTokens(usage.cacheRead)}</b></span>
          <span className={styles.metric} data-token-cache-write>cache write <b>{fmtTokens(usage.cacheCreation)}</b></span>
          <span className={styles.metric} data-token-output>output <b>{fmtTokens(usage.output)}</b></span>
        </>}
        {ring.length > 0 && <span className={styles.metric} title="Estimated fresh input + output rate between the last two usage samples" data-token-rate><span className={styles.spark}>{sparkline(ring)}</span> {fmtTokens(ring.at(-1)!)} tok/min</span>}
        {resourceAgentId ? <>
          <div>OS resources for {resourceAgentId}</div>
          {metricsOpen && <AgentResourceDetails resources={resources} />}
        </> : <div>OS resources unavailable · no selected local agent.</div>}
        </div>
        </details>
        {(hint.above > 0 || hint.below > 0) && (
          <span className={styles.moreHint}>
            {hint.above > 0 ? `↑ ${hint.above} more` : ""}
            {hint.above > 0 && hint.below > 0 ? " · " : ""}
            {hint.below > 0 ? `↓ ${hint.below} more` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
