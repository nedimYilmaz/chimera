import { describe, expect, it } from "vitest";
import { RPC_CONTRACT } from "../src/contract.js";

describe("Chronicle RPC contract", () => {
  it("defaults bounded search pagination and rejects unknown request fields", () => {
    expect(RPC_CONTRACT["events.search"].request.parse({ query: "decision" })).toEqual({ query: "decision", limit: 50 });
    expect(() => RPC_CONTRACT["events.search"].request.parse({ query: "x", limit: 101 })).toThrow();
    expect(() => RPC_CONTRACT["events.search"].request.parse({ query: "x", raw: true })).toThrow();
  });

  it("locks the redacted hit/export response shape", () => {
    const hit = { engineId: "local", seq: 1, ts: 2, agentId: "a", kind: "message_complete", score: 100,
      fields: ["transcript"], snippet: "decision", correlation: { taskId: null, workflow: null, stepId: null, toolId: null,
        artifactId: null, traceId: null, spanId: null, parentAgentId: null } };
    expect(RPC_CONTRACT["events.search"].response.parse({ hits: [hit], nextCursor: null, retained: { firstSeq: 1, lastSeq: 1 } }).hits[0]).toEqual(hit);
    expect(RPC_CONTRACT["events.searchExport"].request.parse({ query: "decision" })).toEqual({ query: "decision", limit: 50, maxResults: 200 });
  });
});
