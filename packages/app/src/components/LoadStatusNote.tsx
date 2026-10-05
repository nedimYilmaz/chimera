import type { LoadStatusState } from "../state/loadStatus";
import { ChipButton } from "./ChipButton";
import styles from "./LoadStatusNote.module.css";

interface LoadStatusNoteProps {
  status: LoadStatusState;
  /** Plural noun for the list ("roles") — keeps the wording uniform across screens. */
  what: string;
  /** Rows are on screen: a failure then means "stale", not "nothing to show". */
  hasRows: boolean;
  onRetry: () => void;
}

/**
 * The one loading / failed / stale line for a screen-owned list.  Renders
 * nothing when the list is healthy (or unsupported — that is a capability
 * hint the screen words itself), so callers can drop it in unconditionally and
 * gate their "nothing here yet" empty hint on `status.loaded && !status.error`.
 */
export function LoadStatusNote({ status, what, hasRows, onRetry }: LoadStatusNoteProps) {
  if (status.unsupported) return null;
  if (!status.loaded && !status.error) {
    return <div className={styles.note} role="status" data-load-status="loading">loading {what}…</div>;
  }
  if (!status.error) return null;
  const stale = status.loaded && hasRows;
  return (
    <div className={`${styles.note} ${styles.failed}`} role="alert" data-load-status={stale ? "stale" : "error"}>
      <span className={styles.text}>
        {stale ? `showing last loaded ${what} — refresh failed` : `couldn't load ${what}`} ({status.error})
      </span>
      <ChipButton className={styles.retry} onClick={onRetry} disabled={status.loading} data-load-retry>
        {status.loading ? "retrying…" : "retry"}
      </ChipButton>
    </div>
  );
}
