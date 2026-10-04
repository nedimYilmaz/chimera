// React face of the connection state for the chrome (ConnChip, banner).
// Each hook instance attaches its own onDaemonState listener — cheap, and
// onDaemonState synthesizes the current state on attach, so late mounts
// render correctly without any shared store (W2 owns real shared state).
import { useEffect, useState } from "react";
import { onDaemonState, rpcCall, type ConnState } from "./bridge";

export function useConnState(): ConnState {
  // Optimistic initial: "reconnecting" matches the Rust driver's own boot
  // state and avoids flashing the disconnected banner during the few ms the
  // daemon_status snapshot takes on a healthy startup.
  const [state, setState] = useState<ConnState>("reconnecting");
  useEffect(() => onDaemonState(setState), []);
  return state;
}

/** ConnChip data: state + a real measured RTT (one daemon.status round-trip
 * per `connected` transition — the continuously-sampled version is W6
 * PerfHud's job). null while unknown → the chip omits the rtt span. */
export function useConn(): { state: ConnState; rttMs: number | null } {
  const state = useConnState();
  const [rttMs, setRttMs] = useState<number | null>(null);
  useEffect(() => {
    if (state !== "connected") {
      setRttMs(null); // a stale number would lie across a reconnect
      return;
    }
    let alive = true;
    const t0 = performance.now();
    rpcCall("daemon.status")
      .then(() => {
        if (alive) setRttMs(performance.now() - t0);
      })
      .catch(() => {}); // chip just keeps omitting the span
    return () => {
      alive = false;
    };
  }, [state]);
  return { state, rttMs };
}
