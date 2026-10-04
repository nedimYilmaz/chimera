import { describe, it, expect } from "vitest";
import type { TerminalState } from "@chimera/ui-state";
import { terminalDockForAgent } from "../src/state/selectors.terminal";

const tab = (id: string, agentId: string | null) => ({ id, title: id, cwd: "/repo", agentId, exited: null });

function terminals(overrides: Partial<TerminalState> = {}): TerminalState {
  return { tabs: [], activeByAgent: {}, openByAgent: {}, dockHeight: 260, ...overrides };
}

describe("terminalDockForAgent", () => {
  it("returns an empty, closed dock when no agent is selected", () => {
    const t = terminals({ tabs: [tab("t1", "a1")], activeByAgent: { a1: "t1" }, openByAgent: { a1: true } });
    expect(terminalDockForAgent(t, null)).toEqual({ tabs: [], activeId: null, open: false });
  });

  it("returns an empty, closed dock for an agent with zero tabs, even if flagged open", () => {
    const t = terminals({ openByAgent: { a1: true } });
    expect(terminalDockForAgent(t, "a1")).toEqual({ tabs: [], activeId: null, open: false });
  });

  it("scopes tabs, active id, and open flag to the requested agent only", () => {
    const t = terminals({
      tabs: [tab("a1-t1", "a1"), tab("a2-t1", "a2")],
      activeByAgent: { a1: "a1-t1", a2: "a2-t1" },
      openByAgent: { a1: true, a2: false },
    });
    expect(terminalDockForAgent(t, "a1")).toEqual({ tabs: [tab("a1-t1", "a1")], activeId: "a1-t1", open: true });
    expect(terminalDockForAgent(t, "a2")).toEqual({ tabs: [tab("a2-t1", "a2")], activeId: "a2-t1", open: false });
  });

  it("never surfaces an agentId:null tab under any agent", () => {
    const t = terminals({ tabs: [tab("orphan", null)] });
    expect(terminalDockForAgent(t, "a1")).toEqual({ tabs: [], activeId: null, open: false });
  });
});
