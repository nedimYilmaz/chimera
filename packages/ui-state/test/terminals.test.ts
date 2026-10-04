import { describe, it, expect } from "vitest";
import { reduce } from "../src/reducer";
import { initialState } from "../src/types";

const tab = (id: string, agentId: string | null = "a1") => ({ id, title: "chimera", cwd: "/repo", agentId, exited: null });

describe("terminal slice", () => {
  it("opening a tab makes it active for its own agent", () => {
    const s = reduce(initialState, { type: "terminalOpened", tab: tab("t1") });
    expect(s.terminals.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(s.terminals.activeByAgent["a1"]).toBe("t1");
    expect(s.terminals.openByAgent["a1"]).toBe(true);
  });

  it("closing the active tab activates its neighbour within the SAME agent", () => {
    let s = reduce(initialState, { type: "terminalOpened", tab: tab("t1") });
    s = reduce(s, { type: "terminalOpened", tab: tab("t2") });
    s = reduce(s, { type: "terminalClosed", id: "t2" });
    expect(s.terminals.activeByAgent["a1"]).toBe("t1");
  });

  it("closing the last tab of an agent clears that agent's active id and open flag", () => {
    let s = reduce(initialState, { type: "terminalOpened", tab: tab("t1") });
    s = reduce(s, { type: "terminalClosed", id: "t1" });
    expect(s.terminals.tabs).toEqual([]);
    expect(s.terminals.activeByAgent["a1"]).toBeNull();
    expect(s.terminals.openByAgent["a1"]).toBe(false);
  });

  it("a clean exit removes the tab, a failing exit keeps it with the code", () => {
    let s = reduce(initialState, { type: "terminalOpened", tab: tab("t1") });
    s = reduce(s, { type: "terminalOpened", tab: tab("t2") });
    s = reduce(s, { type: "terminalExited", id: "t1", code: 0 });
    expect(s.terminals.tabs.map((t) => t.id)).toEqual(["t2"]);
    s = reduce(s, { type: "terminalExited", id: "t2", code: 130 });
    expect(s.terminals.tabs[0]!.exited).toEqual({ code: 130 });
  });

  it("dock resize is global and independent of tabs/agent", () => {
    let s = reduce(initialState, { type: "terminalDockResized", height: 400 });
    expect(s.terminals.dockHeight).toBe(400);
  });

  // TERMINAL-DOCK-PER-AGENT: two agents never see each other's tabs, active tab, or open state.
  describe("per-agent isolation", () => {
    it("keeps separate tab lists, active ids, and open flags per agent", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("a1-t1", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("a2-t1", "a2") });

      expect(s.terminals.tabs.filter((t) => t.agentId === "a1").map((t) => t.id)).toEqual(["a1-t1"]);
      expect(s.terminals.tabs.filter((t) => t.agentId === "a2").map((t) => t.id)).toEqual(["a2-t1"]);
      expect(s.terminals.activeByAgent["a1"]).toBe("a1-t1");
      expect(s.terminals.activeByAgent["a2"]).toBe("a2-t1");
      expect(s.terminals.openByAgent["a1"]).toBe(true);
      expect(s.terminals.openByAgent["a2"]).toBe(true);
    });

    it("toggling one agent's dock never touches another agent's open flag", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("a1-t1", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("a2-t1", "a2") });
      s = reduce(s, { type: "terminalDockToggled", agentId: "a1" });
      expect(s.terminals.openByAgent["a1"]).toBe(false); // collapsed
      expect(s.terminals.openByAgent["a2"]).toBe(true); // untouched
    });

    it("activating a tab only updates ITS OWN agent's active id", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("a1-t1", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("a1-t2", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("a2-t1", "a2") });
      s = reduce(s, { type: "terminalActivated", id: "a1-t1" });
      expect(s.terminals.activeByAgent["a1"]).toBe("a1-t1");
      expect(s.terminals.activeByAgent["a2"]).toBe("a2-t1"); // untouched
    });

    it("closing agent A's last tab does not affect agent B's open/active state", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("a1-t1", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("a2-t1", "a2") });
      s = reduce(s, { type: "terminalClosed", id: "a1-t1" });
      expect(s.terminals.tabs.map((t) => t.id)).toEqual(["a2-t1"]);
      expect(s.terminals.activeByAgent["a1"]).toBeNull();
      expect(s.terminals.openByAgent["a1"]).toBe(false);
      expect(s.terminals.activeByAgent["a2"]).toBe("a2-t1");
      expect(s.terminals.openByAgent["a2"]).toBe(true);
    });
  });

  // A tab created with agentId:null is deliberately UNREACHABLE — kept in the flat `tabs`
  // list (so it stays mounted, never killing a live PTY) but never surfaced through any
  // agent's activeByAgent/openByAgent slice, and terminalActivated on it is a no-op.
  describe("agentId: null tabs (unreachable, not global)", () => {
    it("terminalOpened adds the tab but touches no agent's active/open map", () => {
      const s = reduce(initialState, { type: "terminalOpened", tab: tab("orphan", null) });
      expect(s.terminals.tabs.map((t) => t.id)).toEqual(["orphan"]);
      expect(s.terminals.activeByAgent).toEqual({});
      expect(s.terminals.openByAgent).toEqual({});
    });

    it("terminalActivated on it is a no-op", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("orphan", null) });
      const before = s;
      s = reduce(s, { type: "terminalActivated", id: "orphan" });
      expect(s).toEqual(before);
    });

    it("terminalClosed on it removes the tab without touching any agent map", () => {
      let s = reduce(initialState, { type: "terminalOpened", tab: tab("a1-t1", "a1") });
      s = reduce(s, { type: "terminalOpened", tab: tab("orphan", null) });
      s = reduce(s, { type: "terminalClosed", id: "orphan" });
      expect(s.terminals.tabs.map((t) => t.id)).toEqual(["a1-t1"]);
      expect(s.terminals.activeByAgent["a1"]).toBe("a1-t1");
      expect(s.terminals.openByAgent["a1"]).toBe(true);
    });
  });
});
