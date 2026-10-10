import { RemoteControlCard } from "../../src/components/RemoteControlCard";
import { appStore } from "../../src/state/store";
import { systemLocal } from "../../src/state/commands.system";

const agentId = "remote-fixture";
let finish: (() => void) | undefined;
export const remoteFixture = {
  active: false,
  nextSeq: () => appStore.getState().lastSeq + 1,
  calls: [] as Record<string, unknown>[],
  configure(transport = "exec", busy = false, state = "running", provider = "codex") {
    appStore.dispatch({ type: "agentRecords", records: [{ agentId, provider, state, accountName: "fixture", createdAt: 1, spec: { displayLabel: "Remote fixture" } }] as never });
    appStore.dispatch({ type: "selectAgent", agentId });
    appStore.dispatch({ type: "event", event: { agentId, seq: this.nextSeq(), ts: Date.now(), kind: "agent_started", data: { provider, codexTransport: transport } } });
    appStore.dispatch({ type: "event", event: { agentId, seq: this.nextSeq(), ts: Date.now(), kind: "turn_complete", data: {} } });
    if (busy) appStore.dispatch({ type: "event", event: { agentId, seq: this.nextSeq(), ts: Date.now(), kind: "status", data: { turnStarted: true } } });
    appStore.dispatch({ type: "event", event: { agentId, seq: this.nextSeq(), ts: Date.now(), kind: "status", data: { state, ...(state === "paused" ? { paused: true } : {}), remoteControl: { agentId, provider, enabled: false } } } });
    systemLocal.set({ remoteControlOpen: true });
  },
  close() { systemLocal.set({ remoteControlOpen: false }); },
  snapshot() {
    appStore.dispatch({ type: "agentRecords", records: [{ agentId: "remote-snapshot", provider: "codex", state: "running", accountName: "fixture", createdAt: 1, spec: {}, permissionApplication: { version: 1, transport: "exec" } }] as never });
    appStore.dispatch({ type: "selectAgent", agentId: "remote-snapshot" });
  },
  reset() { this.calls.length = 0; finish = undefined; this.configure(); },
  complete() { finish?.(); finish = undefined; },
  rpc(method: string, params: Record<string, unknown>) {
    if (method !== "agent.remoteControl") return undefined;
    this.calls.push(params);
    return new Promise(resolve => {
      finish = () => {
        const status = { agentId, provider: "codex", enabled: params.enable, connectionStatus: params.enable ? "connected" : "off" };
        appStore.dispatch({ type: "event", event: { agentId, seq: this.nextSeq(), ts: Date.now(), kind: "status", data: { remoteControl: status } } });
        resolve(status);
      };
    });
  },
};
export function RemoteControlProbe() { return <RemoteControlCard />; }
