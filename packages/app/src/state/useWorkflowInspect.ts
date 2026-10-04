// SHADOW-WORKFLOW-VISIBILITY: the cockpit's polling hook for the workflow shadow inspector.
// Split from ./workflowInspect (the pure fold) because this imports the Tauri bridge, whose
// module-level subscriptions need a browser/Tauri `window` — keeping the fold bridge-free lets it
// be unit-tested in plain node.

import { useEffect, useState } from "react";
import type { ShadowWorkflowInspectResponse } from "@chimera/protocol/contract";
import { rpcCall } from "../rpc/bridge";
import { errorText } from "./errorText";

export type InspectState = {
  data: ShadowWorkflowInspectResponse | null;
  error: string | null;
  loading: boolean;
};

// Polls shadow.workflowInspect for the given shadow. `innerAgentId` is folded into the SAME call
// (the response carries both the roster and, when an inner agent is selected, its transcript tail)
// so drilling in never fires a second stream. Re-polls every `intervalMs`; re-subscribes when the
// selected shadow or drilled-into inner agent changes.
export function useWorkflowInspect(
  agentId: string,
  innerAgentId: string | null,
  intervalMs = 2500,
): InspectState {
  const [state, setState] = useState<InspectState>({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    // Reset to a loading state whenever the target changes so a stale roster never flashes under
    // a freshly-selected shadow.
    setState({ data: null, error: null, loading: true });
    let inFlight = false;
    const poll = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const data = await rpcCall<ShadowWorkflowInspectResponse>("shadow.workflowInspect", {
          agentId,
          ...(innerAgentId ? { innerAgentId } : {}),
        });
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: errorText(e), loading: false }));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [agentId, innerAgentId, intervalMs]);

  return state;
}
