import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// DONE-AGENTS-HIDDEN-AFTER-RESTART: a daemon restart terminates every running
// agent at once, moving the whole conversation history behind the "showDone"
// filter simultaneously. Before this fix, showDone was plain component state
// (useState(false)) — a remount (app reload) always reset it to hidden, even
// if the user had just clicked "show". This proves the choice survives a
// fresh mount of AgentList, same harness shape as CommandPalette.test.tsx
// (plain-node vitest env, no jsdom — window/localStorage are shimmed).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
// Node's built-in localStorage (behind --localstorage-file) can exist as an
// object without a usable backing file, so `typeof localStorage` alone isn't
// a reliable undefined-check here — always install a real in-memory shim.
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

import { AgentList } from "../src/components/AgentList";
import { appStore } from "../src/state/store";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  localStorage.removeItem("chimera.agentList.showDone");
});

function seedAllDone(): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId: "done-1", state: "done", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
  });
}

describe("AgentList showDone persistence (DONE-AGENTS-HIDDEN-AFTER-RESTART)", () => {
  it("remembers the user's 'show done' choice across a remount", () => {
    act(() => {
      seedAllDone();
      mounted = create(React.createElement(AgentList));
    });
    const toggle = mounted!.root.findByProps({ "data-agents-done-toggle": "" });
    act(() => toggle.props["onClick"]());
    expect(localStorage.getItem("chimera.agentList.showDone")).toBe("1");

    act(() => mounted!.unmount());
    act(() => {
      mounted = create(React.createElement(AgentList));
    });
    // Post-fix: the done agent row is visible immediately on the fresh mount,
    // because showDone was seeded from localStorage instead of defaulting to false.
    expect(() => mounted!.root.findByProps({ "data-agent-action": "agents.kill" })).not.toThrow();
  });
});

// SYMMETRIC-TOGGLE-LABEL: "hide done" on its own is a bare verb with no count, sitting beside two
// sibling ACTION buttons — so it reads just as easily as a STATE ("done are hidden"), which is the
// opposite of what it means. Reported as "why are done agents still visible, weren't we hiding
// them?" while the toggle was simply switched on. Both states now read as COUNT · verb, so the
// label can only be read as the action it performs.
describe("the done toggle says which way it is", () => {
  const labelOf = (): string => {
    const t = mounted!.root.findByProps({ "data-agents-done-toggle": "" });
    return (Array.isArray(t.props["children"]) ? t.props["children"] : [t.props["children"]])
      .filter((c: unknown) => typeof c === "string").join("");
  };

  it("offers to SHOW while they are hidden, and to HIDE while they are shown — with a count either way", () => {
    act(() => {
      seedAllDone();
      mounted = create(React.createElement(AgentList));
    });
    const hidden = labelOf();
    expect(hidden).toMatch(/done · show$/);
    expect(hidden).toMatch(/\d/);

    act(() => mounted!.root.findByProps({ "data-agents-done-toggle": "" }).props["onClick"]());
    const shown = labelOf();
    expect(shown).toMatch(/done · hide$/);
    expect(shown).toMatch(/\d/);
  });

  it("never renders a bare verb that could be read as the current state", () => {
    act(() => {
      seedAllDone();
      mounted = create(React.createElement(AgentList));
    });
    act(() => mounted!.root.findByProps({ "data-agents-done-toggle": "" }).props["onClick"]());
    expect(labelOf()).not.toBe("hide done");
  });
});

// The direction that was never covered, and the one the operator kept hitting: starting from a
// persisted "show", does clicking the toggle actually HIDE the finished rows? Reported three times
// as "these are still here, I rebuilt and restarted" — a rebuild cannot change it, because the
// choice is persisted on purpose (that is the test above). Only the click can.
describe("clicking the toggle hides the finished rows", () => {
  const rowCount = (): number => mounted!.root.findAllByProps({ "data-agent-action": "agents.kill" }).length;

  it("hides them, starting from a persisted 'show'", () => {
    localStorage.setItem("chimera.agentList.showDone", "1");
    act(() => {
      seedAllDone();
      mounted = create(React.createElement(AgentList));
    });
    // visible to begin with, because the persisted choice says so
    appStore.dispatch({ type: "selectAgent", agentId: "done-1" });
    act(() => {});
    expect(rowCount()).toBeGreaterThan(0);

    act(() => mounted!.root.findByProps({ "data-agents-done-toggle": "" }).props["onClick"]());
    expect(rowCount()).toBe(0);
    // and the choice is cleared, so the next launch starts hidden
    expect(localStorage.getItem("chimera.agentList.showDone")).toBeNull();
  });

  it("a rebuild/restart alone cannot change it — the choice is persisted by design", () => {
    localStorage.setItem("chimera.agentList.showDone", "1");
    act(() => {
      seedAllDone();
      mounted = create(React.createElement(AgentList));
    });
    act(() => mounted!.unmount());
    act(() => { mounted = create(React.createElement(AgentList)); });
    appStore.dispatch({ type: "selectAgent", agentId: "done-1" });
    act(() => {});
    expect(rowCount()).toBeGreaterThan(0);   // still shown — remounting is not a reset
  });
});
