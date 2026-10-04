import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, type UiState } from "@chimera/ui-state";
import { buildAgentRows, fleetSummary } from "../src/state/selectors";

// F47.UI: the app fleet list's attention-only filter. The chip counts every unseen agent, so the
// filtered list must never show fewer — see UNSEEN-OUTRANKS-HIDE-DONE in selectors.ts.

function fixture(): UiState {
  const fresh = { ...emptyAgent("fresh"), state: "running", attentionAt: 500 };
  const read = { ...emptyAgent("read"), state: "running", attentionAt: 500, reviewedAt: 900 };
  const overnight = { ...emptyAgent("overnight"), state: "done", attentionAt: 500 };
  return { ...initialState, agents: { fresh, read, overnight }, agentOrder: ["fresh", "read", "overnight"] };
}

const ids = (rows: ReturnType<typeof buildAgentRows>) => rows.filter((r) => r.kind === "agent").map((r) => r.agentId);

describe("attention-only fleet filter (app)", () => {
  it("shows only agents with unread activity", () => {
    expect(ids(buildAgentRows(fixture(), "", true, true)).sort()).toEqual(["fresh", "overnight"]);
  });

  it("still surfaces an agent that finished overnight and was never read, with done hidden", () => {
    // The exact case the filter exists for: hide-done must not cull it, or the chip's count and
    // the visible list would disagree.
    const rows = ids(buildAgentRows(fixture(), "", false, true));
    expect(rows).toContain("overnight");
    expect(rows).toHaveLength(fleetSummary(fixture()).unseen);
  });

  it("defers to a query — search still reaches an already-read agent", () => {
    expect(ids(buildAgentRows(fixture(), "read", true, true))).toEqual(["read"]);
  });

  it("is inert when off", () => {
    expect(ids(buildAgentRows(fixture(), "", true, false)).sort()).toEqual(["fresh", "overnight", "read"]);
  });
});
