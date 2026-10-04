// F11 (W11) — single source for SHARED user-facing English strings: footer
// hint rows, empty states, banner texts, and toast/confirm templates. The
// design mock (handoff/design/Chimera TUI.dc.html) is the copy spec; strings
// here match it verbatim where the mock renders the element, and follow the
// copy style otherwise (lowercase chrome labels, terse `·`-joined hints, no
// exclamation marks, units like 4m/15min/2.4k tok).
//
// Scope rule (do NOT over-centralize): one-off labels, field names, and
// component-private prose stay inline. This module holds only strings that the
// F11 spec names as shared — the future locale layer hooks here.

/** Footer / hint rows shown at the bottom edge of a bar or overlay. */
export const HINTS = {
  slashPopup: "↑↓ select · enter run · ⌘ = app-local, others go to the agent · esc close",
  queued: "sent in order when the turn ends · mod+u edit · esc drop",
  replayStatus: "from events.jsonl · inputs disabled",
  replayControls: "space play · ←→ turn · l back to live",
  a2aHistory: "enter/esc close · row → receiver transcript",
  hostToolsFoot:
    "space: allow→ask→deny · p: edit per profile · policy hooks into the permission gate (deny=command rejected, ask=⚠ card)",
  // HOST-TOOLS-PROFILE-VISIBILITY: names the cursored profile + its current
  // mode explicitly, so editing stays legible even when the profile chip
  // itself is clipped by .cellProfiles' ellipsis (many-context tools).
  hostToolsFootEdit: (tool: string, profileText: string, mode: string): string =>
    `editing ${tool} · ${profileText} → ${mode} · space: allow→ask→deny · ←→ move · esc done`,
  /** Defensive fallback only — used if a cursor is open but cursoredProfile()
   * can't resolve a caption (shouldn't happen; keeps the footer non-blank). */
  hostToolsFootEditFallback: "←→ profile (default (*) first) · space: cycle mode · esc/p exit",
  hostToolsNote: "discovery: PATH scan + version/profile probe · on-connect + every 15min",
  hostToolsAgeNote: "client-side fetch age — the daemon's host.tools reply carries no scannedAt",
  pluginsFoot: "space toggle · enter detail · commands show in the / popup (not ⌘ — they go to the agent)",
  pluginsNote: "applies to new spawns; running agents must restart",
} as const;

/** Empty / loading placeholders. */
export const EMPTY = {
  hostToolsScanning: "scanning PATH…",
  hostToolsNone: "no tools found",
  pluginsCatalog: "catalog empty — no skills/plugins under ~/.claude",
  replayLoading: "reading events.jsonl…",
} as const;

/** Danger / status banner texts (composed into styled spans by the banner). */
export const BANNERS = {
  disconnectedLead: "○ daemon connection lost — ",
  disconnectedDetail: "retrying in 3s · view shows the last snapshot · inputs disabled",
  // F50.UI: order is most-important-first, so a narrow pane truncates the tail, not the reason.
  // "this tree" is deliberate — a budget is per-tree and reading it as "the fleet is down"
  // makes an operator over-react.
  budgetPauseDetail:
    "· every agent in this tree is interrupted · new spawns in it are rejected · other trees keep running",
  budgetMeasuredDetail: (usd: string): string => `· ${usd} reported by the provider`,
  budgetEstimatedDetail: (usd: string): string => `· ~${usd} estimated from token counts (not billed yet)`,
  budgetRePaused: "· re-paused after operator resume — still over the cap",
  // The ellipsis is the app-wide "opens a confirm" marker: budget.resume is audited and
  // one-shot, so the click must not BE the release.
  budgetResumeAction: "resume tree…",
  budgetResumeInFlight: "resuming…",
  holdPauseLabel: {
    "session-limit": "session limit hit",
    "crash-loop-backoff": "crash-loop backoff",
    "reattach-recovery": "reattach recovery",
  } as Record<string, string>,
} as const;

/** Toast templates (built from live daemon events; always English). */
export const TOASTS = {
  modelApplied: (model: string): string => `model → ${model} · takes effect next turn`,
  effortApplied: (effort: string): string => `effort → ${effort} · takes effect next turn`,
  accountApplied: (account: string): string => `account → ${account} · takes effect next turn`,
  remoteControlEnabled: (sessionUrl?: string): string =>
    sessionUrl ? `remote control on · attach at ${sessionUrl}` : "remote control on",
  remoteControlDisabled: "remote control off",
  budgetResumed: (note: string): string => note,
  // COMPACTION-OBSERVABILITY: agent.compact's result is ALWAYS shown verbatim (result.message),
  // never re-worded into a generic "done" — a manual trigger that got queued, refused (nothing
  // droppable), or applied immediately are three different truths the operator needs, not one.
  compactResult: (result: { ok: boolean; message?: string; before?: { chars?: number }; after?: { chars?: number } }): string => {
    if (result.message) return `compact: ${result.message}`;
    if (result.before?.chars !== undefined && result.after?.chars !== undefined) {
      return `compact: ${result.before.chars.toLocaleString()} → ${result.after.chars.toLocaleString()} chars`;
    }
    return result.ok ? "compact: done" : "compact: not applied";
  },
  cancelOnlyPending: "cancel is only for a pending task — kill the agent for running work",
  // TASK-EDIT-VERSIONING: an in-place edit is only offered while the task is
  // still queued (pending/blocked); the daemon rejects an in_progress/terminal
  // edit the same way, this hint fires before the form even opens.
  editOnlyQueued: "edit is only for a still-queued task (pending/blocked) — running/finished tasks are immutable",
  // D11/F15: the client-side pre-check refusal (queue.delete would refuse the
  // same way daemon-side; this toast fires before the RPC is even attempted).
  queueDeleteHasPending: (name: string, count: number): string =>
    `queue "${name}" has ${count} pending/in-progress task${count === 1 ? "" : "s"} — cancel them first`,
  // VOICE-STOP: speech starts and stops outside any screen the operator is looking at, so every
  // silent transition gets one line here. "muted" vs "muted — stopped speaking" are deliberately
  // distinct: the second one tells the operator their click cut a reply short.
  voiceSpeechTimedOut: "speech playback timed out — stopped speaking",
  voiceRepliesMuted: "spoken replies muted — voice input still works",
  voiceRepliesMutedStopped: "spoken replies muted — stopped speaking",
  voiceRepliesUnmuted: "spoken replies on — agent answers will be read aloud",
} as const;

/** Destructive-action confirm dialogs (body + note). */
// KIMI-BACKEND S6 (spec docs/superpowers/specs/2026-07-28-kimi-backend.md §8, §11-S6): the
// SDK's `SessionOptions` exposes only a boolean `thinking` toggle, no graduated effort — the
// landed backend (packages/core/src/backends/kimi.ts) maps chimera's effort onto it as
// effort==="low" (or unset) -> thinking:false, every other level -> thinking:true, discarding
// the CLI's own finer default_effort/support_efforts distinction. Shown wherever effort is
// normally editable (RoleFormCard.tsx, EffortCard.tsx) so an operator picking e.g. "high" on a
// kimi role/agent isn't misled into thinking it lands as anything more specific than
// thinking-on.
export const CAPABILITY_NOTES = {
  kimiEffortDowngrade:
    "Kimi only exposes a thinking on/off toggle here — chimera maps effort \"low\" to "
    + "thinking-off and medium/high/xhigh all to thinking-on. The CLI's finer-grained effort "
    + "levels are not reachable through chimera.",
};

export const CONFIRMS = {
  // F50.UI: the pre-release brief. spendSplit/effect come from @chimera/ui-state's shared budget
  // wording so the banner, this card and the transcript line describe one pause in one voice.
  resumeBudget: (label: string, spendSplit: string, effect: string) => ({
    body: `Release the budget pause on tree ${label} — ${spendSplit}.`,
    note: `${effect} The release is recorded in the audit ledger with "app" as the principal.`,
  }),
  dissolveTeam: (name: string) => ({
    body: `"${name}" will be dissolved — the running worker pool is shut down.`,
    note: "This cannot be undone — queued tasks are not deleted; the team record and its persistent workers are removed.",
  }),
  cancelTask: (label: string) => ({
    body: `"${label}" will be removed from the queue.`,
    note: "This cannot be undone — it does not affect a running agent, it only drops the pending task.",
  }),
  archiveProject: (name: string) => ({
    body: `"${name}" will be archived — the project is marked paused in the list.`,
    note: "The daemon refuses while a session runs (conflict) — finish or kill the sessions first.",
  }),
  deleteProject: (name: string) => ({
    body: `"${name}" will be permanently removed from the project list — its name becomes free for a future create/import.`,
    note: "This cannot be undone. The daemon refuses while a session runs under its path (same guard as archive) — archive it first (tears down its conductor) and finish or kill any other session, then delete.",
  }),
  deleteJob: (name: string) => ({
    body: `"${name}" will be removed from the schedule.`,
    note: "This cannot be undone — an in-flight run is not killed, only the schedule record is dropped.",
  }),
  // F05.UI (QA UI-3): space on a dead-lettered row sits directly under the failed run and reads
  // as "retry that run". It is not — it re-arms the NEXT occurrence. Say so before it happens.
  requeueJob: (name: string, failedRuns: number) => ({
    body: `"${name}" is re-armed for its next scheduled occurrence — this does NOT re-run the failed one.`,
    note: `The ${failedRuns} failed ${failedRuns === 1 ? "run stays" : "runs stay"} in the run history; the failure counter resets to zero.`,
  }),
  deleteQueue: (name: string) => ({
    body: `"${name}" will be removed.`,
    note: "This cannot be undone — offered only once it has no pending/in-progress tasks.",
  }),
  deleteWorkflow: (name: string) => ({
    body: `"${name}" (all versions) will be removed from the workflow registry.`,
    note: "This cannot be undone — any in-flight task still pinned to this workflow fails immediately, and a queue bound to it keeps a stale reference until rebound.",
  }),
  deleteMemory: (label: string) => ({
    body: `"${label}" will be removed from the shared memory pool.`,
    note: "This cannot be undone — the note disappears from every agent's next memory_search.",
  }),
  // F22.UI: both lease actions are destructive to the OTHER agent — its next write into the
  // worktree is refused mid-turn with no warning of its own.
  worktreeLeaseHandoff: (workdirKey: string, ownerLabel: string, toLabel: string) => ({
    body: `The single-writer lease on worktree "${workdirKey}" moves from ${ownerLabel} to ${toLabel}.`,
    note: "The current holder is not notified — its next write into this worktree is refused mid-turn (enforce mode) or warned about (warn mode). Hand the lease back the same way if that was a mistake.",
  }),
  worktreeLeaseRelease: (workdirKey: string, ownerLabel: string, force: boolean) => ({
    body: `The single-writer lease on worktree "${workdirKey}" (held by ${ownerLabel}) is released — the next agent to write there takes it.`,
    note: force
      ? "FORCE: the lease is dropped even though its holder may still be running and still believes it owns the worktree — two agents can then write the same tree concurrently."
      : "The daemon refuses to release a lease whose holder is still active; use force only when you know that agent is gone.",
  }),
  killAgent: (label: string) => ({
    body: `"${label}" will be killed — its process is terminated immediately.`,
    note: "This cannot be undone — any work in flight is lost and the session cannot be resumed.",
  }),
  closeAgent: (label: string) => ({
    body: `"${label}"'s session will be closed — its stdin ends gracefully once any in-flight turn finishes.`,
    note: "This cannot be undone — the next message starts a brand-new session with no memory of this one.",
  }),
  closeAllSessions: (count: number) => ({
    body: `${count} session${count === 1 ? "" : "s"} will be killed — every project conductor stays running.`,
    note: "This cannot be undone — any work in flight in those sessions is lost.",
  }),
  purgeTerminalSessions: (count: number) => ({
    body: `${count} finished agent${count === 1 ? "" : "s"} (done, failed and killed) will be forgotten — the record leaves the list and its archived copy and mailbox are deleted from disk.`,
    note: "This cannot be undone. RUNNING and PAUSED agents are never touched — a paused agent is not finished, it is resumable work. Transcripts already in the event log are not removed by this; they age out with the log's own retention.",
  }),
  revokeInvite: (createdLabel: string) => ({
    body: `The invite created ${createdLabel} will be revoked — its token becomes permanently unusable.`,
    note: "This cannot be undone — a peer still holding this blob can no longer redeem it; generate and redistribute a new invite instead.",
  }),
  deleteThreshold: (label: string) => ({
    body: `"${label}" will be removed from the saved SLO thresholds.`,
    note: "This cannot be undone here — the alert stops firing immediately; re-add it manually if that was a mistake.",
  }),
  // ROLES-TAB S5 (spec §2/§3), reworded by ROLES-UNIFY S5 for the unified role
  // library: a role is still a spawn template, so every confirm here names its
  // REAL effect (future spawns / running agents), never implies a running
  // agent changes.
  deleteSessionRole: (name: string) => ({
    body: `"${name}" will be permanently removed from the role library.`,
    note: `Future spawns/bindings referencing "${name}" will fail with UnknownRoleError; running agents are unaffected.`,
  }),
  resetBuiltinRole: (name: string) => ({
    body: `"${name}" will be reset to its pristine builtin values.`,
    note: "Your customization to this builtin is irrecoverably lost — future spawns use the pristine template; running agents are unaffected.",
  }),
  removeTeamRole: (team: string, role: string) => ({
    body: `"${role}" will be removed from team "${team}".`,
    note: "This cannot be undone — refused only while it has running members or blocking tasks (checked server-side); sibling roles are untouched.",
  }),
} as const;
