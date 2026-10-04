import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events.js";

describe("EventLog Chronicle search", () => {
  it("ranks phrases, correlates records, pages, and searches sealed segments", () => {
    const log = new EventLog(mkdtempSync(join(tmpdir(), "chronicle-")), { maxEventsPerSegment: 2, maxSegments: 4 });
    log.append({ agentId: "a1", kind: "message_complete", data: { text: "alpha release decision", taskId: "t1" } });
    log.append({ agentId: "a2", kind: "tool_call", data: { toolName: "Bash", input: "find alpha" } });
    log.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", workflow: "ship", stepId: "qa", title: "alpha gate" } });
    const first = log.search({ query: "alpha", limit: 1 });
    expect(first.hits[0]).toMatchObject({ agentId: "a1", fields: ["transcript"], correlation: { taskId: "t1" } });
    const second = log.search({ query: "alpha", limit: 2, cursor: first.nextCursor! });
    expect(second.hits.map((h) => h.seq)).not.toContain(first.hits[0]!.seq);
    expect(first.retained).toEqual({ firstSeq: 1, lastSeq: 3 });
    expect(log.search({ query: "ship", scope: { taskIds: ["t1"] }, limit: 10 }).hits[0]?.correlation.workflow).toBe("ship");
  });

  it("redacts nested secret shapes and credential-like values", () => {
    const log = new EventLog(mkdtempSync(join(tmpdir(), "chronicle-redact-")));
    log.append({ agentId: "a1", kind: "tool_result", data: { output: "deploy ok", nested: { apiKey: "sk-supersecret123", note: "Bearer abcdefghijkl" } }, raw: { password: "hunter2" } });
    const hit = log.search({ query: "deploy", limit: 10 }).hits[0]!;
    const exported = log.searchExport({ query: "deploy", limit: 10, maxResults: 10 });
    expect(`${hit.snippet}\n${exported.content}`).not.toMatch(/supersecret|abcdefghijkl|hunter2/);
    expect(hit.snippet).toContain("[REDACTED]");
  });

  it("rejects a cursor from another query", () => {
    const log = new EventLog(mkdtempSync(join(tmpdir(), "chronicle-cursor-")));
    for (let i = 0; i < 3; i++) log.append({ agentId: "a", kind: "message_complete", data: { text: `alpha ${i}` } });
    const cursor = log.search({ query: "alpha", limit: 1 }).nextCursor!;
    expect(() => log.search({ query: "beta", limit: 1, cursor })).toThrow(/cursor/);
  });
});
