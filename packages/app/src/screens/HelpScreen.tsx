import { useMemo, useState } from "react";
import { KEYMAP, desktopKeymap, displayChord, formatPhysicalChord } from "../keymap";
import { bindingConflict, keyboardPreferences, resetKeyboardPreferences, saveKeyboardPreferences, sequenceSuffix, useKeyboardPreferences } from "../state/keyboardPreferences";
import { appStore } from "../state/store";
import styles from "./HelpScreen.module.css";

export function HelpScreen() {
  const preferences = useKeyboardPreferences();
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("system.palette");
  const [value, setValue] = useState(sequenceSuffix(KEYMAP.find(r => r.action === "system.palette")!) ?? "");
  const [message, setMessage] = useState("");
  const editable = useMemo(() => [...new Map(KEYMAP.filter(r => r.chord.startsWith("mod+") && r.chord !== "mod+f" || r.chord.startsWith("leader+") || r.action === "voice.conversationToggle").map(r => [r.action, r])).values()], []);
  const rows = desktopKeymap().filter(r => `${r.label} ${r.scope} ${r.action} ${r.chord}`.toLowerCase().includes(query.toLowerCase()));
  const scopes = [...new Set(rows.map(r => r.scope))];
  const save = () => {
    const next = value.trim().toLowerCase() || null;
    const error = bindingConflict(KEYMAP, action, next);
    if (error) return setMessage(error);
    setMessage(saveKeyboardPreferences({ ...keyboardPreferences(), bindings: { ...keyboardPreferences().bindings, [action]: next } }) ?? "Shortcut saved.");
  };
  return <div className={styles.wrap} data-help-screen>
    <div className={styles.panel}>
      <div className={styles.paneLabel}>Keyboard shortcuts <button onClick={() => appStore.dispatch({type:"helpOpen",open:false})}>Close</button></div>
      <div className={styles.preferences}>
        <p>Press {formatPhysicalChord(preferences.leader)}, release it, then the action key within 3 seconds. Escape cancels. Shortcuts work only inside Chimera; native copy, paste, undo, redo and Tab focus stay available.</p>
        <label>Leader<select value={preferences.leader} onChange={e => setMessage(saveKeyboardPreferences({...preferences, leader:e.target.value as typeof preferences.leader}) ?? "Leader saved.")}>
          <option value="mod+k">{formatPhysicalChord("mod+k")}</option><option value="mod+shift+k">{formatPhysicalChord("mod+shift+k")}</option>
        </select></label>
        <form onSubmit={e => {e.preventDefault(); save();}} className={styles.bindingForm}>
          <label>Action<select value={action} onChange={e => {setAction(e.target.value); setValue(sequenceSuffix(KEYMAP.find(r=>r.action===e.target.value)!) ?? ""); setMessage("");}}>{editable.map(r=><option key={r.action} value={r.action}>{r.label} · {r.scope}</option>)}</select></label>
          <label>Key after leader<input value={value} onChange={e=>setValue(e.target.value)} placeholder="space, n, shift+k; empty disables" /></label>
          <button type="submit">Save shortcut</button>
          <button type="button" onClick={()=>{setMessage(resetKeyboardPreferences() ?? "Defaults restored."); setValue(sequenceSuffix(KEYMAP.find(r=>r.action===action)!) ?? "");}}>Reset defaults</button>
        </form>
        {message && <div role="status">{message}</div>}
        <label>Find a shortcut<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search actions, screens or keys" /></label>
      </div>
      <div className={styles.columns}>{scopes.map(scope=><section key={scope} className={styles.column}>
        <div className={styles.columnTitle}>{scope}</div>
        {rows.filter(r=>r.scope===scope).map(r=><div key={`${r.action}:${r.chord}`} className={styles.row}><span className={styles.chord}>{displayChord(r.chord)}</span><span className={styles.label}>{r.label}</span></div>)}
      </section>)}</div>
      <div className={styles.footer}>No system-wide bindings are registered. If your window manager reserves the leader, select the alternate leader above.</div>
    </div>
  </div>;
}
