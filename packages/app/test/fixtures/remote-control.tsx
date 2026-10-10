import { RemoteControlCard } from "../../src/components/RemoteControlCard";
import { appStore } from "../../src/state/store";
import { systemLocal } from "../../src/state/commands.system";

const agentId = "remote-fixture";
let finishPair: ((expired?: boolean, fail?: boolean) => void) | undefined;
let finish: (() => void) | undefined;
export const remoteFixture = {
  active: false,
  pairCalls: 0,
  completePair(expired = false, fail = false) { finishPair?.(expired, fail); finishPair = undefined; },
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
    if (method === "agent.remotePair") {
      this.pairCalls++;
      return new Promise((resolve, reject) => {
        finishPair = (expired, fail) => fail ? reject(new Error("SECRET-ERROR-TOKEN")) : resolve({ manualPairingCode: "SYNTHETIC-CODE", environmentId: "env-fixture", expiresAt: Math.floor(Date.now() / 1000) + (expired ? -1 : 300) });
      });
    }
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
