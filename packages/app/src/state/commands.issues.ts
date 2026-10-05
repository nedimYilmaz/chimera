import { useEffect, useSyncExternalStore } from "react";
import type { IssueSource, IssueBoardLink } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { singleFlight } from "./singleFlight";
import { appStore } from "./store";
import { createLoadStatus, runLoad, useLoadStatus } from "./loadStatus";

const rows = new Map<string, ReturnType<typeof makeRows>>();
function makeRows(queue: string) {
  let value: { sources: IssueSource[]; links: IssueBoardLink[] } = { sources: [], links: [] };
  const listeners = new Set<() => void>(); const status = createLoadStatus();
  const load = () => runLoad(status, () => Promise.all([
    rpcCall<IssueSource[]>("issues.sourceList", { queue }), rpcCall<IssueBoardLink[]>("issues.linkList", { queue }),
  ]), ([sources, links]) => { value = { sources, links }; for (const l of listeners) l(); }, { isUnsupported: e => typeof e === "object" && e !== null && "code" in e && (e.code === "unsupported" || (e.code === "protocol" && "message" in e && /unknown method/.test(String(e.message)))) });
  let refs = 0; let unsubscribe: (() => void) | undefined;
  const eventRefresh = singleFlight(() => refs > 0 && appStore.getState().connected ? load() : Promise.resolve());
  return { status, load, get: () => value, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    watch() {
      if (++refs === 1) {
        let connected = appStore.getState().connected;
        let seq = appStore.getState().events.at(-1)?.seq ?? 0;
        unsubscribe = appStore.subscribe(() => {
          const snapshot = appStore.getState(); const latest = snapshot.events.at(-1)?.seq ?? 0;
          const recent = snapshot.events.filter(e => e.seq > seq); seq = latest;
          if (snapshot.connected !== connected) {
            connected = snapshot.connected;
            if (!connected) status.interrupt("Disconnected; reconnect to refresh issue sources."); else void load();
            return;
          }
          if (connected && !status.getState().unsupported && recent.some(e =>
            (e.kind === "task_state_changed" && e.data["queue"] === queue) ||
            (e.kind === "review_changed" && value.links.some(l => l.taskId === e.data["taskId"]))
          )) void eventRefresh();
        });
        void load();
      }
      return () => { if (--refs === 0) { unsubscribe?.(); status.interrupt("Issue view closed during refresh."); } };
    },
  };
}
export function queueIssues(queue: string) { let row = rows.get(queue); if (!row) { row = makeRows(queue); rows.set(queue, row); } return row; }
export function useQueueIssues(queue: string) {
  const owner = queueIssues(queue); const value = useSyncExternalStore(owner.subscribe, owner.get); const status = useLoadStatus(owner.status);
  useEffect(() => owner.watch(), [owner]); return { ...value, status, refresh: owner.load };
}
