import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F47.UI: the palette is the ONLY keyboard reach for mark-seen in the app (the keymap's letter
// budget is spent on the agents scope, and an `unbound` keymap row is dropped by keymapCommands),
// so these two entries existing and being runnable IS the feature. Same harness as
// CommandPalette.test.tsx — plain node env, so window/localStorage are shimmed.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
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

import "../src/components/CommandPalette";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  act(() => appStore.dispatch({ type: "paletteOpen", open: false }));
});

function seed(): void {
  act(() => {
    appStore.dispatch({ type: "event", event: { ts: 1000, seq: 1, agentId: "seen-agent", kind: "agent_started", data: { model: "m1" } } });
    appStore.dispatch({ type: "selectAgent", agentId: "seen-agent" });
    appStore.dispatch({ type: "paletteOpen", open: true });
  });
}

const rowIds = (root: ReturnType<typeof create>["root"]) =>
  root.findAll((n) => typeof n.props["data-palette-row"] === "string").map((n) => String(n.props["data-palette-row"]));

describe("command palette: mark-seen has keyboard reach (F47.UI)", () => {
  it("offers both mark-read commands on the agents tab", async () => {
    seed();
    act(() => { mounted = create(React.createElement(OverlayOutlet, { host: "agents" })); });
    const input = mounted!.root.findByProps({ "data-palette-input": true });
    act(() => { input.props.onChange({ target: { value: "mark" } }); });
    await flush();

    const ids = rowIds(mounted!.root).join(" ");
    expect(ids).toContain("agents.markSeen");
    expect(ids).toContain("agents.markAllSeen");
  });
});
