import { describe, expect, it } from "vitest";
import { copiedNotice, shouldAutoCopy, type SelectionGate } from "../src/state/copyOnSelect";

// Final-acceptance MAJOR 2 — the pure copy-on-select gate (coverage A7-3):
// copy iff a real, pane-contained, non-editable selection is released without
// shift/alt. The DOM collector/clipboard glue is exercised by the Playwright
// gate; only the decision rule lives here (node env, no DOM).

const ok: SelectionGate = {
  collapsed: false, textLength: 42,
  anchorInPane: true, focusInPane: true, inEditable: false,
  shiftKey: false, altKey: false,
};

describe("shouldAutoCopy", () => {
  it("copies a plain pane-contained drag selection", () => {
    expect(shouldAutoCopy(ok)).toBe(true);
  });
  it("never fires for a collapsed/empty selection (plain click)", () => {
    expect(shouldAutoCopy({ ...ok, collapsed: true })).toBe(false);
    expect(shouldAutoCopy({ ...ok, textLength: 0 })).toBe(false);
  });
  it("never fires when either endpoint escapes the pane (other panes)", () => {
    expect(shouldAutoCopy({ ...ok, anchorInPane: false })).toBe(false);
    expect(shouldAutoCopy({ ...ok, focusInPane: false })).toBe(false);
    expect(shouldAutoCopy({ ...ok, anchorInPane: false, focusInPane: false })).toBe(false);
  });
  it("never fires for selections inside inputs/textareas/contenteditable", () => {
    expect(shouldAutoCopy({ ...ok, inEditable: true })).toBe(false);
  });
  it("shift/alt-modified releases skip (terminal-native parity)", () => {
    expect(shouldAutoCopy({ ...ok, shiftKey: true })).toBe(false);
    expect(shouldAutoCopy({ ...ok, altKey: true })).toBe(false);
  });
});

describe("copiedNotice", () => {
  it("matches the mock's literal toast body", () => {
    expect(copiedNotice(1791)).toBe("1791 characters copied to clipboard");
  });
});
