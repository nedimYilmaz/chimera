import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// TOPBAR-OVERFLOW — the responsive tab strip's React shell. This package's
// vitest env is plain node (no jsdom/ResizeObserver), so both are stubbed:
// a FakeResizeObserver whose callback the test invokes manually to simulate a
// resize, and createNodeMock supplying fake getBoundingClientRect widths per
// measured node (bar/brand/chips + the per-tab shadow-measurer copies,
// identified by the data-topbar-* hooks TopBar.tsx renders for exactly this).
// The pure fit math itself (splitTabs) is covered without any of this
// machinery in selectors.tabs.test.ts.

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof document === "undefined") {
  (globalThis as unknown as { document: Record<string, unknown> }).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

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

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
const byData = (node: TreeNode, attr: string) => findAll(node, (n) => n.props[attr] !== undefined)[0];
// Scoped to the LIVE nav only — the shadow measurer (see TopBar.tsx) always
// renders every label too, off-screen, so an unscoped search double-counts.
const hasLabel = (nav: TreeNode, label: string) =>
  findAll(nav, (n) => Array.isArray(n.children) && n.children.includes(label)).length > 0;

const connectedWithAccount = {
  protocolVersion: 1,
  agents: { running: 0, done: 0, failed: 0, killed: 0 },
  accounts: [{ name: "a", provider: "claude" }],
};

// Roughly-realistic per-label natural widths (num 1..9), independent of gap —
// the shell adds TAB_GAP itself.
// ROLES-TAB S5: the tenth slot (num 0, "roles") joins the widths table too.
const TAB_WIDTHS: Record<number, number> = { 1: 70, 2: 86, 3: 64, 4: 72, 5: 70, 6: 72, 7: 86, 8: 62, 9: 50, 0: 56 };
// F13.2: the eleventh slot ("runs") has num:null, so it renders
// data-topbar-measure={null} and gets no entry in the numbered table above —
// it still has to be measurable, or the mock hands the shell a node with no
// getBoundingClientRect at all.
const NUMBERLESS_TAB_WIDTH = 54;

// Mutable so a test can simulate a live resize between renders.
const measured = { bar: 1102, brand: 110, chips: 250 };

function rectOf(getWidth: () => number) {
  return () => {
    const width = getWidth();
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 };
  };
}

// getWidth is called live on every getBoundingClientRect() invocation (not
// captured at mock-creation time) so a test can mutate `measured` between an
// initial mount and a later simulated resize.
const createNodeMock = (element: { props?: Record<string, unknown> }) => {
  const props = element.props ?? {};
  if (props["data-topbar-bar"] !== undefined) return { getBoundingClientRect: rectOf(() => measured.bar) };
  if (props["data-topbar-brand"] !== undefined) return { getBoundingClientRect: rectOf(() => measured.brand) };
  if (props["data-topbar-chips"] !== undefined) return { getBoundingClientRect: rectOf(() => measured.chips) };
  if ("data-topbar-measure" in props) {
    const num = props["data-topbar-measure"];
    return { getBoundingClientRect: rectOf(() => (typeof num === "number" ? TAB_WIDTHS[num] ?? 60 : NUMBERLESS_TAB_WIDTH)) };
  }
  return {};
};

let mounted: ReturnType<typeof create> | null = null;
beforeEach(() => {
  FakeResizeObserver.instances = [];
  measured.bar = 1102;
  measured.brand = 110;
  measured.chips = 250;
  act(() => {
    appStore.dispatch({ type: "daemonStatus", status: connectedWithAccount as never });
    appStore.dispatch({ type: "selectTab", tab: "agents" });
  });
});
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("TopBar — TOPBAR-OVERFLOW (responsive tab strip)", () => {
  it("renders every tab with no overflow control when the strip fits", () => {
    measured.bar = 1600; // available comfortably exceeds the 9-tab total
    act(() => { mounted = create(React.createElement(TopBar), { createNodeMock }); });
    const root = mounted!.root as unknown as TreeNode;
    expect(byData(root, "data-tab-overflow")).toBeUndefined();
    const nav = byData(root, "data-topbar-nav");
    for (const label of ["agents", "projects", "teams", "queues", "events", "memory", "settings", "inbox", "slo", "roles"]) {
      expect(hasLabel(nav, label)).toBe(true);
    }
  });

  it("collapses into an overflow control when the strip doesn't fit, dropping the highest slot numbers first", () => {
    // available=434 -> budget=380: agents(92)+projects(108)+teams(86)+queues(94)=380 exactly, memory..slo overflow.
    measured.bar = 882;
    act(() => { mounted = create(React.createElement(TopBar), { createNodeMock }); });
    const root = mounted!.root as unknown as TreeNode;
    const nav = byData(root, "data-topbar-nav");
    for (const label of ["agents", "projects", "teams", "queues"]) {
      expect(hasLabel(nav, label)).toBe(true);
    }
    expect(byData(root, "data-tab-overflow")).toBeDefined();
    // events/memory/settings/inbox/slo/roles all collapsed — none render in the live nav anymore.
    for (const label of ["events", "memory", "settings", "inbox", "slo", "roles"]) {
      expect(hasLabel(nav, label)).toBe(false);
    }
  });

  it("widening the window restores the strip (reversible, not one-way)", () => {
    measured.bar = 882;
    act(() => { mounted = create(React.createElement(TopBar), { createNodeMock }); });
    let root = mounted!.root as unknown as TreeNode;
    expect(byData(root, "data-tab-overflow")).toBeDefined();

    measured.bar = 1600;
    act(() => { for (const ro of FakeResizeObserver.instances) ro.cb(); });
    root = mounted!.root as unknown as TreeNode;
    expect(byData(root, "data-tab-overflow")).toBeUndefined();
    expect(hasLabel(byData(root, "data-topbar-nav"), "slo")).toBe(true);
  });

  it("keeps the active tab visible even when it would otherwise collapse, and clicking a hidden tab in the popup selects it", () => {
    measured.bar = 882; // only agents/projects/teams/queues fit
    act(() => { mounted = create(React.createElement(TopBar), { createNodeMock }); });
    const root = mounted!.root as unknown as TreeNode;

    const overflowBtn = byData(root, "data-tab-overflow");
    act(() => { (overflowBtn.props["onClick"] as () => void)(); });
    const popup = byData(mounted!.root as unknown as TreeNode, "data-tab-overflow-popup");
    expect(popup).toBeDefined();
    const settingsRow = findAll(popup, (n) => Array.isArray(n.children) && n.children.includes("settings"))[0];
    expect(settingsRow).toBeDefined();

    act(() => { (settingsRow!.props["onClick"] as () => void)(); });
    expect(appStore.getState().activeTab).toBe("settings");
    // the popup closes on selection, and "settings" (the now-active tab) is pinned into the live nav.
    const after = mounted!.root as unknown as TreeNode;
    expect(byData(after, "data-tab-overflow-popup")).toBeUndefined();
    expect(hasLabel(byData(after, "data-topbar-nav"), "settings")).toBe(true);
  });

  it("surfaces an aggregate badge on the overflow control when a badged tab collapses", () => {
    act(() => {
      for (let i = 1; i <= 3; i++) {
        appStore.dispatch({ type: "event", event: { ts: i, seq: i, agentId: "a1", kind: "error", data: {} } as never });
      }
    });
    // available=380 -> budget=326: agents(92)+projects(108)+teams(86)=286 fits, queues(94) and events(92) don't -> both collapse.
    measured.bar = 828;
    act(() => { mounted = create(React.createElement(TopBar), { createNodeMock }); });
    const root = mounted!.root as unknown as TreeNode;
    expect(hasLabel(byData(root, "data-topbar-nav"), "events")).toBe(false);
    const overflowBadge = byData(root, "data-tab-overflow-badge");
    expect(overflowBadge).toBeDefined();
    expect(String(overflowBadge!.children?.[0])).toBe("3");
  });

  // The measurement path is best-effort by contract: a ref is not guaranteed to
  // be a laid-out DOM element (any non-DOM host, or a slot the host doesn't
  // recognise, hands back a bare object). Calling getBoundingClientRect there
  // threw out of the layout effect and took the whole shell down — the shell
  // must degrade to "everything visible" instead.
  it("degrades to the full strip when a measured node exposes no layout API, instead of throwing", () => {
    measured.bar = 882; // narrow enough that a working measurement WOULD collapse slots
    const blindNodeMock = () => ({}); // every node: no getBoundingClientRect
    expect(() => {
      act(() => { mounted = create(React.createElement(TopBar), { createNodeMock: blindNodeMock }); });
    }).not.toThrow();
    const nav = byData(mounted!.root as unknown as TreeNode, "data-topbar-nav");
    expect(byData(mounted!.root as unknown as TreeNode, "data-tab-overflow")).toBeUndefined();
    expect(hasLabel(nav, "runs")).toBe(true);
  });

  it("never gives .tabs an overflow ancestor that can clip the popup — the tab strip's own clip lives on .tabList, a sibling of .tabWrap", async () => {
    // TAB-STRIP-STILL-WRONG-AT-TEN-SLOTS: react-test-renderer has no layout
    // engine, so the popup-invisible bug can't be caught by asserting on the
    // render tree (see the other tests in this file, all of which passed
    // even with the popup invisible). A prior fix (9edb12e) set
    // `.tabs { overflow-x: hidden; overflow-y: visible }`, believing that
    // clips only the x-axis — but per the CSS overflow spec, when one axis
    // is anything but "visible" the OTHER "visible" axis computes to "auto",
    // not "visible". So .tabs still became a scroll container once the
    // ~230px-tall popup (a descendant, via .tabWrap) overflowed its own
    // ~22px box: the popup scrolled out of view instead of rendering, and
    // the resulting vertical scrollbar painted as a stray bar right where
    // the tab strip meets the status chips. Fix: give NO axis on .tabs any
    // non-"visible" value at all — the horizontal clip moves to .tabList, a
    // wrapper around only the tab pills; .tabWrap (button + popup) is a
    // sibling of .tabList, never a descendant of anything clipped, so no
    // ancestor overflow value — correct or not — can ever touch the popup.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cssRaw = fs.readFileSync(path.resolve(__dirname, "../src/components/TopBar.module.css"), "utf8");
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments — they legitimately say "overflow"
    const tabsRule = css.match(/\.tabs\s*\{[^}]*\}/)?.[0];
    expect(tabsRule).toBeDefined();
    expect(tabsRule).not.toMatch(/overflow/);
    const tabListRule = css.match(/\.tabList\s*\{[^}]*\}/)?.[0];
    expect(tabListRule).toBeDefined();
    expect(tabListRule).toMatch(/overflow:\s*hidden/);

    // .tabWrap must be a sibling of .tabList in the render tree, not nested
    // inside it — otherwise the clip still reaches the popup regardless of
    // which selector it's declared under.
    const fsTsx = await import("node:fs");
    const pathTsx = await import("node:path");
    const tsx = fsTsx.readFileSync(pathTsx.resolve(__dirname, "../src/components/TopBar.tsx"), "utf8");
    const navBody = tsx.match(/className=\{styles\.tabs\}[\s\S]*?<\/nav>/)?.[0] ?? "";
    const tabListOpen = navBody.indexOf("styles.tabList");
    const tabListClose = navBody.indexOf("</div>", tabListOpen);
    const tabWrapIdx = navBody.indexOf("styles.tabWrap");
    expect(tabListOpen).toBeGreaterThan(-1);
    expect(tabWrapIdx).toBeGreaterThan(tabListClose); // tabWrap starts AFTER tabList's closing tag
  });
});
