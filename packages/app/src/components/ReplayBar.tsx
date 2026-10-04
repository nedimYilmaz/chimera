import { useEffect } from "react";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { isEditableTarget } from "../keymap";
import { systemCommands, systemLocal, turnCount, useSystemLocal, type ReplayLocal } from "../state/commands.system";
import { HINTS, EMPTY } from "../copy";
import styles from "./ReplayBar.module.css";

// W6 build item 7 — the ReplayBar (mock showReplay, lines 473-481): the amber
// strip "replay ◀◀ ◀ turn 3/9 ▶ ▶▶ [meter] from events.jsonl · inputs
// disabled … space play · ←→ turn · l back to live". Pages through the persisted
// history via the events.replay RPC (SystemCommands.toggleReplay fetches the
// whole log in 500-event windows); ◀▶ step over result/turn_complete turn
// boundaries (commands.system.ts turnStarts), space auto-plays forward, l
// returns to live (closes). While active the app-local replayActive store is
// the inputs-disabled seam (commands.system.ts's useReplayActive/
// isReplayActive — the documented Composer/cards integration point); this bar
// itself owns ←→/space/l via a capture-phase handler.
export function ReplayBar() {
  const replay = useSystemLocal((s) => s.replay);
  const commands = systemCommands(appStore, rpcCall);

  // key ownership while active (mouse buttons dispatch the SAME commands).
  useEffect(() => {
    if (!replay.active) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.key === "ArrowLeft") { ev.preventDefault(); ev.stopImmediatePropagation(); commands.stepReplay(-1); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); ev.stopImmediatePropagation(); commands.stepReplay(1); }
      else if (ev.key === " ") { ev.preventDefault(); ev.stopImmediatePropagation(); commands.setReplayPlaying(!appStorePlaying()); }
      else if (ev.key === "l") { ev.preventDefault(); ev.stopImmediatePropagation(); commands.closeReplay(); }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay.active]);

  // space play: auto-advance one turn per tick; stop at the last turn.
  useEffect(() => {
    if (!replay.active || !replay.playing) return undefined;
    const id = setInterval(() => {
      const r = commands; // step through the command layer (one path)
      const cur = currentReplay();
      if (cur.turn >= turnCount(cur.events) - 1) {
        r.setReplayPlaying(false);
        return;
      }
      const next = cur.turn + 1;
      r.seekReplay(next);
      r.setReplayPlaying(true); // seek pauses by contract; keep playing
    }, 800);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay.active, replay.playing]);

  if (!replay.active) return null;
  const count = turnCount(replay.events);
  const shown = count > 0 ? replay.turn + 1 : 0;
  const pct = count > 0 ? Math.round((shown / count) * 100) : 0;
  const firstSeq = replay.events[0]?.seq ?? 0;
  const lastSeq = replay.events[replay.events.length - 1]?.seq ?? 0;
  const cutoff = replay.cutoffSeq ?? lastSeq;
  const cutoffEvent = replay.events.find((event) => event.seq === cutoff);

  return (
    <div className={styles.bar} data-replay-bar>
      <span className={styles.label}>historical · read only</span>
      {replay.loading ? (
        <span className={styles.dim}>{EMPTY.replayLoading}</span>
      ) : (
        <>
          <span className={styles.controls}>
            <span className={styles.btn} onClick={() => commands.seekReplay(0)}>◀◀</span>{" "}
            <span className={styles.btn} onClick={() => commands.stepReplay(-1)}>◀</span>{" "}
            <span className={styles.turn}>turn {shown}/{count}</span>{" "}
            <span className={styles.btn} onClick={() => commands.stepReplay(1)}>▶</span>{" "}
            <span className={styles.btn} onClick={() => commands.setReplayPlaying(!replay.playing)}>▶▶</span>
          </span>
          <span className={styles.meter}>
            <span className={styles.meterFill} style={{ width: `${pct}%` }} />
          </span>
          <input aria-label="historical sequence" type="range" min={firstSeq} max={lastSeq} value={cutoff}
            onChange={(event) => commands.seekReplaySeq(Number(event.currentTarget.value))} />
          <span className={styles.dim}>seq {cutoff}{cutoffEvent ? ` · ${new Date(cutoffEvent.ts).toLocaleTimeString()}` : ""}{replay.truncated ? " · retained window truncated" : ""}</span>
        </>
      )}
      <span className={styles.dim}>{HINTS.replayStatus}</span>
      <span className={styles.spacer} />
      <span className={styles.hint} onClick={() => commands.closeReplay()}>
        {HINTS.replayControls}
      </span>
    </div>
  );
}

// read FRESH state inside key/interval callbacks (no stale closures)
function currentReplay(): ReplayLocal {
  return systemLocal.getState().replay;
}

function appStorePlaying(): boolean {
  return currentReplay().playing;
}
