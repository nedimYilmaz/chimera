import { describe, expect, it } from "vitest";
import { emptyAgent, type UiState } from "@chimera/ui-state";
import { buildAgentRows, hiddenTerminalAgentCount, visibleAgentIds } from "../src/state/selectors";

function agent(id: string, session: boolean, state: UiState["agents"][string]["state"] = "running") {
  return { ...emptyAgent(id), session, state };
}

function fleetState(): Pick<UiState, "agents" | "agentOrder" | "collapsed" | "teams" | "mainConductorId"> {
  return {
    agents: {
      p1: agent("p1", false),
      s1: agent("s1", true),
      p2: agent("p2", false),
    },
    agentOrder: ["p1", "s1", "p2"],
    collapsed: new Set(),
    teams: {},
    mainConductorId: null,
  };
}

describe("buildAgentRows session bucket", () => {
  it("keeps session agents out of the main tree order and vice versa", () => {
    const state = fleetState();
    const rows = buildAgentRows(state, "", true);
    const ids = rows.filter((r) => r.kind === "agent").map((r) => r.agentId);
    expect(ids).toEqual(["p1", "p2", "s1"]);
  });

  it("tags each row with its section", () => {
    const state = fleetState();
    const rows = buildAgentRows(state, "", true);
    const bySection = Object.fromEntries(rows.filter((r) => r.kind === "agent").map((r) => [r.agentId, r.section]));
    expect(bySection).toEqual({ p1: "main", p2: "main", s1: "session" });
  });
});

// ---------------------------------------------------------------------------
// SESSION-CHATS-STAY-VISIBLE: a session chat's row must survive showDone=false
// while done/failed — only an explicit kill lets the hide-done filter drop it.
// Non-session agents keep today's showDone behavior exactly.
// ---------------------------------------------------------------------------
describe("buildAgentRows session exemption from hide-done", () => {
  function doneState() {
    return {
      agents: {
        w1: agent("w1", false, "done"), // worker, done — hidden by showDone=false (unchanged behavior)
        s1: agent("s1", true, "done"), // session, done — must stay visible regardless of showDone
      },
      agentOrder: ["w1", "s1"],
      collapsed: new Set(),
      teams: {},
      mainConductorId: null,
    } satisfies Pick<UiState, "agents" | "agentOrder" | "collapsed" | "teams" | "mainConductorId">;
  }

  it("a done session stays visible with showDone=false while a done worker is hidden", () => {
    const rows = buildAgentRows(doneState(), "", false);
    const ids = rows.filter((r) => r.kind === "agent").map((r) => r.agentId);
    expect(ids).toEqual(["s1"]);
  });

  it("a failed session also stays visible with showDone=false", () => {
    const s = doneState();
    const failed: typeof s = { ...s, agents: { ...s.agents, s1: agent("s1", true, "failed") } };
    const ids = buildAgentRows(failed, "", false).filter((r) => r.kind === "agent").map((r) => r.agentId);
    expect(ids).toEqual(["s1"]);
  });

  it("a killed session IS hidden by showDone=false — killing is the explicit dismissal", () => {
    const s = doneState();
    const killed: typeof s = { ...s, agents: { ...s.agents, s1: agent("s1", true, "killed") } };
    const ids = buildAgentRows(killed, "", false).filter((r) => r.kind === "agent").map((r) => r.agentId);
    expect(ids).toEqual([]);
  });

  it("hiddenTerminalAgentCount does not count the exempt done session, only the hidden worker", () => {
    expect(hiddenTerminalAgentCount(doneState())).toBe(1); // w1 only; s1 isn't actually hidden
  });

  it("visibleAgentIds stays in lockstep with the rendered rows (no keyboard-nav desync)", () => {
    const state = doneState();
    expect(visibleAgentIds(state, "", false)).toEqual(
      buildAgentRows(state, "", false).filter((r) => r.kind === "agent").map((r) => r.agentId),
    );
  });
});
