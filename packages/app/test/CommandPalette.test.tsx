import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// R2 QA fix wave 2 (#2) — CommandPalette's ArrowDown/Enter must never target a row past the
// rendered `matches.slice(0, 12)` window. Real store-driven render harness, same conventions as
// ProjectsScreen.test.tsx (a live `renderer.root` TestInstance + the component's own CSS module
// imported for class-identity assertions) and InboxScreen.test.tsx (real appStore singleton,
// rpc/bridge mocked, a bare window shim — this package's vitest env is plain node, no jsdom).
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

// CommandPalette has no named export — it self-registers as an overlay at module-eval time
// (registerOverlay("system.palette", ...)) and is mounted through OverlayOutlet, same as in the
// real app (every screen renders `<OverlayOutlet host="..." />`).
import "../src/components/CommandPalette";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import { appStore } from "../src/state/store";
import styles from "../src/components/CommandPalette.module.css";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// 15 agents named so they sort FIRST, deterministically, ahead of every other entity kind
// (settings sections, MCP tools, the event ring's own "agent_started" rows) under the palette's
// empty-query alphabetical ranking — isolates the render-window/Enter assertions below from
// unrelated catalog contents.
const AGENT_IDS = Array.from({ length: 15 }, (_, i) => `0-agent-${String(i).padStart(2, "0")}`);

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  act(() => appStore.dispatch({ type: "paletteOpen", open: false }));
});

describe("CommandPalette — ArrowDown/Enter never target an off-screen row (only matches.slice(0,12) renders)", () => {
  it("13x ArrowDown keeps the highlight on a rendered row, and Enter runs exactly that visible entity", async () => {
    act(() => {
      AGENT_IDS.forEach((id, i) => {
        appStore.dispatch({ type: "event", event: { ts: 1000 + i, seq: i + 1, agentId: id, kind: "agent_started", data: { model: "m1" } } });
      });
      appStore.dispatch({ type: "paletteOpen", open: true });
    });
    act(() => { mounted = create(React.createElement(OverlayOutlet, { host: "queues" })); });
    const root = mounted!.root;
    const input = () => root.findByProps({ "data-palette-input": true });

    // mode: all -> commands -> entities, so the catalog is entities-only (no keymap/builtin
    // commands mixed into the alphabetical sort ahead of the seeded agents).
    act(() => { input().props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault() {} }); });
    act(() => { input().props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault() {} }); });

    for (let i = 0; i < 13; i++) {
      act(() => { input().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }); });
    }

    const rows = root.findAll((n) => typeof n.props["data-palette-row"] === "string");
    expect(rows.length).toBeLessThanOrEqual(12);
    const selectedIdx = rows.findIndex((r) => String(r.props.className).includes(styles.rowSel));
    // pre-fix, 13 ArrowDown presses against >13 matches clamped the highlight to row 13 — off
    // the rendered 0..11 window, so no row carried the selected class at all.
    expect(selectedIdx).toBeGreaterThanOrEqual(0);
    expect(selectedIdx).toBeLessThanOrEqual(11);

    const selectedRowId = String(rows[selectedIdx]!.props["data-palette-row"]);
    expect(selectedRowId.startsWith("entity:agent:0-agent-")).toBe(true);
    const expectedAgentId = selectedRowId.replace("entity:agent:", "");

    act(() => { input().props.onKeyDown({ key: "Enter", preventDefault() {} }); });
    await flush();

    // Enter fired the entry actually highlighted on screen, not matches[13] (off-screen).
    expect(appStore.getState().navigation.target).toEqual({ kind: "agent", agentId: expectedAgentId });
  });
});
