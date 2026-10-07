import { openConversationFork } from "../state/conversationFork";
import { ForkLineageChip } from "./ForkAgentOverlay";
import { ContextLinks } from "./ContextLinks";
import { AgentResources } from "./AgentResources";
import { ContextLimitsInfo } from "./ContextLimitsInfo";
import { useState, type ReactNode } from "react";
import type { AgentGroup } from "@chimera/protocol";
import { worktreeKeyFromWorkdir, worktreeLeaseChips, type AgentView } from "@chimera/ui-state";
import { agentDetailView, ctxPct, effectiveContextLimitForAgent, fmtCost, fmtTokens, fullContextTokens } from "../state/selectors";
import styles from "./AgentDetailPanel.module.css";
import { AgentNotes } from "./AgentNotes";

// AGENT-INFO-PANEL — the TranscriptPanel header-click inspector (in-place
// expand between the header and the scrollable transcript body, same "raised
// block" idiom as AgentInspector/TaskInspector — NOT an overlay/modal). Opens
// via a click on the agent name/id (TranscriptPanel's headerTop button);
// closes via that same click, the ✕ here, or esc (esc-tier "agentDetail",
// commands.agents.ts). `status` is the on-demand agent.status fetch
// (useAgentStatus) — null while loading or on a fetch failure, in which case
// every status-only field (cwd/permissionProfile/isolation/prompts) reads "—"
// rather than blocking the fields AgentView already has synchronously.

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

export function AgentDetailPanel({
  agent,
  status,
  loading,
  providerDefaultModels,
  groups,
  onSetGroup,
  onClose,
  leaseTargets,
  onLeaseHandoff,
  onLeaseRelease,
  onSpawnAnotherLikeThis,
}: {
  agent: AgentView;
  status: Record<string, unknown> | null;
  loading: boolean;
  // MODEL-ACTUAL-SURFACE: providerId -> catalog defaultModel (useProviderDefaultModels),
  // optional/defensive — a caller that doesn't pass one just gets the bare placeholder below.
  providerDefaultModels?: ReadonlyMap<string, string>;
  // AGENT-GROUPS Phase 1: the operator-defined group registry, and the assign-to-group
  // action — both optional/defensive (absent ⇒ the row renders nothing), mirroring
  // onSpawnAnotherLikeThis's own "caller wires it, absent degrades cleanly" shape.
  groups?: ReadonlyArray<AgentGroup>;
  onSetGroup?: (groupId: string | null) => void;
  onClose: () => void;
  // F22.UI (single-writer worktree lease): the other running agents this lease can be handed to,
  // and the two lease actions. All optional/defensive like onSetGroup above — a caller that has
  // not wired them renders the lease facts read-only, never a dead button. `leaseTargets`
  // undefined ⇒ still loading the roster; empty ⇒ genuinely nobody else to hand off to.
  leaseTargets?: ReadonlyArray<{ agentId: string; label: string }>;
  onLeaseHandoff?: (workdirKey: string, toAgentId: string) => void;
  onLeaseRelease?: (workdirKey: string) => void;
  /** ROLES-UNIFY §6.3/§9.2: "spawn another like this" — reopens SpawnCard
   * prefilled with the SAME session role this agent was spawned from. A
   * callback prop (not a direct appStore/composerLocal import here) keeps
   * this component free of window-dependent bridge side effects, same as
   * onClose above — the caller (TranscriptPanel) already owns that wiring.
   * Optional/defensive: a caller that doesn't pass one just gets no action
   * (the audit line's text still renders). */
  onSpawnAnotherLikeThis?: (role: string) => void;
}) {
  const view = agentDetailView(agent, status);
  // F22.UI: the key core itself leases on is the worktree directory name — derived, never a
  // separate piece of state, so the row and the RPC argument can never drift apart.
  const leaseKey = worktreeKeyFromWorkdir(agent.workdir ?? view.cwd ?? null);
  const leaseChips = worktreeLeaseChips(agent);
  const [handoffTo, setHandoffTo] = useState("");
  const measuredUsage = agent.sessionUsage ?? agent.usage;
  const usageTotal = measuredUsage ? measuredUsage.input + measuredUsage.output : null;
  // R2: the ctx meter's own basis (input+cacheRead+cacheCreation), distinct from usageTotal.
  // CTX-VS-BILLABLE: same basis the transcript meter uses — the dedicated ctx baseline first,
  // since `usage`'s cumulative `result` source would climb past the model's window.
  const fullContext = agent.ctxUsage ? fullContextTokens(agent.ctxUsage) : null;
  // R2 (ctx meter effective-limit): an operator-configured compactionThreshold when set, else
  // the model's native window — same resolution TranscriptHeader's caller uses.
  const limit = effectiveContextLimitForAgent(agent);
  const defaultModel = view.provider ? providerDefaultModels?.get(view.provider) : undefined;
  const unknownModelLabel = defaultModel ? `(default: ${defaultModel})` : "(provider default model)";

  return (
    <div className={styles.card} data-agent-detail-panel>
      <div className={styles.titleRow}>
        <span className={styles.title}>agent detail</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.closeBtn} onClick={onClose} data-agent-detail-close>
          ✕ close
        </button>
      </div>
      <div><button type="button" onClick={e => { e.currentTarget.focus(); openConversationFork(agent.agentId); }}>Branch conversation…</button><ForkLineageChip lineage={agent.forkLineage} /></div>
      <ContextLinks key={`context-${agent.agentId}`} agentId={agent.agentId} />
      <AgentResources key={agent.agentId} agentId={agent.agentId} />
      <Row label="state">
        <span>
          {view.state} <span className={styles.meta}>— {view.activity}</span>
        </span>
      </Row>
      {/* Which backend/model actually ran this agent — a codex/glm agent was
          indistinguishable from a claude one here (user report). model falls
          back to "(provider default)" when the spec pinned none. */}
      <Row label="provider">
        <span className={styles.meta}>
          {view.provider
            ? [view.provider, view.account ? `account ${view.account}` : null, view.model ?? unknownModelLabel]
                .filter((s): s is string => !!s)
                .join(" · ")
            : loading ? "loading…" : "—"}
        </span>
      </Row>
      <Row label="config">
        <span className={styles.meta}>
          {[
            view.model,
            view.effort,
            agent.permissionApplication && view.permissionProfile
              ? `${view.permissionProfile} (effective: ${agent.permissionApplication.effectiveProfile ?? "unknown"}; ${agent.permissionApplication.profileStatus}; routing: ${agent.permissionApplication.routingStatus})`
              : agent.permissionAppliedToRunningProcess === false && view.permissionProfile
              ? `${view.permissionProfile} (recorded, NOT applied to running process)`
              : view.permissionProfile,
            view.isolation ? `isolation ${view.isolation}` : null,
            view.permissionRequestMode ? `on.permissionRequest ${view.permissionRequestMode}` : null,
          ]
            .filter((s): s is string => !!s)
            .join(" · ") || (loading ? "loading…" : "—")}
        </span>
      </Row>
      <Row label="cwd">
        <span className={styles.meta}>{view.cwd ?? (loading ? "loading…" : "—")}</span>
      </Row>
      {Boolean(status?.spec && typeof status.spec === "object" && (status.spec as Record<string, unknown>).autonomy === "full") && <Row label="questions"><span className={styles.meta}>Full autonomy disables clarification questions; tool approval policy is separate.</span></Row>}
      <AgentNotes key={agent.agentId} agentId={agent.agentId} />
      {/* F22.UI: lease facts + the two destructive actions, in the panel the operator opens by
          clicking the agent name — the header chip states the fact, this row is where it can be
          changed. Rendered only for agents that actually live in a worktree (same "omit rather
          than show a misleading —" rule as the tool-surface row above). Both actions route
          through the shared ConfirmAction gate; the caller decides what confirm looks like. */}
      {leaseKey && (
        <Row label="worktree lease">
          <span className={styles.meta}>
            {leaseChips.length > 0
              ? leaseChips.map((c) => <span key={c.kind} title={c.title}>{c.label} </span>)
              : <span title="No lease event has been seen for this agent yet — it either has not written into the worktree, or the lease mode is off.">key {leaseKey} · no lease activity seen</span>}
          </span>
          {onLeaseHandoff && (
            leaseTargets === undefined ? (
              <span className={styles.meta}> · loading agents…</span>
            ) : leaseTargets.length === 0 ? (
              <span className={styles.meta}> · no other running agent to hand off to</span>
            ) : (
              <>
                {" "}
                <select
                  className={styles.groupSelect}
                  value={handoffTo}
                  onChange={(e) => setHandoffTo(e.target.value)}
                  data-lease-handoff-target
                >
                  <option value="">— hand off to… —</option>
                  {leaseTargets.map((t) => (
                    <option key={t.agentId} value={t.agentId}>{t.label}</option>
                  ))}
                </select>
                {handoffTo && (
                  <span
                    className={styles.spawnAgainChip}
                    onClick={() => onLeaseHandoff(leaseKey, handoffTo)}
                    data-lease-handoff
                  >
                    {" "}· hand off
                  </span>
                )}
              </>
            )
          )}
          {onLeaseRelease && (
            <span
              className={styles.spawnAgainChip}
              onClick={() => onLeaseRelease(leaseKey)}
              data-lease-release
            >
              {" "}· release
            </span>
          )}
        </Row>
      )}
      <Row label="skills">
        <span className={styles.meta}>
          {view.skills.length > 0 ? view.skills.join(", ") : "—"}
        </span>
      </Row>
      <Row label="mcp">
        <span className={styles.meta}>{view.mcpServers.length > 0 ? view.mcpServers.join(", ") : "—"}</span>
      </Row>
      {/* TOOL-SURFACE-MEASURE: two independent, honestly-labeled figures — see
          AgentView.toolSurfaceEstimate/.toolSurfaceCacheWriteTokens doc comments (ui-state
          types.ts). The estimate covers ONLY chimera's own eagerly-registered tools (title
          carries the full caveat text verbatim); the cache-write figure is real billed usage
          for the whole first-turn prompt, not tool schemas exclusively. Row omitted entirely
          when neither has landed yet, rather than showing a misleading "—". */}
      {(agent.toolSurfaceEstimate || agent.toolSurfaceCacheWriteTokens !== undefined) && (
        <Row label="tool surface">
          <span className={styles.meta}>
            {/* F41.UI: "core-tier" was stale — post-F41 the estimate covers the WHOLE granted
                catalog (a conductor spawn's 46 tools / ~8.6k tok included), so labelling it
                core-tier understated every conductor by ~2x. bySource is optional (core's
                persisted record type omits it), hence the guard. */}
            {agent.toolSurfaceEstimate && (
              <span title={agent.toolSurfaceEstimate.note}>
                chimera MCP ~{fmtTokens(agent.toolSurfaceEstimate.approxTokens)} tok ({agent.toolSurfaceEstimate.toolCount} tools, estimate)
                {agent.toolSurfaceEstimate.bySource && agent.toolSurfaceEstimate.bySource.length > 0
                  ? ` — ${agent.toolSurfaceEstimate.bySource.map((r) => `${r.source.replace(/^chimera-/, "")} ${r.toolCount}`).join(" + ")}`
                  : ""}
              </span>
            )}
            {agent.toolSurfaceCacheWriteTokens !== undefined && (
              <span title="Real billed cache-write tokens for this agent's first turn — covers the WHOLE prompt (instructions, tool defs, any ambient MCP catalog), not exclusively tool schemas.">
                {agent.toolSurfaceEstimate ? " · " : ""}first-turn cache write {fmtTokens(agent.toolSurfaceCacheWriteTokens)} tok (measured)
                {agent.toolSurfaceServers && agent.toolSurfaceServers.length > 0
                  ? ` over ${agent.toolSurfaceServers.join(", ")}`
                  : ""}
              </span>
            )}
          </span>
        </Row>
      )}
      <Row label="role prompt">
        <span className={styles.prompt}>{view.rolePrompt ?? (loading ? "loading…" : "—")}</span>
      </Row>
      <Row label="task prompt">
        <span className={styles.prompt}>{view.taskPrompt ? `"${view.taskPrompt}"` : loading ? "loading…" : "—"}</span>
      </Row>
      <Row label="team">
        <span className={styles.meta}>{view.membership ?? "—"}</span>
      </Row>
      {/* AGENT-GROUPS Phase 1: one group per agent in the UI (the multi-select gesture is
          deferred) — a plain select degrading to "no groups yet" when the registry is empty,
          rather than hiding the row (an operator with no groups yet should still discover the
          affordance). onSetGroup/groups are optional so a caller that hasn't wired them yet
          (or an older code path) renders nothing here at all. */}
      {onSetGroup && groups ? (
        <Row label="group">
          {groups.length === 0 ? (
            <span className={styles.meta}>no groups yet</span>
          ) : (
            <select
              className={styles.groupSelect}
              value={agent.groups?.[0] ?? ""}
              onChange={(e) => onSetGroup(e.target.value || null)}
              data-agent-group-select
            >
              <option value="">— ungrouped —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
        </Row>
      ) : null}
      {/* ROLES-UNIFY §6.3/§9.2: READ-ONLY audit line — what was overridden at
          spawn time, never a live edit control. There is no reusable binding
          on the agent side to write back to (decision #2, §1: no retroactive
          respawn) — "spawn another like this" reopens SpawnCard prefilled
          with the SAME role, exactly like the library detail pane's own
          "spawn session with this role" (S6 wires SpawnCard to also prefill
          the overrides themselves; here it prefills the role name, and the
          operator re-enters overrides guided by this audit line). */}
      {view.sessionRole && (
        <Row label="role">
          <span className={styles.meta}>
            {`spawned from ${view.sessionRole}` +
              (view.sessionRoleOverrides && Object.keys(view.sessionRoleOverrides).length > 0
                ? ` with: ${Object.entries(view.sessionRoleOverrides).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ")}`
                : " (no overrides)")}
          </span>
          <span
            className={styles.spawnAgainChip}
            onClick={() => onSpawnAnotherLikeThis?.(view.sessionRole!)}
            data-spawn-again-like-this
          >
            {" "}· spawn another like this
          </span>
        </Row>
      )}
      <Row label="tree">
        <span className={styles.meta}>
          depth {view.depth ?? "—"} · tree {view.treeId ?? "—"}
        </span>
      </Row>
      <Row label="usage">
        <span className={styles.meta}>
          {/* R2: the ctx% and the "used/limit" figure now share the SAME basis (fullContext) —
              previously this showed usageTotal (input+output, cache-excluded) next to a
              percentage computed from fullContext (cache-included), the "5.6k tok · ctx 100%"
              inconsistency. usageTotal (new/throughput tokens) still shows, labeled separately. */}
          {fmtCost(agent.costUsd)} · ctx {fullContext === null || limit <= 0 ? "unknown" : `${ctxPct(fullContext, limit)}%`} ({fmtTokens(fullContext)}/{limit > 0 ? fmtTokens(limit) : "unknown"}) · {fmtTokens(usageTotal)} fresh + output
          <ContextLimitsInfo limits={agent.provider === "codex" ? agent.contextLimits ?? { source: "codex" } : undefined} />
        </span>
      </Row>
      {measuredUsage && <Row label="cache"><span className={styles.meta}>read {fmtTokens(measuredUsage.cacheRead)} · write {fmtTokens(measuredUsage.cacheCreation)} tokens (included in total input)</span></Row>}
      <Row label="">
        <span className={styles.hint}>esc close</span>
      </Row>
    </div>
  );
}
