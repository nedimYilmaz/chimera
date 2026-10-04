import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";
import { EventLog } from "@chimera/core/events";

/** EventLog keeps its segments in an `events/` subdirectory of the home it is given. */
const segDir = (home: string): string => join(home, "events");

// AGENT-FORGET — cleaning up a finished agent now erases its event history too. Previously "forget"
// forgot only the agent RECORD: the run stayed in the Events list, and in chronicle_search,
// indefinitely.
//
// This is destructive and it edits files the integrity scan checksums, so what is tested here is
// mostly what must NOT happen: no other agent's events lost, no segment quarantined, no seq
// renumbering, and a REAL corruption still caught afterwards.

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "fa-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A log whose segments seal every `per` events, so multi-segment behaviour is reachable. */
function makeLog(dir: string, per = 4): EventLog {
  return new EventLog(dir, { maxEventsPerSegment: per, maxSegments: 50, integrityScan: "sync" });
}
const push = (log: EventLog, agentId: string, n = 1): void => {
  for (let i = 0; i < n; i++) log.append({ agentId, kind: "status", data: { i } });
};
const seqsOf = (log: EventLog, agentId: string | null): number[] =>
  log.replay({ fromSeq: 1, limit: 10_000 }).filter((e) => agentId === null || e.agentId === agentId).map((e) => e.seq);

describe("forgetAgent", () => {
  it("removes that agent's events and leaves everyone else's", () => {
    const dir = tmp();
    const log = makeLog(dir);
    push(log, "gone", 3);
    push(log, "kept", 3);
    push(log, "gone", 2);
    const before = seqsOf(log, "kept");

    const res = log.forgetAgent(["gone"]);
    expect(res.removed).toBe(5);
    expect(seqsOf(log, "gone")).toEqual([]);
    expect(seqsOf(log, "kept")).toEqual(before);
  });

  it("does NOT renumber the survivors", () => {
    // seqs are referenced from outside the log — chronicle documents, transcript items,
    // historyMinSeq, search jump targets, the snapshot watermark. Closing the gaps would silently
    // repoint every one of them.
    const dir = tmp();
    const log = makeLog(dir);
    push(log, "gone", 2);   // 1,2
    push(log, "kept", 2);   // 3,4
    log.forgetAgent(["gone"]);
    expect(seqsOf(log, "kept")).toEqual([3, 4]);
  });

  it("keeps appending from where it left off — the next event does not reuse a freed seq", () => {
    const dir = tmp();
    const log = makeLog(dir);
    push(log, "gone", 3);
    log.forgetAgent(["gone"]);
    const next = log.append({ agentId: "kept", kind: "status", data: {} });
    expect(next.seq).toBe(4);
  });

  it("survives a reopen with NOTHING quarantined — the rewrite is legible to the integrity scan", () => {
    // The failure this guards is severe and silent: verifySegment requires consecutive seqs, so a
    // naive line-delete makes the whole segment look corrupt and it is moved to quarantine/ —
    // taking every OTHER agent's events in that segment with it.
    const dir = tmp();
    const log = makeLog(dir, 4);
    push(log, "gone", 2);
    push(log, "kept", 6);   // forces at least one seal
    log.forgetAgent(["gone"]);

    const reopened = makeLog(dir, 4);
    const report = reopened.recoveryReport();
    expect(report.quarantined).toEqual([]);
    expect(readdirSync(segDir(dir))).not.toContain("quarantine");
    expect(seqsOf(reopened, "kept")).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("still catches REAL corruption afterwards — the check is not just switched off", () => {
    // The cheap way to make a delete pass verification is to stop requiring continuity at all.
    // That would trade a live safety property for one operation's convenience, so a gap is only
    // tolerated where the sidecar records one.
    const dir = tmp();
    const log = makeLog(dir, 4);
    push(log, "gone", 1);
    push(log, "kept", 7);
    log.forgetAgent(["gone"]);

    // Now damage a sealed segment the way a real fault would: drop a line nobody recorded.
    const sealed = readdirSync(segDir(dir)).find((f) => /^events\.\d+-\d+\.jsonl$/.test(f))!;
    const path = join(segDir(dir), sealed);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    writeFileSync(path, lines.slice(1).join("\n") + "\n");

    const reopened = makeLog(dir, 4);
    expect(reopened.recoveryReport().quarantined.length).toBeGreaterThan(0);
  });

  it("forgets several agents at once, and reports nothing for an unknown one", () => {
    const dir = tmp();
    const log = makeLog(dir);
    push(log, "a", 2); push(log, "b", 2); push(log, "c", 2);
    expect(log.forgetAgent(["a", "c"]).removed).toBe(4);
    expect(seqsOf(log, null).length).toBe(2);
    expect(log.forgetAgent(["never-existed"]).removed).toBe(0);
  });

  it("is a no-op for an empty request rather than rewriting every segment", () => {
    const dir = tmp();
    const log = makeLog(dir);
    push(log, "kept", 6);
    expect(log.forgetAgent([])).toEqual({ removed: 0, segmentsRewritten: 0 });
    expect(log.forgetAgent([""])).toEqual({ removed: 0, segmentsRewritten: 0 });
  });

  it("only rewrites segments that actually hold the agent", () => {
    // Forgetting a five-minute agent must not rewrite the whole log.
    const dir = tmp();
    const log = makeLog(dir, 4);
    push(log, "kept", 12);      // three sealed segments, none containing "gone"
    push(log, "gone", 1);
    expect(log.forgetAgent(["gone"]).segmentsRewritten).toBe(0);   // it was still in the ACTIVE window
  });

  it("erases from the active window too, not just sealed segments", () => {
    const dir = tmp();
    const log = makeLog(dir, 100);   // nothing seals
    push(log, "gone", 2);
    push(log, "kept", 2);
    expect(log.forgetAgent(["gone"]).removed).toBe(2);
    expect(seqsOf(log, null)).toEqual([3, 4]);
    // and it is gone from DISK, not just from memory
    const reopened = makeLog(dir, 100);
    expect(seqsOf(reopened, "gone")).toEqual([]);
  });

  it("leaves an unparseable line alone — corrupt lines belong to the integrity scan", () => {
    // Silently dropping one during an unrelated delete would destroy the evidence that scan
    // exists to surface.
    const dir = tmp();
    const log = makeLog(dir, 4);
    push(log, "gone", 1);
    push(log, "kept", 7);
    const sealed = readdirSync(segDir(dir)).find((f) => /^events\.\d+-\d+\.jsonl$/.test(f))!;
    const path = join(segDir(dir), sealed);
    appendFileSync(path, "{ not json\n");
    log.forgetAgent(["gone"]);
    expect(readFileSync(path, "utf8")).toContain("{ not json");
  });
});
