import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

import { ActionChipRow, type ActionChip } from "../src/components/ActionChipRow";

// `ActionChip.key` is the DISPLAYED shortcut. Footer actions without one (the schedules panel's
// clone/export/import/snooze/unsnooze) pass "", so using it as the React key made every
// shortcut-less sibling collide — a dev-mode duplicate-key error on each render.
const noop = () => {};
const chips: ActionChip[] = [
  { key: "mod+o", label: "new", onClick: noop },
  { key: "", label: "clone", onClick: noop },
  { key: "", label: "export", onClick: noop },
  { key: "", label: "import", onClick: noop },
  { key: "space", label: "on/off", onClick: noop },
];

afterEach(() => vi.restoreAllMocks());

describe("ActionChipRow identity", () => {
  it("renders shortcut-less chips without React duplicate-key warnings", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => { create(React.createElement(ActionChipRow, { chips })); });
    const dupes = errors.mock.calls.filter((c) => String(c[0]).includes("same key"));
    expect(dupes).toEqual([]);
  });

  it("keeps the displayed chord empty for those chips instead of inventing one", () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(React.createElement(ActionChipRow, { chips })); });
    type Json = { props: Record<string, unknown>; children: (Json | string)[] | null };
    const row = tree.toJSON() as unknown as Json;
    const shortcutless = (row.children as Json[]).filter((c) => c.props["data-action-chip"] === "");
    expect(shortcutless).toHaveLength(3);
    // children[0] is the chord span, children[1] the label span.
    for (const chip of shortcutless) {
      const [chord] = chip.children as Json[];
      expect((chord!.children ?? []).join("")).toBe("");
    }
  });
});
