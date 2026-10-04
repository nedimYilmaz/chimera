import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "@chimera/ui-state";

// TERMINAL-LIFETIME — a terminal ends when the OPERATOR ends it, and at no other time.
//
// It used to end whenever React unmounted the view, which is a different thing and one the
// operator cannot predict. Twice a reasonable ancestor change killed a running session: an
// ErrorBoundary keyed by agentId (selecting another agent), then AgentsScreen unmounting (a
// top-level tab switch). Each fix moved the dock to a stabler owner and each stabler owner turned
// out to have an owner of its own.
//
// What is pinned here is the RULE, not xterm: attaching and detaching a view must never end a
// session, and the only things that may are the tab leaving the store and the process ending it
// explicitly. The real factory needs a DOM and a GL context, so a stand-in stands in for it —
// which is also the honest boundary, since none of the above is about terminal emulation.

const closed: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "term_close") closed.push(String(args?.["termId"]));
    return undefined;
  }),
}));
// store.ts reaches the bridge, which fires real Tauri listen()/invoke() at import time in DEV.
vi.mock("../src/rpc/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rpc/bridge")>();
  return { ...actual, rpcCall: async () => ({}), subscribeEvents: async () => {}, onDaemonEvent: () => () => {}, onDaemonState: () => () => {} };
});
// The real module imports xterm's CSS and the addon bundles; neither survives a node env, and
// neither is what these tests are about.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const {
  __setTerminalSessionFactory, acquireTerminalSession, attachTerminalSession,
  detachTerminalSession, destroyTerminalSession, liveTerminalSessionIds,
} = await import("../src/state/terminalSessions");
const { appStore } = await import("../src/state/store");

const disposed: string[] = [];
const removed: string[] = [];

/** A session with no terminal in it — every field the lifetime rules actually touch. */
function fakeSession(tab: TerminalTab) {
  return {
    id: tab.id,
    // offsetParent null = not in a rendered document, which is exactly true of this stand-in — so
    // refit() takes its own "nothing to measure" path rather than needing a fake layout.
    element: {
      parentElement: null as unknown, offsetParent: null, clientWidth: 0, clientHeight: 0,
      remove: () => removed.push(tab.id),
    } as unknown as HTMLDivElement,
    term: { dispose: () => disposed.push(tab.id) } as never,
    fit: { fit: () => {} } as never,
    search: {} as never,
    onFindRequested: null,
    destroyed: false,
  };
}

const tab = (id: string, agentId = "a1"): TerminalTab =>
  ({ id, title: id, cwd: "/repo", agentId, exited: null }) as TerminalTab;

const container = (): HTMLElement => ({ appendChild: () => {} }) as unknown as HTMLElement;

beforeEach(() => {
  closed.length = 0; disposed.length = 0; removed.length = 0;
  __setTerminalSessionFactory(fakeSession as never);
});
afterEach(() => {
  for (const id of liveTerminalSessionIds()) destroyTerminalSession(id);
  __setTerminalSessionFactory(null);
});

describe("a terminal session's lifetime", () => {
  it("is created once and reused — re-attaching does not build a second one", () => {
    const first = acquireTerminalSession(tab("t1"));
    const second = attachTerminalSession(tab("t1"), container());
    expect(second).toBe(first);
    expect(liveTerminalSessionIds()).toEqual(["t1"]);
  });

  it("SURVIVES a detach — that is the whole point", () => {
    // A view unmounting (agent switch, tab switch, dock closing) hands the element back. None of
    // those is the operator ending the terminal, so none of them may.
    attachTerminalSession(tab("t1"), container());
    detachTerminalSession("t1");
    expect(liveTerminalSessionIds()).toEqual(["t1"]);
    expect(closed).toEqual([]);
    expect(disposed).toEqual([]);
  });

  it("survives being detached and re-attached repeatedly", () => {
    const created = attachTerminalSession(tab("t1"), container());
    for (let i = 0; i < 5; i++) {
      detachTerminalSession("t1");
      expect(attachTerminalSession(tab("t1"), container())).toBe(created);
    }
    expect(closed).toEqual([]);
  });

  it("closes the PTY when it is explicitly destroyed", () => {
    attachTerminalSession(tab("t1"), container());
    destroyTerminalSession("t1");
    expect(closed).toEqual(["t1"]);
    expect(disposed).toEqual(["t1"]);
    expect(liveTerminalSessionIds()).toEqual([]);
  });

  it("is destroyed when its tab leaves the store, and only that one", () => {
    // The store is the one authority on which terminals exist: the operator closing a tab, and an
    // agent going away taking its tabs with it, both arrive here the same way.
    for (const t of ["keep", "gone"]) {
      appStore.dispatch({ type: "terminalOpened", tab: tab(t) } as never);
      attachTerminalSession(tab(t), container());
    }
    appStore.dispatch({ type: "terminalClosed", id: "gone" } as never);
    expect(closed).toEqual(["gone"]);
    expect(liveTerminalSessionIds()).toEqual(["keep"]);
    appStore.dispatch({ type: "terminalClosed", id: "keep" } as never);
  });

  it("does not close a PTY twice if destroy is called again", () => {
    attachTerminalSession(tab("t1"), container());
    destroyTerminalSession("t1");
    destroyTerminalSession("t1");
    expect(closed).toEqual(["t1"]);
  });

  it("keeps sessions for different tabs independent", () => {
    attachTerminalSession(tab("t1"), container());
    attachTerminalSession(tab("t2"), container());
    destroyTerminalSession("t1");
    expect(closed).toEqual(["t1"]);
    expect(liveTerminalSessionIds()).toEqual(["t2"]);
  });
});
