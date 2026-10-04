import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import styles from "./SearchBox.module.css";

// Shared per-tab search/filter input (user request: every tab gets a search box
// that filters everything in it). A real <input> so the global keymap's
// isEditableTarget guard suppresses tab/shortcut keys while typing; esc clears
// the query (and blurs). `count` renders the live "N of M <noun>" tally. The
// screen owns the query state + the actual filtering — this is just the row.
export function SearchBox({ value, onChange, placeholder, count, dataAttr, autoFocus, inputRef: externalRef, onKeyDown, children }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  count?: { shown: number; total: number; noun: string };
  /** optional data-* hook name for tests, e.g. "agents-search". */
  dataAttr?: string;
  /** focus the input as soon as it mounts (e.g. a search panel that just opened). */
  autoFocus?: boolean;
  /** TRANSCRIPT-SEARCH: lets a caller re-focus an ALREADY-OPEN box — pressing the find chord a
   *  second time should select the query, and autoFocus only fires on mount. The box keeps its own
   *  ref for its row-click behaviour; this mirrors into the caller's. */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** TRANSCRIPT-FIND: extra key handling for the caller (enter/shift+enter step the match cursor).
   *  Runs FIRST; the box's own esc-clears only applies if the caller did not take the key. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** AGENTS-HIDE-DONE: optional trailing control (e.g. the "N done" reveal
   * chip) rendered after the count, inside the same search row. */
  children?: ReactNode;
}) {
  const dataProps = dataAttr ? { [`data-${dataAttr}`]: "" } : {};
  const ownRef = useRef<HTMLInputElement | null>(null);
  const inputRef = externalRef ?? ownRef;
  return (
    <div
      className={styles.searchRow}
      // SEARCHBOX-UNCLICKABLE: crowded rows (agents panel) can squeeze the
      // input to a sub-pixel sliver, so the row itself must also be a click
      // target. Skip buttons/the input so their own handlers still fire.
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, input, a, [role='button']")) return;
        e.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <span className={styles.slash}>/</span>
      <input
        ref={inputRef}
        className={styles.searchInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder ?? "type to search"}
        spellCheck={false}
        aria-label="search"
        autoFocus={autoFocus}
        {...dataProps}
      />
      {count ? (
        <span className={styles.countMeta}>
          {count.shown}{count.total !== count.shown ? ` of ${count.total}` : ""} {count.noun}
        </span>
      ) : null}
      {children}
    </div>
  );
}
