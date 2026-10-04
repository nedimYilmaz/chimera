import { useEffect, useState } from "react";
import { displayChord, registerActionHandler } from "../keymap";
import { composerLocal } from "../state/commands.agents";
import { deriveEditDiff, formatToolInput, toolPathHint, type ToolItem } from "../state/selectors";
import styles from "./ToolDetailCard.module.css";

// W4 build item 7 — the INLINE tool-detail card (mock showToolDetail,
// line 147-163): NOT an OverlayCard — it renders in place of the collapsed
// ToolStrip inside the transcript body (the mock's showToolDetail /
// n_toolDetail pair are alternatives at the same spot). Call rows (✓/✗ +
// name + dim path); the selected call shows "[✓ Read]" bold-bracketed with
// its input block (verbatim string / pretty JSON — mod+e toggles raw),
// result block (from TranscriptItem.result; a dim "(not carried by daemon
// yet)" note when the daemon hasn't landed tool_result text — NEVER an empty
// box; a red "denied" line for denied calls) and a DiffPreview for Edit
// inputs (first hunk ±2 from old_string/new_string). ←→ walks calls (bound
// while mounted, shadowing the fold rows), esc closes (chain tier 2), wheel
// scrolls the result (overflow:auto).
export function ToolDetailCard({ items, call, onSelectCall, onClose, blockKey }: {
  items: ToolItem[];
  call: number;
  onSelectCall: (i: number) => void;
  /** F-TOGGLE-ANIM: closes the card back to the collapsed ToolStrip — same
   * affordance esc/mod+e already give, so a click can close it too, not
   * just open it (the strip itself is gone from the DOM once open, replaced
   * by this card, so there's no "click the same spot again" target without
   * this explicit close). */
  onClose?: () => void;
  /** Transcript-window measure key: carries data-bkey so the taller open card
   * is measured into the height cache (else the block keeps its collapsed
   * strip's height and the prefix-sum geometry drifts while it's open). */
  blockKey?: string;
}) {
  const [raw, setRaw] = useState(false);
  const selected = Math.max(0, Math.min(call, items.length - 1));
  const item = items[selected];

  // ←→ walk the call list while the card is mounted (registry shadow over the
  // agents fold rows — same mechanism as FlowPane's view toggle).
  useEffect(() => {
    const offs = [
      registerActionHandler("agents.foldLeft", () => {
        const cur = composerLocal.getState().toolDetail;
        if (cur) composerLocal.set({ toolDetail: { ...cur, call: Math.max(0, cur.call - 1) } });
      }),
      registerActionHandler("agents.foldRight", () => {
        const cur = composerLocal.getState().toolDetail;
        if (cur) composerLocal.set({ toolDetail: { ...cur, call: Math.min(items.length - 1, cur.call + 1) } });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [items.length]);

  if (!item) return null;
  const diff = deriveEditDiff(item.input);
  const inputText = formatToolInput(item.input, !raw);

  const statusGlyph = (t: ToolItem): React.ReactElement =>
    t.status === "denied"
      ? <span className={styles.danger}>✗</span>
      : t.status === "called"
        ? <span className={styles.warnPulse}>◐</span>
        : <span className={styles.success}>✓</span>;

  return (
    <div className={styles.card} data-tool-detail data-bkey={blockKey}>
      <div
        className={styles.header}
        role={onClose ? "button" : undefined}
        tabIndex={-1}
        onClick={onClose}
        data-tool-detail-header
      >
        ⚙ {items.length} tool call{items.length === 1 ? "" : "s"}{" "}
        <span className={styles.headerHint}>— {displayChord("mod+e")} / click header to close · click a call · ←→ move · esc close</span>
        {onClose ? (
          <span className={styles.closeBtn} role="button" tabIndex={-1} data-tool-detail-close>
            ✕ close
          </span>
        ) : null}
      </div>
      {items.map((t, i) => {
        const isSel = i === selected;
        const hint = toolPathHint(t.input);
        return (
          <div key={i}>
            <button
              type="button"
              className={[styles.callRow, isSel ? styles.callRowSelected : ""].filter(Boolean).join(" ")}
              onClick={() => onSelectCall(i)}
              data-tool-call={i}
            >
              {isSel ? (
                <span className={t.status === "denied" ? styles.dangerBold : styles.successBold}>
                  [{t.status === "denied" ? "✗" : "✓"} {t.toolName}]
                </span>
              ) : (
                <>
                  {statusGlyph(t)} {t.toolName}
                </>
              )}
              {hint ? <span className={styles.pathHint}> · {hint}</span> : null}
            </button>
            {isSel ? (
              <div className={styles.block} onClick={() => setRaw((r) => !r)} title={`${displayChord("mod+e")} pretty/raw`} data-tool-block>
                <div className={styles.blockLabel}>input{raw ? " · raw" : ""}</div>
                <div className={styles.inputText}>{inputText || <span className={styles.ghost}>(no input)</span>}</div>
                {t.status === "denied" ? (
                  <div className={styles.deniedLine}>denied</div>
                ) : (
                  <>
                    <div className={styles.blockLabel}>
                      result
                      {t.result !== undefined
                        ? <span className={styles.ghost}> · wheel scrolls inside</span>
                        : null}
                    </div>
                    {t.result !== undefined ? (
                      <div className={styles.resultText} data-tool-result>{t.result}</div>
                    ) : (
                      <div className={styles.ghost}>(not carried by daemon yet)</div>
                    )}
                  </>
                )}
                {diff ? (
                  <>
                    <div className={styles.blockLabel}>diff{diff.file ? ` · ${diff.file}` : ""}</div>
                    {diff.plus.map((l, j) => <div key={`p${j}`} className={styles.diffPlus}>+ {l}</div>)}
                    {diff.minus.map((l, j) => <div key={`m${j}`} className={styles.diffMinus}>− {l}</div>)}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
