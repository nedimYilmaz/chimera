import { expect, it } from "vitest";
import { initialState } from "../src/types.js";
import { reduce } from "../src/reducer.js";

it("preserves a streaming row birth key while recording its actual completed branch boundary", () => {
  let state = initialState;
  for (const [seq, kind, text] of [[10, "message_delta", "partial"], [15, "message_complete", "complete"]] as const) state = reduce(state, { type: "event", event: { agentId: "a", engineId: "local", ts: seq, seq, kind, data: { text } } });
  expect(state.agents.a!.transcript[0]).toMatchObject({ seq: 10, completedSeq: 15, streaming: false, text: "complete" });
});
it("folds validated branch lineage from events and snapshots, and ignores malformed lineage", () => {
  const lineage = { forkedFrom: "parent", mode: "snapshot" as const, atSeq: 15 };
  let state = reduce(initialState, { type: "event", event: { agentId: "a", engineId: "local", ts: 1, seq: 1, kind: "status", data: { registered: true, forkLineage: lineage } } });
  expect(state.agents.a!.forkLineage).toEqual(lineage);
  state = reduce(state, { type: "event", event: { agentId: "a", engineId: "local", ts: 2, seq: 2, kind: "status", data: { forkLineage: { forkedFrom: { invalid: true } } } } });
  expect(state.agents.a!.forkLineage).toEqual(lineage);
  const fresh = reduce(initialState, { type: "agentRecords", records: [{ agentId: "a", state: "done", forkLineage: lineage }] });
  expect(fresh.agents.a!.forkLineage).toEqual(lineage);
});
