import type { OutboxItem } from "@chimera/ui-state";
import { HINTS } from "../copy";
import { displayChord } from "../keymap";
import styles from "./QueuedBar.module.css";

// W4 build item 2 — the queued bar (mock showQueued, line 465-472): numbered
// chips for messages held while the target is busy (A1-4). mod+u pops the
// LAST back into the composer; a chip CLICK edits THAT chip's item through
// the same popIntoDraft path (Composer's onEdit — W4 review: clicking chip 1
// used to pull the last item); esc drops the last (chain tier 9); the FIFO
// auto-flush lives in commands.agents.ts's busy→idle watcher.
export function QueuedBar({ items, targetLabel, onEdit }: { items: OutboxItem[]; targetLabel: string; onEdit: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.bar} data-queued-bar>
      <span className={styles.label}>queued → {targetLabel}</span>
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          className={styles.chip}
          title={`edit this queued message (${displayChord("mod+u")} edits the last)`}
          onClick={() => onEdit(it.id)}
        >
          {i + 1} · {it.text}
        </button>
      ))}
      <span className={styles.spacer} />
      <span className={styles.hint}>{HINTS.queued}</span>
    </div>
  );
}
