import { describe, it, expect } from "vitest";
import { reduce, emptyAgent } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// COVERAGE tests: the new reducer cases (list cursors with clamping, drill-in
// payloads, accounts/result overlays, confirm gate, agentResult upsert).

const withTeams = (items: Array<Record<string, unknown>>): UiState =>
  reduce(initialState, { type: "teams", available: true, items });
const withQueueDetail = (tasks: Array<Record<string, unknown>>): UiState =>
  reduce(initialState, { type: "queueDetail", detail: { spec: { name: "q1" }, counts: {}, tasks } });

describe("reducer coverage — list cursors clamp against their list length", () => {
  it("teamCursor clamps into [0, len-1] and never goes negative", () => {
    let s = withTeams([{ name: "a" }, { name: "b" }, { name: "c" }]);
    s = reduce(s, { type: "teamCursor", delta: -1 });
    expect(s.teamCursor).toBe(0);                                  // floored at 0
    s = reduce(s, { type: "teamCursor", delta: 1 });
    s = reduce(s, { type: "teamCursor", delta: 1 });
    expect(s.teamCursor).toBe(2);
    s = reduce(s, { type: "teamCursor", delta: 1 });
    expect(s.teamCursor).toBe(2);                                  // capped at len-1
  });

  it("queueCursor clamps against the queues list", () => {
    let s = reduce(initialState, { type: "queues", available: true, items: [{ name: "q1" }, { name: "q2" }] });
    s = reduce(s, { type: "queueCursor", delta: 5 });
    expect(s.queueCursor).toBe(1);
    s = reduce(s, { type: "queueCursor", delta: -5 });
    expect(s.queueCursor).toBe(0);
  });

  it("an empty list pins the cursor at 0", () => {
    const s = reduce(withTeams([]), { type: "teamCursor", delta: 3 });
    expect(s.teamCursor).toBe(0);
  });

  it("taskCursor clamps against the OPEN queue drill's task list", () => {
    let s = withQueueDetail([{ taskId: "t1" }, { taskId: "t2" }]);
    s = reduce(s, { type: "taskCursor", delta: 9 });
    expect(s.taskCursor).toBe(1);
    // with no drill open, taskCursor pins to 0 regardless
    const noDrill = reduce(initialState, { type: "taskCursor", delta: 4 });
    expect(noDrill.taskCursor).toBe(0);
  });
});

describe("reducer coverage — drill-in payloads", () => {
  it("opening a queue drill resets taskCursor to 0 (a stale index from a longer queue can't leak)", () => {
    let s = withQueueDetail([{ taskId: "t1" }, { taskId: "t2" }, { taskId: "t3" }]);
    s = reduce(s, { type: "taskCursor", delta: 2 });
    expect(s.taskCursor).toBe(2);
    s = reduce(s, { type: "queueDetail", detail: { spec: { name: "q2" }, counts: {}, tasks: [{ taskId: "x" }] } });
    expect(s.taskCursor).toBe(0);
  });

  it("teamDetail / pushQueue set and clear", () => {
    let s = reduce(initialState, { type: "teamDetail", detail: { spec: { name: "a" }, running: 0, agents: [] } });
    expect(s.teamDetail).not.toBeNull();
    s = reduce(s, { type: "teamDetail", detail: null });
    expect(s.teamDetail).toBeNull();
    s = reduce(s, { type: "pushQueue", queue: "q1" });
    expect(s.pushQueue).toBe("q1");
  });
});

describe("reducer coverage — overlays and confirm gate", () => {
  it("accountsOpen / accountList / resultOpen / confirm are plain setters", () => {
    let s = reduce(initialState, { type: "accountsOpen", open: true });
    expect(s.accountsOpen).toBe(true);
    s = reduce(s, { type: "accountList", items: [{ name: "main" }] });
    expect(s.accountList).toEqual([{ name: "main" }]);
    s = reduce(s, { type: "resultOpen", open: true });
    expect(s.resultOpen).toBe(true);
    s = reduce(s, { type: "confirm", confirm: { kind: "stopDaemon" } });
    expect(s.confirm).toEqual({ kind: "stopDaemon" });
    s = reduce(s, { type: "confirm", confirm: null });
    expect(s.confirm).toBeNull();
  });
});

describe("reducer coverage — agentResult upsert", () => {
  it("stashes detail on an existing agent view", () => {
    const seeded: UiState = { ...initialState, agents: { "a1": emptyAgent("a1") }, agentOrder: ["a1"] };
    const detail = { result: { state: "done", text: "hi", costUsd: 1 }, status: { agentId: "a1" } };
    const s = reduce(seeded, { type: "agentResult", agentId: "a1", detail });
    expect(s.agents["a1"]!.resultDetail).toEqual(detail);
  });

  it("upserts a placeholder agent when the id has no view yet (never drops the fetch)", () => {
    const detail = { result: { state: "done", costUsd: 0 }, status: {} };
    const s = reduce(initialState, { type: "agentResult", agentId: "ghost", detail });
    expect(s.agents["ghost"]!.resultDetail).toEqual(detail);
    expect(s.agents["ghost"]!.state).toBe("unknown");   // emptyAgent fallback
  });
});

describe("reducer coverage — emptyAgent carries the new field", () => {
  it("emptyAgent seeds resultDetail: null", () => {
    expect(emptyAgent("x").resultDetail).toBeNull();
  });
});
