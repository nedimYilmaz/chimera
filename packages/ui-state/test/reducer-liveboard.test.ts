import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, reduce } from "@chimera/ui-state";

describe("liveboard reducer", () => {
  it("deduplicates and caps lanes at four", () => {
    let state = initialState;
    for (const id of ["a", "b", "c", "d", "e", "a"]) state = reduce(state, { type: "liveboardLaneAdd", agentId: id });
    expect(state.liveboardLanes.map((l) => l.agentId)).toEqual(["a", "b", "c", "d"]);
  });
  it("counts new transcript items only while held and clears on follow", () => {
    let state = { ...initialState, agents: { a: { ...emptyAgent("a"), state: "running" } }, agentOrder: ["a"] };
    state = reduce(state, { type: "liveboardLaneAdd", agentId: "a" });
    state = reduce(state, { type: "liveboardLaneFollow", agentId: "a", follow: false });
    state = reduce(state, { type: "event", event: { agentId: "a", seq: 1, ts: 1, kind: "message_delta", data: { text: "hi" } } });
    expect(state.liveboardLanes[0]!.unread).toBe(1);
    state = reduce(state, { type: "liveboardLaneFollow", agentId: "a", follow: true });
    expect(state.liveboardLanes[0]).toMatchObject({ follow: true, unread: 0 });
  });
});
