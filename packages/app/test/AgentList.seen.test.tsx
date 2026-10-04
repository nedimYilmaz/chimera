import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F47 (A14/A15): the fleet list's attention surface — an "N new" filter chip, a "mark all seen"
// sweep and a per-row `new` badge that is itself the mark-seen affordance. Same plain-node harness
// as AgentList.showDonePersist.test.tsx (no jsdom — window/localStorage are shimmed).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
const storageBacking = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (storageBacking.has(k) ? storageBacking.get(k)! : null),
  setItem: (k: string, v: string) => { storageBacking.set(k, v); },
  removeItem: (k: string) => { storageBacking.delete(k); },
};

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { rpcCall } from "../src/rpc/bridge";
import { AgentList } from "../src/components/AgentList";
import { appStore } from "../src/state/store";

const UNSEEN_KEY = "chimera.agentList.unseenOnly";
let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  localStorage.removeItem(UNSEEN_KEY);
  vi.mocked(rpcCall).mockClear();
});

// Two unseen (reviewed never / before the attention) and one already read. All RUNNING so the
// done-fold (default: hide terminal) can never be what removes a row from these assertions.
// Every record carries an EXPLICIT reviewedAt, and every seed names the SAME three ids: the store
// is a module singleton and the agentRecords reducer merges field-wise (`r.reviewedAt ?? prev`)
// while keeping unlisted ids as `extras` — so an omitted field or an omitted agent would leak the
// previous test's seen state into this one, and the suite would pass or fail by test order.
function seedFleet(reviewed: readonly [number, number, number] = [0, 100, 900]): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [
      { agentId: "new-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, attentionAt: 300, reviewedAt: reviewed[0] },
      { agentId: "new-2", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, attentionAt: 300, reviewedAt: reviewed[1] },
      { agentId: "old-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 3, attentionAt: 300, reviewedAt: reviewed[2] },
    ],
  });
}

const mount = (): void => {
  act(() => { mounted = create(React.createElement(AgentList)); });
};
// Rows are enumerated by data-agent-row, the row div's own identity — the per-row ACTION hooks
// (agents.kill etc.) render on the SELECTED row alone, so they can count rows but never say which.
const rowIds = (): string[] =>
  mounted!.root.findAll((n) => typeof n.props["data-agent-row"] === "string").map((n) => String(n.props["data-agent-row"]));
const chip = () => mounted!.root.findByProps({ "data-agents-unseen-toggle": "" });
const chipLabel = (): string => {
  const c = chip();
  return (Array.isArray(c.props["children"]) ? c.props["children"] : [c.props["children"]])
    .filter((x: unknown) => typeof x === "string").join("");
};
const seenCalls = (): unknown[][] => vi.mocked(rpcCall).mock.calls.filter((c) => c[0] === "agent.markSeen");

describe("AgentList unseen chip (F47 A14)", () => {
  it("counts the unseen agents and offers to narrow to them, then back to all", () => {
    act(() => { seedFleet(); });
    mount();
    expect(chipLabel()).toContain("2 new");
    expect(chipLabel()).toMatch(/· only$/);

    act(() => chip().props["onClick"]());
    expect(chipLabel()).toMatch(/· all$/);          // the label always names the ACTION, not the state
    expect(rowIds().sort()).toEqual(["new-1", "new-2"]);

    act(() => chip().props["onClick"]());
    expect(rowIds().sort()).toEqual(["new-1", "new-2", "old-1"]);
  });

  it("hides the chip entirely when nothing is unseen — no hollow '0 new'", () => {
    act(() => { seedFleet([900, 900, 900]); });   // the whole fleet read
    mount();
    expect(() => chip()).toThrow();
  });

  it("remembers the narrowed choice across a remount (a reload is not a reset)", () => {
    act(() => { seedFleet(); });
    mount();
    act(() => chip().props["onClick"]());
    expect(localStorage.getItem(UNSEEN_KEY)).toBe("1");

    act(() => mounted!.unmount());
    mount();
    expect(rowIds().sort()).toEqual(["new-1", "new-2"]);
  });
});

describe("AgentList mark-seen affordances (F47 A15)", () => {
  it("the row badge marks exactly that agent seen, and does NOT change the selection", () => {
    act(() => { seedFleet(); appStore.dispatch({ type: "selectAgent", agentId: "old-1" }); });
    mount();
    const badges = mounted!.root.findAllByProps({ "data-agent-action": "agents.markSeen" });
    expect(badges).toHaveLength(2);                 // one per unseen row, none on the read one

    act(() => badges[0]!.props["onClick"]({ stopPropagation: () => {} }));
    expect(seenCalls()).toEqual([["agent.markSeen", { agentIds: ["new-1"] }]]);
    expect(appStore.getState().selectedAgentId).toBe("old-1");
  });

  it("'mark all seen' sweeps every unseen agent in one call", () => {
    act(() => { seedFleet(); });
    mount();
    act(() => mounted!.root.findByProps({ "data-agent-action": "agents.markAllSeen" }).props["onClick"]());
    // skipUnknown marks this as the FLEET sweep (F47.FIX M-2) — the row badge above must not carry it.
    expect(seenCalls()).toEqual([["agent.markSeen", { agentIds: ["new-1", "new-2"], skipUnknown: true }]]);
  });

  // F47.QA2: the chip narrows the rows without touching `query`, so the clamp effect used to skip
  // it — marking the SELECTED agent read left the selection on a row the list no longer draws, and
  // the next ↑/↓ (move()'s indexOf -> -1 -> index 0) teleported to the top of the fleet.
  it("moves the selection off the selected row when it is marked read under the attention-only chip", () => {
    act(() => { seedFleet(); appStore.dispatch({ type: "selectAgent", agentId: "new-1" }); });
    mount();
    act(() => chip().props["onClick"]());
    expect(rowIds()).toEqual(["new-1", "new-2"]);
    expect(appStore.getState().selectedAgentId).toBe("new-1");

    const badge = mounted!.root.findAllByProps({ "data-agent-action": "agents.markSeen" })[0]!;
    act(() => badge.props["onClick"]({ stopPropagation: () => {} }));
    expect(seenCalls()).toEqual([["agent.markSeen", { agentIds: ["new-1"] }]]);
    // the click only sends the RPC; the daemon's status{reviewedAt} fold is what drops the row
    act(() => { seedFleet([300, 100, 900]); });

    expect(rowIds()).toEqual(["new-2"]);
    expect(appStore.getState().selectedAgentId).toBe("new-2");
  });
});
