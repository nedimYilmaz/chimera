import { lazy, Suspense, useEffect } from "react";
import { isOnboardingGated, type UiState } from "@chimera/ui-state";
import { TopBar } from "./components/TopBar";
import { NativeVoiceDock } from "./components/NativeVoiceDock";
import { MeetingRoomsProvider, MeetingRoomsBand, useMeetingRooms } from "./components/MeetingRooms";
import { DisconnectedBanner } from "./components/DisconnectedBanner";
import { PinnedBar } from "./components/PinnedBar";
import { Toast } from "./components/Toast";
import { Footer } from "./components/Footer";
import { AgentsScreen } from "./screens/AgentsScreen";
import { WorkflowStudio } from "./components/WorkflowStudio";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { useConnState } from "./rpc/useConnState";
import { rpcCall, onDaemonEvent, setDockBadge } from "./rpc/bridge";
import { appStore } from "./state/store";
import { useStore } from "./state/useStore";
import { registerActionHandler, useHotkeys } from "./keymap";
import { systemCommands } from "./state/commands.system";
import { getHostCommands } from "./state/commands.host";
import { getNotifyBridge } from "./state/commands.notify";
import { pendingBadgeCount } from "./state/selectors.notify";
import { applyWorkspaceDisplay, workspaceTools } from "./state/workspaceTools";
import { applyAppearance, subscribeAppearance } from "./state/appearance";
import { installTerminalInputListener } from "./state/terminalSessions";

// BUNDLE-STARTUP-COST: one tab is visible at a time, but every screen used to be a static import,
// so opening the app parsed all thirteen of them — the single largest slice of the entry chunk.
// Each tab is now its own chunk, fetched the first time you actually go there.
//
// AgentsScreen and WelcomeScreen stay EAGER on purpose: they are the startup route, and deferring
// them would trade a cost you pay once, later, for a blank frame on every cold start.
const ProjectsScreen = lazy(() => import("./screens/ProjectsScreen").then((m) => ({ default: m.ProjectsScreen })));
const TeamsScreen = lazy(() => import("./screens/TeamsScreen").then((m) => ({ default: m.TeamsScreen })));
const RolesScreen = lazy(() => import("./screens/RolesScreen").then((m) => ({ default: m.RolesScreen })));
const QueuesScreen = lazy(() => import("./screens/QueuesScreen").then((m) => ({ default: m.QueuesScreen })));
const EventsScreen = lazy(() => import("./screens/EventsScreen").then((m) => ({ default: m.EventsScreen })));
const InboxScreen = lazy(() => import("./screens/InboxScreen").then((m) => ({ default: m.InboxScreen })));
const SloScreen = lazy(() => import("./screens/SloScreen").then((m) => ({ default: m.SloScreen })));
const HistoryScreen = lazy(() => import("./screens/HistoryScreen").then((m) => ({ default: m.HistoryScreen })));
const MemoryScreen = lazy(() => import("./screens/MemoryScreen").then((m) => ({ default: m.MemoryScreen })));
const SettingsScreen = lazy(() => import("./screens/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const HelpScreen = lazy(() => import("./screens/HelpScreen").then((m) => ({ default: m.HelpScreen })));
const ReviewRoomScreen = lazy(() => import("./screens/ReviewRoomScreen").then((m) => ({ default: m.ReviewRoomScreen })));

import { requestOsNotifyPermission } from "./state/notifyOs";
import { getCoordCommands } from "./state/commands.coord";
import { getSloCommands } from "./state/commands.slo";
import { formatMetricValue, metricLabel } from "./state/selectors.slo";
import { resolveWorkflowNavigation } from "./state/commands.workflows";
import { installAppOverlayLifecycle } from "./state/overlayLifecycle";
import { errorText } from "./state/errorText";
import styles from "./App.module.css";

// W5: the tab switch renders the real coordination screens; each screen
// registers its own keymap handlers while mounted, so this stays a switch.
// W6 adds the system chrome: the PinnedBar strip (mock showPinned — under the
// top bar), the Toast stack (bottom-right absolute), the HelpScreen route
// (helpOpen replaces the content area, mock s_help) and the WelcomeScreen
// route (agents tab + empty agentOrder, mock s_welcome), plus the
// system-surface wiring below.

/** W6 system surfaces: the always-mounted owner registers the system action
 * handlers (cards toggle app-wide state, so no screen can own them) and
 * starts the 5s daemon.status poll (spend chip + cooling + peers + PerfHud
 * rtt). KEYMAP-REDESIGN: perf hud/pin agent/replay moved off
 * mod+shift+letter onto plain mod+letter (none of the three is a DESTROY
 * action — rule 4) and now resolve through the SAME registerActionHandler
 * path as every other row below, so the dedicated ctrl+shift capture-phase
 * listener this hook used to install is gone. */
export function useSystemSurfaces(): void {
  useEffect(() => {
    const sys = systemCommands(appStore, rpcCall);
    const offs = [
      registerActionHandler("system.accounts", () => sys.toggleAccounts()),
      registerActionHandler("system.result", () => sys.toggleResult()),
      registerActionHandler("system.model", () => sys.toggleModel()),
      registerActionHandler("system.effort", () => sys.toggleEffort()),
      registerActionHandler("system.accountSwitch", () => sys.toggleAccount()),
      registerActionHandler("system.remoteControl", () => sys.toggleRemoteControl()),
      // COMPACTION-OBSERVABILITY: unlike remoteControl (enable/disable + optional name needs a
      // card), compact takes no params beyond the agent — fires straight off the header button,
      // no overlay. Acts on whichever agent is currently selected, same target every other
      // header chip (model/effort/account) resolves against.
      registerActionHandler("system.compact", () => {
        const agentId = appStore.getState().selectedAgentId;
        if (agentId) void sys.applyCompact(agentId);
      }),
      registerActionHandler("system.palette", () =>
        appStore.dispatch({ type: "paletteOpen", open: !appStore.getState().paletteOpen })),
      registerActionHandler("system.mcpPalette", () =>
        appStore.dispatch({ type: "mcpPaletteOpen", open: !appStore.getState().mcpPaletteOpen })),
      registerActionHandler("system.perfHud", () => sys.togglePerfHud()),
      registerActionHandler("system.pinSelected", () => sys.togglePinSelected()),
      registerActionHandler("system.replay", () => sys.toggleReplay()),
    ];
    const stopPolling = sys.startPolling();
    // W10 · F10: federation liveness. daemon.status carries state.peers only on
    // the 5s poll / on-connect; a pairing that lands BETWEEN polls would leave
    // the SpawnCard engine list and the ⇅ remote host-tools rows stale until the
    // next tick. peer_paired/network_changed refetch both eagerly: refreshStatus
    // re-pulls state.peers (SpawnCard engine cycle), refreshPeers re-pulls the
    // peer.status host-tools carriage (HostToolsCard ⇅ rows). The pairing UI's
    // OWN peers table refreshes through its own onDaemonEvent hook.
    const host = getHostCommands(appStore, rpcCall);
    const offFed = onDaemonEvent((e) => {
      if (e.kind === "peer_paired" || e.kind === "network_changed") {
        void sys.refreshStatus();
        void host.refreshPeers();
      }
    });
    return () => {
      for (const off of offs) off();
      stopPolling();
      offFed();
    };
  }, []);
}

/** W20 (F18 notifications): always-mounted, tab-independent — a pending
 * permission fired while the user sits on Queues must still show up. Routes a
 * delivered `notify`/`notify_error` event to a toast or an OS notification
 * (whose click applies the event's deep-link — commands.notify.ts), and keeps
 * the dock badge (pending permissions + questions) in sync with every store
 * change. */
function useNotifySurfaces(): void {
  useEffect(() => {
    requestOsNotifyPermission();
    const bridge = getNotifyBridge(appStore, rpcCall);
    const offEvent = onDaemonEvent((e) => {
      if (e.kind === "notify" || e.kind === "notify_error") {
        bridge.onDaemonEvent(e.kind, e.data as Record<string, unknown> | undefined);
      }
    });
    let lastBadge = -1;
    const syncBadge = (): void => {
      const n = pendingBadgeCount(appStore.getState());
      if (n !== lastBadge) { lastBadge = n; void setDockBadge(n); }
    };
    syncBadge();
    const offStore = appStore.subscribe(syncBadge);
    return () => { offEvent(); offStore(); };
  }, []);
}

function useSloSurfaces(): void {
  useEffect(() => {
    const commands = getSloCommands(rpcCall);
    commands.setBreachNotifier((breach) => appStore.dispatch({ type: "notice", message: `SLO breach: ${metricLabel(breach.threshold.metric)} ${formatMetricValue(breach.threshold.metric, breach.observed)} > ${formatMetricValue(breach.threshold.metric, breach.threshold.limit)}` }));
    commands.start();
    const watched = new Set(["turn_complete", "result", "error", "task_step_advanced", "task_step_failed", "budget_warning"]);
    const off = onDaemonEvent((e) => { if (watched.has(e.kind)) commands.requestRefresh(); });
    return () => { off(); commands.stop(); };
  }, []);
}

function useOverlayLifecycle(): void {
  useEffect(() => installAppOverlayLifecycle(appStore), []);
}

/** Finish reducer-owned deep links that require daemon data. The request id is
 * checked before every commit/consume so a slow task lookup cannot overwrite a
 * newer navigation. Pure tab/agent links need no RPC and are consumed here too. */
function useNavigationSurfaces(): void {
  const navigation = useStore((s: UiState) => s.navigation);
  useEffect(() => {
    const target = navigation.target;
    if (!target) return;
    const requestId = navigation.requestId;
    const current = (): boolean => appStore.getState().navigation.requestId === requestId;
    const consume = (): void => { if (current()) appStore.dispatch({ type: "navigationConsumed", requestId }); };
    const coord = getCoordCommands(appStore, rpcCall);
    const run = async (): Promise<void> => {
      if (target.kind === "team") await coord.openTeamDetail(target.name);
      else if (target.kind === "queue") {
        const detail = await coord.queueStatus(target.name);
        if (current()) appStore.dispatch({ type: "queueDetail", detail });
      } else if (target.kind === "task") {
        let queue = target.queue ?? appStore.getState().tasks[target.taskId]?.queue;
        if (!queue) {
          const queues = await rpcCall<Array<Record<string, unknown>>>("queue.list", {});
          for (const row of queues) {
            const name = typeof row["name"] === "string" ? row["name"] : null;
            if (!name) continue;
            const detail = await coord.queueStatus(name);
            if (detail.tasks.some((task) => task["taskId"] === target.taskId)) { queue = name; break; }
          }
        }
        if (!queue) throw new Error(`task not found: ${target.taskId}`);
        const detail = await coord.queueStatus(queue);
        if (current()) {
          appStore.dispatch({ type: "queueDetail", detail });
          const index = detail.tasks.findIndex((task) => task["taskId"] === target.taskId);
          if (index > 0) appStore.dispatch({ type: "taskCursor", delta: index });
        }
      } else if (target.kind === "mcpTool") {
        appStore.dispatch({ type: "mcpPaletteOpen", open: true });
      } else if (target.kind === "workflow") {
        const result = await resolveWorkflowNavigation(rpcCall, target);
        if (current()) appStore.dispatch({ type: "workflowStudioOpen", mode: "inspect", document: result.document, queue: null, taskId: null, version: result.version, failedOnly: result.failedOnly });
      }
      consume();
    };
    void run().catch((error) => {
      if (!current()) return;
      appStore.dispatch({ type: "commandError", message: errorText(error) });
      consume();
    });
  }, [navigation]);
}

export function App() { return <MeetingRoomsProvider><AppContent /></MeetingRoomsProvider>; }

function AppContent() {
  const meetings = useMeetingRooms();
  const conn = useConnState();
  const activeTab = useStore((s: UiState) => s.activeTab);
  const helpOpen = useStore((s: UiState) => s.helpOpen);
  const agentCount = useStore((s: UiState) => s.agentOrder.length);
  const reviewOpen = useStore((s: UiState) => s.reviewRoom.openTaskId !== null);
  // ONBOARDING-GATE R2: zero CONFIRMED accounts — no other screen is
  // reachable (TopBar/keymap already lock the tab bar/chords/palette to
  // "agents"; this is the render-level backstop so even a stray activeTab
  // change can never surface anything but the onboarding welcome screen).
  const gated = useStore((s: UiState) => isOnboardingGated(s));
  useHotkeys(appStore);
  useSystemSurfaces();
  useNotifySurfaces();
  useOverlayLifecycle();
  // HUMAN-TURN-COLOR: push the operator's choice onto <html> as a CSS custom property. Done here
  // rather than in the transcript so changing it repaints every turn already on screen without
  // re-rendering anything — and so the value exists before the first paint.
  useEffect(() => {
    applyAppearance();
    return subscribeAppearance(applyAppearance);
  }, []);
  // TERMINAL-WRITE: the app owns the PTYs, so it is the end that performs an agent's terminal
  // write. Installed once here rather than per view — a write must land whether or not the
  // terminal's tab happens to be mounted.
  useEffect(() => installTerminalInputListener(onDaemonEvent as never), []);
  useEffect(() => { applyWorkspaceDisplay(); return workspaceTools.subscribe(applyWorkspaceDisplay); }, []);
  useNavigationSurfaces();
  useSloSurfaces();
  return (
    <div className={styles.app}>
      <TopBar />
      <NativeVoiceDock />
      {!gated && <MeetingRoomsBand />}
      {conn === "disconnected" && <DisconnectedBanner />}
      <PinnedBar />
      <main className={styles.content}>
        {/* fallback={null} rather than a spinner: these chunks come off local disk in a webview,
            so a visible "loading" would flash for longer than the load it announces. */}
        <Suspense fallback={null}>
        {gated ? <WelcomeScreen />
          : reviewOpen ? <ReviewRoomScreen />
          : helpOpen ? <HelpScreen />
          : activeTab === "agents" ? (agentCount === 0 && !meetings?.open ? <WelcomeScreen /> : <AgentsScreen />)
          : activeTab === "projects" ? <ProjectsScreen />
          : activeTab === "teams" ? <TeamsScreen />
          : activeTab === "queues" ? <QueuesScreen />
          : activeTab === "events" ? <EventsScreen />
          : activeTab === "settings" ? <SettingsScreen />
          : activeTab === "inbox" ? <InboxScreen />
          : activeTab === "slo" ? <SloScreen />
          : activeTab === "roles" ? <RolesScreen />
          : activeTab === "runs" ? <HistoryScreen />
          : <MemoryScreen />}
        </Suspense>
      </main>
      <WorkflowStudio />
      <Footer />
      <Toast />
    </div>
  );
}
