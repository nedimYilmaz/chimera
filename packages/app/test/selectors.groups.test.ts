import { describe, expect, it } from "vitest";
import type { AgentGroup } from "@chimera/protocol";
import { emptyAgent, type AgentView } from "@chimera/ui-state";
import type { AgentRow } from "../src/state/selectors";
import { groupAgentListRowsByGroup } from "../src/state/selectors.groups";
import { visibleListRowIds, type AgentListRow } from "../src/state/selectors.workflows";

function agentRow(agentId: string, depth = 0): AgentRow {
  return { kind: "agent", agentId, depth, collapsible: false, collapsed: false, hiddenCount: 0, section: "main" };
}

function agent(over: Partial<AgentView> & { agentId: string }): AgentView {
  return { ...emptyAgent(over.agentId), ...over };
}

function group(id: string, over: Partial<AgentGroup> = {}): AgentGroup {
  return { id, name: id, createdAt: 0, order: 0, ...over };
}

describe("groupAgentListRowsByGroup", () => {
  it("a grouped agent's WHOLE SUBTREE moves into the box together, nested at rebased depth — the placement invariant", () => {
    const rows: AgentListRow[] = [agentRow("root", 0), agentRow("child", 1), agentRow("grandchild", 2), agentRow("standalone", 0)];
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root", groups: ["sprint"] }),
      child: agent({ agentId: "child", parentId: "root" }),
      grandchild: agent({ agentId: "grandchild", parentId: "child" }),
      standalone: agent({ agentId: "standalone" }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("sprint")]);
    expect(out).toHaveLength(2); // one "group" row (root+child+grandchild) + standalone, unchanged
    const box = out[0] as Extract<AgentListRow, { kind: "group" }>;
    expect(box.kind).toBe("group");
    expect(box.groupId).toBe("sprint");
    expect(box.memberRows.map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).agentId)).toEqual(["root", "child", "grandchild"]);
    // rebased so the box's own root renders at depth 0, preserving relative nesting
    expect(box.memberRows.map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).depth)).toEqual([0, 1, 2]);
    expect(out[1]).toEqual(rows[3]);
  });

  it("never orphans a descendant: no row from a grouped subtree survives in the OUTER list", () => {
    const rows: AgentListRow[] = [agentRow("root", 0), agentRow("child", 1)];
    const agents: Record<string, AgentView> = {
      root: agent({ agentId: "root", groups: ["sprint"] }),
      child: agent({ agentId: "child", parentId: "root" }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("sprint")]);
    // the ONLY top-level output row is the box itself — "child" never appears as a bare row
    expect(out).toHaveLength(1);
    expect(out.every((r) => r.kind === "group")).toBe(true);
  });

  it("liveCount/totalCount reflect terminal vs non-terminal member states", () => {
    const rows: AgentListRow[] = [agentRow("a"), agentRow("b")];
    const agents: Record<string, AgentView> = {
      a: agent({ agentId: "a", groups: ["sprint"], state: "running" }),
      b: agent({ agentId: "b", groups: ["sprint"], state: "done" }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("sprint")]);
    const box = out[0] as Extract<AgentListRow, { kind: "group" }>;
    expect(box.liveCount).toBe(1);
    expect(box.totalCount).toBe(2);
  });

  it("EMPTY-GROUPS-PERSIST: a registry group with zero members still renders, appended after non-empty boxes", () => {
    const rows: AgentListRow[] = [agentRow("a")];
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a", groups: ["sprint"] }) };
    const out = groupAgentListRowsByGroup(rows, agents, [group("sprint"), group("daily")]);
    expect(out).toHaveLength(2);
    expect((out[0] as Extract<AgentListRow, { kind: "group" }>).groupId).toBe("sprint");
    const empty = out[1] as Extract<AgentListRow, { kind: "group" }>;
    expect(empty.groupId).toBe("daily");
    expect(empty.memberRows).toEqual([]);
    expect(empty.totalCount).toBe(0);
  });

  it("multiple disjoint subtrees sharing the SAME group merge into ONE box at the first occurrence's position", () => {
    const rows: AgentListRow[] = [agentRow("a"), agentRow("mid"), agentRow("b")];
    const agents: Record<string, AgentView> = {
      a: agent({ agentId: "a", groups: ["sprint"] }),
      mid: agent({ agentId: "mid" }),
      b: agent({ agentId: "b", groups: ["sprint"] }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("sprint")]);
    expect(out).toHaveLength(2); // one merged box (both "a" and "b") + "mid" untouched
    // the box renders at the position of its FIRST occurrence ("a", index 0) — "mid" (its own
    // ordinary row, ungrouped) follows, and "b"'s later run is absorbed into the SAME box
    // rather than opening a second one.
    expect(out[0]).toMatchObject({ kind: "group", groupId: "sprint" });
    expect((out[0] as Extract<AgentListRow, { kind: "group" }>).memberRows.map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).agentId)).toEqual(["a", "b"]);
    expect(out[1]).toEqual(rows[1]);
  });

  it("is a no-op (returns fresh copies) when nothing is grouped and the registry is empty", () => {
    const rows: AgentListRow[] = [agentRow("a"), agentRow("b")];
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a" }), b: agent({ agentId: "b" }) };
    expect(groupAgentListRowsByGroup(rows, agents, [])).toEqual(rows);
  });

  it("a group id with no registry entry still renders using the raw id as its name (fail-open, never guessed-away)", () => {
    const rows: AgentListRow[] = [agentRow("a")];
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a", groups: ["ghost"] }) };
    const out = groupAgentListRowsByGroup(rows, agents, []);
    const box = out[0] as Extract<AgentListRow, { kind: "group" }>;
    expect(box.name).toBe("ghost");
  });

  it("defensively degrades to a no-op when groupRegistry isn't actually an array (stub/mock bridge)", () => {
    const rows: AgentListRow[] = [agentRow("a")];
    const agents: Record<string, AgentView> = { a: agent({ agentId: "a" }) };
    expect(groupAgentListRowsByGroup(rows, agents, undefined as unknown as AgentGroup[])).toEqual(rows);
  });
});

describe("visibleListRowIds with a group row", () => {
  it("walks INTO the box's nested member rows (not a synthetic box id)", () => {
    const rows: AgentListRow[] = [
      { kind: "group", groupId: "sprint", name: "sprint", color: "blue", liveCount: 2, totalCount: 2, memberRows: [agentRow("root"), agentRow("child", 1)] },
    ];
    expect(visibleListRowIds(rows)).toEqual(["root", "child"]);
  });

  it("MAIN.agent-tree: an indented row belonging to ANOTHER owner ends the run instead of joining the box", () => {
    // the live shape, hand-built: a grouped conductor followed by a foreign conductor's queue
    // workers at depth 1. This pass must stand on its own — it must not rely on buildAgentRows'
    // indent guarantee, since it also runs over rows rebased by earlier passes.
    const rows: AgentListRow[] = [agentRow("i170", 0), agentRow("w1", 1), agentRow("w2", 1)];
    const agents: Record<string, AgentView> = {
      i170: agent({ agentId: "i170", treeId: "i170", groups: ["i-170"] }),
      other: agent({ agentId: "other", treeId: "other" }),
      w1: agent({ agentId: "w1", treeId: "w1", originConductorId: "other" }),
      w2: agent({ agentId: "w2", treeId: "w2", originConductorId: "other" }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("i-170")]);
    const box = out[0] as Extract<AgentListRow, { kind: "group" }>;
    expect(box.totalCount).toBe(1);
    expect(out.slice(1).map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).agentId)).toEqual(["w1", "w2"]);
  });

  it("MAIN.agent-tree: the grouped conductor's OWN owned workers are still absorbed", () => {
    const rows: AgentListRow[] = [agentRow("i170", 0), agentRow("w1", 1), agentRow("w2", 1)];
    const agents: Record<string, AgentView> = {
      i170: agent({ agentId: "i170", treeId: "i170", groups: ["i-170"] }),
      w1: agent({ agentId: "w1", treeId: "w1", originConductorId: "i170" }),
      w2: agent({ agentId: "w2", treeId: "w2", originConductorId: "i170" }),
    };
    const out = groupAgentListRowsByGroup(rows, agents, [group("i-170")]);
    const box = out[0] as Extract<AgentListRow, { kind: "group" }>;
    expect(box.totalCount).toBe(3);
    expect(out).toHaveLength(1);
  });
});


it("dragged-out or reassigned children are not swallowed by the old parent's group", () => {
  const rows = [agentRow("root"), agentRow("child", 1), agentRow("leaf", 2)];
  const agents = {
    root: agent({ agentId: "root", groups: ["sprint"] }),
    child: agent({ agentId: "child", parentId: "root", groups: [] }),
    leaf: agent({ agentId: "leaf", parentId: "child" }),
  };
  const out = groupAgentListRowsByGroup(rows, agents, [group("sprint")]);
  expect(out[0]).toMatchObject({ kind: "group", totalCount: 1 });
  expect(out.slice(1)).toEqual([agentRow("child"), agentRow("leaf", 1)]);
  agents.child.groups = ["daily"];
  const moved = groupAgentListRowsByGroup(rows, agents, [group("sprint"), group("daily")]);
  expect(moved).toHaveLength(2);
  expect(moved[1]).toMatchObject({ kind: "group", groupId: "daily", memberRows: [agentRow("child"), agentRow("leaf", 1)] });
});
