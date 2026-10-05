import { useEffect, useMemo, useState } from "react";
import type { QueueStatusView } from "@chimera/ui-state";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import { TaskInspector } from "./TaskInspector";
import { taskRowView } from "../state/selectors.coord";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import type { CanvasRequest } from "../state/canvas-controller";
import { errorText } from "../state/errorText";

/** One selected entity, never a fleet of mounted task streams. */
export function CanvasTaskInspector({ taskId, queue, request }: { taskId: string; queue: string; request: CanvasRequest }) {
  const status = useMemo(createLoadStatus, [taskId, queue, request]), state = useLoadStatus(status);
  const connected = useStore(s => s.connected);
  const [value, setValue] = useState<{ raw: Record<string, unknown>; retryLimit: number } | null>(null);
  const load = () => {
    if (!appStore.getState().connected) return;
    void runLoad(status, async () => {
      const detail = await request<QueueStatusView>("queue.status", { name: queue });
      const raw = detail.tasks.find(t => t["taskId"] === taskId);
      if (!raw) throw new Error("Task is no longer in this queue; refresh the graph");
      return { raw, retryLimit: typeof detail.spec["retryLimit"] === "number" ? detail.spec["retryLimit"] : 0 };
    }, setValue, { isUnsupported: e => /unknown method|unsupported|not implemented/i.test(errorText(e)) });
  };
  useEffect(() => {
    let previous = appStore.getState().connected; load();
    const off = appStore.subscribe(() => { const next = appStore.getState().connected; if (previous && !next) status.interrupt("Disconnected; task snapshot may be stale"); if (!previous && next) load(); previous = next; });
    return () => { off(); status.reset(); };
  }, [status]);
  return <div>
    <LoadStatusNote status={state} what="selected task" hasRows={!!value} onRetry={load} />
    {state.unsupported && <p role="status">Task details are unavailable on this daemon.</p>}
    {!connected && <p role="status">Disconnected · selected task snapshot may be stale.</p>}
    {value && state.loaded && <><button type="button" disabled={!connected || state.loading || state.unsupported} onClick={load}>Refresh task snapshot</button><TaskInspector task={taskRowView(value.raw)} raw={value.raw} retryLimit={value.retryLimit} team={null} /></>}
  </div>;
}
