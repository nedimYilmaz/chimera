import { useEffect, type ReactNode } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { isEditableTarget } from "../keymap";
import { ChipButton } from "./ChipButton";
import styles from "./ConfirmCard.module.css";

// W5 — the destructive-action confirm gate (mock showConfirm, s_queues
// 714-729: "⚠ cancel task" — 540 card, --edge-confirm border, danger title,
// enter=confirm / esc=back chips). Generic over the two W5 destructive
// actions (queue.cancelTask, team.dissolve) so both ride ONE gated path.
// Enter is intercepted window-capture (like OverlayCard's own esc) so the
// screen's enter handler (drill) can never fire underneath the gate.
export function ConfirmCard({ title, meta, body, note, confirmLabel, onConfirm, onClose, children }: {
  title: string;         // "⚠ cancel task"
  meta?: string;         // "t-0a41"
  body: string;
  note?: string;         // the dim irreversibility caveat
  confirmLabel: string;  // "confirm cancel"
  onConfirm: () => void;
  onClose: () => void;
  /** Optional extra content (a toggle, an inline error) between the note and
   * the footer — e.g. the delete-project confirm's "also delete files" switch. */
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      // Native footer buttons own Enter/Space through their default click.
      // Without this guard, capture-phase Enter would turn Cancel into confirm.
      if (typeof Element !== "undefined" && ev.target instanceof Element && ev.target.closest("button")) return;
      if (ev.key === "Enter") {
        ev.stopPropagation();
        ev.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onConfirm]);

  return (
    <OverlayCard width={540} align="center" edge="var(--edge-confirm)" onClose={onClose}>
      <OverlayCardHeader title={title} titleColor="var(--danger)" meta={meta} />
      <div className={styles.body}>
        {body}
        {note ? <div className={styles.note}>{note}</div> : null}
        {children}
      </div>
      <div className={styles.footer}>
        <ChipButton className={styles.confirmChip} onClick={onConfirm} data-confirm>
          <span className={styles.confirmKey}>enter</span>
          <span className={styles.confirmVerb}> {confirmLabel}</span>
        </ChipButton>
        <ChipButton className={styles.backChip} onClick={onClose} data-confirm-cancel>esc back</ChipButton>
      </div>
    </OverlayCard>
  );
}
