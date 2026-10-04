import { useMemo } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { derivedState, displayName, fmtCost, shortId } from "../state/selectors";
import { systemCommands, useSystemLocal, type Pin } from "../state/commands.system";
import styles from "./PinnedBar.module.css";

// W6 build item 6 — the PinnedBar (mock showPinned, lines 50-54): the strip
// under the top bar, "▸ pinned" + each pin's LIVE fields, right hint. The pin
// store is app-local ({type:'task'|'agent', id} — commands.system.ts);
// mod+i pins/unpins the SELECTED agent today (was ctrl+shift+p — "pin" is a
// rule-3 mutate example, not destroy, KEYMAP-REDESIGN; the events/queue-row `mod+p`
// hook is a LATER pass, per the workstream brief). An agent pin's fields come
// straight off the store's AgentView; a task pin's off the latest event
// carrying its taskId (defensive — renders what the ring still knows).
function agentPinView(state: UiState, pin: Pin): { primary: string; state: string; detail: string } | null {
  const a = state.agents[pin.id];
  if (!a) return { primary: shortId(pin.id), state: "unknown", detail: "" };
  return {
    primary: `${displayName(a)} ${shortId(a.agentId)}`,
    state: derivedState(a),
    detail: fmtCost(a.costUsd),
  };
}

function taskPinView(state: UiState, pin: Pin): { primary: string; state: string; detail: string } {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]!;
    if (e.data["taskId"] !== pin.id) continue;
    const st = typeof e.data["state"] === "string" ? (e.data["state"] as string) : e.kind;
    const agent = typeof e.data["agentId"] === "string" ? shortId(e.data["agentId"] as string) : "";
    return { primary: pin.id, state: st, detail: agent };
  }
  return { primary: pin.id, state: "—", detail: "" };
}

export function PinnedBar() {
  const pins = useSystemLocal((s) => s.pins);
  const agents = useStore((s: UiState) => s.agents);
  const events = useStore((s: UiState) => s.events);

  const views = useMemo(() => {
    const state = appStore.getState();
    return pins.map((pin) => ({
      pin,
      view: pin.type === "agent" ? agentPinView(state, pin) : taskPinView(state, pin),
    }));
    // agents/events subscriptions keep the LIVE fields ticking (B7 verifier:
    // "pin'li task state değişimi bar'da canlı").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, agents, events]);

  if (pins.length === 0) return null;

  return (
    <div className={styles.bar} data-pinned-bar>
      <span className={styles.label}>▸ pinned</span>
      {views.map(({ pin, view }) =>
        view ? (
          <span
            key={`${pin.type}:${pin.id}`}
            className={styles.item}
            onClick={() => {
              if (pin.type === "agent") {
                appStore.dispatch({ type: "selectAgent", agentId: pin.id });
                appStore.dispatch({ type: "selectTab", tab: "agents" });
              }
            }}
            data-pin={pin.id}
          >
            <span className={styles.primary}>{view.primary}</span>
            <span className={styles.state}> {view.state}</span>
            {view.detail ? <span className={styles.detail}> {view.detail}</span> : null}
            <span
              className={styles.unpin}
              title="unpin"
              onClick={(e) => {
                e.stopPropagation();
                systemCommands(appStore, rpcCall).togglePin(pin);
              }}
            >
              ✕
            </span>
          </span>
        ) : null,
      )}
      <span className={styles.spacer} />
      <span className={styles.hint}>p unpin · enter git</span>
    </div>
  );
}
