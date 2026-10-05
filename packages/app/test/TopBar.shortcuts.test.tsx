import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// UX26-UI: the tab strip prints each slot's keyboard digit before its label, so the Roles tab reads
// "0 roles" — indistinguishable from "zero roles" in a screenshot or to a screen reader.  The digit
// is a KEY, never a count: it must be named as a shortcut (tooltip + aria-keyshortcuts) and kept out
// of the accessible name, while key bindings and the visible text stay exactly as they were.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

// Node 25 ships a bare `localStorage` whose setItem throws, which makes saveKeyboardPreferences
// refuse every rebind — shim it (same pattern as the AgentList tests) or the rebind tests below
// would exercise an unchanged keymap.
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

import { TopBar } from "../src/components/TopBar";
import { appStore } from "../src/state/store";
import { APP_TABS } from "../src/keymap/rows.tabs";
import { actionChord, handleHotkey } from "../src/keymap";
import { resetKeyboardPreferences, saveKeyboardPreferences } from "../src/state/keyboardPreferences";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
const connectedWithAccount = { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts: [{ name: "a", provider: "claude" }] };
const connectedNoAccounts = { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts: [] };

const textOf = (n: Json | string | null, skipHidden: boolean): string => {
  if (n === null) return "";
  if (typeof n === "string") return n;
  if (skipHidden && n.props["aria-hidden"] === "true") return "";
  return (n.children ?? []).map((c) => textOf(c, skipHidden)).join("");
};

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  resetKeyboardPreferences();
});

function mountStrip(status: unknown): Json {
  act(() => {
    appStore.dispatch({ type: "daemonStatus", status: status as never });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
  });
  act(() => { mounted = create(React.createElement(TopBar)); });
  return mounted!.toJSON() as unknown as Json;
}

const find = (n: Json | string | null, pred: (j: Json) => boolean, out: Json[] = []): Json[] => {
  if (n === null || typeof n === "string") return out;
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) find(c, pred, out);
  return out;
};
const tabButton = (tree: Json, id: string) => find(tree, (n) => n.props["data-topbar-tab"] === id)[0]!;

describe("TopBar — tab digits are shortcuts, not counts", () => {
  it("roles: the visible '0' stays, but it is hidden from the accessible name and named as a shortcut", () => {
    const roles = tabButton(mountStrip(connectedWithAccount), "roles");

    expect(textOf(roles, false)).toBe("0 roles"); // visible text unchanged
    expect(textOf(roles, true).trim()).toBe("roles"); // accessible name carries no digit (name computation collapses the gap)
    expect(roles.props["title"]).toBe("roles — press 0");
    expect(roles.props["aria-keyshortcuts"]).toBe("0");
  });

  it("every numbered slot exposes its own digit as the shortcut and the digit/label pair matches APP_TABS", () => {
    const tree = mountStrip(connectedWithAccount);
    for (const slot of APP_TABS.filter((s) => s.tab !== null && s.num !== null)) {
      const btn = tabButton(tree, slot.tab!);
      expect(btn.props["aria-keyshortcuts"], slot.label).toBe(String(slot.num));
      expect(btn.props["title"], slot.label).toBe(`${slot.label} — press ${slot.num}`);
    }
  });

  it("a leader-sequence slot (runs) has no digit, so it must not invent an aria-keyshortcuts value", () => {
    const runs = tabButton(mountStrip(connectedWithAccount), "runs");

    expect(runs.props["aria-keyshortcuts"]).toBeUndefined();
    expect(String(runs.props["title"])).toMatch(/^runs — press /);
    expect(textOf(runs, true).trim()).toBe("runs");
  });

  it("a locked tab keeps the unlock hint and advertises no shortcut it cannot honour", () => {
    const roles = tabButton(mountStrip(connectedNoAccounts), "roles");

    expect(roles.props["title"]).toBe("connect a provider to unlock");
    expect(roles.props["aria-keyshortcuts"]).toBeUndefined();
    expect(roles.props["disabled"]).toBe(true);
  });
});

// The digit is a raw key: handleHotkey resolves it over KEYMAP and keyboard preferences only
// rewrite the leader SEQUENCE.  So a rebind leaves the digit live and ADDS a key, and an unbind
// removes only the sequence — the hints must follow that, never advertise a key that no longer
// works or hide one that still does.
const pressDigit = (key: string): void => {
  handleHotkey({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, repeat: false, preventDefault: () => {} }, appStore);
};
const rebind = (action: string, suffix: string | null): void => {
  act(() => { expect(saveKeyboardPreferences({ leader: "mod+k", bindings: { [action]: suffix } })).toBeNull(); });
};
const stripNow = (): Json => mounted!.toJSON() as unknown as Json;

describe("TopBar — shortcut hints follow keyboard rebinding", () => {
  it("rebinding re-renders the tooltip: the digit AND the new leader sequence are listed, and the digit still navigates", () => {
    mountStrip(connectedWithAccount);
    expect(tabButton(stripNow(), "roles").props["title"]).toBe("roles — press 0");

    rebind("tab.roles", "x");
    const roles = tabButton(stripNow(), "roles");
    const sequence = actionChord("tab.roles");

    expect(sequence).toMatch(/→ x$/); // the rebind really took effect
    expect(roles.props["title"]).toBe(`roles — press 0 or ${sequence}`);
    expect(textOf(roles, false)).toBe("0 roles"); // the printed digit is still a working key…
    act(() => { appStore.dispatch({ type: "selectTab", tab: "agents" }); });
    act(() => pressDigit("0"));
    expect(appStore.getState().activeTab).toBe("roles"); // …so it must not be hidden
    expect(roles.props["aria-keyshortcuts"]).toBe("0");
  });

  it("unbinding the sequence drops it from the hint but keeps the digit that still works", () => {
    mountStrip(connectedWithAccount);
    rebind("tab.roles", null);

    expect(actionChord("tab.roles")).toBe("unbound");
    const roles = tabButton(stripNow(), "roles");
    expect(roles.props["title"]).toBe("roles — press 0");
    expect(textOf(roles, false)).toBe("0 roles");
    act(() => { appStore.dispatch({ type: "selectTab", tab: "agents" }); });
    act(() => pressDigit("0"));
    expect(appStore.getState().activeTab).toBe("roles");
  });

  it("a numberless slot (runs) shows only its rebound sequence and never grows a digit or aria value", () => {
    mountStrip(connectedWithAccount);
    rebind("tab.runs", "u");
    const runs = tabButton(stripNow(), "runs");

    expect(runs.props["title"]).toBe(`runs — press ${actionChord("tab.runs")}`);
    expect(actionChord("tab.runs")).toMatch(/→ u$/);
    expect(runs.props["aria-keyshortcuts"]).toBeUndefined();
    expect(textOf(runs, false)).toBe("runs");
  });
});
