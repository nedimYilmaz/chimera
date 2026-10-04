import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { TerminalTab } from "@chimera/ui-state";
import {
  attachTerminalSession, detachTerminalSession, fitTerminalSession, type TerminalSession,
} from "../state/terminalSessions";
import { findOptionsFor } from "./terminalConfig";
import styles from "./TerminalView.module.css";

// TERMINAL-LIFETIME: this component no longer OWNS a terminal — it borrows one.
//
// It used to create the xterm instance in a mount effect and tear it down, PTY and all, in the
// cleanup. That made "is my terminal still alive?" a question about React's render tree, which the
// operator cannot see and cannot predict: twice now a perfectly reasonable ancestor change (an
// ErrorBoundary keyed by agentId, then a screen unmounting on a tab switch) silently killed a
// running session.
//
// Everything that outlives a mount now lives in state/terminalSessions.ts. What is left here is
// the part that genuinely belongs to a mounted view: where the element is parented, whether it is
// visible, and the find bar's own UI state.
export function TerminalView({ tab, visible }: { tab: TerminalTab; visible: boolean }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [finding, setFinding] = useState(false);
  const [needle, setNeedle] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const session = attachTerminalSession(tab, container);
    sessionRef.current = session;
    // The terminal's own mod+f is handled inside the session's key handler (it has to be, to beat
    // xterm's input); it calls back here to open the bar this component renders.
    session.onFindRequested = () => {
      setFinding(true);
      queueMicrotask(() => findInputRef.current?.select());
    };
    return () => {
      session.onFindRequested = null;
      // Hands the element back. Deliberately NOT a teardown — see terminalSessions.ts.
      detachTerminalSession(tab.id);
      sessionRef.current = null;
    };
    // Re-attach only on a different tab; visibility is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // A hidden element measures zero, so a tab that was never visible has never been sized. Fit when
  // it becomes visible, which is the first moment the measurement means anything.
  useEffect(() => {
    if (visible) fitTerminalSession(tab.id);
  }, [visible, tab.id]);

  const run = useCallback((back: boolean) => {
    const s = sessionRef.current?.search;
    if (!s || needle.length === 0) return;
    const opts = findOptionsFor(needle);
    if (back) s.findPrevious(needle, opts); else s.findNext(needle, opts);
  }, [needle]);

  const closeFind = useCallback(() => {
    setFinding(false);
    sessionRef.current?.search.clearDecorations();
    sessionRef.current?.term.focus();   // hand the keyboard straight back; a find that steals focus is a trap
  }, []);

  return (
    <div className={styles.wrap} style={{ display: visible ? "block" : "none" }}>
      {finding ? (
        <div className={styles.find}>
          <input
            ref={findInputRef}
            className={styles.findInput}
            value={needle}
            placeholder="find in terminal"
            autoFocus
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey); }
              else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
            }}
          />
          <button className={styles.findBtn} title="previous (⇧⏎)" onClick={() => run(true)}>↑</button>
          <button className={styles.findBtn} title="next (⏎)" onClick={() => run(false)}>↓</button>
          <button className={styles.findBtn} title="close (esc)" onClick={closeFind}>✕</button>
        </div>
      ) : null}
      <div ref={containerRef} className={styles.screen} />
    </div>
  );
}
