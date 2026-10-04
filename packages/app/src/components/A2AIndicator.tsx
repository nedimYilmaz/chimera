import { useEffect, useMemo, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { a2aFeed } from "../state/selectors.projects";
import { agentName } from "../state/selectors";
import styles from "./A2AIndicator.module.css";

// A2A-UX-OVERHAUL · PART 2 — the ephemeral live-traffic indicator. When agent X
// messages agent Y (a live a2a event), a transient "<sender> ⇒ <receiver> ·
// <snippet>" row animates in at the BOTTOM of the AgentList panel, holds ~4-5s,
// then fades out (real CSS keyframes; `onAnimationEnd` unmounts the row — no JS
// timers). A burst STACKS (newest at the bottom) capped at STACK_MAX so it never
// grows unbounded and never steals focus/keyboard. Clicking a row jumps to the
// SENDER's transcript (nice-to-have). The feed is seeded on mount so pre-existing
// history is never replayed as "live" traffic.

const STACK_MAX = 3;

function nameOf(id: string): string {
  return id === "main" ? "main" : agentName(id);
}

type Item = { key: number; from: string; to: string; text: string };

export function A2AIndicator() {
  const events = useStore((s: UiState) => s.events);
  const feed = useMemo(() => a2aFeed(events), [events]);
  const seenRef = useRef<number | null>(null); // null until the first feed is absorbed
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const newestSeq = feed.length > 0 ? feed[0]!.seq : -1;
    if (seenRef.current === null) { seenRef.current = newestSeq; return; } // seed — no history replay
    if (newestSeq <= seenRef.current) return;
    const fresh = feed.filter((x) => x.seq > seenRef.current!).slice().reverse(); // chronological
    seenRef.current = newestSeq;
    setItems((prev) => [...prev, ...fresh.map((x) => ({ key: x.seq, from: x.from, to: x.to, text: x.text }))].slice(-STACK_MAX));
  }, [feed]);

  const remove = (key: number): void => setItems((prev) => prev.filter((i) => i.key !== key));

  if (items.length === 0) return null;
  return (
    <div className={styles.stack} data-a2a-indicator>
      {items.map((i) => (
        <div
          key={i.key}
          className={styles.row}
          data-a2a-indicator-row={i.key}
          onAnimationEnd={() => remove(i.key)}
          onClick={() => appStore.dispatch({ type: "selectAgent", agentId: i.from })}
          title={`jump to ${nameOf(i.from)}`}
        >
          <span className={styles.agent}>{nameOf(i.from)}</span>
          <span className={styles.arrow}> ⇒ </span>
          <span className={styles.agent}>{nameOf(i.to)}</span>
          <span className={styles.text}> · {i.text}</span>
        </div>
      ))}
    </div>
  );
}
