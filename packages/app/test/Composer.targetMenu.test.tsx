import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createPortal } from "react-dom";

// COMPOSER-TARGET-MENU-CLIPPED. Reported as "the agent-select list in the input area ends up
// BEHIND the transcript" — clicking the target chip appeared to do nothing.
//
// It was not a paint order, it was a CLIP. The menu is anchored above the chip
// (`bottom: calc(100% + 6px)`) so it extends past the top of the composer band, and that band is
// `overflow: hidden` (AgentsScreen.module.css `.band`) — a deliberate ceiling so a tall composer
// cannot push the transcript off screen. An absolutely positioned box is still clipped by an
// overflow ancestor of its containing block, so the whole menu was cut away.
//
// The fix portals it to <body> and positions it from the chip's measured rect, so it escapes the
// clip without weakening the band's ceiling.

const runActionSpy = vi.fn();
vi.mock("../src/keymap", async () => {
  const actual = await vi.importActual<typeof import("../src/keymap")>("../src/keymap");
  return { ...actual, runAction: (...a: Parameters<typeof actual.runAction>) => { runActionSpy(...a); return actual.runAction(...a); } };
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

// Passthrough mock (ExcalidrawBlock.test.tsx's pattern): this harness has no DOM, so real DOM
// adjacency cannot be observed. What DOES determine the real behaviour is which container the
// overlay is handed to — a portal attaches its node under that container wherever the calling
// component sits in the React tree, which is precisely what escapes the band's overflow.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: vi.fn((children: React.ReactNode) => children) };
});
const createPortalMock = vi.mocked(createPortal);

const CHIP_RECT = { left: 140, top: 900, right: 240, bottom: 918, width: 100, height: 18, x: 140, y: 900 };
const VIEWPORT_H = 1000;

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {}, removeEventListener: () => {}, innerHeight: VIEWPORT_H,
  };
} else {
  (window as unknown as { innerHeight: number }).innerHeight = VIEWPORT_H;
}

import { Composer } from "../src/components/Composer";
import styles from "../src/components/Composer.module.css";
import { composerLocal } from "../src/state/commands.agents";
import { appStore } from "../src/state/store";

/** react-test-renderer leaves host refs null unless a node mock is supplied, and the menu's anchor
 *  is measured off the CHIP's ref — so that one node needs a rect. Everything else stays null on
 *  purpose: the composer's other ref-driven effects (textarea autosize, the markdown mirror) guard
 *  on a null ref, and handing them a stub would drive real DOM code this harness cannot support. */
const chipNodeMock = (element: { props: Record<string, unknown> }): unknown =>
  element.props["data-target-chip"] !== undefined ? { getBoundingClientRect: () => CHIP_RECT } : null;

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  composerLocal.reset();
});

/** Mounts the composer with a stubbed <body> and a chip whose ref reports CHIP_RECT, then opens
 *  the target menu by clicking the chip exactly as the operator does. */
function openMenu(run: (ctx: { body: object }) => void): void {
  const body = { __body: true };
  const prevDoc = (globalThis as unknown as { document?: unknown }).document;
  (globalThis as unknown as { document: unknown }).document = { body };
  try {
    act(() => {
      appStore.dispatch({ type: "agentRecords", records: [
        { agentId: "tgtmenu-main", state: "running", createdAt: 1, spec: { conductor: true } },
      ] });
      appStore.dispatch({ type: "mainConductorId", agentId: "tgtmenu-main" });
      appStore.dispatch({ type: "selectAgent", agentId: "tgtmenu-main" });
    });
    createPortalMock.mockClear();
    act(() => {
      renderer = create(React.createElement(Composer), { createNodeMock: chipNodeMock });
    });
    const chip = renderer!.root.findByProps({ "data-target-chip": true });
    act(() => (chip.props["onClick"] as () => void)());
    run({ body });
  } finally {
    if (prevDoc === undefined) delete (globalThis as unknown as { document?: unknown }).document;
    else (globalThis as unknown as { document: unknown }).document = prevDoc;
  }
}

describe("the composer target menu escapes the band that was clipping it", () => {
  it("hands the menu to createPortal with document.body as the container", () => {
    // Identity, not merely truthy: being a child of <body> is the whole mechanism — anywhere
    // inside the composer subtree and the band's overflow clips it again.
    openMenu(({ body }) => {
      expect(createPortalMock).toHaveBeenCalledTimes(1);
      expect(createPortalMock.mock.calls[0]![1]).toBe(body);
    });
  });

  it("does not portal anything until the chip is actually clicked", () => {
    // A stranded portal would keep an invisible menu attached to <body> for the whole session.
    const body = { __body: true };
    const prevDoc = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = { body };
    try {
      createPortalMock.mockClear();
      act(() => {
        renderer = create(React.createElement(Composer), { createNodeMock: chipNodeMock });
      });
      expect(createPortalMock).not.toHaveBeenCalled();
    } finally {
      if (prevDoc === undefined) delete (globalThis as unknown as { document?: unknown }).document;
      else (globalThis as unknown as { document: unknown }).document = prevDoc;
    }
  });

  it("pins the menu to the chip's measured rect, in viewport coordinates", () => {
    // Portaling alone is not enough: at <body> the menu no longer has the chip as its containing
    // block, so `left: 0; bottom: 100%` would put it in the window's bottom-left corner instead of
    // over the chip. `bottom` is measured from the viewport floor UP to the chip's top edge, so the
    // menu grows upward and stays anchored as its height changes with the option count.
    openMenu(() => {
      const menu = renderer!.root.findByProps({ "data-target-menu": true });
      expect(menu.props["style"]).toEqual({
        left: CHIP_RECT.left,
        bottom: VIEWPORT_H - CHIP_RECT.top + 6,
      });
    });
  });

  it("still renders every target option through the portal", () => {
    // The clip made the menu useless, not absent — this is the actual user-facing outcome: the
    // options are reachable again.
    openMenu(() => {
      const menu = renderer!.root.findByProps({ "data-target-menu": true });
      const labels = menu.findAllByType("button").map((b) => String(b.children.join("")));
      expect(labels.some((l) => l.includes("main"))).toBe(true);
      expect(labels.some((l) => l.includes("all"))).toBe(true);
    });
  });
});

describe("the menu's stylesheet matches the portal it now lives in", () => {
  const css = readFileSync(join(__dirname, "../src/components/Composer.module.css"), "utf8");
  const rule = css.slice(css.indexOf(".targetMenu {"), css.indexOf("}", css.indexOf(".targetMenu {")));

  it("is positioned FIXED — an absolute box at <body> would resolve to the page, not the chip", () => {
    expect(rule).toContain("position: fixed");
    expect(rule).not.toContain("position: absolute");
  });

  it("drops the static left/bottom the inline rect now supplies", () => {
    // Left behind, `left: 0` would win over nothing (the inline style beats it) but a future reader
    // would take them as the source of truth for placement. They are not.
    expect(rule).not.toMatch(/\bleft:/);
    expect(rule).not.toMatch(/\bbottom:/);
  });

  it("stacks above the app tree but below the full-screen layers", () => {
    // At <body> the menu is compared against every other root-level layer, not just the composer's
    // own siblings. It must cover the transcript; it must never cover the workflow studio (80), the
    // image lightbox (100) or the file viewer (200).
    const z = Number(/z-index:\s*(\d+)/.exec(rule)?.[1] ?? 0);
    expect(z).toBeGreaterThan(20);
    expect(z).toBeLessThan(80);
  });

  it("keeps the class the component actually applies", () => {
    expect(styles.targetMenu).toBeTruthy();
  });
});
