import type { SlashEntry } from "../state/commands.agents";
import { HINTS } from "../copy";
import styles from "./SlashPopup.module.css";

// W4 build item 3 — the "/" popup (mock showSlash, line 457-464): unified
// list of ⌘ app-local built-ins + the selected agent's advertised commands
// (+ W7's project-command entries, which join the CATALOG in the Composer's
// buildSlashMatches — not here — so they get the same ↑↓/enter cursor and
// open-gating as every other row). Pure presentational (the Composer owns
// ↑↓/enter; a row CLICK runs the same entry the keyboard would — parity
// rule). Windowed to 6 rows like the TUI's SlashPopup.
const WINDOW = 6;

export function SlashPopup({ matches, selectedIndex, onRun }: {
  matches: SlashEntry[];
  selectedIndex: number;
  onRun: (entry: SlashEntry) => void;
}) {
  if (matches.length === 0) return null;
  // keep the selected row inside the rendered slice (TUI windowStart port)
  const rows = Math.min(WINDOW, matches.length);
  const start = Math.max(0, Math.min(selectedIndex - rows + 1, matches.length - rows));
  const shown = matches.slice(start, start + rows);
  return (
    <div className={styles.popup} data-slash-popup>
      {shown.map((c, i) => {
        const isSelected = start + i === selectedIndex;
        return (
          <button
            key={c.name}
            type="button"
            className={[styles.row, isSelected ? styles.rowSelected : ""].filter(Boolean).join(" ")}
            onMouseDown={(e) => e.preventDefault() /* keep composer focus */}
            onClick={() => onRun(c)}
          >
            /{c.name}
            {c.description ? <span className={styles.desc}> {c.description}</span> : null}
            <span className={styles.spacer} />
            <span className={styles.marker}>
              {c.source === "builtin" ? `⌘ app${c.keyHint ? ` · ${c.keyHint}` : ""}` : "agent"}
            </span>
          </button>
        );
      })}
      <div className={styles.footer}>{HINTS.slashPopup}</div>
    </div>
  );
}
