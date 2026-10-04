// @chimera/ui-state — the UI-framework-free state layer the Chimera desktop app consumes
// (W2 state port, PLAN-TAURI §3). types/reducer/flow were moved here VERBATIM from the
// since-retired TUI's state dir so every UI folds the daemon's event stream through ONE
// reducer; createStore adds the plain
// getState/subscribe/dispatch store the desktop app feeds to
// useSyncExternalStore. HARD RULE: this package never imports from a UI
// package (no ink, no react, no app) — @chimera/protocol is its only
// dependency.
export * from "./types.js";
export * from "./reducer.js";
export * from "./flow.js";
export * from "./createStore.js";
// FEATURE-9 — the attention-inbox aggregation selector.
export * from "./inbox.js";
export * from "./navigation.js";
// F12 — shared markdown-subset parser (pure, streaming-aware); both UIs consume.
export * from "./markdown.js";
export * from "./teamIcon.js";
export * from "./errorText.js";
// FEATURE ONBOARDING-GATE (R2) — the app/tui hard-navigation-gate predicate.
export * from "./onboarding.js";
// ALWAYS-ALLOW-UI — permission-card "always allow" key derivation (shared).
export * from "./mcpPolicy.js";
// MEM-8 — TUI memory fallback: search-prefix parser + note adjacency jump targets.
export * from "./memory.js";
// VOICE S5+S6 — push-to-talk UI state machine (app-only consumer today; TUI is out of scope).
export * from "./voice.js";
// ROLES-TAB S4 — usage join + patch builders shared by the app tab (S5) and TUI confirm glue.
export * from "./roles.js";
// PERMISSION-CARD-READABILITY — tool-input → human-readable rendering plan (no JSON syntax).
export * from "./toolInput.js";
// JOB-FLEET-GROUPING — bucket agents by their spawning job, newest-first (app/tui both consume).
export * from "./jobGroups.js";
// PAUSED-AGENTS-VISIBLE — shared pause-reason label, so app/tui never describe a hold differently.
export * from "./pause.js";

// F08 — shared failure-cause label, so app/tui never describe a failure disposition differently.
export * from "./failure.js";
// F09.UI — shared prompt-stall wording (badge/tooltip/transcript), so app+tui never diverge.
export * from "./promptStall.js";
// F22.UI — shared single-writer worktree-lease wording + workdirKey derivation (app+tui).
export * from "./worktreeLease.js";
// F50.UI — shared budget-guardrail wording (spend split, pause scope, resume effect).
export * from "./budget.js";
// AGENT-GROUPS Phase 1 — effective-group resolution + bucketing (app-only consumer; TUI is out
// of scope, per CLAUDE.md's group-boxes brief).
export * from "./agentGroups.js";
// F13.1 — pure run-history filter/derive selector shared by the app HistoryScreen and the
// TUI RunHistoryPane (both consume the same history.runs response shape).
export * from "./runHistory.js";
// F47 — shared seen/unseen predicate + fleet unseen list (app + TUI read attentionAt/
// reviewedAt only through these, never comparing the timestamps inline).
export * from "./seen.js";

// F49.UI: loopback MCP listener — shared footnote + grant-roster diff (see mcpListener.ts).
export * from "./mcpListener.js";
