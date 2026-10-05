import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type ChimeraApi } from "@chimera/ui-state";
import { dismissRegisteredOverlays, registerOverlay } from "../src/components/OverlayOutlet";
import { artifactsLocal } from "../src/state/commands.artifacts";
import { composerLocal } from "../src/state/commands.agents";
import { jobsLocal } from "../src/state/commands.jobs";
import { projectsLocal } from "../src/state/commands.projects";
import { getSettingsCommands } from "../src/state/commands.settings";
import { systemLocal } from "../src/state/commands.system";
import { workflowsLocal } from "../src/state/commands.workflows";
import {
  dismissAppLocalOverlays,
  installAppOverlayLifecycle,
  reducerOverlayId,
} from "../src/state/overlayLifecycle";

const api = {
  request: async () => [],
  call: async () => ({}),
  subscribe: async () => () => {},
} as unknown as ChimeraApi;

function resetLocals(): void {
  composerLocal.reset();
  projectsLocal.reset();
  systemLocal.reset();
  jobsLocal.set({ items: [], cursor: 0, focused: false, formOpen: false, confirmDelete: null });
  workflowsLocal.set({ items: [], cardOpen: false, formOpen: false, editing: null });
  artifactsLocal.set({ previewId: null });
}

afterEach(resetLocals);

describe("app overlay lifecycle", () => {
  it("dismisses module-local popups while preserving drafts, cursors, and persistent HUD state", () => {
    composerLocal.set({
      composeText: "/help",
      targetMenuOpen: true,
      spawnOpen: true,
      slashDismissed: false,
      agentDetail: { agentId: "agent-1" },
      permissionRaw: true,
    });
    systemLocal.set({ modelOpen: true, effortOpen: true, remoteControlOpen: true, perfHudOpen: true });
    projectsLocal.set({
      cursor: 4,
      formOpen: true,
      assignOpen: true,
      confirmArchive: "project-1",
      a2aHistoryOpen: true,
      pluginsOpen: true,
    });
    jobsLocal.set({ cursor: 3, focused: true, formOpen: true, confirmDelete: "nightly" });
    workflowsLocal.set({ cardOpen: true, formOpen: true, editing: "release" });
    artifactsLocal.set({ previewId: "artifact-1" });

    dismissAppLocalOverlays();

    expect(composerLocal.getState()).toMatchObject({
      composeText: "/help",
      targetMenuOpen: false,
      spawnOpen: false,
      slashDismissed: true,
      slashIndex: 0,
      agentDetail: null,
      permissionRaw: false,
    });
    expect(systemLocal.getState()).toMatchObject({
      modelOpen: false,
      effortOpen: false,
      remoteControlOpen: false,
      perfHudOpen: true,
    });
    expect(projectsLocal.getState()).toMatchObject({
      cursor: 4,
      formOpen: false,
      assignOpen: false,
      confirmArchive: null,
      a2aHistoryOpen: false,
      pluginsOpen: false,
    });
    expect(jobsLocal.getState()).toMatchObject({ cursor: 3, focused: true, formOpen: false, confirmDelete: null });
    expect(workflowsLocal.getState()).toMatchObject({ cardOpen: false, formOpen: false, editing: null });
    expect(artifactsLocal.getState().previewId).toBeNull();
  });

  it("closes a local form when the palette opens and closes the slash popup on a tab change", () => {
    const store = createStore(api);
    const dispose = installAppOverlayLifecycle(store);

    composerLocal.set({ spawnOpen: true });
    store.dispatch({ type: "paletteOpen", open: true });
    expect(store.getState().paletteOpen).toBe(true);
    expect(composerLocal.getState().spawnOpen).toBe(false);

    composerLocal.set({ composeText: "/agents", slashDismissed: false });
    store.dispatch({ type: "selectTab", tab: "teams" });
    expect(store.getState().paletteOpen).toBe(false);
    expect(composerLocal.getState()).toMatchObject({ composeText: "/agents", slashDismissed: true });

    dispose();
  });

  it("identifies reducer-owned form and popup variants", () => {
    const store = createStore(api);
    expect(reducerOverlayId(store.getState())).toBeNull();
    store.dispatch({ type: "setMode", mode: "spawn" });
    expect(reducerOverlayId(store.getState())).toBe("mode:spawn");
    store.dispatch({ type: "paletteOpen", open: true });
    expect(reducerOverlayId(store.getState())).toBe("palette");
  });

  it("runs data-preserving dismiss hooks registered by always-mounted overlay cards", () => {
    const dismiss = vi.fn();
    const unregister = registerOverlay("test.overlay-lifecycle", () => null, dismiss);
    dismissRegisteredOverlays();
    expect(dismiss).toHaveBeenCalledOnce();
    unregister();
  });

  it("does not repeatedly dismiss an open overlay while its own state updates", () => {
    const store = createStore(api);
    const dismiss = vi.fn();
    const unregister = registerOverlay("test.overlay-update", () => null, dismiss);
    const dispose = installAppOverlayLifecycle(store);

    store.dispatch({ type: "paletteOpen", open: true });
    expect(dismiss).toHaveBeenCalledTimes(1);

    store.dispatch({ type: "paletteQuery", query: "spawn" });
    expect(dismiss).toHaveBeenCalledTimes(1);

    store.dispatch({ type: "paletteOpen", open: false });
    expect(dismiss).toHaveBeenCalledTimes(1);

    dispose();
    unregister();
  });

  it("dismisses an open Settings card when the section rail changes without a tab change", () => {
    const store = createStore(api);
    const settings = getSettingsCommands(store, async () => ({}));
    const dismiss = vi.fn();
    const unregister = registerOverlay("test.settings-card", () => null, dismiss);
    const dispose = installAppOverlayLifecycle(store);

    settings.setSection("tools"); // e.g. host tools auto-discovery card opens here
    expect(dismiss).toHaveBeenCalledTimes(1);

    settings.setSection("notify"); // moving on: notifications card should close the previous one
    expect(dismiss).toHaveBeenCalledTimes(2);

    settings.setSection("hooks"); // and lifecycle hooks should close notifications, not stack on top
    expect(dismiss).toHaveBeenCalledTimes(3);

    dispose();
    unregister();
  });

  it("does not re-dismiss while the settings section is unchanged (other settings state updates)", () => {
    const store = createStore(api);
    const settings = getSettingsCommands(store, async () => ({}));
    const dismiss = vi.fn();
    const unregister = registerOverlay("test.settings-card-stable", () => null, dismiss);
    const dispose = installAppOverlayLifecycle(store);

    settings.setSection("tools");
    expect(dismiss).toHaveBeenCalledTimes(1);

    void settings.loadGeneral(); // an unrelated settings data refresh, same section
    expect(dismiss).toHaveBeenCalledTimes(1);

    dispose();
    unregister();
  });

  it("still allows a reducer overlay closing to null to reveal a local form without dismissing it (carve-out)", () => {
    const store = createStore(api);
    getSettingsCommands(store, async () => ({}));
    const dispose = installAppOverlayLifecycle(store);

    store.dispatch({ type: "paletteOpen", open: true });
    composerLocal.set({ spawnOpen: false });
    store.dispatch({ type: "paletteOpen", open: false });
    // The palette's own close handler may open a local form (e.g. Spawn) in
    // the same turn; the lifecycle must not immediately dismiss it again.
    composerLocal.set({ spawnOpen: true });
    expect(composerLocal.getState().spawnOpen).toBe(true);

    dispose();
  });
});
it("secondary context sharing dismisses other overlays while preserving its inline inspector and draft", () => {
  composerLocal.set({ agentDetail: { agentId: "a" }, composeText: "draft", spawnOpen: true, targetMenuOpen: true, toolDetail: { agentId: "a", toolId: "t" } as never });
  dismissAppLocalOverlays({ preserveAgentDetail: true });
  expect(composerLocal.getState()).toMatchObject({ agentDetail: { agentId: "a" }, composeText: "draft", spawnOpen: false, targetMenuOpen: false, toolDetail: null });
  dismissAppLocalOverlays(); expect(composerLocal.getState().agentDetail).toBeNull();
});
