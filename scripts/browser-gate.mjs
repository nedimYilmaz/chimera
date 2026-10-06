import { spawn } from "node:child_process";
import { constants, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULT_PREFIX = "__CHIMERA_BROWSER_GATE_RESULT__=";
// Required probe inventory is reviewed independently of emitted results. New probes
// may be added, but removing or skipping any existing ID must fail both boundaries.
export const REQUIRED_CHECK_IDS = {
  "ui": [
    "ui.project-delete-stale-resolve-same-target-keeps-focus-identity-path",
    "ui.project-delete-latest-resolve-same-target-owns-response",
    "ui.project-delete-stale-reject-same-target-keeps-focus-identity-path",
    "ui.project-delete-latest-reject-same-target-owns-response",
    "ui.project-delete-stale-resolve-different-target-keeps-focus-identity-path",
    "ui.project-delete-latest-resolve-different-target-owns-response",
    "ui.project-delete-stale-reject-different-target-keeps-focus-identity-path",
    "ui.project-delete-latest-reject-different-target-owns-response",
    "ui.project-delete-native-labeled-default-off",
    "ui.project-delete-native-tab-reaches-checkbox",
    "ui.project-delete-native-space-opts-in",
    "ui.project-delete-exact-path-fits-360px",
    "ui.project-delete-exact-path-fits-768px",
    "ui.project-delete-exact-path-fits-1440px",
    "ui.project-delete-dismiss-reopen-resets-choice",
    "ui.project-delete-registration-only-payload-closes",
    "ui.project-delete-rejected-retains-dialog-error-selection",
    "ui.project-delete-opt-in-payload-success-closes",
    "ui.project-delete-changing-project-resets-choice",
    "ui.compact-header-360px-reduces-baseline-height",
    "ui.compact-header-360px-increases-remaining-transcript-viewport",
    "ui.compact-header-360px-keyboard-reveals-bounded-details",
    "ui.compact-header-360px-escape-restores-summary-focus",
    "ui.compact-header-360px-touch-reveals-details",
    "ui.compact-header-360px-live-metrics-preserve-draft-selection-scroll",
    "ui.compact-header-360px-long-model-counters-no-overflow-composer-reachable",
    "ui.compact-header-768px-reduces-baseline-height",
    "ui.compact-header-768px-increases-remaining-transcript-viewport",
    "ui.compact-header-768px-keyboard-reveals-bounded-details",
    "ui.compact-header-768px-escape-restores-summary-focus",
    "ui.compact-header-768px-touch-reveals-details",
    "ui.compact-header-768px-live-metrics-preserve-draft-selection-scroll",
    "ui.compact-header-768px-long-model-counters-no-overflow-composer-reachable",
    "ui.compact-header-1440px-reduces-baseline-height",
    "ui.compact-header-1440px-increases-remaining-transcript-viewport",
    "ui.compact-header-1440px-keyboard-reveals-bounded-details",
    "ui.compact-header-1440px-escape-restores-summary-focus",
    "ui.compact-header-1440px-touch-reveals-details",
    "ui.compact-header-1440px-live-metrics-preserve-draft-selection-scroll",
    "ui.compact-header-1440px-long-model-counters-no-overflow-composer-reachable",

    "ui.ux26-qa-liveboard-recovery-message-readable",
    "ui.ux26-qa-large-queue-renders-500-real-task-rows",
    "ui.ux26-qa-large-queue-contained-scroll-360-768-1440",
    "ui.ux26-qa-large-queue-keyboard-selects-exact-task",
    "ui.ux26-qa-large-queue-search-preserves-task-identity",

    "ui.ux26-qa-liveboard-loading-is-not-empty",
    "ui.ux26-qa-liveboard-error-offers-retry",
    "ui.ux26-qa-liveboard-pending-retry-deduplicates",
    "ui.ux26-qa-liveboard-late-reply-rejected",
    "ui.ux26-qa-liveboard-stale-keeps-transcript-and-draft",
    "ui.ux26-qa-liveboard-no-overflow-composer-reachable-360-768-1440",
    "ui.ux26-qa-route-failure-retains-chrome",
    "ui.ux26-qa-route-recovery-reachable-360-768-1440",
    "ui.ux26-qa-route-keyboard-retry-makes-fresh-attempt",
    "ui.ux26-qa-route-recovers-actual-projects",
    "ui.ux26-qa-route-navigation-restores-draft",

    "ui.ux26-v-canvas-relationship-labels-use-theme-color",
    "ui.ux26-v-canvas-filter-list-parity",
    "ui.ux26-v-canvas-task-selects-exact-entity",
    "ui.ux26-v-canvas-task-opens-established-evidence",
    "ui.ux26-v-canvas-artifact-opens-existing-preview",
    "ui.ux26-v-canvas-list-retains-project-sessions-files",
    "ui.ux26-v-canvas-project-switch-isolates-arrangement",
    "ui.ux26-v-canvas-native-tab-focus",
    "ui.ux26-v-canvas-layout-persistence-after-remount",
    "ui.ux26-v-canvas-removed-entity-clears-selection",
    "ui.ux26-v-canvas-toggle-and-list-fallback",
    "ui.ux26-v-canvas-keyboard-pan-zoom-open",
    "ui.ux26-v-canvas-scaled-pointer-math",
    "ui.ux26-v-canvas-context-snapshot-list-labels",
    "ui.ux26-v-canvas-300-nodes-truncation-no-overflow",
    "ui.ux26-v-canvas-snapshot-keeps-viewport-selection",
    "ui.ux26-v-canvas-bounded-previews-idle-cheap",
    "ui.ux26-v-canvas-stale-save-retains-arrangement",
    "ui.ux26-v-canvas-error-stale-reconnect",
    "ui.ux26-v-canvas-narrow-falls-back-to-list",
    "ui.ux26-v-no-overflow-360-768-1440",
    "ui.ux26-v-canvas-enter-opens-existing-transcript",
    "ui.inspector-registry-external-create",
    "ui.inspector-registry-external-rename-color",
    "ui.inspector-registry-external-delete-stale-membership",
    "ui.inspector-registry-reconnect-missed-crud",
    "ui.inspector-registry-selection-draft-panel-preserved",

    "ui.ux26-f-fork-overlay-capability-labels",
    "ui.ux26-f-native-disabled-with-reason",
    "ui.ux26-f-overlay-focus-escape",
    "ui.ux26-f-reconnect-retains-intended-task",
    "ui.ux26-f-fork-keeps-selection-and-draft",
    "ui.ux26-f-selected-boundary-no-duplicate-execution",
    "ui.ux26-f-lineage-chip-no-overflow",
    "ui.ux26-f-no-overflow-360-768-1440",

    "ui.ux26-w-settings-card-states",
    "ui.ux26-w-pair-overlay-focus-escape",
    "ui.ux26-w-session-revoke-and-expiry-state",
    "ui.ux26-w-panel-360-agents-queue-review",
    "ui.ux26-w-panel-read-scope-hides-controls",
    "ui.ux26-w-panel-controls-explicit-send",
    "ui.ux26-w-review-explicit-decision",
    "ui.ux26-w-session-scope-change-clears-view",
    "ui.ux26-w-no-overflow-360-768-1440",
    "ui.ux26-teams-form-create-360px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-create-360px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-create-360px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-create-360px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-create-360px-close-restores-connected-opener",
    "ui.ux26-teams-form-create-360px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-teams-form-create-768px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-create-768px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-create-768px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-create-768px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-create-768px-close-restores-connected-opener",
    "ui.ux26-teams-form-create-768px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-teams-form-create-1440px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-create-1440px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-create-1440px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-create-1440px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-create-1440px-close-restores-connected-opener",
    "ui.ux26-teams-form-create-1440px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-teams-form-edit-360px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-edit-360px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-edit-360px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-edit-360px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-edit-360px-close-restores-connected-opener",
    "ui.ux26-teams-form-edit-360px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-teams-form-edit-768px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-edit-768px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-edit-768px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-edit-768px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-edit-768px-close-restores-connected-opener",
    "ui.ux26-teams-form-edit-768px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-teams-form-edit-1440px-labels-fields-and-actions-are-readable",
    "ui.ux26-teams-form-edit-1440px-all-enabled-fields-are-keyboard-reachable",
    "ui.ux26-teams-form-edit-1440px-resize-and-refresh-preserve-draft-identity",
    "ui.ux26-teams-form-edit-1440px-escape-dismisses-topmost-confirmation-and-keeps-draft",
    "ui.ux26-teams-form-edit-1440px-close-restores-connected-opener",
    "ui.ux26-teams-form-edit-1440px-reducer-overlay-dismisses-registered-form",
    "ui.ux26-c-registered-share-replacement-resets-exact-target",
    "ui.ux26-c-next-escape-follows-existing-agents-chain",
    "ui.ux26-c-agent-switch-dismisses-registered-share-without-stale-commit",
    "ui.ux26-c-replacement-releases-share-escape-ownership",
    "ui.ux26-c-normal-agents-escape-after-replacement",
    "ui.ux26-c-agent-switch-dismisses-local-note-share",
    "ui.ux26-c-share-overlay-focus-escape",
    "ui.ux26-c-native-disclosure-owns-space",
    "ui.ux26-c-pointer-reads-snapshot",
    "ui.ux26-c-share-action-keyboard-reachable-360-768-1440",
    "ui.ux26-c-add-overlay-keeps-inspector-and-restores-opener",
    "ui.ux26-c-keyboard-and-selection-preserved",
    "ui.ux26-c-preview-and-snapshot-label-private-note",
    "ui.ux26-c-immutable-snapshot-survives-private-edit",
    "ui.ux26-c-links-disclosure-states",
    "ui.ux26-c-draft-preserved-on-links-update",
    "ui.ux26-c-no-overflow-360-768-1440",
    "ui.ux26-g-explicit-unstage-stage-reviewed-commit",
    "ui.ux26-g-working-tree-states",
    "ui.ux26-g-edit-content-conflict-keeps-draft",
    "ui.ux26-g-edit-unsaved-draft-preserved",
    "ui.ux26-g-index-only-conflict",
    "ui.ux26-g-stale-head-refresh-keeps-selection",
    "ui.ux26-g-stage-commit-overlay-focus-escape",
    "ui.ux26-g-no-overflow-no-composer-overlap-360-768-1440",
    "ui.ux26-g-lease-held-state",
    "ui.ux26-g-successful-clean-state",
    "ui.ux26-g-unsupported-actions-stay-disabled",

    "ui.ux26-s-ptt-hold-release-inserts-draft",
    "ui.ux26-s-language-selection-stays-local",
    "ui.ux26-s-cancel-releases-capture",
    "ui.ux26-s-ptt-denied-and-unavailable-states",
    "ui.ux26-s-install-progress-cancel-verify",
    "ui.ux26-s-no-overflow-no-composer-overlap-360-768-1440",
    "ui.ux26-i-uncertain-comment-blocks-repeat-and-escape-restores-focus",
    "ui.ux26-i-partial-close-keeps-comment-distinct-and-blocks-repeat",
    "ui.ux26-i-late-write-result-keeps-replacement-overlay",
    "ui.ux26-i-review-event-refreshes-board-status",
    "ui.ux26-i-issue-chip-native-keyboard-opens-comment",
    "ui.ux26-i-sources-keyboard-disclosure",
    "ui.ux26-i-sources-disclosure-states",
    "ui.ux26-i-source-retry-busy",
    "ui.ux26-i-issue-chip-and-changed-badge",
    "ui.ux26-i-stale-keeps-issue-rows",
    "ui.ux26-i-reconnect-discards-late-reply",
    "ui.ux26-i-sync-busy",
    "ui.ux26-i-sync-busy-error-gh-unauthenticated",
    "ui.ux26-i-post-comment-overlay-preview-focus",
    "ui.ux26-i-post-cancel-restores-focus-no-write",
    "ui.ux26-i-exact-confirmation-writes-once",
    "ui.ux26-i-360px-comment-fits-viewport",
    "ui.ux26-i-768px-comment-fits-viewport",
    "ui.ux26-i-1440px-comment-fits-viewport",
    "ui.ux26-i-no-overflow-360-768-1440",
    "ui.ux26-teams-master-360px-large-list-leaves-footer-unobstructed",
    "ui.ux26-teams-master-768px-large-list-leaves-footer-unobstructed",
    "ui.ux26-teams-master-1440px-large-list-leaves-footer-unobstructed",
    "ui.ux26-teams-master-360px-last-row-is-keyboard-reachable",
    "ui.ux26-teams-master-768px-last-row-is-keyboard-reachable",
    "ui.ux26-teams-master-1440px-last-row-is-keyboard-reachable",
    "ui.ux26-teams-master-360px-scrolling-preserves-selected-team-and-draft",
    "ui.ux26-teams-master-768px-scrolling-preserves-selected-team-and-draft",
    "ui.ux26-teams-master-1440px-scrolling-preserves-selected-team-and-draft",
    "ui.ux26-teams-detail-360px-headers-and-populated-cells-are-reachable",
    "ui.ux26-teams-detail-768px-headers-and-populated-cells-are-reachable",
    "ui.ux26-teams-detail-1440px-headers-and-populated-cells-are-reachable",
    "ui.ux26-teams-detail-360px-keyboard-scroll-stays-in-its-pane",
    "ui.ux26-teams-detail-768px-keyboard-scroll-stays-in-its-pane",
    "ui.ux26-teams-detail-1440px-keyboard-scroll-stays-in-its-pane",
    "ui.ux26-teams-detail-360px-keyboard-still-toggles-the-worker-inspector",
    "ui.ux26-teams-detail-768px-keyboard-still-toggles-the-worker-inspector",
    "ui.ux26-teams-detail-1440px-keyboard-still-toggles-the-worker-inspector",
    "ui.ux26-r-resources-section-states",
    "ui.ux26-r-tree-recovery-resets-virtual-window",
    "ui.ux26-r-stale-keeps-last-good",
    "ui.ux26-r-no-overflow-360-768-1440",
    "ui.ux26-r-selected-header-shares-inspector-sampling",
    "ui.ux26-teams-team-list-360px-pending-is-not-empty",
    "ui.ux26-teams-team-list-360px-failure-offers-retry",
    "ui.ux26-teams-team-list-360px-retry-is-busy",
    "ui.ux26-teams-team-list-360px-retry-recovers",
    "ui.ux26-teams-team-list-360px-stale-retains-rows-and-draft",
    "ui.ux26-teams-team-list-360px-disconnect-discards-late-reply",
    "ui.ux26-teams-team-list-360px-batched-reconnect-reloads-once",
    "ui.ux26-teams-team-list-360px-refresh-preserves-selection-and-draft",
    "ui.ux26-teams-team-list-360px-fits-viewport",
    "ui.ux26-teams-team-list-768px-pending-is-not-empty",
    "ui.ux26-teams-team-list-768px-failure-offers-retry",
    "ui.ux26-teams-team-list-768px-retry-is-busy",
    "ui.ux26-teams-team-list-768px-retry-recovers",
    "ui.ux26-teams-team-list-768px-stale-retains-rows-and-draft",
    "ui.ux26-teams-team-list-768px-disconnect-discards-late-reply",
    "ui.ux26-teams-team-list-768px-batched-reconnect-reloads-once",
    "ui.ux26-teams-team-list-768px-refresh-preserves-selection-and-draft",
    "ui.ux26-teams-team-list-768px-fits-viewport",
    "ui.ux26-teams-team-list-1440px-pending-is-not-empty",
    "ui.ux26-teams-team-list-1440px-failure-offers-retry",
    "ui.ux26-teams-team-list-1440px-retry-is-busy",
    "ui.ux26-teams-team-list-1440px-retry-recovers",
    "ui.ux26-teams-team-list-1440px-stale-retains-rows-and-draft",
    "ui.ux26-teams-team-list-1440px-disconnect-discards-late-reply",
    "ui.ux26-teams-team-list-1440px-batched-reconnect-reloads-once",
    "ui.ux26-teams-team-list-1440px-refresh-preserves-selection-and-draft",
    "ui.ux26-teams-team-list-1440px-fits-viewport",
    "ui.ux26-teams-team-list-successful-empty-is-honest",
    "ui.ux26-teams-team-list-unsupported-has-no-retry",
    "ui.ux26-roles-team-list-360px-pending-is-not-empty",
    "ui.ux26-roles-team-list-360px-failure-offers-retry",
    "ui.ux26-roles-team-list-360px-retry-is-busy",
    "ui.ux26-roles-team-list-360px-retry-recovers",
    "ui.ux26-roles-team-list-360px-stale-retains-rows-and-draft",
    "ui.ux26-roles-team-list-360px-disconnect-discards-late-reply",
    "ui.ux26-roles-team-list-360px-batched-reconnect-reloads-once",
    "ui.ux26-roles-team-list-360px-refresh-preserves-selection-and-draft",
    "ui.ux26-roles-team-list-360px-fits-viewport",
    "ui.ux26-roles-team-list-768px-pending-is-not-empty",
    "ui.ux26-roles-team-list-768px-failure-offers-retry",
    "ui.ux26-roles-team-list-768px-retry-is-busy",
    "ui.ux26-roles-team-list-768px-retry-recovers",
    "ui.ux26-roles-team-list-768px-stale-retains-rows-and-draft",
    "ui.ux26-roles-team-list-768px-disconnect-discards-late-reply",
    "ui.ux26-roles-team-list-768px-batched-reconnect-reloads-once",
    "ui.ux26-roles-team-list-768px-refresh-preserves-selection-and-draft",
    "ui.ux26-roles-team-list-768px-fits-viewport",
    "ui.ux26-roles-team-list-1440px-pending-is-not-empty",
    "ui.ux26-roles-team-list-1440px-failure-offers-retry",
    "ui.ux26-roles-team-list-1440px-retry-is-busy",
    "ui.ux26-roles-team-list-1440px-retry-recovers",
    "ui.ux26-roles-team-list-1440px-stale-retains-rows-and-draft",
    "ui.ux26-roles-team-list-1440px-disconnect-discards-late-reply",
    "ui.ux26-roles-team-list-1440px-batched-reconnect-reloads-once",
    "ui.ux26-roles-team-list-1440px-refresh-preserves-selection-and-draft",
    "ui.ux26-roles-team-list-1440px-fits-viewport",
    "ui.ux26-roles-team-list-successful-empty-is-honest",
    "ui.ux26-roles-team-list-unsupported-has-no-retry",
    "ui.ux26-roles-batched-reconnect-is-not-lost",
    "ui.ux26-reducer-overlay-replaces-contextual-form",
    "ui.ux26-roles-pending-is-not-empty",
    "ui.ux26-roles-retry-is-busy",
    "ui.ux26-roles-retry-recovers-real-rows",
    "ui.ux26-roles-keyboard-uses-loaded-rows",
    "ui.ux26-roles-failed-refresh-retains-rows-and-draft",
    "ui.ux26-roles-disconnect-drops-late-reply",
    "ui.ux26-roles-reconnect-reloads-once",
    "ui.ux26-roles-refresh-keeps-selection-and-unsaved-override",
    "ui.ux26-topbar-rebinding-keeps-digit-and-live-sequence",
    "ui.ux26-topbar-digit-still-navigates-after-rebinding",
    "ui.ux26-roles-unsupported-stays-explicit-without-retry",
    "ui.ux26-roles-large-list-360px-fits-viewport",
    "ui.ux26-roles-large-list-360px-preserves-scroll",
    "ui.ux26-topbar-360px-names-digit-as-shortcut",
    "ui.ux26-roles-large-list-768px-fits-viewport",
    "ui.ux26-roles-large-list-768px-preserves-scroll",
    "ui.ux26-topbar-768px-names-digit-as-shortcut",
    "ui.ux26-roles-large-list-1440px-fits-viewport",
    "ui.ux26-roles-large-list-1440px-preserves-scroll",
    "ui.ux26-topbar-1440px-names-digit-as-shortcut",
    "ui.output-images-360px-fit-viewport",
    "ui.output-images-768px-fit-viewport",
    "ui.output-images-1440px-fit-viewport",
    "ui.output-preview-visible-while-tool-strip-is-collapsed",
    "ui.output-raster-decodes-actual-image-bytes",
    "ui.output-malformed-raster-degrades-safely",
    "ui.output-oversized-payload-has-explicit-omission",
    "ui.output-viewer-uses-existing-named-overlay",
    "ui.output-viewer-escape-restores-opener-focus",
    "ui.output-images-remain-with-owning-agent",
    "ui.output-replay-preserves-inline-preview",
    "ui.output-viewer-closes-when-registered-overlay-opens",
    "ui.output-viewer-closes-on-agent-selection",
    "ui.output-viewer-yields-to-another-local-card",
    "ui.output-old-card-teardown-preserves-replacement-image",
    "ui.output-nested-confirmcard-preserves-parent-lifecycle",
    "ui.desktop-preview-stays-out-of-other-agent-transcripts",
    "ui.desktop-preview-floats-top-right-inside-the-controlling-transcript",
    "ui.desktop-preview-does-not-steal-focus-or-cover-the-composer",
    "ui.desktop-preview-fits-a-390px-transcript",
    "ui.desktop-preview-collapse-pauses-frames-and-hide-keeps-control-running",
    "ui.desktop-preview-drops-a-late-frame-after-the-agent-switches",
    "ui.desktop-preview-shows-only-the-controlling-agent-actions",
    "ui.desktop-preview-clears-on-capture-failure-and-lease-release",
    "ui.desktop-preview-stop-calls-the-explicit-stop-service",
    "ui.desktop-preview-never-opens-a-native-window",
    "ui.native-workflows-stay-out-of-fleet-list",
    "ui.workflow-transcript-links-open-the-exact-completed-run",
    "ui.workflow-transcript-links-open-the-exact-running-run-by-keyboard",
    "ui.computer-use-identifies-chimera-as-permission-owner",
    "ui.computer-use-controls-fit-a-390px-screen",
    "ui.computer-use-permission-flow-explains-app-relaunch",
    "ui.computer-use-starts-and-stops-through-native-host-controls",
    "ui.computer-use-labels-built-in-integrations-and-first-use-assets",
    "ui.computer-use-built-in-rows-fit-a-390px-screen",
    "ui.computer-use-installs-laya-through-the-managed-first-use-download",
    "ui.metrics-390px-provider-capacity-stays-separate-from-session-and-compaction",
    "ui.metrics-630px-provider-capacity-stays-separate-from-session-and-compaction",
    "ui.metrics-1180px-provider-capacity-stays-separate-from-session-and-compaction",
    "ui.background-task-completes-in-place-without-a-stale-spinner",
    "ui.background-task-failure-shows-its-reason",
    "ui.background-task-stop-is-visibly-distinct-from-success",
    "ui.project-import-offers-provider-account-and-flagship-model",
    "ui.project-claude-conductor-defaults-to-full-permissions",
    "ui.project-codex-conductor-preserves-full-permissions",
    "ui.project-provider-switch-resets-account-and-model",
    "ui.project-import-390px-controls-fit",
    "ui.project-import-780px-controls-fit",
    "ui.project-creation-submits-chosen-conductor-routing",
    "ui.project-global-defaults-clear-explicit-routing",
    "ui.native-codex-goal-appears-in-slash-menu",
    "ui.claude-slash-menu-reflects-sdk-discovery",
    "ui.hover-name-scroll-reveals-final-characters-without-moving-columns",
    "ui.hover-name-recalculates-scrolling-after-pane-resize",
    "ui.hover-name-resets-on-pointer-leave",
    "ui.hover-name-respects-reduced-motion-with-full-title",
    "ui.hover-name-leaves-fitting-text-still",
    "ui.inspector-groups-reorder-by-dragging-header",
    "ui.inspector-agent-reorder-preserves-subtree-and-quote-payload",
    "ui.inspector-ungrouped-agents-reorder",
    "ui.inspector-ordering-survives-remount",
    "ui.inspector-live-children-stay-with-owner-after-manual-sorting",
    "ui.inspector-owner-fold-hides-direct-and-queue-descendants",
    "ui.inspector-drag-removes-inherited-group-membership",
    "ui.inspector-dragging-into-group-retains-membership-gesture",
    "ui.inspector-failed-move-keeps-previous-placement",
    "ui.inspector-ungroup-drop-fits-narrow-viewport",
    "ui.quick-spawn-opens-routing-form-without-spawning",
    "ui.quick-spawn-provider-switches-account-and-flagship-model",
    "ui.quick-spawn-390px-controls-fit",
    "ui.quick-spawn-780px-controls-fit",
    "ui.quick-spawn-preserves-idle-session-defaults-and-selected-routing",
    "ui.full-spawn-form-remains-available",
    "ui.unread-indicator-320px-keeps-row-columns-stable",
    "ui.unread-indicator-320px-uses-accessible-dot",
    "ui.unread-indicator-320px-clears-without-moving-columns",
    "ui.unread-indicator-420px-keeps-row-columns-stable",
    "ui.unread-indicator-420px-uses-accessible-dot",
    "ui.unread-indicator-420px-clears-without-moving-columns",
    "ui.unread-indicator-640px-keeps-row-columns-stable",
    "ui.unread-indicator-640px-uses-accessible-dot",
    "ui.unread-indicator-640px-clears-without-moving-columns",

    "ui.screen-review-390px-stays-within-shared-grid",
    "ui.screen-review-768px-stays-within-shared-grid",
    "ui.screen-review-1440px-stays-within-shared-grid",
    "ui.screen-welcome-390px-stays-within-shared-grid",
    "ui.screen-welcome-768px-stays-within-shared-grid",
    "ui.screen-welcome-1440px-stays-within-shared-grid",
    "ui.settings-provider-cards-390px-keep-details-inside-grid",
    "ui.settings-provider-cards-768px-keep-details-inside-grid",
    "ui.settings-provider-cards-1440px-keep-details-inside-grid",

    "ui.workspace-bookmarks-persist-a-real-transcript-turn",
    "ui.workspace-bookmarks-navigate-to-the-saved-turn",
    "ui.focus-workspace-390px-preserves-transcript-and-hides-fleet",
    "ui.focus-workspace-768px-preserves-transcript-and-hides-fleet",
    "ui.focus-workspace-1440px-preserves-transcript-and-hides-fleet",

    "ui.workspace-parameterized-prompts-append-without-sending",
    "ui.workspace-draft-restore-protects-existing-composer",
    "ui.workspace-draft-restores-after-composer-is-empty",
    "ui.workspace-notes-save-separately-from-transcript",
    "ui.workspace-saves-fleet-filter-settings",
    "ui.workspace-export-reports-the-loaded-window-scope",
    "ui.workspace-compaction-states-bounded-event-history",
    "ui.workspace-readability-settings-apply-to-app-tokens",
    "ui.workspace-prompts-390px-fits-dialog-grid",
    "ui.workspace-drafts-390px-fits-dialog-grid",
    "ui.workspace-notes-390px-fits-dialog-grid",
    "ui.workspace-bookmarks-390px-fits-dialog-grid",
    "ui.workspace-views-390px-fits-dialog-grid",
    "ui.workspace-display-390px-fits-dialog-grid",
    "ui.workspace-export-390px-fits-dialog-grid",
    "ui.workspace-compaction-390px-fits-dialog-grid",
    "ui.workspace-prompts-768px-fits-dialog-grid",
    "ui.workspace-drafts-768px-fits-dialog-grid",
    "ui.workspace-notes-768px-fits-dialog-grid",
    "ui.workspace-bookmarks-768px-fits-dialog-grid",
    "ui.workspace-views-768px-fits-dialog-grid",
    "ui.workspace-display-768px-fits-dialog-grid",
    "ui.workspace-export-768px-fits-dialog-grid",
    "ui.workspace-compaction-768px-fits-dialog-grid",
    "ui.workspace-prompts-1440px-fits-dialog-grid",
    "ui.workspace-drafts-1440px-fits-dialog-grid",
    "ui.workspace-notes-1440px-fits-dialog-grid",
    "ui.workspace-bookmarks-1440px-fits-dialog-grid",
    "ui.workspace-views-1440px-fits-dialog-grid",
    "ui.workspace-display-1440px-fits-dialog-grid",
    "ui.workspace-export-1440px-fits-dialog-grid",
    "ui.workspace-compaction-1440px-fits-dialog-grid",

    "ui.keyboard-leader-is-visible-while-composing",
    "ui.keyboard-sequence-dispatches-once-without-changing-draft",
    "ui.keyboard-escape-cancels-the-pending-sequence",
    "ui.keyboard-alt-space-does-not-start-voice",
    "ui.keyboard-voice-uses-the-leader-sequence",
    "ui.keyboard-tab-preserves-native-focus-navigation",

    "ui.screen-projects-390px-stays-within-shared-grid",
    "ui.screen-memory-390px-stays-within-shared-grid",
    "ui.screen-events-390px-stays-within-shared-grid",
    "ui.screen-roles-390px-stays-within-shared-grid",
    "ui.screen-inbox-390px-stays-within-shared-grid",
    "ui.screen-slo-390px-stays-within-shared-grid",
    "ui.screen-runs-390px-stays-within-shared-grid",
    "ui.screen-help-390px-stays-within-shared-grid",
    "ui.screen-agents-390px-stays-within-shared-grid",
    "ui.screen-settings-390px-stays-within-shared-grid",
    "ui.screen-teams-390px-stays-within-shared-grid",
    "ui.screen-queues-390px-stays-within-shared-grid",
    "ui.screen-projects-768px-stays-within-shared-grid",
    "ui.screen-memory-768px-stays-within-shared-grid",
    "ui.screen-events-768px-stays-within-shared-grid",
    "ui.screen-roles-768px-stays-within-shared-grid",
    "ui.screen-inbox-768px-stays-within-shared-grid",
    "ui.screen-slo-768px-stays-within-shared-grid",
    "ui.screen-runs-768px-stays-within-shared-grid",
    "ui.screen-help-768px-stays-within-shared-grid",
    "ui.screen-agents-768px-stays-within-shared-grid",
    "ui.screen-settings-768px-stays-within-shared-grid",
    "ui.screen-teams-768px-stays-within-shared-grid",
    "ui.screen-queues-768px-stays-within-shared-grid",
    "ui.screen-projects-1440px-stays-within-shared-grid",
    "ui.screen-memory-1440px-stays-within-shared-grid",
    "ui.screen-events-1440px-stays-within-shared-grid",
    "ui.screen-roles-1440px-stays-within-shared-grid",
    "ui.screen-inbox-1440px-stays-within-shared-grid",
    "ui.screen-slo-1440px-stays-within-shared-grid",
    "ui.screen-runs-1440px-stays-within-shared-grid",
    "ui.screen-help-1440px-stays-within-shared-grid",
    "ui.screen-agents-1440px-stays-within-shared-grid",
    "ui.screen-settings-1440px-stays-within-shared-grid",
    "ui.screen-teams-1440px-stays-within-shared-grid",
    "ui.screen-queues-1440px-stays-within-shared-grid",

    "ui.topbar-account-and-spend-controls-are-named-native-buttons",
    "ui.topbar-keyboard-opens-configured-account-details",
    "ui.metrics-390px-controls-remain-stable-when-usage-changes",
    "ui.metrics-390px-no-horizontal-overflow",
    "ui.metrics-390px-cache-context-and-rate-stay-distinct",
    "ui.accounts-390px-long-names-and-quota-fit",
    "ui.accounts-390px-both-providers-visible",
    "ui.metrics-630px-controls-remain-stable-when-usage-changes",
    "ui.metrics-630px-no-horizontal-overflow",
    "ui.metrics-630px-cache-context-and-rate-stay-distinct",
    "ui.accounts-630px-long-names-and-quota-fit",
    "ui.accounts-630px-both-providers-visible",
    "ui.metrics-1180px-controls-remain-stable-when-usage-changes",
    "ui.metrics-1180px-no-horizontal-overflow",
    "ui.metrics-1180px-cache-context-and-rate-stay-distinct",
    "ui.accounts-1180px-long-names-and-quota-fit",
    "ui.accounts-1180px-both-providers-visible",
    "ui.local-markdown-image-link-opens-the-actual-file-viewer",
    "ui.local-markdown-guide-supports-keyboard-opening-and-source-toggle",
    "ui.local-markdown-guide-source-toggle-displays-source",
    "ui.local-markdown-line-link-opens-source-at-requested-line",
    "ui.minimal-markdown-local-link-opens-the-shared-viewer",
    "ui.unresolved-and-unsafe-markdown-links-remain-inert-without-navigation",
    "ui.design-starts-in-conversation-without-stealing-focus",
    "ui.design-loads-the-newest-registered-html-snapshot",
    "ui.design-frame-has-no-script-or-same-origin-sandbox-permissions",
    "ui.design-strips-scripts-navigation-embeds-and-event-handlers",
    "ui.design-revision-selection-restores-the-immutable-prior-snapshot",
    "ui.design-agent-switch-never-shows-another-agents-snapshot",
    "ui.design-restores-selected-revision-when-returning-to-an-agent",
    "ui.design-source-displays-original-html-as-text",
    "ui.design-mobile-viewport-uses-an-actual-390px-frame",
    "ui.design-wide-split-preserves-conversation-beside-canvas",
    "ui.design-narrow-split-stacks-and-keeps-controls-in-bounds",
    "ui.design-inert-parsing-and-preview-make-no-resource-requests",
    "ui.design-rejects-oversize-source-before-parsing",
    "ui.design-list-failures-are-visible-and-retryable",
    "ui.design-oversized-snapshots-are-rejected-before-native-read",

    "ui.soft-limit-preserves-busy-running-animation",
    "ui.soft-limit-warning-is-separate-from-running-header",
    "ui.soft-limit-running-remains-distinct-with-reduced-motion",
    "ui.soft-limit-idle-retains-running-color-without-pulse",
    "ui.actual-pause-remains-paused-despite-prior-soft-limit",

    "ui.live-rename-updates-inspector-list-without-reload",
    "ui.live-rename-updates-transcript-authors-without-reload",
    "ui.secret-grants-follow-live-names-rather-than-cached-labels",
    "ui.secret-access-management-starts-collapsed",
    "ui.secret-delete-waits-for-explicit-confirmation",
    "ui.secret-deletion-cancel-makes-no-mutation",
    "ui.secret-values-remain-password-inputs",
    "ui.secret-controls-fit-a-390px-pane",

    "ui.network-guard-blocks-external-fetch-and-websocket",
    "ui.custom-provider-built-in-id-collision-is-visible-without-mutation",
    "ui.custom-provider-no-key-save-preserves-rpc-order-without-secret-write",
    "ui.custom-provider-appears-immediately-after-save",
    "ui.custom-provider-model-refresh-is-requested",
    "ui.custom-provider-discovered-model-is-selectable-in-spawn-ui",
    "ui.custom-provider-keyed-path-uses-write-only-password-field",
    "ui.chip-actions-render-named-native-confirm-buttons",
    "ui.editable-confirmcard-children-do-not-confirm",
    "ui.focused-confirm-enter-confirms-exactly-once",
    "ui.focused-confirm-cancel-space-only-cancels-once",
    "ui.focused-confirm-cancel-enter-only-cancels-once",
    "ui.chip-actions-render-named-native-team-buttons",
    "ui.focused-team-save-enter-submits-once",
    "ui.disabled-chipbutton-cannot-invoke-its-callback",
    "ui.focused-team-cancel-space-only-cancels-once",
    "ui.focused-team-cancel-enter-only-cancels-once",
    "ui.chip-actions-render-named-native-queue-buttons",
    "ui.queue-input-enter-still-submits",
    "ui.focused-queue-save-space-submits-once",
    "ui.focused-queue-cancel-enter-only-cancels-once",
    "ui.overlaycard-fits-a-390px-action-card-host-without-cropped-actions",
    "ui.overlaycard-fits-a-constrained-630px-pane",
    "ui.topbar-wide-labels-are-unique",
    "ui.topbar-tabs-use-keyboard-operable-buttons",
    "ui.topbar-wide-layout-has-no-page-overflow",
    "ui.topbar-overflow-popup-stays-in-viewport",
    "ui.topbar-overflow-exposes-expanded-state",
    "ui.topbar-has-no-duplicate-accessible-controls",
    "ui.topbar-narrow-layout-has-no-overflow",
    "ui.topbar-has-no-hidden-focusable-controls",
    "ui.overlay-exposes-non-modal-dialog-semantics",
    "ui.overlay-is-named-by-its-real-title",
    "ui.real-topbar-navigation-click-works-while-card-stays-open",
    "ui.overlay-preserves-child-autofocus-and-skips-hidden-controls",
    "ui.non-modal-overlay-lets-tab-reach-the-top-bar",
    "ui.non-modal-overlay-lets-shift-tab-reach-agent-switching",
    "ui.pane-confined-scrim-leaves-agent-switching-clickable",
    "ui.portaled-nested-dialog-owns-initial-focus",
    "ui.portaled-nested-dialog-remains-non-modal",
    "ui.nested-escape-leaves-the-parent-dialog-open",
    "ui.nested-dialog-restores-its-live-opener",
    "ui.overlay-restores-opener-focus",
    "ui.closing-after-agent-switching-preserves-external-focus",
    "ui.overlay-does-not-restore-focus-to-a-hidden-opener",
    "ui.overlay-does-not-restore-focus-to-a-disconnected-opener",
    "ui.initial-focus-preserves-deliberate-external-focus-before-microtask",
    "ui.cancel-before-initial-focus-microtask-restores-opener-without-detached-focus",
    "ui.card-without-onclose-does-not-swallow-escape",
    "ui.nested-escguard-lets-local-popup-consume-first-escape",
    "ui.next-escape-closes-only-nested-card",
    "ui.transcript-groups-adjacent-tool-rows-once",
    "ui.windowed-transcript-preserves-original-indices",
    "ui.windowed-transcript-excludes-out-of-range-messages",
    "ui.transcript-omits-blank-tool-only-assistant-cards",
    "ui.actual-transcript-pane-is-at-most-630px-wide",
    "ui.transcript-header-exposes-exactly-one-voice-toggle",
    "ui.transcript-unknown-context-never-renders-billable-usage-as-100-percent",
    "ui.pane-voice-history-closes",
    "ui.pane-voice-history-reopens-once",
    "ui.active-voice-becomes-visible-without-opening-history",
    "ui.630px-transcript-pane-has-no-horizontal-overflow",
    "ui.630px-transcript-pane-has-no-hidden-focusable-controls",
    "ui.active-pane-still-has-one-voice-toggle",
    "ui.voice-history-closes-without-duplicate-panel",
    "ui.voice-history-reopens-exactly-once",
    "ui.voice-meters-honor-reduced-motion",
    "ui.voice-630px-pane-has-no-overflow",
    "ui.queues-expose-loading-schedules-state",
    "ui.queues-render-populated-state",
    "ui.queues-expose-schedule-error-state",
    "ui.queues-render-empty-task-state",
    "ui.queues-fit-a-630px-pane",
    "ui.teams-render-list-and-detail",
    "ui.teams-fit-a-630px-pane",
    "ui.teams-have-no-hidden-focusable-controls",
    "ui.inline-child-keeps-child-autofocus-on-simultaneous-mount",
    "ui.portal-child-keeps-child-autofocus-on-simultaneous-mount",
    "ui.queues-1180px-resized-430px-master-detail-geometry",
    "ui.queues-1180px-resized-430px-named-summary-text-visible",
    "ui.queues-1180px-resized-560px-master-detail-geometry",
    "ui.queues-1180px-resized-560px-named-summary-text-visible",
    "ui.queues-630px-resized-430px-master-detail-geometry",
    "ui.queues-630px-resized-430px-named-summary-text-visible",
    "ui.queues-630px-resized-430px-detail-controls-reachable",
    "ui.queues-630px-resized-560px-master-detail-geometry",
    "ui.queues-630px-resized-560px-named-summary-text-visible",
    "ui.queues-630px-resized-560px-detail-controls-reachable",
    "ui.queues-390px-resized-430px-master-detail-geometry",
    "ui.queues-390px-resized-430px-named-summary-text-visible",
    "ui.queues-390px-resized-430px-backlog-label-value-and-meter-visible",
    "ui.queues-390px-resized-430px-detail-controls-reachable",
    "ui.queues-390px-resized-560px-master-detail-geometry",
    "ui.queues-390px-resized-560px-named-summary-text-visible",
    "ui.queues-390px-resized-560px-backlog-label-value-and-meter-visible",
    "ui.queues-390px-resized-560px-detail-controls-reachable",
    "ui.teams-1180px-resized-430px-master-detail-geometry",
    "ui.teams-1180px-resized-560px-master-detail-geometry",
    "ui.teams-630px-resized-430px-master-detail-geometry",
    "ui.teams-630px-resized-430px-detail-controls-reachable",
    "ui.teams-630px-resized-560px-master-detail-geometry",
    "ui.teams-630px-resized-560px-detail-controls-reachable",
    "ui.teams-390px-resized-430px-master-detail-geometry",
    "ui.teams-390px-resized-430px-detail-controls-reachable",
    "ui.teams-390px-resized-560px-master-detail-geometry",
    "ui.teams-390px-resized-560px-detail-controls-reachable",
    "ui.focused-ptt-space-hold-starts-and-sends-exactly-once",
    "ui.focused-ptt-space-repeat-does-not-scroll",
    "ui.focused-ptt-ignores-the-space-compatibility-click-and-unowned-keyup",
    "ui.focused-ptt-enter-hold-starts-and-sends-exactly-once",
    "ui.focused-ptt-owns-enter-before-the-root-keymap",
    "ui.focused-ptt-primary-pointer-sends-once-despite-its-compatibility-click",
    "ui.focused-ptt-ignores-right-click",
    "ui.focused-ptt-release-outside-cancels-without-sending",
    "ui.focused-ptt-stop-speaking-key-acts-once-and-never-records-on-release",
    "ui.focused-ptt-title-explains-space-and-enter-hold-semantics"
  ],
  "meeting": [
    "meeting.typed-meeting-question-sends-without-enabling-microphone",
    "meeting.operator-can-start-a-bounded-discussion",
    "meeting.active-participation-is-enabled-for-the-joined-operator",
    "meeting.active-participation-controls-fit-a-390px-meeting",
    "meeting.operator-can-disable-active-participation-without-leaving",
    "meeting.operator-can-stop-discussion-and-retain-the-meeting",

    "meeting.participant-avatars-remain-visible-with-settings-collapsed",
    "meeting.only-current-speaker-avatar-animates",
    "meeting.joined-human-has-named-speaking-avatar",
    "meeting.mic-off-stops-human-avatar-animation",
    "meeting.leaving-removes-human-and-speaker-switch-moves-animation",

    "meeting.network-guard-blocks-external-fetch-and-websocket",
    "meeting.meeting-tab-sits-between-inspector-and-dashboard",
    "meeting.meeting-workspace-uses-inline-inspector-panes",
    "meeting.meeting-conversation-remains-visible-with-participants-collapsed",
    "meeting.meeting-navigation-hides-workspace-and-retains-top-notifications",
    "meeting.meeting-notification-restores-selected-transcript",
    "meeting.390px-meeting-panes-stack-without-clipping",

    "meeting.actual-audioworklet-reports-no-failures",
    "meeting.operator-output-excludes-self",
    "meeting.operator-output-is-audible",
    "meeting.non-selected-participant-stays-silent",
    "meeting.other-room-stays-isolated",
    "meeting.human-departure-leaves-participant-input-silent",
    "meeting.audioworklet-captures-enough-frames",
    "meeting.operator-output-continuity-has-no-long-silence",
    "meeting.pause-silences-operator-output",
    "meeting.operator-peer-input-remains-silent",
    "meeting.synthetic-local-microphone-produces-frames",
    "meeting.human-input-is-excluded-from-agent-input",
    "meeting.silent-microphone-does-not-invent-an-operator-turn",
    "meeting.managed-audio-reports-no-failures",
    "meeting.floor-audio-stays-held-without-a-recipient",
    "meeting.selected-recipient-is-audible",
    "meeting.recipient-switch-is-audible",
    "meeting.listener-mode-mutes-selected-output",
    "meeting.speaker-mode-resumes-selected-output",
    "meeting.self-and-other-speaker-inputs-stay-silent",
    "meeting.late-joiner-receives-no-history",
    "meeting.listener-input-stays-silent",
    "meeting.late-joiner-receives-live-audio",
    "meeting.recipient-switch-keeps-input-track-live",
    "meeting.managed-audiocontext-stays-running",
    "meeting.meeting-ui-exercises-observer-join-and-audio-controls",
    "meeting.780px-meeting-layout-has-no-horizontal-overflow",
    "meeting.meeting-ui-honors-reduced-motion",
    "meeting.live-participant-approval-controls",
    "meeting.participant-controls-and-scoped-confirmations"
  ]
};

const MAX_ERROR_CHARS = 1_000;
const MAX_CAPTURE_CHARS = 256 * 1_024;
const DEFAULT_ENDPOINT_TIMEOUT_MS = 15_000;
const DEFAULT_CDP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

const sleep = (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs));

export function boundedError(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replaceAll(/(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+))/g, "[environment value omitted]").slice(0, MAX_ERROR_CHARS);
}

function executableCandidates(platform, environment) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "google-chrome",
      "chromium",
      "chromium-browser",
    ];
  }
  if (platform === "win32") {
    return [
      environment.PROGRAMFILES && win32.join(environment.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
      environment["PROGRAMFILES(X86)"] && win32.join(environment["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
      environment.LOCALAPPDATA && win32.join(environment.LOCALAPPDATA, "Chromium/Application/chrome.exe"),
      "chrome.exe",
      "msedge.exe",
    ].filter(Boolean);
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
}

// PATH syntax follows the TARGET platform, not the host, so discovery for an injected platform
// resolves the same way on every machine.
function resolvePathCommand(command, pathValue, fileExists, platform) {
  const path = platform === "win32" ? win32 : posix;
  if (path.isAbsolute(command)) return fileExists(command) ? command : null;
  for (const entry of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function discoverChromium(options = {}) {
  const environment = options.environment ?? process.env;
  const explicitPath = options.explicitPath ?? environment.CHIMERA_TEST_CHROME;
  const fileExists = options.fileExists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? environment.PATH;

  if (explicitPath) {
    const resolved = (platform === "win32" ? win32 : posix).isAbsolute(explicitPath)
      ? explicitPath
      : resolvePathCommand(explicitPath, pathValue, fileExists, platform);
    if (!resolved || !fileExists(resolved)) {
      throw new Error(`CHIMERA_TEST_CHROME does not exist: ${explicitPath}`);
    }
    return resolved;
  }

  for (const candidate of executableCandidates(platform, environment)) {
    const resolved = resolvePathCommand(candidate, pathValue, fileExists, platform);
    if (resolved) return resolved;
  }
  throw new Error("No supported local Chromium browser found. Set CHIMERA_TEST_CHROME to an existing executable; this gate never downloads a browser.");
}

export function createScratchDirectory(prefix, environment = process.env) {
  const parent = resolve(environment.CHIMERA_BROWSER_GATE_TEST_SCRATCH_PARENT ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

export function createScreenshotDirectory(suiteId, environment = process.env) {
  const requested = environment.CHIMERA_BROWSER_GATE_SCREENSHOTS === "1" || Boolean(environment.CHIMERA_UI_ARTIFACT_DIR);
  if (!requested) return null;
  const parent = resolve(environment.CHIMERA_UI_ARTIFACT_DIR ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `chimera-${suiteId}-artifacts-`));
}

function stableCheckId(suiteId, name) {
  const suffix = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
  return `${suiteId}.${suffix}`;
}

export function createSuiteReporter(suiteId, options = {}) {
  const startedAt = performance.now();
  const checks = [];
  const ids = new Set();
  const forceCheckId = options.forceCheckId ?? process.env.CHIMERA_BROWSER_GATE_FORCE_CHECK;

  return {
    check(name, condition, detail, durationMs = 0, explicitId) {
      const id = explicitId ?? stableCheckId(suiteId, name);
      if (!validId(id) || ids.has(id) || checks.length >= MAX_CHECKS) throw new Error(`Invalid, duplicate or excessive browser gate check id: ${id}`);
      if (!validDuration(durationMs)) throw new Error("Invalid check duration");
      ids.add(id);
      const forced = forceCheckId === id;
      const status = condition && !forced ? "passed" : "failed";
      const record = { id, status, durationMs };
      if (status === "failed") {
        const message = forced ? "forced probe failure" : detail === undefined ? `Check failed: ${name}` : `${name}: ${JSON.stringify(detail)}`;
        record.error = boundedError(message);
      }
      checks.push(record);
      return status === "passed";
    },
    fail(id, error) {
      if (ids.has(id)) return;
      ids.add(id);
      checks.push({ id, status: "failed", durationMs: 0, error: boundedError(error) });
    },
    finish(statusOverride) {
      const failed = checks.some((check) => check.status !== "passed");
      return {
        id: suiteId,
        status: statusOverride ?? (failed ? "failed" : "passed"),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        checks,
      };
    },
    get failed() { return checks.some((check) => check.status !== "passed"); },
    get counts() {
      return {
        passed: checks.filter((check) => check.status === "passed").length,
        failed: checks.filter((check) => check.status === "failed").length,
      };
    },
  };
}

function killOwnedProcess(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32" || child.ownedProcessGroup === false) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function ownedProcessAlive(child) {
  if (process.platform === "win32" || child.ownedProcessGroup === false) {
    return child.exitCode === null && child.signalCode === null;
  }
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    // Signal 0 can observe a group during OS reaping without permission to
    // signal it. This is presence, never evidence that cleanup is complete.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function terminateOwnedProcess(child, timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
  if (!child?.pid) return;
  // A leader's exit/close does not establish that its detached group is empty.
  killOwnedProcess(child, "SIGTERM");
  const waitUntilGone = async () => {
    const deadline = performance.now() + timeoutMs;
    while (ownedProcessAlive(child) && performance.now() < deadline) await sleep(Math.min(20, timeoutMs));
  };
  await waitUntilGone();
  if (ownedProcessAlive(child)) {
    killOwnedProcess(child, "SIGKILL");
    await waitUntilGone();
    if (ownedProcessAlive(child)) throw new Error("Owned process group survived bounded cleanup");
  }
}

export async function launchChromium(options) {
  if (options.signal?.aborted) throw new Error("Interrupted before starting Chromium");
  const environment = options.environment ?? process.env;
  const browserPath = discoverChromium({
    environment,
    explicitPath: options.explicitPath,
    fileExists: options.fileExists,
    platform: options.platform,
    pathValue: options.pathValue,
  });
  try {
    await (options.accessExecutable ?? access)(browserPath, constants.X_OK);
  } catch (error) {
    throw new Error(`Chromium executable is not runnable: ${browserPath}: ${boundedError(error)}`);
  }

  // Aggregate children inherit the suite group so its deadline also owns Chrome descendants.
  const ownGroup = !process.send;
  const child = (options.spawnImpl ?? spawn)(browserPath, options.args, {
    env: environment,
    detached: ownGroup && process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.ownedProcessGroup = ownGroup;
  options.onSpawn?.(child);
  const endpointTimeoutMs = options.endpointTimeoutMs ?? (Number(environment.CHIMERA_BROWSER_GATE_ENDPOINT_TIMEOUT_MS) || DEFAULT_ENDPOINT_TIMEOUT_MS);

  try {
    const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
      let output = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        child.stderr.removeListener("data", onData);
        if (error) rejectEndpoint(error);
        else resolveEndpoint(value);
      };
      const abort = () => finish(new Error("Interrupted while waiting for Chromium debugging endpoint"));
      const onError = (error) => finish(new Error(`Unable to start Chromium: ${boundedError(error)}`));
      const onClose = (code, signal) => finish(new Error(`Chromium exited before its debugging endpoint (${signal ? `signal ${signal}` : `exit ${code}`})`));
      const timer = setTimeout(() => finish(new Error(`Chromium debugging endpoint timed out after ${endpointTimeoutMs}ms`)), endpointTimeoutMs);
      child.once("error", onError);
      child.once("close", onClose);
      options.signal?.addEventListener("abort", abort, { once: true });
      const onData = (chunk) => {
        output = `${output}${chunk}`.slice(-8_192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
        if (match) finish(null, match[1]);
      };
      child.stderr.on("data", onData);
      if (options.signal?.aborted) abort();
    });
    return { browserPath, child, endpoint };
  } catch (error) {
    await terminateOwnedProcess(child);
    throw error;
  }
}

export async function connectCdp(endpoint, options = {}) {
  if (options.signal?.aborted) throw new Error("Interrupted before opening CDP");
  const timeoutMs = options.timeoutMs ?? (Number(process.env.CHIMERA_BROWSER_GATE_CDP_TIMEOUT_MS) || DEFAULT_CDP_TIMEOUT_MS);
  const socket = new (options.WebSocketImpl ?? WebSocket)(endpoint);
  const requests = new Map();
  const listeners = new Set();
  let sequence = 0;
  let closed = false;
  const close = (error = new Error("CDP client closed")) => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
    for (const request of requests.values()) request.finish(error);
    requests.clear();
    listeners.clear();
    try { socket.close(); } catch { /* Some WebSocket implementations reject close while connecting. */ }
  };
  const abort = () => close(new Error("Interrupted during CDP"));
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", openingAbort);
        socket.onopen = socket.onerror = socket.onclose = null;
        if (error) rejectOpen(error); else resolveOpen();
      };
      const openingAbort = () => finish(new Error("Interrupted while opening CDP"));
      const timer = setTimeout(() => finish(new Error(`CDP connection timed out after ${timeoutMs}ms`)), timeoutMs);
      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error("Unable to open CDP WebSocket"));
      socket.onclose = () => finish(new Error("CDP WebSocket closed while opening"));
      options.signal?.addEventListener("abort", openingAbort, { once: true });
      if (options.signal?.aborted) openingAbort();
    });
  } catch (error) { close(error); throw error; }

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (!message || typeof message !== "object") throw new Error("Invalid CDP message");
      const pending = requests.get(message.id);
      if (pending) pending.finish(message.error ? new Error(boundedError(JSON.stringify(message.error))) : null, message.result);
      else for (const listener of listeners) listener(message);
    } catch (error) { close(new Error(`Invalid CDP response: ${boundedError(error)}`)); }
  };
  socket.onclose = () => close(new Error("CDP WebSocket closed"));
  socket.onerror = () => close(new Error("CDP WebSocket error"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const call = (method, params = {}, sessionId) => new Promise((resolveCall, rejectCall) => {
    if (closed) { rejectCall(new Error(`CDP client closed before call: ${method}`)); return; }
    const id = ++sequence;
    const finish = (error, value) => {
      if (!requests.delete(id)) return;
      clearTimeout(timer);
      if (error) rejectCall(error); else resolveCall(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`CDP timed out after ${timeoutMs}ms: ${method}`);
      finish(error);
      close(error);
    }, timeoutMs);
    requests.set(id, { finish });
    try {
      if (process.env.CHIMERA_BROWSER_GATE_FORCE_CDP_TIMEOUT !== method) {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }
    } catch (error) { close(error); }
  });
  return { socket, call, close, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

export const LOOPBACK_GUARD_SOURCE = `(() => {
  const attempts = [];
  const allowed = (value) => {
    const url = new URL(String(value instanceof Request ? value.url : value), location.href);
    return (url.protocol === "http:" || url.protocol === "ws:") && url.host === location.host
      && location.protocol === "http:" && location.hostname === "127.0.0.1";
  };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (allowed(input)) return nativeFetch(input, init);
    attempts.push({ kind: "fetch", blocked: true });
    return Promise.reject(new TypeError("Browser gate blocked non-loopback fetch"));
  };
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args) {
      if (allowed(args[0])) return Reflect.construct(Target, args);
      attempts.push({ kind: "websocket", blocked: true });
      throw new DOMException("Browser gate blocked non-loopback WebSocket", "SecurityError");
    },
  });
  Object.defineProperty(globalThis, "__CHIMERA_BROWSER_GATE_NETWORK__", { value: attempts });
})();`;

export async function installLoopbackGuard(cdp, sessionId, fixtureOrigin, options = {}) {
  if (options.fakeMicrophone) {
    const command = await cdp.call("Browser.getBrowserCommandLine");
    if (!command.arguments?.includes("--use-fake-device-for-media-stream")) throw new Error("Fake microphone gate requires an owned Chromium fake-device launch");
  }
  const origin = new URL(fixtureOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) throw new Error("Expected ephemeral loopback fixture origin");
  // Intercept document/subresource requests as well as the page fetch/WebSocket
  // wrappers. Other localhost services are not part of this fixture's authority.
  cdp.onEvent((message) => {
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
    const { requestId, request } = message.params;
    const allowed = new URL(request.url).origin === origin.origin;
    void cdp.call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
      { requestId, ...(allowed ? {} : { errorReason: "BlockedByClient" }) }, sessionId).catch(error => cdp.close(error));
  });
  await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: LOOPBACK_GUARD_SOURCE + `
    // An explicitly opted-in probe may use only the runner's fake audio device.
    // Every other page keeps the media denial; camera access is always denied.
    if (navigator.mediaDevices) {
      const nativeMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (${!!options.fakeMicrophone} && window.__CHIMERA_VOICE_REAL_CAPTURE__ === true && constraints?.audio && !constraints.video) return nativeMedia(constraints);
        throw new Error("Synthetic media fixture required");
      };
    }
  ` }, sessionId);
}

export async function verifyLoopbackGuard(evaluate) {
  return evaluate(`(async () => {
    let fetchBlocked = false;
    let websocketBlocked = false;
    try { await fetch("https://example.invalid/browser-gate"); } catch { fetchBlocked = true; }
    try { new WebSocket("wss://example.invalid/browser-gate"); } catch { websocketBlocked = true; }
    return { fetchBlocked, websocketBlocked, attempts: globalThis.__CHIMERA_BROWSER_GATE_NETWORK__ };
  })()`);
}

export async function runBrowserSuiteCli(suiteId, execute, options = {}) {
  const reporter = createSuiteReporter(suiteId, options);
  const controller = new AbortController();
  const signalSource = options.signalSource ?? process;
  let interruptedBy = null;
  const interrupt = (signal) => {
    interruptedBy ??= signal;
    controller.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  const onMessage = (message) => {
    if (message?.type === "browser-gate-interrupt" && (message.signal === "SIGINT" || message.signal === "SIGTERM")) {
      interrupt(message.signal);
    }
  };
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  signalSource.on?.("message", onMessage);

  try {
    await execute({ reporter, signal: controller.signal });
    if (controller.signal.aborted) throw new Error(`Browser suite interrupted by ${interruptedBy}`);
  } catch (error) {
    reporter.fail(interruptedBy ? "suite.interrupted" : "suite.runtime", error);
  } finally {
    signalSource.removeListener("SIGINT", onSigint);
    signalSource.removeListener("SIGTERM", onSigterm);
    signalSource.removeListener?.("message", onMessage);
  }

  let report;
  try { report = validateSuiteResult(reporter.finish(interruptedBy ? "interrupted" : undefined), suiteId, options.requiredCheckIds); }
  catch (error) { report = failedSuite(suiteId, error); }
  (options.stdout ?? process.stdout).write(`${RESULT_PREFIX}${JSON.stringify(report)}\n`);
  if (interruptedBy === "SIGINT") return 130;
  if (interruptedBy === "SIGTERM") return 143;
  return report.status === "passed" ? 0 : 1;
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  return `${current}${chunk}`.slice(0, MAX_CAPTURE_CHARS);
}

// Leave bounded headroom for the growing required actual-component inventory.
const MAX_CHECKS = 1024;
const validDuration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,159}$/.test(value);
const statuses = new Set(["passed", "failed", "skipped", "interrupted"]);

export function validateSuiteResult(result, suiteId, requiredCheckIds = []) {
  if (!Array.isArray(requiredCheckIds) || requiredCheckIds.length > MAX_CHECKS
    || requiredCheckIds.some(id => !validId(id)) || new Set(requiredCheckIds).size !== requiredCheckIds.length) {
    throw new Error("Invalid or duplicate required check declaration");
  }
  if (!result || result.id !== suiteId || !validId(result.id) || !statuses.has(result.status)
    || !validDuration(result.durationMs) || !Array.isArray(result.checks)
    || result.checks.length === 0 || result.checks.length > MAX_CHECKS) throw new Error("Invalid suite result shape or values");
  const ids = new Set();
  const checks = result.checks.map((check) => {
    if (!check || !validId(check.id) || ids.has(check.id) || !statuses.has(check.status)
      || !validDuration(check.durationMs) || (check.error !== undefined && (typeof check.error !== "string" || check.error.length > MAX_ERROR_CHARS))) {
      throw new Error("Invalid or duplicate suite check");
    }
    ids.add(check.id);
    return { id: check.id, status: check.status, durationMs: check.durationMs,
      ...(check.error === undefined ? {} : { error: boundedError(check.error) }) };
  });
  const missing = requiredCheckIds.some((id) => !ids.has(id));
  if (missing) {
    const existing = checks.findIndex(check => check.id === "runner.required");
    if (existing !== -1) checks.splice(existing, 1);
    if (checks.length >= MAX_CHECKS) checks.pop();
    checks.push({ id: "runner.required", status: "failed", durationMs: 0, error: "Suite omitted required checks" });
  }
  return { id: suiteId, status: result.status === "passed" && checks.some(check => check.status !== "passed") ? "failed" : result.status,
    durationMs: result.durationMs, checks };
}

function failedSuite(suiteId, error) {
  return { id: suiteId, status: "failed", durationMs: 0, checks: [{ id: "runner.result", status: "failed", durationMs: 0, error: boundedError(error) }] };
}

function parseSuiteResult(output, suite) {
  try {
    const lines = output.split(/\r?\n/).filter((value) => value.startsWith(RESULT_PREFIX));
    if (lines.length !== 1) throw new Error("Suite must emit exactly one browser gate result");
    return validateSuiteResult(JSON.parse(lines[0].slice(RESULT_PREFIX.length)), suite.id, suite.requiredCheckIds);
  } catch (error) { return failedSuite(suite.id, error); }
}

async function runSuiteProcess(suite, signalState, options = {}) {
  const child = (options.spawnImpl ?? spawn)(options.nodeExecutable ?? process.execPath, [suite.script], {
    cwd: options.cwd ?? repositoryRoot,
    env: options.environment ?? process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  signalState.child = child;
  const cleanupMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  let stdout = "";
  let stderr = "";
  let outputChars = 0;
  let stop;
  let timer;
  let outcome;
  try {
    outcome = await new Promise((resolveOutcome) => {
      stop = (error) => resolveOutcome({ error });
      child.stdout.on("data", (chunk) => {
        outputChars += chunk.length;
        stdout = appendBounded(stdout, chunk);
        if (outputChars > MAX_CAPTURE_CHARS) stop(new Error("Suite output exceeded limit"));
      });
      child.stderr.on("data", (chunk) => {
        outputChars += chunk.length;
        stderr = appendBounded(stderr, chunk);
        if (outputChars > MAX_CAPTURE_CHARS) stop(new Error("Suite output exceeded limit"));
      });
      child.once("error", stop);
      child.once("close", (code, childSignal) => resolveOutcome({ code, childSignal }));
      signalState.stop = stop;
      timer = setTimeout(() => stop(new Error("Suite deadline exceeded")), options.suiteTimeoutMs ?? suite.timeoutMs ?? 180_000);
      options.onSpawn?.(suite.id, child);
      if (signalState.interruptedBy) stop(new Error(`Suite interrupted by ${signalState.interruptedBy}`));
    });
  } finally {
    clearTimeout(timer);
    signalState.stop = null;
    // First allow the suite's finally blocks to close Vite/CDP/scratch. Then
    // kill its entire owned group, including descendants retaining stdio.
    if (outcome?.error && child.connected) {
      try { child.send({ type: "browser-gate-interrupt", signal: signalState.interruptedBy ?? "SIGTERM" }, () => {}); } catch {}
      const deadline = performance.now() + cleanupMs;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await sleep(20);
    }
    try { await terminateOwnedProcess(child, cleanupMs); }
    catch (error) { outcome = { error: new Error(`Owned suite cleanup failed: ${boundedError(error)}`) }; }
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.connected) child.disconnect();
    signalState.child = null;
  }
  const result = parseSuiteResult(stdout, suite);
  if (outcome.error || outcome.code !== 0) {
    result.status = signalState.interruptedBy ? "interrupted" : "failed";
    // Reserve no unbounded child-provided fields in the final JSON.
    if (result.checks.length >= MAX_CHECKS) result.checks.pop();
    result.checks = result.checks.filter(check => check.id !== "runner.exit");
    result.checks.push({ id: "runner.exit", status: "failed", durationMs: 0,
      error: boundedError(outcome.error ?? (stderr || `Suite exited ${outcome.code ?? outcome.childSignal}`)) });
  }
  return result;
}

export async function runUnifiedBrowserGate(options = {}) {
  const startedAt = performance.now();
  const suites = options.suites ?? [
    // The expanded UI inventory exceeds three minutes even in an isolated run.
    // Keep this suite bounded without extending meeting, action or cleanup deadlines.
    { id: "ui", script: join(scriptDirectory, "test-ui-browser.mjs"), requiredCheckIds: REQUIRED_CHECK_IDS.ui, timeoutMs: 300_000 },
    { id: "meeting", script: join(scriptDirectory, "test-meeting-browser.mjs"), requiredCheckIds: REQUIRED_CHECK_IDS.meeting },
  ];
  const signalSource = options.signalSource ?? process;
  const signalState = { child: null, interruptedBy: null };

  const interrupt = (signal) => {
    signalState.interruptedBy ??= signal;
    signalState.stop?.(new Error(`Suite interrupted by ${signal}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  const results = [];

  try {
    for (const suite of suites) {
      if (signalState.interruptedBy) break;
      const result = await runSuiteProcess(suite, signalState, options);
      results.push(result);
      (options.stderr ?? process.stderr).write(`${result.status === "passed" ? "PASS" : "FAIL"} ${suite.id} browser suite (${result.checks.length} checks, ${result.durationMs}ms)\n`);
    }
  } finally {
    signalSource.removeListener("SIGINT", onSigint);
    signalSource.removeListener("SIGTERM", onSigterm);
  }

  const status = signalState.interruptedBy
    ? "interrupted"
    : results.length === suites.length && results.every((suite) => suite.status === "passed" && suite.checks.every((check) => check.status === "passed"))
      ? "passed"
      : "failed";
  const report = { schemaVersion: 1, status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), suites: results };
  (options.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
  if (signalState.interruptedBy === "SIGINT") return { exitCode: 130, report };
  if (signalState.interruptedBy === "SIGTERM") return { exitCode: 143, report };
  return { exitCode: status === "passed" ? 0 : 1, report };
}

export async function removeScratchDirectory(path) {
  // Vite's dependency scanner can finish a queued cache write just after
  // server.close(); repeat removal across two turns of the event loop so a
  // late write cannot recreate a supposedly-clean profile/cache root.
  for (const delayMs of [0, 25, 75, 400]) {
    if (delayMs) await sleep(delayMs);
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { exitCode } = await runUnifiedBrowserGate();
  process.exitCode = exitCode;
}
