import { describe, it, expect, beforeEach } from "vitest";

// Plain-node + shimmed storage, the convention the other app tests use (no jsdom here).
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => { backing.set(k, v); },
  removeItem: (k: string) => { backing.delete(k); },
};

import {
  PANE_DEFAULTS, PANE_MIN_PX, PANE_RIGHT_MIN_PX,
  clampPaneWidth, hasCustomPaneWidths, paneWidth, resetPaneWidth, resetPaneWidths,
  paneMinWidth, setPaneWidth, subscribePanes, __resetPaneStateForTests,
} from "../src/state/panes";

// PANE-RESIZE. The panes were separated by a fixed gap and could not be resized; the gap is now a
// draggable seam. The risk this file exists to cover is that the feature changes how the app looks
// for someone who has never touched it — it must not.

beforeEach(() => { backing.clear(); __resetPaneStateForTests(); });

describe("nothing changes until something is dragged", () => {
  it("reports exactly the widths that shipped in CSS", () => {
    // These mirror the stylesheets as they were: 430 for the list-and-detail screens, and the two
    // that deliberately differ. A change here is a visual redesign of every fresh install.
    expect(PANE_DEFAULTS).toEqual({
      agents: 430, meetings: 300, queues: 430, teams: 430, roles: 430, projects: 430, memory: 430, inbox: 430,
      settings: 300, help: 150,
      // Horizontal split: the composer band used to be content-sized, so this is where it settled
      // rather than a value that was ever written in CSS.
      "agents.composer": 148,
      // memory's folder rail — the third column, its own seam.
      "memory.rail": 172,
    });
    for (const key of Object.keys(PANE_DEFAULTS) as Array<keyof typeof PANE_DEFAULTS>) {
      expect(paneWidth(key)).toBe(PANE_DEFAULTS[key]);
    }
  });

  it("writes NOTHING to storage until a drag happens", () => {
    expect(hasCustomPaneWidths()).toBe(false);
    expect(backing.size).toBe(0);
  });
});

describe("clampPaneWidth", () => {
  it("never lets a pane become unusably narrow", () => {
    // A 20px pane is not a narrow pane, it is a lost one — nothing in it is readable and the
    // divider is hard to find again.
    expect(clampPaneWidth(10, 1400)).toBe(PANE_MIN_PX);
    expect(clampPaneWidth(-500, 1400)).toBe(PANE_MIN_PX);
  });

  it("leaves the right side room, so a pane cannot swallow the window", () => {
    expect(clampPaneWidth(9999, 1400)).toBe(1400 - PANE_RIGHT_MIN_PX);
  });

  it("keeps the floor even when the window is too small to honour both bounds", () => {
    // On a very narrow window the two bounds conflict. The floor wins: a usable left pane and a
    // squeezed right one beats two unusable ones.
    expect(clampPaneWidth(300, 200)).toBe(PANE_MIN_PX);
  });

  it("rounds to whole pixels — a fractional width is a blurry border", () => {
    expect(clampPaneWidth(420.6, 1400)).toBe(421);
  });

  it("passes a sane width through untouched", () => {
    expect(clampPaneWidth(520, 1400)).toBe(520);
  });
});

describe("dragging, and getting back", () => {
  it("remembers a width across a reload", () => {
    setPaneWidth("agents", 520);
    __resetPaneStateForTests();   // simulates a fresh page load reading the same storage
    expect(paneWidth("agents")).toBe(520);
  });

  it("keeps each screen independent", () => {
    setPaneWidth("agents", 520);
    expect(paneWidth("queues")).toBe(PANE_DEFAULTS.queues);
  });

  it("resets ONE screen back to its default", () => {
    setPaneWidth("agents", 520);
    setPaneWidth("queues", 600);
    resetPaneWidth("agents");
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
    expect(paneWidth("queues")).toBe(600);
  });

  it("resets everything, and stops claiming to be customised", () => {
    setPaneWidth("agents", 520);
    setPaneWidth("settings", 400);
    expect(hasCustomPaneWidths()).toBe(true);
    resetPaneWidths();
    expect(hasCustomPaneWidths()).toBe(false);
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
    expect(paneWidth("settings")).toBe(PANE_DEFAULTS.settings);
    // and leaves nothing behind to be restored on the next load
    __resetPaneStateForTests();
    expect(hasCustomPaneWidths()).toBe(false);
  });

  it("notifies subscribers so a live pane repaints mid-drag", () => {
    let fired = 0;
    const off = subscribePanes(() => { fired++; });
    setPaneWidth("agents", 520);
    expect(fired).toBe(1);
    setPaneWidth("agents", 520);   // same value: no work, no repaint
    expect(fired).toBe(1);
    off();
    setPaneWidth("agents", 540);
    expect(fired).toBe(1);         // unsubscribed
  });
});

describe("a corrupted or hostile stored layout", () => {
  const load = (raw: string): void => { backing.set("chimera.panes.v1", raw); __resetPaneStateForTests(); };

  it("falls back to defaults rather than rendering an unusable pane", () => {
    // The failure mode this guards: a bad entry silently produces a screen with a 3px pane and no
    // obvious way back.
    load('{"agents": 12}');
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
    load('{"agents": "wide"}');
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
    load('{"agents": null}');
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
  });

  it("ignores keys that are not panes", () => {
    load('{"agents": 500, "nonsense": 900}');
    expect(paneWidth("agents")).toBe(500);
    expect(hasCustomPaneWidths()).toBe(true);
  });

  it("survives malformed JSON instead of throwing at import time", () => {
    load("{not json");
    expect(paneWidth("agents")).toBe(PANE_DEFAULTS.agents);
    expect(hasCustomPaneWidths()).toBe(false);
  });

  it("keeps the GOOD entries when only some are bad", () => {
    load('{"agents": 500, "queues": 4}');
    expect(paneWidth("agents")).toBe(500);
    expect(paneWidth("queues")).toBe(PANE_DEFAULTS.queues);
  });
});

describe("per-pane floors", () => {
  it("holds a pane above the width its own content needs", () => {
    // queues is not an arbitrary number: SCHEDULE-NAME-INVISIBLE was a real bug where the
    // schedules rail's fixed columns overflowed and the job-name column resolved to zero. Making
    // the rail draggable put that within reach again, so its floor sits above it.
    expect(paneMinWidth("queues")).toBeGreaterThan(PANE_MIN_PX);
    expect(clampPaneWidth(200, 1400, paneMinWidth("queues"))).toBe(paneMinWidth("queues"));
  });

  it("leaves every other pane on the shared floor", () => {
    expect(paneMinWidth("agents")).toBe(PANE_MIN_PX);
    expect(paneMinWidth("settings")).toBe(PANE_MIN_PX);
  });

  it("refuses a STORED width below that pane's own floor", () => {
    // A layout saved before a floor was raised (or hand-edited) must not resurrect the collapse.
    backing.set("chimera.panes.v1", JSON.stringify({ queues: 200, agents: 200 }));
    __resetPaneStateForTests();
    expect(paneWidth("queues")).toBe(PANE_DEFAULTS.queues);   // dropped — below its floor
    expect(paneWidth("agents")).toBe(200);                    // kept — above the shared one
  });
});

describe("the horizontal split", () => {
  it("has a floor that keeps the composer's input visible", () => {
    // Dragged shut, the seam would sit on top of the thing you type into.
    expect(paneMinWidth("agents.composer")).toBeGreaterThanOrEqual(96);
    expect(clampPaneWidth(10, 900, paneMinWidth("agents.composer"))).toBe(paneMinWidth("agents.composer"));
  });

  it("shares the same store, so the global reset reaches it too", () => {
    setPaneWidth("agents.composer", 260);
    expect(hasCustomPaneWidths()).toBe(true);
    resetPaneWidths();
    expect(paneWidth("agents.composer")).toBe(PANE_DEFAULTS["agents.composer"]);
  });

  it("resets on its own without disturbing the vertical split", () => {
    setPaneWidth("agents", 520);
    setPaneWidth("agents.composer", 260);
    resetPaneWidth("agents.composer");
    expect(paneWidth("agents.composer")).toBe(PANE_DEFAULTS["agents.composer"]);
    expect(paneWidth("agents")).toBe(520);
  });
});
