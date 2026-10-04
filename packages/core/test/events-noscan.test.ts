import { describe, it, expect, vi } from "vitest";

// AUDIT-3: prove tail()/replay() don't rescan the file on every call by counting
// actual node:fs readFileSync invocations through a real (unmocked-behavior) wrapper.
// Isolated in its own file so the vi.mock("node:fs") only affects this module graph.
let readFileSyncCalls = 0;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncCalls++;
      return actual.readFileSync(...args);
    },
  };
});

const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { EventLog } = await import("@chimera/core/events");

describe("EventLog windowed reads", () => {
  it("serves tail()/replay() for recent data with ZERO readFileSync calls (windowed, not a full rescan)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-nordread-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 1000, maxSegments: 4 });
    // 3007, not a multiple of the segment cap, so the active segment holds 7 events
    // (a full multiple would rotate on the very last append and leave `recent` empty)
    for (let i = 0; i < 3007; i++) log.append({ agentId: "a1", kind: "status", data: { i } });

    readFileSyncCalls = 0;
    const t = log.tail("a1", 5);
    const r = log.replay({ limit: 5 });
    expect(readFileSyncCalls).toBe(0);   // served entirely from the in-memory active-segment window

    expect(t.map((e) => (e.data as { i: number }).i)).toEqual([3002, 3003, 3004, 3005, 3006]);
    expect(r.map((e) => (e.data as { i: number }).i)).toEqual(t.map((e) => (e.data as { i: number }).i));
  });

  it("falls back to reading only the necessary sealed segment(s), not the whole history", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-fallback-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 100, maxSegments: 10 });
    for (let i = 0; i < 950; i++) log.append({ agentId: "a1", kind: "status", data: { i } });
    // 9 sealed segments of 100 + active segment with 50 events (seq 901-950)

    readFileSyncCalls = 0;
    // needs 60 events but active segment only has 50 -> must open exactly ONE sealed segment, not all 9
    const t = log.tail("a1", 60);
    expect(readFileSyncCalls).toBe(1);
    expect(t.map((e) => e.seq)).toEqual(Array.from({ length: 60 }, (_, i) => 891 + i));
  });

  it("TRANSCRIPT-SEGMENT-INDEX: a toSeq-bounded replay() skips segments entirely above toSeq via the filename index", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-tosq-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 100, maxSegments: 20 });
    for (let i = 0; i < 950; i++) log.append({ agentId: "a1", kind: "status", data: { i } });
    // 9 sealed segments (1-100, ..., 801-900) of 100 + active segment with 50 events (901-950)

    readFileSyncCalls = 0;
    // toSeq:250, limit:50 -> newest matches at/below 250 live in segments 101-200 and 201-250.
    // Segments 5-9 (401-900) and the active window must be skipped entirely by the filename
    // index, never opened, even though they're scanned newest-first before segment 3.
    const out = log.replay({ toSeq: 250, limit: 50 });
    expect(readFileSyncCalls).toBe(1);   // only the 201-300 segment is needed to satisfy limit:50
    expect(out.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 201 + i));
  });
});
