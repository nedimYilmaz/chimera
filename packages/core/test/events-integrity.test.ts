import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";

// R2-DURABLE-LOG: boot-time integrity scan — sealed segments are checksum/seq-continuity
// verified against their `.meta` sidecar (written durably at seal time by rotate()). This is
// the direct regression coverage for the pre-existing bug: readSegment()'s per-line try/catch
// used to silently skip a corrupt MID-segment line and keep serving everything around it.

function sealedSegmentFile(dir: string, name: string): string {
  return join(dir, "events", name);
}

describe("EventLog integrity scan", () => {
  it("rotate() writes a correct checksum+count .meta sidecar for the sealed segment", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) log.append({ agentId: "a1", kind: "status", data: { i } });   // exactly 1 rotation

    const names = readdirSync(join(dir, "events"));
    const sealed = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    expect(sealed).toBeTruthy();
    expect(names).toContain(`${sealed}.meta`);
    const meta = JSON.parse(readFileSync(sealedSegmentFile(dir, `${sealed}.meta`), "utf8"));
    expect(meta.count).toBe(5);
    expect(meta.startSeq).toBe(1);
    expect(meta.endSeq).toBe(5);
    expect(typeof meta.checksum).toBe("string");
    expect(meta.checksum.length).toBe(64);   // sha256 hex
  });

  it("a clean restart over healthy sealed segments reports no quarantine and no gaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 12; i++) first.append({ agentId: "a1", kind: "status", data: { i } });

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();
    expect(resumed.recoveryReport()).toEqual({ quarantined: [], seqGaps: [] });
  });

  it("mid-segment corruption (not just the torn last line) is quarantined, not silently skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) first.append({ agentId: "a1", kind: "status", data: { i } });   // 1 sealed segment (1-5)

    const names = readdirSync(join(dir, "events"));
    const sealedName = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    const sealedPath = sealedSegmentFile(dir, sealedName);
    const lines = readFileSync(sealedPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(5);
    lines[2] = '{"ts":1,"seq":3,"agentId":"a1","kin';   // corrupt the MIDDLE line, not the last
    writeFileSync(sealedPath, lines.join("\n") + "\n");

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();

    // the corrupt segment is moved into events/quarantine/, not left in place
    expect(existsSync(sealedPath)).toBe(false);
    expect(existsSync(join(dir, "events", "quarantine", sealedName))).toBe(true);
    expect(existsSync(join(dir, "events", "quarantine", `${sealedName}.meta`))).toBe(true);

    // recoveryReport names it
    const report = resumed.recoveryReport();
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.file).toBe(sealedName);

    // tail/replay no longer serve ANY event from that segment — today's bug would still
    // silently serve seq 1,2,4,5 (skipping only the corrupt line 3); this must serve NONE of them.
    const fromQuarantined = resumed.replay({ fromSeq: 1, toSeq: 5, limit: 100 });
    expect(fromQuarantined).toEqual([]);
  });

  it("quarantine emits an event_log_recovery event into the fresh active segment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) first.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const sealedName = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    const sealedPath = sealedSegmentFile(dir, sealedName);
    writeFileSync(sealedPath, 'not even json\n');

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();
    const recoveryEvents = resumed.tail(null, 10).filter((e) => e.kind === "event_log_recovery");
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]!.agentId).toBe("eventlog");
    const data = recoveryEvents[0]!.data as { quarantined: { file: string }[] };
    expect(data.quarantined.map((q) => q.file)).toEqual([sealedName]);
  });

  it("a sealed segment with no .meta sidecar (legacy, pre-durability) is trusted, never quarantined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) first.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const sealedName = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    unlinkSync(sealedSegmentFile(dir, `${sealedName}.meta`));   // simulate a segment sealed before this feature shipped

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();
    expect(resumed.recoveryReport()).toEqual({ quarantined: [], seqGaps: [] });
    expect(existsSync(sealedSegmentFile(dir, sealedName))).toBe(true);   // untouched, not moved
    expect(resumed.replay({ fromSeq: 1, toSeq: 5, limit: 100 })).toHaveLength(5);   // still fully readable
  });

  it("a hole punched in the MIDDLE of the segment chain produces a seqGaps entry, not silence", async () => {
    // Deleting the OLDEST segment is indistinguishable from ordinary maxSegments retention
    // pruning (which is expected and must NOT report a gap on every boot) — so this test
    // removes a MIDDLE segment instead, a hole no legitimate pruning could ever produce.
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 15; i++) first.append({ agentId: "a1", kind: "status", data: { i } });   // 3 sealed segments: 1-5, 6-10, 11-15

    const names = readdirSync(join(dir, "events"));
    // numeric sort by startSeq — a plain lexicographic .sort() would put "events.11-15.jsonl"
    // before "events.6-10.jsonl" ('1' < '6'), picking the wrong "middle" segment.
    const sealedNames = names
      .filter((n) => /^events\.\d+-\d+\.jsonl$/.test(n))
      .sort((a, b) => Number(a.split(".")[1]!.split("-")[0]) - Number(b.split(".")[1]!.split("-")[0]));
    expect(sealedNames).toHaveLength(3);
    const middleSegment = sealedNames[1]!;   // events.6-10.jsonl
    unlinkSync(sealedSegmentFile(dir, middleSegment));
    unlinkSync(sealedSegmentFile(dir, `${middleSegment}.meta`));

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();
    const report = resumed.recoveryReport();
    expect(report.quarantined).toEqual([]);
    expect(report.seqGaps).toEqual([{ afterSeq: 5, nextSeq: 11 }]);
  });

  it("ordinary maxSegments retention pruning is NOT reported as a seqGap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 1 });
    for (let i = 0; i < 22; i++) first.append({ agentId: "a1", kind: "status", data: { i } });   // prunes down to 1 sealed segment

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 1 });

    // BOOT-LATENCY-EVENTLOG: content verification is deferred off the constructor now, so the

    // report/quarantine/recovery-event are observable only once the sweep has settled.

    await resumed.verified();
    expect(resumed.recoveryReport()).toEqual({ quarantined: [], seqGaps: [] });
  });
  // BOOT-LATENCY-EVENTLOG regression: the constructor used to read + sha256 + JSON.parse every
  // byte of every sealed segment before returning, which on a real daemon's retained history
  // (~700MB) was a measured 3.3s of dead time before the RPC socket could bind — the daemon
  // looked hung. These two tests pin the split: nothing is verified synchronously by default,
  // and everything still is once the sweep settles.
  it("the constructor does NOT verify sealed segment contents — the report is empty until verified() settles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) first.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const sealedName = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    writeFileSync(sealedSegmentFile(dir, sealedName), "not even json\n");

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    // synchronously after construction: corruption not yet detected, segment still in place
    expect(resumed.recoveryReport()).toEqual({ quarantined: [], seqGaps: [] });
    expect(existsSync(sealedSegmentFile(dir, sealedName))).toBe(true);

    await resumed.verified();
    expect(resumed.recoveryReport().quarantined.map((q) => q.file)).toEqual([sealedName]);
    expect(existsSync(join(dir, "events", "quarantine", sealedName))).toBe(true);
  });

  it('integrityScan:"sync" verifies inside the constructor, the pre-deferral behavior', () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-int-"));
    const first = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5 });
    for (let i = 0; i < 5; i++) first.append({ agentId: "a1", kind: "status", data: { i } });

    const names = readdirSync(join(dir, "events"));
    const sealedName = names.find((n) => /^events\.\d+-\d+\.jsonl$/.test(n))!;
    writeFileSync(sealedSegmentFile(dir, sealedName), "not even json\n");

    const resumed = new EventLog(dir, { maxEventsPerSegment: 5, maxSegments: 5, integrityScan: "sync" });
    expect(resumed.recoveryReport().quarantined.map((q) => q.file)).toEqual([sealedName]);
    expect(existsSync(join(dir, "events", "quarantine", sealedName))).toBe(true);
  });
});
