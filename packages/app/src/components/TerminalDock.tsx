import { useEffect, useMemo, useState, type ReactElement } from "react";
import { PaneDivider } from "./PaneDivider";

// PANE-RESIZE bounds for the dock, mirroring ui-state's own terminalDockResized clamp
// (Math.max(120, Math.min(1200, …))) rather than inventing a second, tighter pair — a divider that
// stops before the reducer would is a control that feels stuck for no visible reason. Delta mode
// has no container to derive a ceiling from, which is why one is passed explicitly.
const DOCK_MIN_HEIGHT = 120;
const DOCK_MAX_HEIGHT = 1200;
// Mirrors ui-state's initialState.terminals.dockHeight — what double-clicking the seam restores.
const DOCK_DEFAULT_HEIGHT = 260;
import { invoke } from "@tauri-apps/api/core";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { isMacPlatform, registerActionHandler } from "../keymap";
import { openTerminalForAgent } from "../state/terminals";
import { reportTerminalTitle } from "../state/terminalSessions";
import { terminalDockForAgent } from "../state/selectors.terminal";
import { TerminalView } from "./TerminalView";
import styles from "./TerminalDock.module.css";

// IN-APP-TERMINAL Task 6: while a terminal owns keyboard focus, every keystroke belongs to
// the shell underneath it — typing a bare `k` or `o` there would otherwise fire the app's
// kill/spawn shortcuts. The dock's own controls (toggle, tab switching) are the ONE exception,
// since they need to work FROM inside the terminal too (there is no other way to close it).
const ALWAYS_LIVE = new Set(["terminal.toggle", "terminal.nextTab", "terminal.prevTab"]);

export function shouldSuppressGlobalKeys(o: { terminalFocused: boolean; action: string }): boolean {
  return o.terminalFocused && !ALWAYS_LIVE.has(o.action);
}

// TERMINAL-DOCK-PER-AGENT: what "terminal.toggle" (⌘J and the header ⌨ button, see
// TranscriptHeader.tsx) means now depends on the SELECTED agent's own tab count — an agent
// with zero tabs gets a brand-new one opened in ITS OWN workdir (never adopts another
// agent's tab, never opens an empty dock); an agent that already has tabs just gets its own
// dock shown/hidden. No-op when no agent is selected (nothing to scope the dock to).
function openOrToggleTerminalDock(): void {
  const state = appStore.getState();
  const agentId = state.selectedAgentId;
  if (agentId === null) return;
  const dock = terminalDockForAgent(state.terminals, agentId);
  if (dock.tabs.length === 0) {
    void openTerminalForAgent(appStore, { id: agentId, workdir: state.agents[agentId]?.workdir });
    return;
  }
  appStore.dispatch({ type: "terminalDockToggled", agentId });
}

// IN-APP-TERMINAL Task 6: dock open-state and height persistence lives in state/persistence.ts
// (loadPersistedTerminalDock/persistTerminalDock), wired once in state/store.ts. Height stays
// global (TERMINAL-DOCK-PER-AGENT); open-state is per-agent and NOT persisted across reload —
// see persistence.ts's own doc comment.
export function TerminalDock(): ReactElement {
  const terminals = useStore((s) => s.terminals);
  const selectedAgentId = useStore((s) => s.selectedAgentId);

  // Derived per-agent view — recomputed only when the terminals slice or the selection
  // actually changes (useStore's selector-discipline: never build fresh objects/arrays
  // straight out of useStore, memoize them at the call site instead).
  const dock = useMemo(() => terminalDockForAgent(terminals, selectedAgentId), [terminals, selectedAgentId]);

  // One place decides what "toggle" means — the transcript header's icon button and the
  // ⌘J capture-phase handler below both dispatch the same "terminal.toggle" action id.
  useEffect(() => registerActionHandler("terminal.toggle", openOrToggleTerminalDock), []);

  // ⌘J must reach the dock even while a terminal has focus — where the shared root hotkey
  // path (keymap.ts's isEditableTarget gate) refuses to resolve ANY chord — and mod+j is
  // already a fully-allocated agents-scope letter (perm.deny, when a permission is pending;
  // see rows.agents.ts's letter-budget accounting), so this can't be a normal KEYMAP row
  // either. A dedicated capture-phase listener, the same pattern AgentsScreen already uses
  // for permission chords, owns it instead — deferring to that handler whenever a permission
  // is actually pending, so mod+j still denies it exactly as before.
  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      const modPressed = mac ? ev.metaKey : ev.ctrlKey;
      if (!modPressed || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== "j") return;
      if (appStore.getState().pendingPermissions.length > 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      openOrToggleTerminalDock();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // PANE-RESIZE: this used to be a hand-rolled drag that bound pointermove to the 6px handle
  // itself. That is the "resize stops halfway" shape — a fast drag outruns the element and the
  // pointer is lost. It now uses the shared PaneDivider, which listens on the window, so the dock
  // gets the same seam, the same double-click reset and the same behaviour as every other split.
  //
  // CONTROLLED, not store-backed: the dock's height already lives in ui-state with its own
  // persistence (terminalDockResized), and a second copy in panes.ts would be two sources for one
  // number.

  const [renaming, setRenaming] = useState<string | null>(null);

  const commitRename = (id: string, title: string): void => {
    setRenaming(null);
    appStore.dispatch({ type: "terminalRenamed", id, title });
    // TERMINAL-NAMES: the name is how an AGENT addresses this tab, so the daemon has to hear about
    // it. Read back from the store rather than trusting the raw input — the reducer trims, and
    // ignores a blank rename entirely.
    const tab = appStore.getState().terminals.tabs.find((t) => t.id === id);
    if (tab) reportTerminalTitle(tab);
  };

  const openNewTab = (): void => {
    if (!selectedAgentId) return;
    void openTerminalForAgent(appStore, { id: selectedAgentId, workdir: appStore.getState().agents[selectedAgentId]?.workdir });
  };

  return (
    // Hidden via `display:none`, never unmounted — every tab (of EVERY agent, not just the
    // selected one) keeps its xterm instance and PTY alive across an agent switch or a dock
    // close/reopen; only an explicit tab close (or a non-zero exit) destroys one. The chrome
    // (handle + tab strip) only renders when the SELECTED agent has at least one tab of its
    // own — a zero-tab agent shows no terminal-related UI at all, per data-terminal-dock's
    // height:0/display:none below.
    <div
      className={styles.dock}
      style={{ height: dock.open ? terminals.dockHeight : 0, display: dock.open ? "flex" : "none" }}
      data-terminal-dock
      data-terminal-dock-agent={selectedAgentId ?? ""}
    >
      {dock.tabs.length > 0 && (
        <>
          <PaneDivider
            axis="y"
            side="after"
            value={terminals.dockHeight}
            min={DOCK_MIN_HEIGHT}
            maxSize={DOCK_MAX_HEIGHT}
            onChange={(height) => appStore.dispatch({ type: "terminalDockResized", height })}
            onReset={() => appStore.dispatch({ type: "terminalDockResized", height: DOCK_DEFAULT_HEIGHT })}
            label="resize terminal dock"
          />
          <div className={styles.tabBar}>
            {dock.tabs.map((tab) => (
              <div key={tab.id} className={tab.id === dock.activeId ? `${styles.tab} ${styles.tabActive}` : styles.tab} data-terminal-tab>
                {renaming === tab.id ? (
                  // TERMINAL-NAMES: renamed in place. The name is a HANDLE — terminal_read and
                  // terminal_write both take one — so it has to be editable where you read it,
                  // not behind a dialog.
                  <input
                    className={styles.tabRename}
                    defaultValue={tab.title}
                    autoFocus
                    data-terminal-tab-rename
                    onBlur={(e) => { commitRename(tab.id, e.currentTarget.value); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(tab.id, e.currentTarget.value); }
                      // Esc abandons: blur would otherwise commit whatever was half-typed.
                      else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                    }}
                  />
                ) : (
                <button
                  type="button"
                  className={styles.tabButton}
                  onClick={() => appStore.dispatch({ type: "terminalActivated", id: tab.id })}
                  onDoubleClick={() => setRenaming(tab.id)}
                  title="double-click to rename"
                >
                  {tab.title}
                  {tab.exited ? " (exited)" : ""}
                </button>
                )}
                <button
                  type="button"
                  className={styles.tabPopOut}
                  aria-label={`pop out ${tab.title} to iTerm`}
                  title="Open in iTerm/Terminal"
                  onClick={() => void invoke("open_in_terminal", { cwd: tab.cwd })}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label={`close terminal ${tab.title}`}
                  onClick={() => appStore.dispatch({ type: "terminalClosed", id: tab.id })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className={styles.newTab} aria-label="new terminal" onClick={openNewTab}>
              +
            </button>
          </div>
        </>
      )}
      <div className={styles.tabBody}>
        {terminals.tabs.map((tab) => (
          <TerminalView key={tab.id} tab={tab} visible={tab.id === dock.activeId} />
        ))}
      </div>
    </div>
  );
}
