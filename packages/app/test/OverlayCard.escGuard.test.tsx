import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// MEM-5 regression (code-review F1, card path): OverlayCard closes on Escape via
// a window CAPTURE-phase listener that preempts React's synthetic handlers — so a
// card-local Escape consumer (e.g. an open `[[` autocomplete popup) can't just
// stopPropagation in React. The `escGuard` prop lets the card claim Escape: when
// it returns true, OverlayCard neither closes nor stops propagation, letting the
// event flow on to the card's own handler. A node-env window stub captures the
// registered keydown listeners so we can fire a synthetic capture-phase Escape.
const keydownHandlers: Array<(ev: unknown) => void> = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === "keydown") keydownHandlers.push(fn); },
  removeEventListener: (type: string, fn: (ev: unknown) => void) => {
    if (type !== "keydown") return;
    const i = keydownHandlers.indexOf(fn);
    if (i >= 0) keydownHandlers.splice(i, 1);
  },
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { OverlayCard } from "../src/components/OverlayCard";

const fireEscape = (): void => {
  const e = { key: "Escape", preventDefault() {}, stopPropagation() {} };
  for (const h of [...keydownHandlers]) h(e);
};

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => { act(() => mounted?.unmount()); mounted = null; keydownHandlers.length = 0; });

describe("OverlayCard — escGuard", () => {
  it("exposes one named non-modal dialog surface", () => {
    act(() => { mounted = create(React.createElement(OverlayCard, { width: 400, ariaLabel: "Test dialog", children: null })); });
    const card = mounted!.root.findByProps({ role: "dialog" });
    expect(card.props["aria-modal"]).toBeUndefined();
    expect(card.props["aria-label"]).toBe("Test dialog");
    expect(card.props["tabIndex"]).toBe(-1);
  });
  it("does not consume Escape without a close handler", () => {
    act(() => { mounted = create(React.createElement(OverlayCard, { width: 400, children: null })); });
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const handler of keydownHandlers) handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
  it("closes on Escape when no guard is set (unchanged default)", () => {
    const onClose = vi.fn();
    act(() => { mounted = create(React.createElement(OverlayCard, { width: 400, onClose, children: null })); });
    fireEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close on Escape while the guard returns true (a popup owns it)", () => {
    const onClose = vi.fn();
    let popupOpen = true;
    act(() => { mounted = create(React.createElement(OverlayCard, { width: 400, onClose, escGuard: () => popupOpen, children: null })); });
    fireEscape();
    expect(onClose).not.toHaveBeenCalled(); // popup dismissal owns this Escape

    // once the popup is closed, the guard yields and Escape closes the card again.
    popupOpen = false;
    fireEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
