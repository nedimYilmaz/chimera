import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLedger } from "@chimera/core/audit-ledger";
import { AUDIT_GENESIS_HASH } from "@chimera/protocol";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-audit-"));
}

function ledgerLines(dir: string): string[] {
  return readFileSync(join(dir, "audit", "ledger.jsonl"), "utf8").trim().split("\n").filter((l) => l.length > 0);
}

describe("AuditLedger.append — hash chain construction", () => {
  it("chains prevHash -> hash across records, genesis hash on the first record", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    const r1 = ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    const r2 = ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });
    const r3 = ledger.append({ agentId: null, action: "credential_resolution", resource: "acct1", decision: "recorded", reason: "resolved" });

    expect(r1.seq).toBe(1);
    expect(r1.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(r2.seq).toBe(2);
    expect(r2.prevHash).toBe(r1.hash);
    expect(r3.seq).toBe(3);
    expect(r3.prevHash).toBe(r2.hash);
    expect(new Set([r1.hash, r2.hash, r3.hash]).size).toBe(3);   // no accidental hash collisions
  });

  it("persists one JSON record per line", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    ledger.append({ agentId: "a1", action: "mcp_store_call", resource: "srv:tool", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "mcp_store_call", resource: "srv:tool2", decision: "allow", reason: "ok" });
    expect(ledgerLines(dir).length).toBe(2);
  });

  it("restart resumes seq + headHash so the chain continues correctly", () => {
    const dir = tmpDir();
    const first = new AuditLedger(dir);
    const r1 = first.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    const r2 = first.append({ agentId: "a1", action: "host_tool", resource: "curl", decision: "allow", reason: "ok" });

    const resumed = new AuditLedger(dir);
    const r3 = resumed.append({ agentId: "a1", action: "host_tool", resource: "wget", decision: "allow", reason: "ok" });

    expect(r3.seq).toBe(3);
    expect(r3.prevHash).toBe(r2.hash);
    expect(resumed.verify()).toMatchObject({ ok: true, recordCount: 3, headSeq: 3, headHash: r3.hash });
    void r1;
  });

});

describe("AuditLedger.verify — clean chain", () => {
  it("returns ok:true with correct counts on a clean chain", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });
    const r3 = ledger.append({ agentId: "a1", action: "destructive_bash_checkpoint", resource: "/tmp/x", decision: "recorded", reason: "destructive Bash command detected" });

    const result = ledger.verify();
    expect(result).toEqual({
      ok: true, recordCount: 3, headSeq: 3, headHash: r3.hash, checkpoint: null, firstDivergence: null,
    });
  });

  it("returns ok:true with zero counts on an empty ledger", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    expect(ledger.verify()).toEqual({
      ok: true, recordCount: 0, headSeq: 0, headHash: AUDIT_GENESIS_HASH, checkpoint: null, firstDivergence: null,
    });
  });
});

describe("AuditLedger.verify — tamper detection", () => {
  it("detects a MUTATED record (content changed, hash stale) at the right seq", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "curl", decision: "allow", reason: "ok" });

    const lines = ledgerLines(dir);
    const rec2 = JSON.parse(lines[1]!);
    rec2.reason = "TAMPERED — actually was allowed all along";
    lines[1] = JSON.stringify(rec2);
    writeFileSync(join(dir, "audit", "ledger.jsonl"), lines.join("\n") + "\n");

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 2, kind: "hash_mismatch" });
  });

  it("detects a DELETED middle record at the right seq", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "curl", decision: "allow", reason: "ok" });

    const lines = ledgerLines(dir);
    lines.splice(1, 1);   // remove seq=2
    writeFileSync(join(dir, "audit", "ledger.jsonl"), lines.join("\n") + "\n");

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 2, kind: "seq_gap" });
  });

  it("detects an INSERTED/duplicated foreign record at the right seq", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    const r1 = ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "curl", decision: "allow", reason: "ok" });

    const lines = ledgerLines(dir);
    // splice a duplicate of record 1 (self-consistent on its own, but seq=1 again) between seq 2 and 3
    lines.splice(2, 0, JSON.stringify(r1));
    writeFileSync(join(dir, "audit", "ledger.jsonl"), lines.join("\n") + "\n");

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 3, kind: "seq_gap" });
  });

  it("detects a corrupt (non-JSON) mid-file line — not silently skipped", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    ledger.append({ agentId: "a1", action: "host_tool", resource: "git", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "rm", decision: "deny", reason: "blocked" });

    const lines = ledgerLines(dir);
    lines.splice(1, 0, "{not valid json at all");
    writeFileSync(join(dir, "audit", "ledger.jsonl"), lines.join("\n") + "\n");

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 2, kind: "malformed_record" });
  });
});

describe("AuditLedger — periodic checkpoint anchor", () => {
  it("writes checkpoint.json every checkpointInterval appends", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir, { checkpointInterval: 3 });
    for (let i = 0; i < 5; i++) {
      ledger.append({ agentId: "a1", action: "host_tool", resource: `tool${i}`, decision: "allow", reason: "ok" });
    }
    const checkpoint = JSON.parse(readFileSync(join(dir, "audit", "checkpoint.json"), "utf8"));
    const result = ledger.verify();
    expect(checkpoint.seq).toBe(3);
    expect(result.checkpoint).toMatchObject({ seq: 3, hash: checkpoint.hash });
    expect(result.ok).toBe(true);
  });

  it("flags checkpoint_mismatch when the anchor is tampered even though the chain is internally consistent", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir, { checkpointInterval: 2 });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "a", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "b", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "c", decision: "allow", reason: "ok" });

    const checkpointPath = join(dir, "audit", "checkpoint.json");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.hash = "f".repeat(64);   // tamper the anchor only — chain itself untouched
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 2, kind: "checkpoint_mismatch" });
  });
});

// AUDIT-LEDGER-UNBOUNDED-READ regression suite. The production incident: a 631 MB ledger.jsonl
// made `new AuditLedger` throw ERR_STRING_TOO_LONG (V8 caps a string at ~512 MB), which crashed
// the Engine constructor and put the daemon in a boot loop. Allocating 512 MB in a test is not
// viable, so these exercise the two mechanisms that make the size irrelevant instead: chunked
// reads that cross the 1 MiB / 256 KiB window boundaries, and daily rotation.
const DAY1 = new Date(2026, 7, 18, 10, 0, 0).getTime();   // 2026-08-18 local
const DAY2 = new Date(2026, 7, 19, 10, 0, 0).getTime();   // 2026-08-19 local
const DAY3 = new Date(2026, 7, 20, 10, 0, 0).getTime();   // 2026-08-20 local

function segmentFiles(dir: string): string[] {
  return readdirSync(join(dir, "audit")).filter((f) => /^ledger\.\d{4}-\d{2}-\d{2}\./.test(f)).sort();
}

// ~4 KB of payload per record — 400 records clear both the 256 KiB tail window and the 1 MiB
// streaming chunk, so resume and verify both have to handle a boundary mid-record.
function fatDetail(i: number): Record<string, unknown> {
  return { command: `cmd-${i}-${"x".repeat(4096)}` };
}

describe("AuditLedger — chunked reads (no whole-file string)", () => {
  it("resumes seq + headHash from a ledger far larger than the tail window", () => {
    const dir = tmpDir();
    const first = new AuditLedger(dir);
    let last!: ReturnType<AuditLedger["append"]>;
    for (let i = 0; i < 400; i++) {
      last = first.append({ agentId: "a1", action: "host_tool", resource: `t${i}`, decision: "allow", reason: "ok", detail: fatDetail(i) });
    }
    expect(statSync(join(dir, "audit", "ledger.jsonl")).size).toBeGreaterThan(1 << 20);   // > 1 MiB: crosses the streaming chunk

    const resumed = new AuditLedger(dir);
    const next = resumed.append({ agentId: "a1", action: "host_tool", resource: "after", decision: "allow", reason: "ok" });
    expect(next.seq).toBe(401);
    expect(next.prevHash).toBe(last.hash);
    expect(resumed.verify()).toMatchObject({ ok: true, recordCount: 401, headSeq: 401 });
  });

  it("verifies a chain whose records straddle chunk boundaries, and still catches a mutation past the first chunk", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    for (let i = 0; i < 400; i++) {
      ledger.append({ agentId: "a1", action: "host_tool", resource: `t${i}`, decision: "allow", reason: "ok", detail: fatDetail(i) });
    }
    expect(ledger.verify().ok).toBe(true);

    const lines = ledgerLines(dir);
    const victim = JSON.parse(lines[350]!);
    victim.reason = "TAMPERED";
    lines[350] = JSON.stringify(victim);
    writeFileSync(join(dir, "audit", "ledger.jsonl"), lines.join("\n") + "\n");

    expect(ledger.verify().firstDivergence).toMatchObject({ seq: 351, kind: "hash_mismatch" });
  });

  it("decodes multi-byte UTF-8 that spans a chunk boundary without reporting a false corruption", () => {
    const dir = tmpDir();
    const ledger = new AuditLedger(dir);
    // "çğüşöİ" repeated — every character is 2 bytes, so some record WILL land a code point
    // across the 1 MiB read boundary. A naive per-chunk buf.toString() corrupts it into U+FFFD
    // and verify() would report malformed_record / hash_mismatch on untouched data.
    for (let i = 0; i < 400; i++) {
      ledger.append({ agentId: "a1", action: "host_tool", resource: `t${i}`, decision: "allow", reason: "ok", detail: { command: "çğüşöİ".repeat(700) } });
    }
    expect(ledger.verify()).toMatchObject({ ok: true, recordCount: 400, firstDivergence: null });
  });
});

describe("AuditLedger — daily segmentation", () => {
  it("seals the active segment when the day advances, and keeps the chain continuous across it", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const ledger = new AuditLedger(dir, { now: () => clock });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1a", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1b", decision: "allow", reason: "ok" });

    clock = DAY2;
    const r3 = ledger.append({ agentId: "a1", action: "host_tool", resource: "d2a", decision: "allow", reason: "ok" });

    expect(segmentFiles(dir)).toEqual(["ledger.2026-08-18.1-2.jsonl"]);
    expect(ledgerLines(dir).length).toBe(1);          // active file holds ONLY day 2
    expect(r3.seq).toBe(3);                            // seq never restarts at a seal
    expect(ledger.verify()).toMatchObject({ ok: true, recordCount: 3, headSeq: 3, headHash: r3.hash });
  });

  it("verifies sealed + active as ONE chain across three days", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const ledger = new AuditLedger(dir, { now: () => clock });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1", decision: "allow", reason: "ok" });
    clock = DAY2;
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d2", decision: "allow", reason: "ok" });
    clock = DAY3;
    const last = ledger.append({ agentId: "a1", action: "host_tool", resource: "d3", decision: "allow", reason: "ok" });

    expect(segmentFiles(dir)).toEqual(["ledger.2026-08-18.1-1.jsonl", "ledger.2026-08-19.2-2.jsonl"]);
    expect(ledger.verify()).toEqual({
      ok: true, recordCount: 3, headSeq: 3, headHash: last.hash, checkpoint: null, firstDivergence: null,
    });
  });

  it("resumes the chain after a restart that lands on a sealed-only ledger (rotation, then crash before any append)", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const first = new AuditLedger(dir, { now: () => clock });
    const r1 = first.append({ agentId: "a1", action: "host_tool", resource: "d1", decision: "allow", reason: "ok" });
    clock = DAY2;
    first.append({ agentId: "a1", action: "host_tool", resource: "d2", decision: "allow", reason: "ok" });
    // simulate the seal-then-crash window: drop the active file, leaving only the sealed segment
    unlinkSync(join(dir, "audit", "ledger.jsonl"));

    const resumed = new AuditLedger(dir, { now: () => clock });
    const next = resumed.append({ agentId: "a1", action: "host_tool", resource: "after", decision: "allow", reason: "ok" });
    expect(next.seq).toBe(2);
    expect(next.prevHash).toBe(r1.hash);   // picks the chain back up from the sealed segment's tail
    expect(resumed.verify()).toMatchObject({ ok: true, recordCount: 2 });
  });

  it("detects a REMOVED sealed segment from the filename chain alone", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const ledger = new AuditLedger(dir, { now: () => clock });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1", decision: "allow", reason: "ok" });
    clock = DAY2;
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d2", decision: "allow", reason: "ok" });
    clock = DAY3;
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d3", decision: "allow", reason: "ok" });

    unlinkSync(join(dir, "audit", "ledger.2026-08-18.1-1.jsonl"));   // history deleted

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 1, kind: "seq_gap" });
  });

  it("detects a mutation INSIDE an already-sealed segment", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const ledger = new AuditLedger(dir, { now: () => clock });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1a", decision: "allow", reason: "ok" });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1b", decision: "allow", reason: "ok" });
    clock = DAY2;
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d2", decision: "allow", reason: "ok" });

    const sealedPath = join(dir, "audit", "ledger.2026-08-18.1-2.jsonl");
    const sealedLines = readFileSync(sealedPath, "utf8").trim().split("\n");
    const rec = JSON.parse(sealedLines[1]!);
    rec.decision = "allow";
    rec.reason = "REWRITTEN HISTORY";
    sealedLines[1] = JSON.stringify(rec);
    writeFileSync(sealedPath, sealedLines.join("\n") + "\n");

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.firstDivergence).toMatchObject({ seq: 2, kind: "hash_mismatch" });
  });

  it("ignores operator archives (.gz, arbitrary names) sitting in the audit dir", () => {
    const dir = tmpDir();
    let clock = DAY1;
    const ledger = new AuditLedger(dir, { now: () => clock });
    ledger.append({ agentId: "a1", action: "host_tool", resource: "d1", decision: "allow", reason: "ok" });
    clock = DAY2;
    const r2 = ledger.append({ agentId: "a1", action: "host_tool", resource: "d2", decision: "allow", reason: "ok" });

    writeFileSync(join(dir, "audit", "ledger.2026-08-18.1-1.jsonl.gz"), "not really gzip");
    writeFileSync(join(dir, "audit", "ledger-backup.jsonl"), "{}\n");

    expect(ledger.verify()).toMatchObject({ ok: true, recordCount: 2, headSeq: 2, headHash: r2.hash });
  });
});
