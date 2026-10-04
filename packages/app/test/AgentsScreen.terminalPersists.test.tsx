// Harness FIRST — same window/mock ordering every AgentsScreen test needs.
import { keydownHandlers } from "./agents-window-harness";
import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// TERMINAL-SURVIVES-AGENT-SWITCH — open a terminal on one agent, look at another agent's
// transcript, come back: the terminal was dead and could not be reattached.
//
// TerminalDock already kept every tab of every agent mounted (only flipping `visible`), precisely
// because TerminalView's unmount is the ONE place term_close fires. But the dock lived inside
// TranscriptPanel, which AgentsScreen wraps in an ErrorBoundary KEYED BY agentId — so selecting a
// different agent changed the key and React unmounted the whole subtree, PTYs included. An
// invariant a component keeps for itself is still defeated by an ancestor that remounts it.
//
// Same stand-in and the same equivalence TerminalDock.render.test.tsx established: in the real
// TerminalView the unmount cleanup is the only caller of term_close, so "this never unmounts" is
// "the PTY was never killed".

vi.mock("../src/rpc/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rpc/bridge")>();
  return { ...actual, rpcCall: () => Promise.resolve({}), subscribeEvents: async () => {}, onDaemonEvent: () => () => {}, onDaemonState: () => () => {} };
});

const mountEvents: { kind: "mount" | "unmount"; tabId: string }[] = [];
vi.mock("../src/components/TerminalView", () => ({
  TerminalView: ({ tab }: { tab: { id: string } }) => {
    React.useEffect(() => {
      mountEvents.push({ kind: "mount", tabId: tab.id });
      return () => mountEvents.push({ kind: "unmount", tabId: tab.id });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab.id]);
    return React.createElement("div", { "data-terminal-view": tab.id });
  },
}));

const { AgentsScreen } = await import("../src/screens/AgentsScreen");
const { appStore } = await import("../src/state/store");

let seq = 5000;
const seedAgent = (agentId: string): void => {
  seq += 1;
  act(() => {
    appStore.dispatch({ type: "event", event: { seq, ts: seq, agentId, kind: "agent_started", data: {} } } as never);
  });
};
const select = (agentId: string): void => {
  act(() => { appStore.dispatch({ type: "selectAgent", agentId } as never); });
};
const unmounts = (tabId: string): number => mountEvents.filter((e) => e.kind === "unmount" && e.tabId === tabId).length;

describe("a terminal survives looking at another agent", () => {
  it("is not torn down when the selected agent changes, and comes back", () => {
    seedAgent("term-a");
    seedAgent("term-b");
    select("term-a");
    act(() => {
      appStore.dispatch({ type: "terminalOpened", tab: { id: "keep-1", title: "keep-1", cwd: "/repo/a", agentId: "term-a", exited: null } } as never);
    });

    let r!: ReturnType<typeof create>;
    act(() => { r = create(React.createElement(AgentsScreen)); });
    expect(mountEvents.some((e) => e.kind === "mount" && e.tabId === "keep-1")).toBe(true);

    // Look at another agent, then come back — the round trip the operator actually makes.
    select("term-b");
    expect(unmounts("keep-1")).toBe(0);
    select("term-a");
    expect(unmounts("keep-1")).toBe(0);

    act(() => r.unmount());
    keydownHandlers.length = 0;
  });

  it("survives selecting a SHADOW, whose branch renders no transcript panel at all", () => {
    mountEvents.length = 0;
    seedAgent("term-c");
    select("term-c");
    act(() => {
      appStore.dispatch({ type: "terminalOpened", tab: { id: "keep-2", title: "keep-2", cwd: "/repo/c", agentId: "term-c", exited: null } } as never);
    });
    seq += 1;
    act(() => {
      appStore.dispatch({ type: "event", event: { seq, ts: seq, agentId: "shadow:term-c:t1", kind: "agent_task", data: { taskId: "t1", subagentType: "rev", status: "running" } } } as never);
    });

    let r!: ReturnType<typeof create>;
    act(() => { r = create(React.createElement(AgentsScreen)); });
    select("shadow:term-c:t1");
    expect(unmounts("keep-2")).toBe(0);

    act(() => r.unmount());
    keydownHandlers.length = 0;
  });

  it("still tears one down when the tab is actually CLOSED — the fix is not 'never unmount'", () => {
    mountEvents.length = 0;
    seedAgent("term-d");
    select("term-d");
    act(() => {
      appStore.dispatch({ type: "terminalOpened", tab: { id: "gone-1", title: "gone-1", cwd: "/repo/d", agentId: "term-d", exited: null } } as never);
    });

    let r!: ReturnType<typeof create>;
    act(() => { r = create(React.createElement(AgentsScreen)); });
    act(() => { appStore.dispatch({ type: "terminalClosed", id: "gone-1" } as never); });
    expect(unmounts("gone-1")).toBe(1);

    act(() => r.unmount());
    keydownHandlers.length = 0;
  });
});
