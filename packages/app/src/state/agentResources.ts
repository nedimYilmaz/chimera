import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentResourcesResponseSchema, type AgentResourcesResponse } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "./store";
import { createLoadStatus, runLoad, useLoadStatus } from "./loadStatus";

export type ResourceRequest = <T>(method: string, params: unknown) => Promise<T>;
const owners = new WeakMap<ResourceRequest, Map<string, ReturnType<typeof createOwner>>>();
const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

// The selected header and an open inspector share one screen-owned sampler.
// Releasing the last visible consumer invalidates replies, including agent switches.
function createOwner(agentId: string, request: ResourceRequest, onIdle: () => void = () => {}, onSubscribe: () => void = () => {}) {
  const status = createLoadStatus();
  let snapshot = { data: null as AgentResourcesResponse | null, connected: appStore.getState().connected, clock: Date.now() };
  const listeners = new Set<() => void>();
  let refs = 0;
  let stop: (() => void) | undefined;
  const update = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const evictIfIdle = () => { if (!refs && !listeners.size) onIdle(); };
  const load = () => {
    if (!refs || !visible() || !appStore.getState().connected || status.getState().loading || status.getState().unsupported) return;
    void runLoad(status, async () => {
      const data = AgentResourcesResponseSchema.parse(await request<AgentResourcesResponse>("agent.resources", { agentId }));
      if (data.sample.agentId !== agentId) throw new Error("Resource sample belongs to another agent");
      return data;
    }, data => update({ data, clock: Date.now() }), {
      isUnsupported: error => /unknown method|unknown rpc|not implemented|does not accept engine-qualified ids|federation is not configured/i.test(
        error && typeof error === "object" && "message" in error ? String(error.message) : String(error)),
    });
  };
  return {
    status, load,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { onSubscribe(); listeners.add(listener); return () => { listeners.delete(listener); evictIfIdle(); }; },
    watch() {
      refs++;
      if (refs === 1) {
        let connected = appStore.getState().connected;
        update({ connected, clock: Date.now() });
        const off = appStore.subscribe(() => {
          const next = appStore.getState().connected;
          if (next === connected) return;
          connected = next;
          // Invalidate on the synchronous edge, before React can batch reconnects.
          if (!next) status.interrupt("connection to the daemon was lost");
          update({ connected: next });
          if (next) load();
        });
        let timer: ReturnType<typeof setInterval> | undefined;
        const visibility = () => {
          if (timer) clearInterval(timer);
          timer = undefined;
          if (visible()) {
            update({ clock: Date.now() }); load();
            timer = setInterval(() => { update({ clock: Date.now() }); load(); }, 5000);
          } else status.interrupt("resource sampling paused while hidden");
        };
        visibility();
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
        stop = () => {
          off(); if (timer) clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
          status.reset(); update({ data: null });
        };
      }
      return () => { if (--refs === 0) { stop?.(); stop = undefined; evictIfIdle(); } };
    },
  };
}

export function useAgentResources(agentId: string | undefined, active: boolean, request: ResourceRequest = rpcCall) {
  const owner = useMemo(() => {
    if (!agentId) return createOwner("", request);
    let agents = owners.get(request);
    if (!agents) { agents = new Map(); owners.set(request, agents); }
    let entry = agents.get(agentId);
    if (!entry) {
      entry = createOwner(agentId, request, () => {
        // An inactive mounted inspector still subscribes: retain its identity
        // until it unmounts so reactivation shares the current header owner.
        if (agents!.get(agentId) === entry) agents!.delete(agentId);
      }, () => {
        // StrictMode replays effect cleanup/setup while retaining hook identity.
        if (!agents!.has(agentId)) agents!.set(agentId, entry!);
      });
      agents.set(agentId, entry);
    }
    return entry;
  }, [agentId, request]);
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const loadState = useLoadStatus(owner.status);
  useEffect(() => active && agentId ? owner.watch() : undefined, [owner, active, agentId]);
  const sample = snapshot.data?.sample;
  const age = sample ? Math.max(0, Math.floor((snapshot.clock - sample.sampledAt) / 1000)) : 0;
  const stale = !!sample && (!snapshot.connected || !!loadState.error || loadState.unsupported || sample.state === "stale" || age > 12);
  return { ...snapshot, loadState, load: owner.load, sample, age, stale };
}
export type ResourceView = ReturnType<typeof useAgentResources>;

/** Local diagnostic: inactive mounted consumers count as owners, never as samplers. */
export const resourceSamplerOwnerCount = (request: ResourceRequest = rpcCall): number => owners.get(request)?.size ?? 0;
