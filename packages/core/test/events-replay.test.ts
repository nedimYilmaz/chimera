import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";

// WD Stage 1 (coverage B7, replay bar): EventLog.replay — the seq-ordered range
// reader over the persisted events/events.jsonl the writer (append) already keeps.

function seeded(): { log: EventLog; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
  const log = new EventLog(dir);
  log.append({ agentId: "a1", kind: "agent_started", data: {} });          // seq 1
  log.append({ agentId: "a1", kind: "message_complete", data: { text: "hi" } });   // seq 2
  log.append({ agentId: "a2", kind: "agent_started", data: {} });          // seq 3
  log.append({ agentId: "a1", kind: "result", data: { text: "done" } });   // seq 4
  log.append({ agentId: "a2", kind: "result", data: { text: "too" } });    // seq 5
  return { log, dir };
}

describe("EventLog.replay", () => {
  it("returns the full log seq-ordered when no bounds are given", () => {
    const { log } = seeded();
    expect(log.replay({ limit: 500 }).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("fromSeq/toSeq are INCLUSIVE bounds", () => {
    const { log } = seeded();
    expect(log.replay({ fromSeq: 2, toSeq: 4, limit: 500 }).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(log.replay({ fromSeq: 5, limit: 500 }).map((e) => e.seq)).toEqual([5]);
    expect(log.replay({ toSeq: 1, limit: 500 }).map((e) => e.seq)).toEqual([1]);
  });

  it("agentId filters to one agent's events within the range", () => {
    const { log } = seeded();
    expect(log.replay({ agentId: "a1", limit: 500 }).map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(log.replay({ fromSeq: 2, agentId: "a2", limit: 500 }).map((e) => e.seq)).toEqual([3, 5]);
  });

  it("limit takes the FIRST n from fromSeq (forward scrub) but the LAST n without one (tail fill)", () => {
    const { log } = seeded();
    expect(log.replay({ fromSeq: 2, limit: 2 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.replay({ limit: 2 }).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("skips a torn final line instead of throwing (crash mid-append is a planned-for state)", () => {
    const { log, dir } = seeded();
    appendFileSync(join(dir, "events", "events.jsonl"), '{"ts":1,"seq":6,"agentId":"a1","kin');
    expect(log.replay({ limit: 500 }).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns [] for a log that was never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-empty-"));
    // EventLog's constructor creates the events/ dir but no file until the first append —
    // build a second instance pointed at a sibling dir with no appends at all.
    expect(new EventLog(dir).replay({ limit: 500 })).toEqual([]);
  });
});
