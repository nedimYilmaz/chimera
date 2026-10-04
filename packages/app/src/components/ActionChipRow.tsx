import styles from "./ActionChipRow.module.css";

// W16 (F15 CRUD completion, coverage B8/B9/B10/B19 "action chips" rows) — the
// ONE mouse-clickable chip row every managed-surface panel footer renders.
// Parity rule: a chip's onClick calls the EXACT SAME function the matching
// keybinding invokes — this component never re-implements behavior, it only
// visualizes the chord + label and forwards the click. `danger` chips use the
// ConfirmCard's own edge/tint tokens so a destructive action reads
// consistently between the footer and the confirm gate it opens.
export type ActionChip = {
  key: string;             // the chord as shown in the footer, e.g. "mod+o", "e", "space"
  label: string;           // "new", "edit", "dissolve"…
  danger?: boolean;
  disabled?: boolean;
  title?: string;          // tooltip — carries the guard text when disabled
  onClick: () => void;
};

export function ActionChipRow({ chips }: { chips: readonly ActionChip[] }) {
  return (
    <div className={styles.row}>
      {chips.map((c) => (
        <span
          key={c.key}
          className={[styles.chip, c.danger ? styles.danger : styles.safe, c.disabled ? styles.disabled : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={c.disabled ? undefined : c.onClick}
          title={c.title}
          role="button"
          tabIndex={c.disabled ? -1 : 0}
          onKeyDown={(ev) => {
            if (!c.disabled && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); c.onClick(); }
          }}
          data-action-chip={c.key}
        >
          <span className={styles.chipKey}>{c.key}</span>
          <span className={styles.chipLabel}> {c.label}</span>
        </span>
      ))}
    </div>
  );
}
