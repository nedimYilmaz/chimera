// Marketing screenshot entry (scripts/marketing-preview.mjs). Mounts the REAL TopBar / screens /
// Footer on the real app store, fed only by the synthetic "Atlas website" data in marketing-data.ts
// through the mocked RPC bridge. Nothing here reaches a daemon, provider, account or the network.
import "./marketing-boot";
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Footer } from "../../src/components/Footer";
import { TopBar } from "../../src/components/TopBar";
import "../../src/components/PathViewerCard";
import { AgentsScreen } from "../../src/screens/AgentsScreen";
import { MemoryScreen } from "../../src/screens/MemoryScreen";
import { QueuesScreen } from "../../src/screens/QueuesScreen";
import { ProjectsScreen } from "../../src/screens/ProjectsScreen";
import { RolesScreen } from "../../src/screens/RolesScreen";
import { SettingsScreen } from "../../src/screens/SettingsScreen";
import { TeamsScreen } from "../../src/screens/TeamsScreen";
import { rpcCall } from "../../src/rpc/bridge";
import { getSettingsCommands } from "../../src/state/commands.settings";
import { appStore } from "../../src/state/store";
import "../../src/styles/tokens.css";
import "../../src/styles/fonts.css";
import "../../src/styles/base.css";
import { agentRecords, daemonStatus, ids, queues, roles, teams } from "./marketing-data";
import { computerState, featureState } from "./marketing-features";

type View = "workspace" | "queue" | "memory" | "mcp-store" | "secrets" | "schedules" | "teams" | "projects" | "roles" | "computer-use";

// computer-use is the ordinary agent workspace with the lease-owning builder selected: its monitor is
// the real ComputerUseMonitor, fed a synthetic Atlas pricing target by marketing-features.ts.
const screens = { workspace: AgentsScreen, queue: QueuesScreen, memory: MemoryScreen, "mcp-store": SettingsScreen, secrets: SettingsScreen, schedules: QueuesScreen, teams: TeamsScreen, projects: ProjectsScreen, roles: RolesScreen, "computer-use": AgentsScreen } as const;
const tabs = { workspace: "agents", queue: "queues", memory: "memory", "mcp-store": "settings", secrets: "settings", schedules: "queues", teams: "teams", projects: "projects", roles: "roles", "computer-use": "agents" } as const;
// Settings is one screen with a rail; these views differ only by which section is open.
const settingsSections = { "mcp-store": "mcp", secrets: "secrets" } as const;
const isView = (name: string | null): name is View => name !== null && Object.hasOwn(screens, name);

// The real bridge reports "connected" on attach; this fixture's bridge is a stub, so say it here or
// the TopBar renders its "disconnected" state in every screenshot.
appStore.dispatch({ type: "connected", connected: true });
appStore.dispatch({ type: "daemonStatus", status: daemonStatus as never });
appStore.dispatch({ type: "agentRecords", records: agentRecords as never });
appStore.dispatch({ type: "teams", available: true, items: teams });
appStore.dispatch({ type: "queues", available: true, items: queues });
appStore.dispatch({ type: "roles", available: true, items: roles });

function Stage({ children }: { children: React.ReactNode }) {
  return <div style={{ width: "100vw", height: "100vh", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</div>;
}

function MarketingView({ view }: { view: View }) {
  // The capture script waits for this marker instead of sleeping: two frames after mount, so the
  // screen's own effects (RPC loads, layout) have had a chance to commit.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { document.body.dataset.marketingReady = view; }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [view]);
  const Screen = screens[view];
  return <Stage><TopBar /><main data-screen-probe={view} style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}><Screen /></main><Footer /></Stage>;
}

let root: Root | null = null;

// Team / role provenance ("from .claude", role-usage counts) lives on the agent records. Only the
// teams and roles views show it; every other view gets the plain base records back, because the
// reducer keeps `sessionRole` across re-dispatches unless it is reset explicitly.
function seedStore(view: View): void {
  const richRoles = view === "teams" || view === "roles";
  const records = agentRecords.map((r) => richRoles
    ? { ...r, membership: r.agentId === ids.conductor ? { team: "atlas" } : { team: "atlas", role: r.spec.role }, sessionRole: r.spec.role }
    : { ...r, sessionRole: null });
  appStore.dispatch({ type: "agentRecords", records: records as never });
  appStore.dispatch({ type: "teams", available: true, items: teams });
  appStore.dispatch({ type: "roles", available: true, items: roles });
  appStore.dispatch({ type: "mainConductorId", agentId: richRoles ? ids.conductor : null } as never);
}

function show(view: View): void {
  delete document.body.dataset.marketingReady;
  // The feature layer reads these on every RPC: richer answers and the demo desktop lease belong to one view each.
  featureState.view = view;
  computerState.running = view === "computer-use";
  seedStore(view);
  appStore.dispatch({ type: "selectTab", tab: tabs[view] as never });
  if (view === "workspace") appStore.dispatch({ type: "selectAgent", agentId: ids.conductor });
  if (view === "computer-use") appStore.dispatch({ type: "selectAgent", agentId: ids.pricing });
  if (view in settingsSections) getSettingsCommands(appStore, rpcCall).setSection(settingsSections[view as keyof typeof settingsSections]);
  root?.unmount();
  const host = document.getElementById("root")!;
  host.replaceChildren();
  root = createRoot(host);
  root.render(<MarketingView view={view} />);
}

// Deep link for a browser review: ?view=queue&select=atlas-release,6b83d0e4, ?view=memory&select=m-0007 or ?view=schedules&select=atlas-a11y-sweep. Never select the row that is
// already active: that toggles its detail pane closed.
// Each id is clicked through the DOM once its row exists, so queue/inspector/detail panes render as
// they do for a user.
function selectRows(ids: string[]): void {
  const [id, ...rest] = ids;
  if (!id) return;
  const deadline = performance.now() + 10_000;
  const tick = () => {
    const row = document.querySelector<HTMLElement>(`[data-queue-row="${id}"],[data-task-row="${id}"],[data-memory-row="${id}"],[data-job-row="${id}"]`);
    if (row) { row.click(); selectRows(rest); }
    else if (performance.now() < deadline) setTimeout(tick, 60);
  };
  tick();
}

(window as unknown as { __MARKETING__: { show(view: View): void } }).__MARKETING__ = { show };
const params = new URLSearchParams(location.search);
const initial = params.get("view");
show(isView(initial) ? initial : "workspace");
selectRows((params.get("select") ?? "").split(",").filter(Boolean));
