import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { realDurableWriteDeps } from "@chimera/core/durable-write";

// AUDIT-3: events.jsonl grew unboundedly and tail/replay re-parsed the whole file on
// every call. These tests cover the fix: size-bounded rotation + pruning, and a
// windowed read path whose cost doesn't scale with total history.

function fileLineCount(dir: string, name: string): number {
  return readFileSync(join(dir, "events", name), "utf8").trim().split("\n").filter(Boolean).length;
}

describe("EventLog rotation", () => {
  it("rotates the active segment at maxEventsPerSegment and keeps disk usage bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-rot-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 2 });
    for (let i = 0; i < 37; i++) log.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const sealed = names.filter((n) => /^events\.\d+-\d+\.jsonl$/.test(n));
    // bounded: at most maxSegments sealed files ever retained, regardless of 37 appends
    expect(sealed.length).toBe(2);
    // active file never exceeds the rotation threshold
    expect(fileLineCount(dir, "events.jsonl")).toBeLessThanOrEqual(5);
    // total retained on disk is bounded by (maxSegments + 1) * maxEventsPerSegment, not by total appends
    const totalLines = names.reduce((sum, n) => sum + fileLineCount(dir, n), 0);
    expect(totalLines).toBeLessThanOrEqual(3 * 5);
  });

  // R2-DURABLE-LOG: rotation does real durable I/O per rotation (flush + rename + dir fsync + a
  // durable .meta sidecar write). fsync's actual durability guarantee is exhaustively covered
  // independent of rotation in events-durability.test.ts; this test's job is proving disk-bound
  // growth + tail() correctness across 200 rotations, so fsyncSync is a no-op here — that cuts
  // ~800 real fsync syscalls (the load-sensitive cost) without weakening what this test checks.
  it("does not grow without bound over many appends (synthetic large log)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-big-"));
    const log = new EventLog(dir, {
      maxEventsPerSegment: 100, maxSegments: 3,
      ioDeps: { ...realDurableWriteDeps, fsyncSync: () => {} },
    });
    for (let i = 0; i < 20_000; i++) log.append({ agentId: i % 2 ? "a1" : "a2", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const totalLines = names.reduce((sum, n) => sum + fileLineCount(dir, n), 0);
    // 20,000 appends but disk content stays bounded by segment cap * retained segments
    expect(totalLines).toBeLessThanOrEqual(4 * 100);

    // correctness survives rotation: newest data is still reachable
    const last = log.tail(null, 5).map((e) => (e.data as { i: number }).i);
    expect(last).toEqual([19995, 19996, 19997, 19998, 19999]);
  }, 30_000); // 20k real disk writes: correctness test, not a 5s performance benchmark on busy CI.

  it("tail(n) reads the newest n correctly across a rotation boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-tailrot-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 12; i++) log.append({ agentId: "a1", kind: "status", data: { i } });
    // 12 events span 3 segments (5,5,2) at cap 5 — asking for 7 crosses a boundary
    expect(log.tail("a1", 7).map((e) => (e.data as { i: number }).i)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(log.tail("a1", 20).map((e) => (e.data as { i: number }).i)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });

  it("replay(fromSeq) reads correctly across a rotation boundary, seq-ordered", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-replayrot-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 12; i++) log.append({ agentId: "a1", kind: "status", data: { i } });
    // seqs are 1..12; ask starting at seq 4 (inside first sealed segment) through the tail
    expect(log.replay({ fromSeq: 4, limit: 500 }).map((e) => e.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(log.replay({ fromSeq: 4, toSeq: 9, limit: 500 }).map((e) => e.seq)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("pruned segments are genuinely gone: old-enough data no longer returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-pruned-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 1 });
    for (let i = 0; i < 22; i++) log.append({ agentId: "a1", kind: "status", data: { i } });
    // with maxSegments=1, only the newest sealed segment + active file survive;
    // seq 1 (in the earliest, pruned segment) must be gone
    expect(log.replay({ fromSeq: 1, toSeq: 1, limit: 10 })).toEqual([]);
    // but recent data (seq 22, the last appended, in-memory) is intact
    expect(log.tail(null, 1)[0]!.seq).toBe(22);
  });

  it("resumes seq and rebuilds the active-segment window across a restart, without touching sealed segments", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-restart-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 8; i++) first.append({ agentId: "a1", kind: "status", data: { i } });   // 1 sealed segment (1-5), active has 6,7,8

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    const next = resumed.append({ agentId: "a1", kind: "status", data: { i: 8 } });
    expect(next.seq).toBe(9);   // continues seq across restart, not reset
    expect(resumed.tail("a1", 4).map((e) => e.seq)).toEqual([6, 7, 8, 9]);
  });

});
