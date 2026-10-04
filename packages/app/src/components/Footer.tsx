import { displayChord, actionChord, useKeySequence } from "../keymap";
import { useKeyboardPreferences } from "../state/keyboardPreferences";
import { appStore } from "../state/store";
import { PerfHud } from "./PerfHud";
import styles from "./Footer.module.css";

export function Footer() {
  useKeyboardPreferences();
  const pending = useKeySequence();
  return <footer className={styles.footer}>
    <span role="status" aria-live="polite">{pending
      ? `Shortcut: choose a key · ${actionChord("system.palette")} commands · ${actionChord("system.accounts")} accounts · Esc cancel`
      : `${actionChord("system.palette")}: commands · ?: shortcuts · Tab: focus`}</span>
    <button type="button" onClick={() => appStore.dispatch({type:"helpOpen",open:true})}>Shortcuts</button><span className={styles.spacer} />
    <span className={styles.right}><PerfHud /><span>{displayChord("mod+f")} search · drag select → copy</span></span>
  </footer>;
}
