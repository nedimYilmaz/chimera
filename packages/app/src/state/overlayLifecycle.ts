import type { UiState, UiStore } from "@chimera/ui-state";
import { dismissRegisteredOverlays } from "../components/OverlayOutlet";
import { artifactsLocal } from "./commands.artifacts";
import { composerLocal } from "./commands.agents";
import { jobsLocal } from "./commands.jobs";
import { projectsLocal } from "./commands.projects";
import { peekSettingsCommands } from "./commands.settings";
import { systemLocal } from "./commands.system";
import { workflowsLocal } from "./commands.workflows";

/** A stable identifier for whichever reducer-owned transient surface is open.
 * Mutual exclusion makes this singular even though legacy state can contain
 * several flags while a pre-fix snapshot is being folded. */
export function reducerOverlayId(state: UiState): string | null {
  if (state.reviewRoom.openTaskId !== null) return "reviewRoom";
  if (state.workflowStudio.open) return "workflowStudio";
  if (state.versionsOpen) return "versions";
  if (state.accountsOpen) return "accounts";
  if (state.helpOpen) return "help";
  if (state.a2aHistoryOpen) return "a2aHistory";
  if (state.paletteOpen) return "palette";
  if (state.mcpPaletteOpen) return "mcpPalette";
  if (state.resultOpen) return "result";
  if (state.confirm !== null) return "confirm";
  if (state.mode !== "normal") return `mode:${state.mode}`;
  return null;
}

/** Dismiss module-local popups while preserving composer drafts, attachments,
 * fetched lists, cursors, expanded navigation, replay state, and PerfHud. */
export function dismissAppLocalOverlays(options: { preserveAgentDetail?: boolean } = {}): void {
  const composer = composerLocal.getState();
  if (
    composer.targetMenuOpen ||
    composer.spawnOpen ||
    composer.toolDetail !== null ||
    composer.agentDetail !== null ||
    composer.permissionRaw ||
    (composer.composeText.startsWith("/") && !composer.slashDismissed)
  ) {
    composerLocal.set({
      targetMenuOpen: false,
      spawnOpen: false,
      slashDismissed: true,
      slashIndex: 0,
      toolDetail: null,
      agentDetail: options.preserveAgentDetail ? composer.agentDetail : null,
      permissionRaw: false,
    });
  }

  const system = systemLocal.getState();
  if (system.modelOpen || system.effortOpen || system.accountOpen || system.remoteControlOpen) {
    systemLocal.set({ modelOpen: false, effortOpen: false, accountOpen: false, remoteControlOpen: false });
  }

  const projects = projectsLocal.getState();
  if (
    projects.formOpen ||
    projects.assignOpen ||
    projects.confirmArchive !== null ||
    projects.confirmDelete !== null ||
    projects.a2aHistoryOpen ||
    projects.pluginsOpen
  ) {
    projectsLocal.set({
      formOpen: false,
      assignOpen: false,
      confirmArchive: null,
      confirmDelete: null,
      confirmDeleteFiles: false,
      deleteError: null,
      a2aHistoryOpen: false,
      pluginsOpen: false,
      pluginDetail: false,
    });
  }

  const jobs = jobsLocal.getState();
  if (jobs.formOpen || jobs.confirmDelete !== null) {
    jobsLocal.set({ formOpen: false, confirmDelete: null });
  }

  const workflows = workflowsLocal.getState();
  if (workflows.cardOpen || workflows.formOpen) {
    workflowsLocal.set({ cardOpen: false, formOpen: false, editing: null });
  }

  if (artifactsLocal.getState().previewId !== null) artifactsLocal.set({ previewId: null });

  // Host tools, notifications, hooks, usage, and checkpoint cards own private
  // command stores. Their registrations provide a data-preserving dismiss hook.
  dismissRegisteredOverlays();
}

/** Bind the reducer, the Settings screen's own section rail, and the
 * module-local overlay world: a tab change or a Settings section change
 * always dismisses locals (both are "navigated to a different surface" the
 * same way — Settings' section rail is intra-tab navigation, not a reducer
 * overlay), and opening a reducer-owned overlay (notably the command
 * palette) dismisses an already-open local form in the same synchronous turn. */
export function installAppOverlayLifecycle(store: UiStore): () => void {
  let previousTab = store.getState().activeTab;
  let previousOverlay = reducerOverlayId(store.getState());
  let previousSection = peekSettingsCommands()?.getState().section ?? null;

  const check = (): void => {
    const state = store.getState();
    const tabChanged = state.activeTab !== previousTab;
    const overlay = reducerOverlayId(state);
    const overlayChanged = overlay !== previousOverlay;
    const section = peekSettingsCommands()?.getState().section ?? null;
    const sectionChanged = section !== previousSection;
    previousTab = state.activeTab;
    previousOverlay = overlay;
    previousSection = section;
    // A close-to-null may intentionally reveal a local form opened by the
    // overlay's command (for example palette → Spawn). The overlay component
    // resets its own local fields on close, so only a tab/section change or a
    // newly opened reducer surface should dismiss the other local surfaces.
    if (tabChanged || sectionChanged || (overlay !== null && overlayChanged)) dismissAppLocalOverlays();
  };

  const unsubStore = store.subscribe(check);
  const unsubSettings = peekSettingsCommands()?.subscribe(check) ?? null;
  return () => {
    unsubStore();
    unsubSettings?.();
  };
}
