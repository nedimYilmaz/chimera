import { describe, expect, it, vi } from "vitest";
import { listLocations, listRowKey, loadListOrder, moveListRow, orderAgentList, saveListOrder } from "../src/state/agentListOrder";
import type { AgentListRow } from "../src/state/selectors.workflows";
const agent = (agentId: string, depth = 0): AgentListRow => ({ kind: "agent", agentId, depth, section: "main", collapsed: false, collapsible: false, hiddenCount: 0 });
const group = (groupId: string, memberRows: AgentListRow[] = []): AgentListRow => ({ kind: "group", groupId, memberRows, name: groupId, color: "blue", liveCount: memberRows.length, totalCount: memberRows.length });

describe("manual inspector ordering", () => {
  it("moves groups and root agents without splitting subtrees; sorts siblings within groups", () => {
    const rows = [agent("a"), agent("child", 1), group("one", [agent("x"), agent("y")]), group("two")];
    const ordered = orderAgentList(rows, { root: ["group:two", "group:one", "agent:a"], "group:one": ["agent:y", "agent:x"] });
    expect(ordered.map(listRowKey)).toEqual(["group:two", "group:one", "agent:a", "agent:child"]);
    expect(ordered[1]).toMatchObject({ memberRows: [agent("y"), agent("x")] });
    expect(listLocations(ordered).get("agent:child")).toMatchObject({ scope: "agent:a", group: null });
  });
  it("moves adjacent rows in both directions and retains filtered-out siblings", () => {
    const before = { root: ["agent:a", "agent:hidden", "agent:b", "group:c"] };
    const moved = moveListRow(before, "root", ["agent:a", "agent:b", "group:c"], "group:c", "agent:a");
    expect(moved.root).toEqual(["group:c", "agent:a", "agent:hidden", "agent:b"]);
    expect(moveListRow(moved, "root", [], "group:c", "agent:b", true).root).toEqual(before.root);
    expect(before.root).toEqual(["agent:a", "agent:hidden", "agent:b", "group:c"]);
  });
  it("keeps newly arriving agents visible after a saved manual order", () => {
    expect(orderAgentList([agent("a"), agent("b"), agent("new")], { root: ["agent:b", "agent:a", "agent:gone"] }).map(listRowKey))
      .toEqual(["agent:b", "agent:a", "agent:new"]);
  });
  it("survives remount storage and ignores corrupt or unavailable storage", () => {
    let stored = "";
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
    try {
      const order = { root: ["group:two", "agent:a"] };
      saveListOrder(order); expect(loadListOrder()).toEqual(order);
      stored = '{broken'; expect(loadListOrder()).toEqual({});
      stored = '{"root":[1,"agent:a","agent:a"]}'; expect(loadListOrder()).toEqual({ root: ["agent:a"] });
    } finally { vi.unstubAllGlobals(); }
  });
});
