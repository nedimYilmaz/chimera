import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { useEffect } from "react";
import { act, create } from "react-test-renderer";

// SEARCH-SELECTION-PING-PONG. Reported as the app freezing the instant you type in the AGENT
// LIST's search box, with memory climbing — and it is a real unbounded loop, not slow rendering.
//
// Two effects, each correct alone, dispatch each other's undo:
//
//   1. AgentList's selection clamp: when a query narrows the selected agent out of the rows, it
//      re-points the selection at listRows[0]. `idOf` maps a GROUP BOX row to its synthetic
//      "group:<id>" — an id no agent has. (jobGroup rows were already excepted here; the group
//      box shipped later and was not.)
//   2. AgentsScreen's validity effect: a selection that resolves to no agent is bounced back to
//      agentOrder[0]. Its escape hatch covers "task:<id>" and nothing else.
//
// So: type one character -> clamp selects "group:personal" -> the screen bounces to a real agent
// -> that agent does not match the query -> the clamp selects the group again -> forever. Both
// dispatches guard against re-selecting the SAME id, which is why neither loops on its own; the
// ping-pong is between two DIFFERENT ids.
//
// Measured against this operator's own daemon log: 115,729 rejected `agent.status` calls for
// exactly "group:personal" (63% of every line in the log), in bursts up to 960/sec — one pair of
// RPCs per cycle from the checkpoint strip and the plugin catalog, both of which refetch on every
// selection change.
//
// The fix makes the clamp resolve a row to a SELECTABLE id — visibleListRowIds is already the
// one definition of "ids nav can land on", and it has always recursed into a group box's members
// rather than emitting the box itself.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
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

import type { UiState } from "@chimera/ui-state";
import { AgentList } from "../src/components/AgentList";
import { useStore } from "../src/state/useStore";
import { taskIdFromRowId } from "../src/state/selectors.workflows";
import { appStore } from "../src/state/store";

// The operator's own fleet + groups, read off the live daemon at the time of the report.
const FLEET = [
  ["c27ae48d", "paused"], ["dce669c7", "paused"], ["405325ac", "killed"], ["4666ef81", "killed"],
  ["6a8aa9a0", "paused"], ["20cee4e1", "paused"], ["c8763e28", "paused"], ["bd82222f", "paused"],
] as const;
const IN_BOX = "c27ae48d";       // brisk-vole — inside the Personal box, and the search target
const OUTSIDE_BOX = "6a8aa9a0";  // mellow-panda — outside it, and NOT a match for "brisk"

/** Seeds the fleet and parks the selection on `selected`. The selection matters: the clamp has
 *  two halves, and only a selection the query EVICTS reaches the fallback that produced the bad
 *  id in production. */
function seedFleet(selected: string): void {
  act(() => {
    appStore.dispatch({ type: "groups", available: true, items: [
      { id: "personal", name: "Personal", createdAt: 2, order: 1 },
    ] } as never);
    appStore.dispatch({ type: "agentRecords", records: FLEET.map(([agentId, state], i) => ({
      agentId, state, accountName: "main", provider: "claude", costUsd: i, createdAt: 1000 + i,
      groups: i < 4 ? ["personal"] : undefined,        // the first four sit in the Personal box
    })) } as never);
    appStore.dispatch({ type: "selectAgent", agentId: selected });
  });
}

/** AgentsScreen's validity effect, verbatim (screens/AgentsScreen.tsx) — the OTHER half of the
 *  ping-pong. Reproduced rather than imported because mounting the whole screen needs a DOM this
 *  suite does not have, and it is these four lines that close the cycle. */
function ValidityStub(): null {
  const selectedId = useStore((s: UiState) => s.selectedAgentId);
  const agentOrder = useStore((s: UiState) => s.agentOrder);
  useEffect(() => {
    const stillValid = !!selectedId
      && (!!appStore.getState().agents[selectedId] || taskIdFromRowId(selectedId) !== null);
    if (!stillValid && agentOrder.length > 0) {
      appStore.dispatch({ type: "selectAgent", agentId: agentOrder[0]! });
    }
  }, [selectedId, agentOrder]);
  return null;
}

const DISPATCH_CAP = 50;

/** Mounts the list (optionally alongside the validity stub), types `query` one character at a
 *  time, and returns every selectAgent id dispatched. Past DISPATCH_CAP the dispatch is swallowed
 *  so a regression reports a failed assertion instead of hanging the suite. */
function mountAndType(query: string, withValidityStub = false): string[] {
  const selections: string[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  const realDispatch = appStore.dispatch.bind(appStore);
  (appStore as unknown as { dispatch: unknown }).dispatch = (a: { type: string; agentId?: string }) => {
    if (a.type === "selectAgent") {
      selections.push(String(a.agentId));
      if (selections.length > DISPATCH_CAP) return undefined;
    }
    return realDispatch(a as never);
  };
  try {
    act(() => {
      renderer = create(React.createElement(React.Fragment, null,
        React.createElement(AgentList),
        withValidityStub ? React.createElement(ValidityStub) : null,
      ));
    });
    let onChange: ((v: string) => void) | undefined;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as { props?: Record<string, unknown>; children?: unknown[] };
      const p = node.props ?? {};
      if (p["data-agents-search"] !== undefined && typeof p.onChange === "function") {
        onChange = (v: string) => (p.onChange as (e: unknown) => void)({ target: { value: v } });
      }
      (node.children ?? []).forEach(walk);
    };
    walk(renderer!.toJSON());
    if (!onChange) throw new Error("agents search input not found");
    for (let i = 1; i <= query.length; i++) act(() => { onChange!(query.slice(0, i)); });
    return selections;
  } finally {
    act(() => renderer?.unmount());
    (appStore as unknown as { dispatch: unknown }).dispatch = realDispatch;
  }
}

describe("typing in the agent-list search box cannot select a non-agent row", () => {
  it("owns initial selection and chooses a visible agent without the screen validity effect", () => {
    seedFleet(OUTSIDE_BOX);
    act(() => appStore.dispatch({ type: "selectAgent", agentId: null }));
    const selections = mountAndType("");
    expect(selections).toHaveLength(1);
    expect(appStore.getState().agents[selections[0]!]!.state).not.toBe("killed");
  });
  it("re-points an evicted selection at a REAL member of the box, not the box", () => {
    // The selection starts OUTSIDE the Personal box on an agent "brisk" does not match, so the
    // query evicts it and the clamp's fallback — the line that produced "group:personal" — is the
    // thing under test. Asserted as an exact dispatch list: one selection, to the real member.
    seedFleet(OUTSIDE_BOX);
    expect(mountAndType("brisk")).toEqual([IN_BOX]);
  });

  it("leaves a selection AgentsScreen's own validity rule accepts", () => {
    // The ping-pong needs the two sides to DISAGREE about what a valid selection is. This asserts
    // the property that makes them agree, in the same terms AgentsScreen uses, so a future
    // synthetic row kind cannot reintroduce the loop by being added to `idOf` alone.
    seedFleet(OUTSIDE_BOX);
    mountAndType("brisk");
    const st = appStore.getState();
    expect(st.selectedAgentId && st.agents[st.selectedAgentId]).toBeTruthy();
  });

  it("does not ping-pong with AgentsScreen's validity effect", () => {
    // The cycle itself, both halves mounted together. Pre-fix the clamp selects "group:personal",
    // the validity rule bounces to agentOrder[0], that agent does not match "brisk", and the clamp
    // selects the box again — observed here as the box id being dispatched over and over.
    //
    // This renderer settles each act() pass synchronously, so the cycle shows up as REPEATED
    // dispatches rather than as a hang; the browser, driving the same two effects off real commits,
    // is where it does not settle — the daemon logged 115,729 rejected agent.status calls for this
    // one id in bursts up to 960/sec. DISPATCH_CAP is therefore a hang guard, not the assertion.
    seedFleet(OUTSIDE_BOX);
    const selections = mountAndType("brisk", true);
    expect(selections.length).toBeLessThan(DISPATCH_CAP);
    expect(selections.filter((id) => id.startsWith("group:"))).toEqual([]);
  });
});
