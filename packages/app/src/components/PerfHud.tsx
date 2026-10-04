import { useEffect, useState } from "react";
import { appStore } from "../state/store";
import { useSystemLocal } from "../state/commands.system";
import styles from "./PerfHud.module.css";

// W6 build item 10 — the PerfHud (mock showPerfHud, line 881: the ghost "⚡ …"
// stats in the Footer's right cluster; coverage B7: "rAF/render delta, ev/s
// ring, rtt · gizli tuş ctrl+shift+d"). REAL numbers only:
//  - render: mean rAF frame delta over the last second (drops = deltas >34ms);
//  - ev/s: store event dispatches in a rolling 1s ring (lastSeq deltas);
//  - rtt: the bridge-measured status-ping round trip (SystemCommands'
//    5s poll stashes it in systemLocal — the "periyodik status ping" B1 row).
// All meters only run while the HUD is visible (idle cost 0 when hidden).
type HudStats = { frameMs: number; drops: number; evPerSec: number };

export function PerfHud() {
  const open = useSystemLocal((s) => s.perfHudOpen);
  const rttMs = useSystemLocal((s) => s.rttMs);
  const serverHandleMs = useSystemLocal((s) => s.serverHandleMs);
  const socketQueuedBytes = useSystemLocal((s) => s.socketQueuedBytes);
  const [stats, setStats] = useState<HudStats>({ frameMs: 0, drops: 0, evPerSec: 0 });

  useEffect(() => {
    if (!open) return undefined;

    // rAF frame-delta ring, folded into stats twice a second.
    let raf = 0;
    let last = performance.now();
    let deltas: number[] = [];
    const tick = (now: number): void => {
      deltas.push(now - last);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // events/s: count lastSeq advances via a store subscription (each live
    // NormalizedEvent bumps the watermark exactly once).
    let evCount = 0;
    let lastSeq = appStore.getState().lastSeq;
    const off = appStore.subscribe(() => {
      const seq = appStore.getState().lastSeq;
      if (seq > lastSeq) {
        evCount += seq - lastSeq;
        lastSeq = seq;
      }
    });

    const fold = setInterval(() => {
      const window = deltas;
      deltas = [];
      const frameMs = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : 0;
      const drops = window.filter((d) => d > 34).length;
      const events = evCount;
      evCount = 0;
      setStats({ frameMs, drops, evPerSec: events });
    }, 1000);

    return () => {
      cancelAnimationFrame(raf);
      off();
      clearInterval(fold);
    };
  }, [open]);

  if (!open) return null;
  // PERF-SPLIT-RTT: rtt on its own cannot answer "is the daemon slow or is this window busy?" —
  // it is measured around an await HERE, so renderer stall counts as round-trip time. Split into
  // the three places the time can actually be, so a report of "everything is slow with 9 agents"
  // arrives already diagnosed:
  //   daemon — the engine's own handling
  //   queue  — bytes waiting ahead of the reply on the socket events and responses SHARE
  //   ui     — whatever is left, which is this renderer
  // Shown only when the daemon stamped them; an older daemon keeps the single-number readout
  // rather than displaying an invented zero.
  const uiMs = rttMs !== null && serverHandleMs !== null ? Math.max(0, rttMs - serverHandleMs) : null;
  return (
    <span className={styles.hud} data-perf-hud>
      ⚡ render {stats.frameMs.toFixed(1)}ms · {stats.drops} drop · {stats.evPerSec} ev/s
      {rttMs !== null ? ` · rtt ${rttMs.toFixed(1)}ms` : ""}
      {serverHandleMs !== null ? ` (daemon ${serverHandleMs.toFixed(1)}ms` : ""}
      {uiMs !== null ? ` · ui ${uiMs.toFixed(1)}ms` : ""}
      {socketQueuedBytes !== null ? ` · queue ${socketQueuedBytes}B)` : serverHandleMs !== null ? ")" : ""}
    </span>
  );
}
