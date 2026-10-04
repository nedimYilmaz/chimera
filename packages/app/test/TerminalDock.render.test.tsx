import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// Same node-env/no-DOM harness as terminalDock.test.ts / BudgetPauseBanner.test.tsx — TerminalDock
// (via store.ts) transitively reaches the Tauri rpc/bridge module and window/keymap.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
if (typeof document === "undefined") {
  (globalThis as unknown as { document: Record<string, unknown> }).document = {
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), className: "" }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "unused") }));

// TerminalView owns real xterm/PTY wiring (untestable headless) — TerminalDock's OWN contract
// under test here is purely "does it keep every tab's view mounted and only flip `visible`",
// so a lightweight stand-in that records mount/unmount + the props it was given is the right
// boundary, not a real terminal. This doubles as the "no term_close" proof: in the REAL
// TerminalView (TerminalView.tsx), the unmount cleanup is the ONLY place term_close is called,
// unconditionally alongside term.dispose() — so "this stand-in never unmounts" is equivalent to
// "term_close was never called" for that tab.
const mountEvents: { kind: "mount" | "unmount"; tabId: string }[] = [];
const renderedProps: Record<string, { tabId: string; visible: boolean }> = {};
vi.mock("../src/components/TerminalView", () => ({
  TerminalView: ({ tab, visible }: { tab: { id: string }; visible: boolean }) => {
    React.useEffect(() => {
      mountEvents.push({ kind: "mount", tabId: tab.id });
      return () => mountEvents.push({ kind: "unmount", tabId: tab.id });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab.id]);
    renderedProps[tab.id] = { tabId: tab.id, visible };
    return React.createElement("div", { "data-terminal-view": tab.id, "data-visible": visible });
  },
}));

const { TerminalDock } = await import("../src/components/TerminalDock");
const { appStore } = await import("../src/state/store");

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

// appStore is the app's real singleton (imported fresh once per test FILE, not per test) —
// every test below uses its OWN unique agent-id pair so leftover tabs from an earlier `it()`
// in this file (the store is never reset between tests) can never be attributed to the wrong
// agent. Where a check unavoidably reads the GLOBAL mount-event log, it filters by this test's
// own tab id rather than asserting the whole log.
function seedAgents(suffix: string): { a1: string; a2: string } {
  const a1 = `a1-${suffix}`;
  const a2 = `a2-${suffix}`;
  act(() => {
    appStore.dispatch({
      type: "agentRecords",
      records: [
        { agentId: a1, treeId: a1, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, workdir: `/repo/${a1}` },
        { agentId: a2, treeId: a2, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, workdir: `/repo/${a2}` },
      ],
    });
  });
  return { a1, a2 };
}

// Each test creates its own react-test-renderer tree over the SAME shared `appStore`
// singleton — a still-mounted renderer from an earlier test keeps re-rendering (and, via the
// mount-everything-globally contract, re-mounting newly-created tabs from LATER tests) unless
// explicitly torn down, so every test's tree is unmounted before the next one runs.
let activeRenderer: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => { activeRenderer?.unmount(); });
  activeRenderer = null;
  mountEvents.length = 0;
  for (const k of Object.keys(renderedProps)) delete renderedProps[k];
});

describe("TerminalDock (TERMINAL-DOCK-PER-AGENT)", () => {
  it("(a) does not render agent A's tabs while agent B is selected, (b) B with zero tabs shows no dock chrome", () => {
    const { a1, a2 } = seedAgents("ab");
    act(() => {
      appStore.dispatch({ type: "selectAgent", agentId: a1 });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "ab-t1", title: "ab-t1", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "ab-t2", title: "ab-t2", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(TerminalDock)); });
    activeRenderer = renderer;
    let tree = renderer.toJSON() as unknown as TreeNode;
    const tabsForA1 = findAll(tree, (n) => "data-terminal-tab" in n.props);
    expect(tabsForA1).toHaveLength(2);
    const dockBefore = findAll(tree, (n) => "data-terminal-dock" in n.props)[0]!;
    expect(dockBefore.props["style"]).toMatchObject({ display: "flex" });

    // Switch to agent B, which has never opened a terminal.
    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a2 }); });
    tree = renderer.toJSON() as unknown as TreeNode;
    expect(findAll(tree, (n) => "data-terminal-tab" in n.props)).toHaveLength(0);
    const dockAfter = findAll(tree, (n) => "data-terminal-dock" in n.props)[0]!;
    expect(dockAfter.props["style"]).toMatchObject({ height: 0, display: "none" });
  });

  it("(c) switching agents does not unmount TerminalView (never calls term_close)", () => {
    const { a1, a2 } = seedAgents("c");
    act(() => {
      appStore.dispatch({ type: "selectAgent", agentId: a1 });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "c-t1", title: "c-t1", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(TerminalDock)); });
    activeRenderer = renderer;
    expect(mountEvents.filter((e) => e.tabId === "c-t1")).toEqual([{ kind: "mount", tabId: "c-t1" }]);

    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a2 }); });
    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a1 }); });

    expect(mountEvents.filter((e) => e.tabId === "c-t1" && e.kind === "unmount")).toHaveLength(0);
    // Still mounted, just hidden while a2 was selected then visible again for a1.
    expect(renderedProps["c-t1"]).toEqual({ tabId: "c-t1", visible: true });
  });

  it("(d) remembers the active tab per agent across a switch", () => {
    const { a1, a2 } = seedAgents("d");
    act(() => {
      appStore.dispatch({ type: "selectAgent", agentId: a1 });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "d-t1", title: "d-t1", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "d-t2", title: "d-t2", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
      // Explicitly reactivate the first tab (terminalOpened auto-activates the newest one).
      appStore.dispatch({ type: "terminalActivated", id: "d-t1" });
    });

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(TerminalDock)); });
    activeRenderer = renderer;
    expect(renderedProps["d-t1"]!.visible).toBe(true);
    expect(renderedProps["d-t2"]!.visible).toBe(false);

    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a2 }); });
    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a1 }); });

    expect(renderedProps["d-t1"]!.visible).toBe(true);
    expect(renderedProps["d-t2"]!.visible).toBe(false);
  });

  it("(e) collapsing agent A's dock does not collapse agent B's", () => {
    const { a1, a2 } = seedAgents("e");
    act(() => {
      appStore.dispatch({ type: "selectAgent", agentId: a1 });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "e-a1-t1", title: "e-a1-t1", cwd: `/repo/${a1}`, agentId: a1, exited: null } });
      appStore.dispatch({ type: "selectAgent", agentId: a2 });
      appStore.dispatch({ type: "terminalOpened", tab: { id: "e-a2-t1", title: "e-a2-t1", cwd: `/repo/${a2}`, agentId: a2, exited: null } });
      appStore.dispatch({ type: "terminalDockToggled", agentId: a1 }); // collapse A while B is selected
    });

    expect(appStore.getState().terminals.openByAgent[a1]).toBe(false);
    expect(appStore.getState().terminals.openByAgent[a2]).toBe(true);

    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(TerminalDock)); });
    activeRenderer = renderer;
    const tree = renderer.toJSON() as unknown as TreeNode;
    const dock = findAll(tree, (n) => "data-terminal-dock" in n.props)[0]!;
    expect(dock.props["style"]).toMatchObject({ display: "flex" }); // B still open

    // A's own state stayed intact — re-selecting it must show its dock open again, tab alive.
    act(() => { appStore.dispatch({ type: "selectAgent", agentId: a1 }); });
    expect(appStore.getState().terminals.openByAgent[a1]).toBe(false); // collapsed, but tab/PTY untouched
    expect(appStore.getState().terminals.tabs.some((t) => t.id === "e-a1-t1")).toBe(true);
  });
});
