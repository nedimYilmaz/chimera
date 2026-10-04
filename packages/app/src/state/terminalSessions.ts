import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalTab, UiState } from "@chimera/ui-state";
import { appStore } from "./store";
import { takeSink, releaseSink } from "./terminals";
import { readToken, terminalTheme } from "../components/terminalConfig";
import { flushTerminalTee, teeTerminalOutput } from "./terminalTee";
import { rpcCall } from "../rpc/bridge";
import "@xterm/xterm/css/xterm.css";

// TERMINAL-LIFETIME — a terminal ends when the OPERATOR ends it, and at no other time.
//
// It used to end whenever React happened to unmount the view, which is a different thing entirely
// and one the operator has no way to predict. Two rounds of this: first an ErrorBoundary keyed by
// agentId (selecting another agent), then AgentsScreen itself unmounting (switching top-level
// tabs). Each fix moved the dock to a stabler owner, and each time a stabler owner turned out to
// have an owner of its own.
//
// So the lifetime is not owned by a component at all. The xterm instance, its DOM element and the
// PTY live here, keyed by tab id; a view borrows the element while it is mounted and hands it back
// untouched. Mounting and unmounting became things that cannot end a session, rather than things
// that are careful not to — the only two things that end one are the tab being closed and the
// agent going away, both of which reach this through the store (see the reaper below).
//
// The element MOVES between containers rather than being re-created. Reparenting a DOM subtree
// preserves it, including the WebGL canvas, so nothing about the running session notices.

export type TerminalSession = {
  id: string;
  /** The element a view adopts. Owned here; never removed by whoever borrowed it. */
  element: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** Set by the mounted view so the terminal's own mod+f can open its find bar. */
  onFindRequested: (() => void) | null;
  destroyed: boolean;
  /** Kept so a tab-state report can be made from the id alone. */
  agentId: string | null;
  /** The CURRENT name. Updated on rename — the tee used to send the title captured when the
   *  session was created, so a renamed tab kept reporting its old name to the daemon forever. */
  title: string;
};

const sessions = new Map<string, TerminalSession>();

// The real factory needs a DOM and a WebGL context, neither of which exists in the node test env —
// and what is worth testing here is the LIFETIME rule (who may end a session), not xterm. Same
// swappable-default shape terminals.ts uses for its open functions.
type SessionFactory = (tab: TerminalTab) => TerminalSession;
let factory: SessionFactory = (tab) => createSession(tab);
export function __setTerminalSessionFactory(next: SessionFactory | null): void {
  factory = next ?? ((tab) => createSession(tab));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function createSession(tab: TerminalTab): TerminalSession {
  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";

  // TERMINAL-USABILITY: this was `new Terminal({convertEol:false, cursorBlink:true})` and nothing
  // else, which is a terminal you can look at but not work in. Every option below is here for a
  // failure someone actually hits:
  const theme = terminalTheme();
  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    // 1000 (the default) loses the top of any real session — a build log, an agent's whole run.
    scrollback: 50_000,
    // Match the app instead of the webview's default monospace. Read from the SAME token the rest
    // of the UI uses so a font change lands in one place.
    fontFamily: readToken("--font-mono") || "ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    // macOS: without this, Option+B/Option+F (readline word motion) send accented characters
    // instead of Meta sequences — a shell that eats your keystrokes reads as broken.
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    // Required by the Unicode 11 provider below.
    allowProposedApi: true,
    ...(theme ? { theme } : {}),   // absent tokens => xterm's own defaults, never a half-palette
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // WIDE-CHARACTER-WIDTHS: xterm's built-in table is Unicode 6 era. Emoji and CJK then measure one
  // cell where the PTY assumed two, and every box-drawn TUI rendered inside this view tears — which
  // is precisely what we are about to do (an agent CLI's own interface lives here).
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";
  // OSC 52 (copy FROM inside the terminal). Loaded through a DYNAMIC import because this addon
  // ships as a UMD bundle that touches `self` at module scope — a static import poisons every test
  // file that transitively reaches this module, in a node env with no `self`.
  void import("@xterm/addon-clipboard")
    .then(({ ClipboardAddon }) => { if (!session.destroyed) term.loadAddon(new ClipboardAddon()); })
    .catch(() => { /* no OSC 52 copy — every other terminal function is unaffected */ });
  const search = new SearchAddon();
  term.loadAddon(search);

  // Opened into the DETACHED element. xterm only needs a parent to measure against, and it
  // re-measures on the first fit once the element is in the document.
  term.open(element);

  const session: TerminalSession = {
    id: tab.id, element, term, fit, search, onFindRequested: null, destroyed: false,
    agentId: tab.agentId, title: tab.title,
  };

  // TERMINAL-RENDER-PERF: the GPU renderer, loaded AFTER open() and kept alive across context
  // loss. Both details are load-bearing for a full-screen TUI (k9s, htop, vim), which repaints the
  // whole grid many times a second — on the DOM renderer that tears and lags visibly.
  //
  // AFTER open(), because WebglAddon.activate() defers itself via onWillOpen when the terminal has
  // no element yet. Loaded before open() the activation — including its "WebGL2 not supported"
  // throw — happens later, OUTSIDE the try/catch written to handle exactly that.
  //
  // onContextLoss, because a webview may drop the GL context at any time. xterm does not recover
  // on its own: the addon must be disposed, which drops it back to the DOM renderer. Re-created
  // ONCE — a context that dies repeatedly is a machine that cannot keep one.
  let webglTries = 0;
  const loadWebgl = (): void => {
    if (session.destroyed || webglTries >= 2) return;
    webglTries++;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();            // back to the DOM renderer immediately rather than a frozen one
        if (!session.destroyed) loadWebgl();
      });
      term.loadAddon(addon);
    } catch {
      // No WebGL2 in this webview — xterm keeps the DOM renderer. Slower, but correct.
    }
  };
  loadWebgl();

  // COPY-PASTE: xterm binds neither. On macOS a terminal without Cmd+C/Cmd+V is the single loudest
  // "this is unusable" complaint, and Cmd+C must NOT be stolen when nothing is selected — that is
  // how you interrupt a process.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || (e.ctrlKey && e.shiftKey);
    if (!mod) return true;
    const k = e.key.toLowerCase();
    if (k === "c" && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      return false;
    }
    if (k === "v") {
      void navigator.clipboard?.readText().then((text) => {
        if (text) void invoke("term_write", { termId: tab.id, data: text });
      });
      return false;
    }
    if (k === "f") { session.onFindRequested?.(); return false; }
    if (k === "a") { term.selectAll(); return false; }
    if (k === "k") { term.clear(); return false; }
    return true;
  });

  // Stateful across chunks: the PTY splits multi-byte characters at arbitrary read boundaries,
  // exactly as it does for xterm's own decoder.
  const decoder = new TextDecoder("utf-8");
  const channel = takeSink(tab.id);
  if (channel) {
    channel.onmessage = (msg) => {
      if (msg.kind === "output") {
        // Decode base64 straight to bytes and hand xterm the Uint8Array directly: xterm does
        // stateful UTF-8 decoding across writes, whereas building a JS string per chunk here would
        // corrupt multibyte characters split across PTY read boundaries.
        const bytes = base64ToBytes(msg.b64);
        term.write(bytes);
        // TERMINAL-READBACK: the same bytes, teed to the daemon so the agent this terminal was
        // opened under can read back what it printed (mcp: terminal_read).
        teeTerminalOutput(tab.agentId, tab.id, session.title, decoder.decode(bytes, { stream: true }));
      } else {
        appStore.dispatch({ type: "terminalExited", id: tab.id, code: msg.code ?? 0 });
      }
    };
  }

  term.onData((d) => { void invoke("term_write", { termId: tab.id, data: d }); });

  // Observes the session's OWN element, not a borrowed container: the element outlives every
  // container it is parented into, so the observer set up here never needs re-wiring.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => refit(session), 50);
  });
  resizeObserver.observe(element);
  resizeObservers.set(tab.id, { observer: resizeObserver, clear: () => { if (resizeTimer) clearTimeout(resizeTimer); } });

  return session;
}

const resizeObservers = new Map<string, { observer: ResizeObserver; clear: () => void }>();

/** Fit to whatever the element currently measures, and tell the PTY. */
function refit(session: TerminalSession): void {
  if (session.destroyed) return;
  const el = session.element;
  // A detached or hidden element measures zero; fitting it would shrink the shell to zero columns
  // and the PTY would reflow every running program to nothing. offsetParent is null for anything
  // not in the document or inside a display:none subtree.
  if (el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return;
  session.fit.fit();
  void invoke("term_resize", { termId: session.id, cols: session.term.cols, rows: session.term.rows });
}

/** The session for `tab`, created on first use. */
export function acquireTerminalSession(tab: TerminalTab): TerminalSession {
  const existing = sessions.get(tab.id);
  if (existing) return existing;
  installReaper();
  const session = factory(tab);
  sessions.set(tab.id, session);
  return session;
}

/** Parent the session's element into `container` and size it. Safe to call repeatedly. */
export function attachTerminalSession(tab: TerminalTab, container: HTMLElement): TerminalSession {
  const session = acquireTerminalSession(tab);
  reportTabState(tab.agentId, tab.id, { title: tab.title });
  session.title = tab.title;
  if (session.element.parentElement !== container) container.appendChild(session.element);
  // After a move the element has a new box, and its ResizeObserver may not fire if the size is
  // unchanged — so fit explicitly rather than waiting to be told.
  refit(session);
  return session;
}

/** Take the element back out of the DOM. Emphatically NOT a teardown: the session keeps running,
 *  which is the entire point of this module. */
export function detachTerminalSession(id: string): void {
  sessions.get(id)?.element.remove();
}

/** Re-measure — called when a hidden tab becomes visible and finally has a real size. */
export function fitTerminalSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  refit(session);
  // Becoming the visible tab IS the focus change an agent's default write target follows; attach
  // alone would only ever report the tab that mounted first.
  reportTabState(session.agentId, id, { active: true, title: session.title });
}

// TERMINAL-TABSTATE: tell the daemon the two things about a tab it cannot see — which one the
// operator is LOOKING at (an agent's default write target) and what it is CALLED (how an agent
// addresses it). Best-effort: a failed hint must never disturb the terminal itself.
//
// Deduplicated on the pair actually sent, not on the tab id. Keying on the id alone was the bug
// this replaced in a different shape: once a tab had been reported, a later RENAME was considered
// already-sent and never reached the daemon.
const lastSent = new Map<string, string>();
function reportTabState(agentId: string | null, termId: string, opts: { active?: boolean; title?: string }): void {
  if (!agentId) return;
  const key = `${agentId} ${termId}`;
  const stamp = `${opts.active ? "1" : "0"} ${opts.title ?? ""}`;
  if (lastSent.get(key) === stamp) return;
  lastSent.set(key, stamp);
  void rpcCall("terminal.tabState", {
    agentId, termId,
    ...(opts.active ? { active: true } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  }).catch(() => { lastSent.delete(key); });   // let the next attempt through
}

/** TERMINAL-NAMES: called when the operator renames a tab, so an agent can address it by the name
 *  now on screen rather than the generated one it was born with. */
export function reportTerminalTitle(tab: TerminalTab): void {
  const session = sessions.get(tab.id);
  if (session) session.title = tab.title;
  reportTabState(tab.agentId, tab.id, { title: tab.title });
}

/** End a session for good: dispose the terminal and close the PTY. */
export function destroyTerminalSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.destroyed = true;
  const ro = resizeObservers.get(id);
  if (ro) { ro.clear(); ro.observer.disconnect(); resizeObservers.delete(id); }
  // Push the tail before the session goes: an agent asking right after a tab closes wants the last
  // thing that was printed, which is the part still sitting in the batch.
  flushTerminalTee();
  releaseSink(id);
  session.element.remove();
  session.term.dispose();
  // The PTY, which is the half that outlives this process's opinion of the session.
  void invoke("term_close", { termId: id });
}

// TERMINAL-WRITE: an agent typing into its own terminal. The daemon has no PTY, so terminal.write
// resolves the target and emits; this is the end that actually performs it. Routed through the
// PTY rather than xterm's own write() on purpose — the shell has to RECEIVE the keystrokes, the
// same as when the operator types them, or the terminal would only be showing text nobody ran.
export function installTerminalInputListener(onEvent: (fn: (e: { kind: string; data: Record<string, unknown> }) => void) => () => void): () => void {
  return onEvent((e) => {
    if (e.kind !== "terminal_input") return;
    const termId = typeof e.data["termId"] === "string" ? e.data["termId"] : "";
    const text = typeof e.data["text"] === "string" ? e.data["text"] : "";
    // Only into a session this app actually holds. The daemon resolved the id from its own record
    // of the agent's terminals, which can outlive the tab if the app restarted.
    if (!termId || !text || !sessions.has(termId)) return;
    void invoke("term_write", { termId, data: text });
  });
}

/** For tests. */
export function liveTerminalSessionIds(): string[] {
  return [...sessions.keys()];
}

// The ONE path that ends a session, driven by state rather than by any component's lifetime: a tab
// that is no longer in the store is a tab the operator closed (or whose agent went away, which
// removes its tabs the same way). Subscribed once, lazily, so importing this module does nothing.
let reaping = false;
function installReaper(): void {
  if (reaping) return;
  reaping = true;
  appStore.subscribe(() => {
    if (sessions.size === 0) return;
    const live = new Set((appStore.getState() as UiState).terminals.tabs.map((t) => t.id));
    for (const id of [...sessions.keys()]) if (!live.has(id)) destroyTerminalSession(id);
  });
}
