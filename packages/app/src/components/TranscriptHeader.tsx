import { ContextRing } from "./ContextRing";
import { createPortal } from "react-dom";
import { AgentPermissionSelect } from "./AgentPermissionSelect";
import type { PermissionApplication } from "@chimera/protocol";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { useAgentResources, type ResourceRequest } from "../state/agentResources";
import { AgentResourceDetails } from "./AgentResources";
import type { CodexContextLimits } from "@chimera/protocol";
import { ContextLimitsInfo } from "./ContextLimitsInfo";
import type { TokenUsage, WorktreeLeaseChip } from "@chimera/ui-state";
import type { Tone } from "../state/selectors";
import { actionChord } from "../keymap";
import { accountToneVar, ctxPct, fmtCost, fmtTokens, sparkline } from "../state/selectors";
import type { ScrollHint } from "../state/selectors";
import styles from "./TranscriptPanel.module.css";

// Both single-agent and stitched workflow transcripts use this chrome.

export function TranscriptHeader({
  resourceAgentId,
  provider,
  resourceRequest,
  metricsAttribution,
  name,
  fullId,
  overBudget,
  model,
  effort,
  account,
  executionMode,
  requestedExecutionMode,
  executionModePending,
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
  lifecycleDisabled = false,
  controlsHost,
  voiceHistoryOpen = false,
  remoteControlEnabled = false,
  remoteControlDisabled = false,
  remoteControlActive = false,
  terminalOpen = false,
  onToggleVoiceHistory,
  search,
  hideName = false,
  onBranch,
}: {
  resourceAgentId?: string;
  provider?: string;
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
  // the composer mode control; changed live via the
  // agent_set_permission command-palette form (commands.system.ts) or mod+p's coupled toggle.
  executionMode?: "plan" | "execute" | "auto" | "bypassPermissions";
  requestedExecutionMode?: string;
  executionModePending?: boolean;
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
  onAction: (actionId: string) => void | Promise<void>;
  // WORKFLOW-HEADER-CHIPS-DEAD: model/effort/account are per-AGENT settings — in a
  // workflow's stitched view they only apply while the CURRENT step's agent is actually
  // live (overlayTargetAgentId's own "in_progress" gate; a finished/pending step has no
  // running process to change). false renders the chips as plain non-interactive text
  // instead of a `▾` button connected to nothing. Always true for single-agent mode.
  chipsInteractive?: boolean;
  lifecycleState?: string;
  lifecycleDisabled?: boolean;
  controlsHost?: HTMLElement | null;
  voiceHistoryOpen?: boolean;
  remoteControlEnabled?: boolean;
  remoteControlDisabled?: boolean;
  remoteControlActive?: boolean;
  terminalOpen?: boolean;
  onToggleVoiceHistory?: () => void;
  search?: ReactNode;
  hideName?: boolean;
  onBranch?: () => void;
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
  const modelControl = <>        {(model || controlsHost !== undefined) ? (
          chipsInteractive ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.actionChip}`}
              aria-label={`Change model: ${model || "default"}`} title={`Model: ${model || "default"}`}
              data-transcript-action="system.model"
              onClick={() => onAction("system.model")}
            >
              {controlsHost === undefined ? "model: " : ""}{model || "Model"} ▾
            </button>
          ) : (
            <span className={styles.chip} title="this step has finished — no live agent to change" data-transcript-static="system.model">
              model: {model}
            </span>
          )
        ) : null}
</>;
  const effortControl = <>        {(effort || controlsHost !== undefined) ? (
          chipsInteractive ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.actionChip}`}
              aria-label={`Change effort: ${effort || "default"}`} title={`Effort: ${effort || "default"}`}
              data-transcript-action="system.effort"
              onClick={() => onAction("system.effort")}
            >
              {controlsHost === undefined ? "effort: " : ""}{effort || "Effort"} ▾
            </button>
          ) : (
            <span className={styles.chip} title="this step has finished — no live agent to change" data-transcript-static="system.effort">
              effort: {effort}
            </span>
          )
        ) : null}
</>;
  const settingsControl = chipsInteractive ? <button type="button" className={styles.headerAction} aria-label="Agent settings" title="Agent settings" data-transcript-action="system.agentSettings" disabled={lifecycleDisabled} onClick={() => onAction("system.agentSettings")}><ActionIcon kind="settings" /></button> : null;
  const pendingActions = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const actionKey = (id: string) => `${resourceAgentId ?? fullId}:${id}`;
  const directAction = (id: string): void => {
    const key = actionKey(id);
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    const clear = () => { pendingActions.current.delete(key); setPending(new Set(pendingActions.current)); };
    try {
      const result = onAction(id);
      if (result) {
        setPending(new Set(pendingActions.current));
        void result.then(clear, clear);
      } else clear();
    } catch (error) { clear(); throw error; }
  };
  const compactPending = pending.has(actionKey("system.compact"));
  const remotePending = pending.has(actionKey("system.remoteControl"));
  const contextControl = <ContextRing used={ctxBasis} limit={limit} compacting={compacting || compactPending} compactions={compactions} lastCompactedAt={lastCompactedAt}
    onCompact={() => directAction("system.compact")} pending={compactPending} disabled={lifecycleDisabled || !chipsInteractive} />;
  const actions = (
        <div className={`${styles.headerActions} ${controlsHost === undefined ? styles.inlineActions : ""}`} data-conversation-actions>
          {resourceAgentId && <AgentPermissionSelect key={resourceAgentId} agentId={resourceAgentId} provider={provider} value={permissionProfile} executionMode={executionMode} requestedMode={requestedExecutionMode} modePending={executionModePending} disabled={lifecycleDisabled || !chipsInteractive} />}
        {controlsHost !== undefined && <>{modelControl}{effortControl}{settingsControl}</>}
        {onBranch && <button type="button" className={styles.headerAction} aria-label="Branch conversation" title="Branch conversation" disabled={lifecycleDisabled || !chipsInteractive} onClick={e => { e.currentTarget.focus(); onBranch(); }}><ActionIcon kind="branch" /></button>}
        {onToggleVoiceHistory && <button
          type="button"
          className={styles.headerAction}
          aria-label={voiceHistoryOpen ? "Hide voice history" : "Show voice history"}
          title={voiceHistoryOpen ? "Hide voice history" : "Show voice history"}
          aria-pressed={voiceHistoryOpen}
          onClick={onToggleVoiceHistory}
        ><ActionIcon kind="voice" /></button>}
        <button
          type="button"
          className={styles.headerAction}
          aria-label="remote control"
          title={remotePending ? "Updating remote control…" : remoteControlEnabled ? "Disable remote control" : "Enable remote control"}
          aria-pressed={remoteControlActive}
          aria-busy={remotePending}
          disabled={lifecycleDisabled || !chipsInteractive || remoteControlDisabled || remotePending}
          data-transcript-action="system.remoteControl"
          onClick={() => directAction("system.remoteControl")}
        >
          <ActionIcon kind="remote" />
        </button>
        {/* IN-APP-TERMINAL Task 6: opens/closes the terminal dock below the composer —
            "terminal.toggle" is a registerActionHandler'd id (TerminalDock.tsx), not a
            KEYMAP-routed one, so the mouse and ⌘J affordances share one dispatch point. */}
        <button
          type="button"
          className={styles.headerAction}
          aria-label="toggle terminal"
          title={`${terminalOpen ? "Hide" : "Show"} terminal (${actionChord("terminal.toggle")})`}
          aria-pressed={terminalOpen}
          aria-expanded={terminalOpen}
          data-transcript-action="terminal.toggle"
          onClick={() => onAction("terminal.toggle")}
        >
          <ActionIcon kind="terminal" />
        </button>
        {controlsHost === undefined && contextControl}
        </div>
  );
  return (
    <div className={styles.header} data-transcript-header>
      {controlsHost !== undefined && controlsHost ? createPortal(<>{actions}{contextControl}</>, controlsHost) : null}
      <div className={styles.headerTop}>
        {!hideName && <button
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
        </button>}
        {controlsHost === undefined ? actions : null}
        {overBudget ? <span className={styles.toneWarn} data-soft-limit-warning title="Soft turn limit exceeded; this does not pause the agent">⚠ soft limit exceeded</span> : null}
      </div>
      <div className={styles.chipRow}>
        {controlsHost === undefined && <>{modelControl}{settingsControl}</>}
        {permissionProfile && (permissionWarning || permissionInfo) ? (
          <span data-permission-tone={permissionWarning ? "warning" : "info"}
            className={`${styles.chip} ${permissionWarning ? styles.toneDanger : ""}`}
            title={permissionDetail}>
            {permissionInfo}{permissionInfo && permissionWarning ? " · " : ""}{permissionWarning ? `⚠ ${permissionWarning}` : ""}
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

        {controlsHost === undefined && <>
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
        </>}
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
        {controlsHost === undefined && effortControl}
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
        <Fragment key="history-search">{search}</Fragment>
      </div>
    </div>
  );
}

function ActionIcon({ kind }: { kind: "voice" | "remote" | "compact" | "terminal" | "settings" | "branch" }) {
  const paths = {
    settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    branch: "M6 3v12a6 6 0 0 0 6 6 M6 9h6a6 6 0 0 0 6-6 M3 3h6 M15 3h6 M12 18v6",
    voice: "M4 9v6 M8 5v14 M12 3v18 M16 6v12 M20 9v6",
    remote: "M4 7h16 m-4-4 4 4-4 4 M20 17H4 m4-4-4 4 4 4",
    compact: "M3 7h6V3 M9 7 3 1 M21 17h-6v4 M15 17l6 6 M4 12h16",
    terminal: "M4 7l5 5-5 5 M12 17h8",
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
