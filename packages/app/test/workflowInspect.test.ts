import { describe, it, expect } from "vitest";
import type { WorkflowInnerAgent } from "@chimera/protocol/contract";
import { foldInnerAgents, relTimeOf } from "../src/state/workflowInspect";

// SHADOW-WORKFLOW-VISIBILITY: the pure fold the cockpit's workflow-inspect pane renders.

function inner(over: Partial<WorkflowInnerAgent>): WorkflowInnerAgent {
  return {
    agentId: "x", agentType: null, label: null, phase: null, state: "done",
    resultPreview: null, lastActivityTs: null, spawnDepth: null, model: null, ...over,
  };
}

describe("foldInnerAgents", () => {
  it("floats running agents above done agents, preserving each subgroup's incoming order", () => {
    const agents = [
      inner({ agentId: "d1", state: "done", lastActivityTs: 300 }),
      inner({ agentId: "r1", state: "running", lastActivityTs: 200 }),
      inner({ agentId: "d2", state: "done", lastActivityTs: 100 }),
      inner({ agentId: "r2", state: "running", lastActivityTs: 250 }),
    ];
    const rows = foldInnerAgents(agents, 1000);
    expect(rows.map((r) => r.agentId)).toEqual(["r1", "r2", "d1", "d2"]);
  });

  it("stamps a coarse relative time and passes through null timestamps", () => {
    const rows = foldInnerAgents([inner({ agentId: "a", lastActivityTs: 1000 - 90_000 }), inner({ agentId: "b", lastActivityTs: null })], 1000);
    expect(rows.find((r) => r.agentId === "a")!.relTime).toBe("2m ago");   // 90s -> ~2m (rounded)
    expect(rows.find((r) => r.agentId === "b")!.relTime).toBeNull();
  });

  it("handles an empty roster", () => {
    expect(foldInnerAgents([], 1000)).toEqual([]);
  });
});

describe("relTimeOf", () => {
  it("buckets by magnitude", () => {
    expect(relTimeOf(null, 10_000)).toBeNull();
    expect(relTimeOf(10_000 - 2_000, 10_000)).toBe("just now");
    expect(relTimeOf(10_000 - 30_000, 10_000)).toBe("30s ago");
    expect(relTimeOf(10_000 - 120_000, 10_000)).toBe("2m ago");
    expect(relTimeOf(10_000 - 3 * 3_600_000, 10_000)).toBe("3h ago");
    expect(relTimeOf(10_000 - 2 * 86_400_000, 10_000)).toBe("2d ago");
  });
});
