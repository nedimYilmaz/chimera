import { useEffect } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { displayChord, runAction } from "../keymap";
import { pickToast } from "../state/selectors.system";
import styles from "./Toast.module.css";

// W6 build item 9 — Toasts (mock toast_note/toast_err, lines 872-877):
// bottom-right absolute in App, warn-tinted "note:" for the ui-state NOTICE
// channel (this is what makes W4's cyclePermissionMode// /status notices
// visible) and danger-tinted "error:" for lastError, each self-dismissing
// after 3s by dispatching the existing null-clears. The error toast carries
// the mock's "mod+u accounts" hint (coverage B7: "error'da ctrl+a ipucu") —
// clicking it opens the AccountsCard via the SAME action id as mod+u (system.accounts
// is no longer bound on the agents scope; this toast can still fire the action
// directly regardless of the active tab).
const TOAST_MS = 3000;

export function Toast() {
  const notice = useStore((s: UiState) => s.notice);
  const lastError = useStore((s: UiState) => s.lastError);

  useEffect(() => {
    if (notice === null) return undefined;
    const id = setTimeout(() => {
      if (appStore.getState().notice === notice) appStore.dispatch({ type: "notice", message: null });
    }, TOAST_MS);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (lastError === null) return undefined;
    const id = setTimeout(() => {
      if (appStore.getState().lastError === lastError) appStore.dispatch({ type: "commandError", message: null });
    }, TOAST_MS);
    return () => clearTimeout(id);
  }, [lastError]);

  // ONE slot (F01): notice + lastError never stack — pickToast resolves the
  // single toast to show (error outranks a live notice; else the notice).
  const pick = pickToast(notice, lastError);
  if (pick === null) return null;

  return (
    <div className={styles.stack} data-toast>
      {pick.channel === "error" ? (
        <div className={styles.error} data-toast-error>
          error: {pick.message}
          <span
            className={styles.errorHint}
            onClick={() => runAction("system.accounts", appStore)}
          >
            {" "}· {displayChord("mod+u")} accounts
          </span>
        </div>
      ) : (
        <div className={styles.note} data-toast-note>
          note: {pick.message} <span className={styles.noteHint}>· 3s</span>
        </div>
      )}
    </div>
  );
}
