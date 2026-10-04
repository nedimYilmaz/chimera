import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";

describe("EventLog", () => {
  it("appends with seq/ts, persists JSONL, tails and notifies subscribers", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    const log = new EventLog(dir);
    const seen: string[] = [];
    const unsub = log.subscribe((e) => seen.push(e.kind));

    const e1 = log.append({ agentId: "a1", kind: "agent_started", data: {} });
    const e2 = log.append({ agentId: "a1", kind: "result", data: { text: "done" } });
    log.append({ agentId: "a2", kind: "error", data: { message: "boom" } });
    unsub();
    log.append({ agentId: "a2", kind: "status", data: {} });

    expect(e2.seq).toBe(e1.seq + 1);
    expect(seen).toEqual(["agent_started", "result", "error"]); // unsubscribed before 4th
    expect(log.tail("a1", 10).map((e) => e.kind)).toEqual(["agent_started", "result"]);
    expect(log.tail(null, 2).length).toBe(2);
    const lines = readFileSync(join(dir, "events", "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]!).agentId).toBe("a1");
    expect(JSON.parse(lines[0]!).engineId).toBe("local");   // federation pre-provision: stamped on every local event
  });

  it("resumes seq from the last persisted event after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    const first = new EventLog(dir);
    first.append({ agentId: "a1", kind: "agent_started", data: {} });
    const e2 = first.append({ agentId: "a1", kind: "result", data: {} });
    expect(e2.seq).toBe(2);

    // a fresh instance over the same dir must continue, not restart at 1
    const resumed = new EventLog(dir);
    const e3 = resumed.append({ agentId: "a1", kind: "status", data: {} });
    expect(e3.seq).toBe(3);
  });

  it("lets a caller-supplied engineId override the local default", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    const e = new EventLog(dir).append({ agentId: "a1", kind: "status", data: {}, engineId: "peer-7" });
    expect(e.engineId).toBe("peer-7");
  });

  it("tail(_, 0) returns [] rather than the whole history (slice(-0) guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    const log = new EventLog(dir);
    log.append({ agentId: "a1", kind: "agent_started", data: {} });
    log.append({ agentId: "a1", kind: "result", data: {} });
    expect(log.tail("a1", 0)).toEqual([]);
    expect(log.tail(null, 0)).toEqual([]);
    expect(log.tail("a1", 1).map((e) => e.kind)).toEqual(["result"]);
  });

  it("recovers seq from the last well-formed line when the final line is torn", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    const first = new EventLog(dir);
    first.append({ agentId: "a1", kind: "agent_started", data: {} });   // seq 1
    first.append({ agentId: "a1", kind: "result", data: {} });          // seq 2
    // simulate a crash mid-append leaving a truncated final JSON line
    appendFileSync(join(dir, "events", "events.jsonl"), '{"ts":1,"seq":3,"agentId":"a1","kin');
    const resumed = new EventLog(dir);                                   // must not throw
    const next = resumed.append({ agentId: "a1", kind: "status", data: {} });
    expect(next.seq).toBe(3);   // recovered from the last good line (seq 2), not restarted at 1
  });

  it("does not adopt a NaN seq from a malformed final line", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-"));
    mkdirSync(join(dir, "events"), { recursive: true });
    writeFileSync(join(dir, "events", "events.jsonl"), '{"agentId":"a1","kind":"status","data":{}}\n');  // no seq field
    const log = new EventLog(dir);
    const e = log.append({ agentId: "a1", kind: "status", data: {} });
    expect(Number.isFinite(e.seq)).toBe(true);   // not NaN
    expect(e.seq).toBe(1);
  });
});
