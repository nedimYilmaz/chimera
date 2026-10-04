import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  AUDIT_GENESIS_HASH, AuditLedgerRecordSchema,
  type AuditAction, type AuditDecision, type AuditLedgerRecord, type AuditVerifyResult, type AuditDivergence,
} from "@chimera/protocol";

const DEFAULT_CHECKPOINT_INTERVAL = 200;

// AUDIT-LEDGER-UNBOUNDED-READ: every read path here is CHUNKED, never `readFileSync(whole)`.
// A V8 string caps at 0x1fffffe8 (~512 MB), so a ledger past that size made `new AuditLedger`
// throw ERR_STRING_TOO_LONG — which, because the Engine constructor builds the ledger before
// anything else, took the whole daemon down in a boot crash-loop with no way back in (observed
// at 631 MB). Chunked reads are the load-bearing fix: they hold the file size invariant-free.
// Daily segmentation (below) is the second, independent guard — it bounds how much any single
// file can grow and keeps queries from re-walking all of history, but it is NOT what makes the
// limit unreachable; a single runaway day would still blow past 512 MB without chunked reads.
const READ_CHUNK = 1 << 20;    // 1 MiB streaming window for full walks (verify)
const TAIL_WINDOW = 1 << 18;   // 256 KiB tail window — resume only needs the LAST valid record
const HEAD_WINDOW = 1 << 16;   // 64 KiB head window — rotation only needs the FIRST record's seq

export type AuditLedgerOptions = {
  checkpointInterval?: number;
  // Injectable clock (ms). Rotation is date-driven, so tests need to cross a day boundary
  // without waiting for one — same seam convention as the setTimer/exec injections elsewhere.
  now?: () => number;
};

export type AuditAppendInput = {
  agentId: string | null;
  action: AuditAction;
  resource: string;
  decision: AuditDecision;
  reason: string;
  // caller-redacted — see AuditLedgerRecordSchema's `detail` doc comment (protocol/index.ts).
  detail?: Record<string, unknown>;
};

type UnhashedRecord = Omit<AuditLedgerRecord, "hash">;

// Explicit key order (not a raw spread of the input object) so a future field reorder in the
// TS type can't silently change every historical hash — this is the exact byte sequence that
// gets sha256'd, both on write and on re-verification.
function canonicalize(r: UnhashedRecord): string {
  return JSON.stringify({
    seq: r.seq, ts: r.ts, agentId: r.agentId, action: r.action, resource: r.resource,
    decision: r.decision, reason: r.reason, detail: r.detail ?? null, prevHash: r.prevHash,
  });
}

function hashRecord(r: UnhashedRecord): string {
  return createHash("sha256").update(canonicalize(r)).digest("hex");
}

// Local (not UTC) calendar day: the operator reading "which day is this segment" is in their
// own timezone, and the only thing that must be consistent is that the key advances once a day.
function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sealed segment: `ledger.<day>.<startSeq>-<endSeq>.jsonl`. The seq range lives in the FILENAME
// (directory-entry metadata, readable without opening the file) so verify() can order segments
// and detect a missing one without a content pass — same rationale as events.ts's sealed names.
const SEGMENT_RE = /^ledger\.(\d{4}-\d{2}-\d{2})\.(\d+)-(\d+)\.jsonl$/;
type Segment = { file: string; day: string; startSeq: number; endSeq: number };

// Chunked line reader. StringDecoder (not buf.toString) because a UTF-8 sequence can straddle a
// chunk boundary — decoding each chunk independently would corrupt those code points and turn a
// valid record into a spurious `malformed_record` divergence.
function* streamLines(file: string): Generator<string> {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n === 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf("\n")) !== -1) {
        yield carry.slice(0, nl);
        carry = carry.slice(nl + 1);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) yield carry;
  } finally {
    closeSync(fd);
  }
}

// Read at most `maxBytes` from either end. `complete` reports whether the window covers that
// edge of the file — when it doesn't, the boundary line is truncated and must be discarded.
function readWindow(file: string, maxBytes: number, from: "head" | "tail"): { text: string; complete: boolean } {
  const size = statSync(file).size;
  if (size === 0) return { text: "", complete: true };
  const len = Math.min(size, maxBytes);
  const start = from === "tail" ? size - len : 0;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    // A tail window can start mid-character; dropping the partial boundary line (below) also
    // drops any partial code point, so a lossy decode here is harmless.
    return { text: buf.toString("utf8", 0, read), complete: len === size };
  } finally {
    closeSync(fd);
  }
}

function parseRecordLine(line: string): AuditLedgerRecord | null {
  if (!line.trim()) return null;
  try {
    const rec = JSON.parse(line) as AuditLedgerRecord;
    if (typeof rec.seq === "number" && Number.isFinite(rec.seq) && typeof rec.hash === "string") return rec;
    return null;
  } catch {
    return null;
  }
}

// Last valid record without reading the file: scans the tail window BACKWARDS. Torn-final-line
// tolerance on RESUME only (same as events.ts's constructor) — a crash mid-appendFileSync must
// not poison seq/headHash on restart. verify() below does NOT extend this tolerance to a
// mid-file line; that's a corruption finding, not a recoverable restart case.
function lastRecordOf(file: string): AuditLedgerRecord | null {
  const { text, complete } = readWindow(file, TAIL_WINDOW, "tail");
  const lines = text.split("\n");
  if (!complete) lines.shift();   // window started mid-line
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parseRecordLine(lines[i]!);
    if (rec) return rec;
  }
  return null;
}

function firstRecordOf(file: string): AuditLedgerRecord | null {
  const { text } = readWindow(file, HEAD_WINDOW, "head");
  for (const line of text.split("\n")) {
    const rec = parseRecordLine(line);
    if (rec) return rec;
  }
  return null;
}

// Tamper-evident, append-only audit trail — deliberately a SEPARATE file/store from EventLog
// (events.ts), which rotates and hard-deletes old segments (pruneOldSegments). This ledger
// rotates DAILY but is never pruned: every authorization-relevant fact lives here for the
// lifetime of the daemon's home dir, and verify() walks the whole sealed chain plus the active
// segment. See engine.ts/supervisor.ts for the call sites that append to it, and events.ts's
// file-header comment for why capability_decision in the general EventLog is no longer
// considered the authoritative record.
export class AuditLedger {
  private dir: string;
  private file: string;
  private checkpointFile: string;
  private checkpointInterval: number;
  private now: () => number;
  private seq = 0;
  private headHash: string = AUDIT_GENESIS_HASH;
  private activeDay: string | null = null;    // calendar day the active segment holds (null = empty)
  private activeFirstSeq = 1;                 // seq of the active segment's first record

  constructor(homeDir: string, opts?: AuditLedgerOptions) {
    this.checkpointInterval = opts?.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    this.now = opts?.now ?? (() => Date.now());
    this.dir = join(homeDir, "audit");
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, "ledger.jsonl");
    this.checkpointFile = join(this.dir, "checkpoint.json");

    const active = existsSync(this.file) ? lastRecordOf(this.file) : null;
    if (active) {
      this.seq = active.seq;
      this.headHash = active.hash;
      const first = firstRecordOf(this.file);
      this.activeFirstSeq = first?.seq ?? active.seq;
      this.activeDay = dayKey((first ?? active).ts);
    } else {
      // No active segment (fresh home, or a rotation that crashed before the first new append):
      // pick the chain back up from the newest sealed segment so seq never restarts mid-history.
      const sealed = this.listSegments();
      const newest = sealed[sealed.length - 1];
      const tail = newest ? lastRecordOf(newest.file) : null;
      if (tail) {
        this.seq = tail.seq;
        this.headHash = tail.hash;
      }
      this.activeFirstSeq = this.seq + 1;
    }
  }

  append(input: AuditAppendInput): AuditLedgerRecord {
    const ts = this.now();
    this.rotateIfNewDay(ts);
    const base: UnhashedRecord = {
      seq: ++this.seq, ts, agentId: input.agentId, action: input.action,
      resource: input.resource, decision: input.decision, reason: input.reason,
      detail: input.detail, prevHash: this.headHash,
    };
    const hash = hashRecord(base);
    const full: AuditLedgerRecord = { ...base, hash };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    if (this.activeDay === null) {
      this.activeDay = dayKey(ts);
      this.activeFirstSeq = full.seq;
    }
    this.headHash = hash;
    if (full.seq % this.checkpointInterval === 0) this.writeCheckpoint(full.seq, hash);
    return full;
  }

  // Seals the active segment when the calendar day advances. Rename-only: start/end seq are
  // already in memory, so sealing is O(1) regardless of segment size — a 631 MB legacy segment
  // seals as fast as an empty one, with no content pass. The chain is unbroken across the seal
  // (headHash carries over), so verify() reads sealed + active as ONE continuous chain.
  private rotateIfNewDay(ts: number): void {
    const day = dayKey(ts);
    if (this.activeDay === null || this.activeDay === day) return;
    if (!existsSync(this.file) || statSync(this.file).size === 0) { this.activeDay = null; return; }
    const sealed = join(this.dir, `ledger.${this.activeDay}.${this.activeFirstSeq}-${this.seq}.jsonl`);
    // A same-name segment can only exist if a prior rotation already sealed this exact range —
    // leave it alone rather than clobbering sealed audit history.
    if (existsSync(sealed)) return;
    renameSync(this.file, sealed);   // atomic seal; appendFileSync recreates ledger.jsonl below
    this.activeDay = null;
    this.activeFirstSeq = this.seq + 1;
  }

  // Sealed segments, ascending by startSeq. A file whose name doesn't match SEGMENT_RE is
  // ignored (operator archives, .gz copies, quarantine leftovers) rather than treated as chain.
  private listSegments(): Segment[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const segments: Segment[] = [];
    for (const name of names) {
      const m = SEGMENT_RE.exec(name);
      if (!m) continue;
      segments.push({ file: join(this.dir, name), day: m[1]!, startSeq: Number(m[2]), endSeq: Number(m[3]) });
    }
    return segments.sort((a, b) => a.startSeq - b.startSeq);
  }

  private writeCheckpoint(seq: number, hash: string): void {
    const tmp = `${this.checkpointFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seq, hash, ts: this.now() }));
    renameSync(tmp, this.checkpointFile);   // atomic — verify() never observes a half-written anchor
  }

  private readCheckpoint(): { seq: number; hash: string; ts: number } | null {
    if (!existsSync(this.checkpointFile)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.checkpointFile, "utf8")) as { seq: number; hash: string; ts: number };
      if (typeof parsed.seq === "number" && typeof parsed.hash === "string" && typeof parsed.ts === "number") return parsed;
      return null;
    } catch {
      return null;
    }
  }

  // Always re-reads from disk — a verify path must observe exactly what's persisted, never
  // trust in-memory state (which could itself be the product of a compromised process).
  // Walks every sealed segment in seq order, then the active one, as a SINGLE chain, streaming
  // line by line: peak memory is one 1 MiB chunk, so total history size is irrelevant.
  verify(): AuditVerifyResult {
    const checkpoint = this.readCheckpoint();
    let recordCount = 0;
    let headSeq = 0;
    let headHash = AUDIT_GENESIS_HASH;
    let firstDivergence: AuditDivergence | null = null;
    let checkpointHashAtSeq: string | null = null;
    let expectedSeq = 1;
    let runningHash = AUDIT_GENESIS_HASH;

    const walk = (file: string, seg: Segment | null): void => {
      // A sealed segment that doesn't start where the chain left off means a segment file was
      // removed or renamed — caught from the FILENAME, before a single byte is read.
      if (seg && seg.startSeq !== expectedSeq) {
        firstDivergence = { seq: expectedSeq, kind: "seq_gap", detail: `expected seq ${expectedSeq}, sealed segment ${seg.day} starts at seq ${seg.startSeq}` };
        return;
      }
      for (const line of streamLines(file)) {
        if (firstDivergence) return;
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          firstDivergence = { seq: expectedSeq, kind: "malformed_record", detail: `line is not valid JSON (expected seq ${expectedSeq})` };
          return;
        }
        const result = AuditLedgerRecordSchema.safeParse(parsed);
        if (!result.success) {
          firstDivergence = { seq: expectedSeq, kind: "malformed_record", detail: `line does not match AuditLedgerRecordSchema (expected seq ${expectedSeq}): ${result.error.message}` };
          return;
        }
        const record = result.data;

        if (record.seq !== expectedSeq) {
          firstDivergence = { seq: expectedSeq, kind: "seq_gap", detail: `expected seq ${expectedSeq}, found seq ${record.seq}` };
          return;
        }
        if (record.prevHash !== runningHash) {
          firstDivergence = { seq: record.seq, kind: "hash_mismatch", detail: `prevHash does not match the prior record's hash — chain broken at seq ${record.seq}` };
          return;
        }
        const expectedHash = hashRecord(record);
        if (expectedHash !== record.hash) {
          firstDivergence = { seq: record.seq, kind: "hash_mismatch", detail: `record content does not match its own hash — mutated at seq ${record.seq}` };
          return;
        }

        recordCount++;
        headSeq = record.seq;
        headHash = record.hash;
        runningHash = record.hash;
        expectedSeq++;
        if (checkpoint && record.seq === checkpoint.seq) checkpointHashAtSeq = record.hash;
      }
      if (seg && !firstDivergence && headSeq !== seg.endSeq) {
        firstDivergence = { seq: headSeq + 1, kind: "seq_gap", detail: `sealed segment ${seg.day} claims records through seq ${seg.endSeq} but its content ends at seq ${headSeq}` };
      }
    };

    for (const seg of this.listSegments()) {
      if (firstDivergence) break;
      walk(seg.file, seg);
    }
    if (!firstDivergence && existsSync(this.file)) walk(this.file, null);

    if (!firstDivergence && checkpoint) {
      if (checkpointHashAtSeq === null) {
        // The chain never reached the checkpoint's anchored seq at all (e.g. records were
        // truncated off the end after the checkpoint was written) — the anchor can't be
        // corroborated, which is itself a divergence.
        firstDivergence = { seq: checkpoint.seq, kind: "checkpoint_mismatch", detail: `checkpoint anchors seq ${checkpoint.seq} but the ledger never reached that seq` };
      } else if (checkpointHashAtSeq !== checkpoint.hash) {
        firstDivergence = { seq: checkpoint.seq, kind: "checkpoint_mismatch", detail: `checkpoint anchor hash does not match the chain's hash at seq ${checkpoint.seq}` };
      }
    }

    return { ok: firstDivergence === null, recordCount, headSeq, headHash, checkpoint, firstDivergence };
  }
}
