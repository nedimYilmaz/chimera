import { describe, expect, it } from "vitest";
import type { ChronicleSearchHit } from "@chimera/protocol";
import { chronicleCausalKey, chronicleLanes } from "../src/state/selectors.chronicle";

const hit: ChronicleSearchHit = { engineId: "remote", seq: 2, ts: 3, agentId: "a", kind: "tool_call", score: 100,
  fields: ["tool_input", "workflow"], snippet: "x", correlation: { taskId: "t", workflow: "wf", stepId: "s", toolId: "tool",
    artifactId: null, traceId: "trace", spanId: "span", parentAgentId: null } };

describe("Chronicle timeline selectors", () => {
  it("derives deterministic lanes and only explicit causal keys", () => {
    expect(chronicleLanes(hit)).toEqual(["workflow", "agent", "task", "tool/gate", "engine/trace"]);
    expect(chronicleCausalKey(hit)).toEqual(["t", "wf", "s", "tool", "trace", "span"]);
  });
});
