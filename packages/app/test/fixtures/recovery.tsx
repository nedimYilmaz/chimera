import { useMemo } from "react";
import { lazyScreen } from "../../src/components/lazyScreen";
import { Liveboard } from "../../src/components/Liveboard";
import { TopBar } from "../../src/components/TopBar";
import { Footer } from "../../src/components/Footer";
import { Composer } from "../../src/components/Composer";
import { AgentsScreen } from "../../src/screens/AgentsScreen";
import { appStore } from "../../src/state/store";
import { useStore } from "../../src/state/useStore";
import { composerLocal } from "../../src/state/commands.agents";

let active = false, attempts = 0;
let release: (() => void) | null = null;
const pending: { resolve(value: unknown[]): void; reject(error: Error): void }[] = [];
export function resetRecovery(name: string) {
  active = name === "qa-liveboard"; attempts = 0; release = null; pending.length = 0;
  if (name !== "qa-recovery" && !active) return;
  appStore.dispatch({ type: "connected", connected: true });
  appStore.dispatch({ type: "selectTab", tab: "agents" });
  appStore.dispatch({ type: "selectAgent", agentId: "ui-qa-agent" });
  composerLocal.set({ draftOwner: "ui-qa-agent", target: "selected", composeText: "QA unsent recovery draft", agentDetail: null, spawnOpen: false });
  if (active) {
    for (const lane of appStore.getState().liveboardLanes) appStore.dispatch({ type: "liveboardLaneRemove", agentId: lane.agentId });
    appStore.dispatch({ type: "agentRecords", records: [{ agentId: "qa-recovery-lane", displayLabel: "Recovery lane", state: "done", accountName: "synthetic", provider: "codex", costUsd: 0, createdAt: 1 }] });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "qa-recovery-lane" });
  }
}
export function recoveryRpc(method: string, params: Record<string, unknown>) {
  if (active && method === "agent.tail" && params.agentId === "qa-recovery-lane") return { value: new Promise<unknown[]>((resolve, reject) => pending.push({ resolve, reject })) };
  return null;
}
declare global { interface Window { __QA_RECOVERY__: { pending(): number; settle(index: number, text?: string): void; cycle(): void; attempts(): number; release(): void; select(tab: "agents" | "projects"): void } } }
window.__QA_RECOVERY__ = {
  pending: () => pending.length,
  settle(index, text) { if (text === undefined) pending[index]!.reject(new Error("Synthetic history offline")); else pending[index]!.resolve([{ seq: 9000000 + index, ts: 100 + index, engineId: "local", agentId: "qa-recovery-lane", kind: "message_complete", data: { text } }]); },
  cycle() { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); },
  attempts: () => attempts, release: () => release?.(),
  select(tab) { appStore.dispatch({ type: "selectTab", tab }); },
};
export function RecoveryProbe({ liveboard = false }: { liveboard?: boolean }) {
  const tab = useStore(s => s.activeTab);
  const Projects = useMemo(() => lazyScreen(async () => {
    attempts++;
    if (attempts === 1) throw new Error("Synthetic route chunk offline");
    await new Promise<void>(resolve => { release = resolve; });
    const m = await import("../../src/screens/ProjectsScreen");
    return { default: m.ProjectsScreen };
  }), []);
  return <div data-qa-recovery style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
    <TopBar />
    <main style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
      {liveboard ? <Liveboard onOpen={() => {}} /> : tab === "projects" ? <Projects /> : <AgentsScreen />}
    </main>
    {liveboard && <Composer />}
    <Footer />
  </div>;
}
