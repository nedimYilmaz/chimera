import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

import { SearchBox } from "../src/components/SearchBox";

// SEARCHBOX-UNCLICKABLE: the agents panel's search row can squeeze the
// <input> to an unclickable sliver, so the whole row must focus the input on
// mousedown — but WITHOUT hijacking clicks on the row's own buttons (+ spawn,
// the done toggle, ...). react-test-renderer has no real DOM/layout, so this
// proves the row handler's target-based routing logic directly: a click on a
// non-interactive area calls .focus() on the input; a click on a button
// leaves the handler a no-op and the button's own onClick still fires.

let renderer: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

// react-test-renderer host refs are null unless createNodeMock supplies a
// stand-in instance — this is the standard way to assert .focus() was called
// without a real DOM (mirrors TerminalDock.render.test.tsx's node-mock use).
function mountSearchBox(props: Partial<React.ComponentProps<typeof SearchBox>> = {}) {
  const focusSpy = vi.fn();
  const onChange = vi.fn();
  const spawnClick = vi.fn();
  act(() => {
    renderer = create(
      React.createElement(
        SearchBox,
        { value: "", onChange, dataAttr: "x", ...props },
        React.createElement("button", { type: "button", "data-testid": "spawn", onClick: spawnClick }, "+ spawn"),
      ),
      { createNodeMock: (el) => ((el as { type: string }).type === "input" ? { focus: focusSpy } : {}) },
    );
  });
  const row = renderer!.root.findByType("div");
  return { row, focusSpy, onChange, spawnClick };
}

describe("SearchBox row click-to-focus (SEARCHBOX-UNCLICKABLE)", () => {
  it("mousedown on a non-interactive area (e.g. the slash/count text) focuses the input", () => {
    const { row, focusSpy } = mountSearchBox();
    const preventDefault = vi.fn();
    const target = { closest: () => null };

    act(() => { (row.props["onMouseDown"] as (e: unknown) => void)({ target, preventDefault }); });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("mousedown on a sibling button does NOT steal focus, and the button's own onClick still fires", () => {
    const { row, focusSpy, spawnClick } = mountSearchBox();
    const preventDefault = vi.fn();
    // simulates the mousedown bubbling up from inside the <button>
    const target = { closest: (sel: string) => (sel.includes("button") ? {} : null) };

    act(() => { (row.props["onMouseDown"] as (e: unknown) => void)({ target, preventDefault }); });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();

    const spawnButton = renderer!.root.findByProps({ "data-testid": "spawn" });
    act(() => { (spawnButton.props["onClick"] as () => void)(); });
    expect(spawnClick).toHaveBeenCalledTimes(1);
  });

  it("mousedown directly on the input itself is left alone (no double-focus/preventDefault)", () => {
    const { row, focusSpy } = mountSearchBox();
    const preventDefault = vi.fn();
    const target = { closest: (sel: string) => (sel.includes("input") ? {} : null) };

    act(() => { (row.props["onMouseDown"] as (e: unknown) => void)({ target, preventDefault }); });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("forwards autoFocus onto the underlying <input> (opt-in wiring for TranscriptPanel's search toggle)", () => {
    const { row } = mountSearchBox({ autoFocus: true });
    const input = renderer!.root.findByType("input");
    expect(input.props["autoFocus"]).toBe(true);
    expect(row.props["onMouseDown"]).toBeTypeOf("function");
  });
});
