import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { projectHistoricalEvents } from "../src/reducer.js";

const event = (seq: number, kind: NormalizedEvent["kind"], data: Record<string, unknown>): NormalizedEvent =>
  ({ seq, ts: seq * 10, engineId: "local", agentId: "a1", kind, data });

describe("projectHistoricalEvents", () => {
  it("deterministically correlates transcript/tool rows at an inclusive cutoff", () => {
    const events = [event(3, "tool_result", { toolId: "x", output: "done" }), event(1, "message_complete", { text: "hello" }),
      event(2, "tool_call", { toolId: "x", toolName: "Read", input: { path: "a.ts" } }), event(4, "message_complete", { text: "future" })];
    const one = projectHistoricalEvents(events, 3);
    expect(one).toEqual(projectHistoricalEvents(events, 3));
    expect(one.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(one.agents.a1?.transcript.some((row) => row.role === "assistant" && row.text === "future")).toBe(false);
    expect(one.agents.a1?.transcript).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", toolName: "Read", status: "done", result: "done" })]));
    expect(events.map((e) => e.seq)).toEqual([3, 1, 2, 4]);
  });
});
