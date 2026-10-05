import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { EventLogDurabilityConfigSchema, type ChronicleExportRequest, type ChronicleExportResponse, type ChronicleMatchField, type ChronicleSearchHit, type ChronicleSearchRequest, type ChronicleSearchResponse, type EventKind, type EventLogDurabilityConfig, type NormalizedEvent } from "@chimera/protocol";
import {
  DurableAppendLog, fsyncDirectory, realDurableWriteDeps, writeFileDurable,
  type ClearTimerFn, type DurableWriteDeps, type TimerFn,
} from "./durable-write.js";
import { scanSegments, SCAN_BACKGROUND, SCAN_INTERACTIVE } from "./segment-scan.js";

type Listener = (e: NormalizedEvent) => void;

// R2-DURABLE-LOG: boot-time integrity-scan findings. `quarantined` entries are sealed segments
// whose checksum/seq-continuity no longer matched their `.meta` sidecar — moved into
// events/quarantine/ rather than silently served with a skipped bad line. `seqGaps` entries are
// breaks in seq continuity across the surviving segment chain (from a quarantine just performed,
// or from a segment missing for any other reason) — reported, never silently tolerated.
export type QuarantineEntry = { file: string; reason: string };
export type SeqGapEntry = { afterSeq: number; nextSeq: number };
export type RecoveryReport = { quarantined: QuarantineEntry[]; seqGaps: SeqGapEntry[] };

type SegmentMeta = {
  checksum: string;
  count: number;
  startSeq: number;
  endSeq: number;
  // AGENT-FORGET: seqs deliberately removed from this segment by forgetAgent(). Absent on every
  // segment sealed before that existed, and on every segment nothing was ever removed from.
  //
  // This is what keeps the integrity scan honest. verifySegment requires strictly consecutive
  // seqs, so any deletion would otherwise look exactly like the mid-segment corruption the scan
  // exists to catch, and the whole segment — every OTHER agent's history in it — would be
  // quarantined. Recording the removals lets the walk distinguish "we did this on purpose" from
  // "a line went missing", instead of the alternative: relaxing the check to allow gaps, which
  // would have traded a real safety property for one operation's convenience.
  //
  // startSeq/endSeq deliberately keep their ORIGINAL values even when the first or last event is
  // removed, so the BETWEEN-segment continuity scan is unaffected by a forget.
  removedSeqs?: number[];
};

// Canonical defaults sourced from the zod schema itself (not duplicated here) so a schema
// default change can never silently drift from what a durability-option-less `new EventLog(dir)`
// actually does.
const DEFAULT_DURABILITY: EventLogDurabilityConfig = EventLogDurabilityConfigSchema.parse({});

// AUDIT-3: events.jsonl grew unboundedly and tail/replay re-parsed the WHOLE file on
// every call. Fix has two parts:
//  1. Rotation: once the active file holds MAX_EVENTS_PER_SEGMENT events, it's renamed
//     to a sealed segment `events.<firstSeq>-<lastSeq>.jsonl` and a fresh active file
//     starts. Segments beyond MAX_SEGMENTS are pruned oldest-first (size/age bound).
//  2. Windowed reads: `recent` mirrors the active segment's parsed content in memory,
//     updated incrementally on append (no re-read). tail()/replay() serve from it
//     directly; only when a query needs data older than the active segment do they
//     fall back to reading sealed segment files — and only the ones whose filename
//     range can possibly contain the requested seq (an index, not a scan).
// EVENT-LOG-RETENTION: these mirror EventLogRetentionConfigSchema's own defaults in
// @chimera/protocol (not duplicated logic, just the fallback for a config-less `new EventLog(dir)`
// e.g. in tests) — 5000 * 60 ≈ 300,000 events, ≈3 days of history at this machine's measured rate
// (see protocol/src/index.ts for the measurement). The prior 5000 * 4 ≈ 20,000 events silently
// bounded history to five to six hours, which is what ate a user's prior-day conversation.
const DEFAULT_MAX_EVENTS_PER_SEGMENT = 5000;   // accepted bound: rotate the active segment at this size
const DEFAULT_MAX_SEGMENTS = 60;               // accepted bound: oldest sealed segments pruned beyond this count

// Tamper-evident audit ledger note: `capability_decision` events written through this log
// (see engine.ts's CapabilityBroker emit closure) are a live/recent-window cache ONLY — they
// rotate and get hard-deleted by pruneOldSegments below like any other event. The durable,
// hash-chained, NEVER-pruned copy of every authorization decision lives in audit-ledger.ts's
// AuditLedger (<home>/audit/ledger.jsonl), which this class has no relationship to. Do not
// treat this file's capability_decision entries as the authoritative security record.
export type EventLogOptions = {
  maxEventsPerSegment?: number;
  maxSegments?: number;
  // R2-DURABLE-LOG: absent ⇒ EventLogDurabilityConfigSchema's own defaults (group-commit).
  // ioDeps/setTimer/clearTimer are test seams (absent ⇒ real fs/timers), mirroring the
  // "absent ⇒ real behavior" convention used throughout engine.ts (notifySetTimer, otelFetch, …).
  durability?: EventLogDurabilityConfig;
  ioDeps?: DurableWriteDeps;
  setTimer?: TimerFn;
  clearTimer?: ClearTimerFn;
  // BOOT-LATENCY-EVENTLOG: absent ⇒ "deferred" (see IntegrityScanMode below).
  integrityScan?: IntegrityScanMode;
};

// BOOT-LATENCY-EVENTLOG: how the sealed-segment content verification is scheduled. "deferred"
// (the default, and what the daemon runs) hands the constructor back after only the cheap
// filename-level chain scan and walks the segments one-per-timer-tick afterwards; "sync"
// verifies everything inside the constructor, the pre-feature behavior, kept for callers that
// need the report to be complete the instant the constructor returns. Either way `verified()`
// resolves when the pass is done — the deferred path is the one under test, not a second
// code path (see events-integrity.test.ts).
export type IntegrityScanMode = "deferred" | "sync";

type Segment = { file: string; startSeq: number; endSeq: number };

export class EventLog {
  private eventsDir: string;
  private file: string;
  private seq = 0;
  private listeners = new Set<Listener>();
  private maxEventsPerSegment: number;
  private maxSegments: number;
  private recent: NormalizedEvent[] = [];   // parsed content of the ACTIVE segment file, in append order
  private segmentFirstSeq = 1;              // seq of recent[0] (or the next seq to be assigned if recent is empty)
  private durability: EventLogDurabilityConfig;
  private ioDeps: DurableWriteDeps;
  private setTimerFn?: TimerFn;
  private clearTimerFn?: ClearTimerFn;
  private appendLog: DurableAppendLog;
  private recoveryReportValue: RecoveryReport = { quarantined: [], seqGaps: [] };
  // BOOT-LATENCY-EVENTLOG: settles when the sealed-segment content verification pass has
  // finished (immediately, for integrityScan:"sync"). Exposed via verified().
  private verifiedPromise!: Promise<void>;

  archiveContext(text: string): string {
    const directory = join(this.eventsDir, "transfers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.md`);
    writeFileSync(path, text, { mode: 0o600, flag: "wx" });
    return path;
  }

  constructor(dir: string, opts?: EventLogOptions) {
    this.maxEventsPerSegment = opts?.maxEventsPerSegment ?? DEFAULT_MAX_EVENTS_PER_SEGMENT;
    this.maxSegments = opts?.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    this.eventsDir = join(dir, "events");
    mkdirSync(this.eventsDir, { recursive: true });     // spec §3 layout: ~/.chimera/events/*.jsonl
    this.file = join(this.eventsDir, "events.jsonl");
    this.durability = opts?.durability ?? DEFAULT_DURABILITY;
    this.ioDeps = opts?.ioDeps ?? realDurableWriteDeps;
    this.setTimerFn = opts?.setTimer;
    this.clearTimerFn = opts?.clearTimer;
    this.appendLog = this.newAppendLog();
    const hadActiveFile = existsSync(this.file);
    if (hadActiveFile) {
      const lines = readFileSync(this.file, "utf8").trim();
      if (lines) {
        const seqFrom = (s: string): number | null => {
          try {
            const seq = (JSON.parse(s) as NormalizedEvent).seq;
            return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
          } catch {
            return null;
          }
        };
        // Fast path: read the last line only. On a torn/malformed final line
        // (crash mid-appendFileSync — a restart scenario the design plans for),
        // recover seq from the last well-formed line instead of throwing or
        // adopting NaN, which would poison the monotonic-seq contract.
        const fast = seqFrom(lines.slice(lines.lastIndexOf("\n") + 1));
        if (fast !== null) {
          this.seq = fast;
        } else {
          for (const line of lines.split("\n").reverse()) {
            const s = seqFrom(line);
            if (s !== null) {
              this.seq = s;
              break;
            }
          }
        }
        // Build the in-memory window from the active file (bounded by rotation,
        // so this is a bounded read, not a full-history scan). A torn final line
        // is skipped, same tolerance as replay().
        for (const line of lines.split("\n")) {
          if (!line.trim()) continue;
          try { this.recent.push(JSON.parse(line) as NormalizedEvent); } catch { continue; }
        }
        const firstValid = this.recent.find((e) => typeof e.seq === "number" && Number.isFinite(e.seq));
        this.segmentFirstSeq = firstValid ? firstValid.seq : this.seq + 1;
      }
    }
    // (no active file: segmentFirstSeq/seq are resolved below, from the sealed chain's
    // watermark, once the scan has run — NOT defaulted to `this.seq + 1` here, which would be
    // 1 whenever `this.seq` is still its 0 initializer, silently reusing already-sealed seqs on
    // a restart that lands exactly on a rotation boundary. See scanSealedSegments' doc comment.)
    //
    // BOOT-LATENCY-EVENTLOG: the chain scan is FILENAME-level only — seq continuity and the
    // sealed chain's watermark both come from the `events.<start>-<end>.jsonl` names, never
    // from file contents. That matters because it's the only part of the old scan the
    // constructor genuinely has to finish before the log is usable, and it costs one readdir
    // instead of reading + sha256-ing + JSON.parsing every byte of retained history (on a real
    // daemon's ~700MB of sealed segments that was a measured 3.3s of dead time BEFORE the RPC
    // socket could even bind, which reads to an operator as "the daemon didn't start"). The
    // content verification still happens — see startDeferredVerification below.
    //
    // Watermark semantics are unchanged by the split: the old scan advanced `expectedNext` to
    // `seg.endSeq + 1` in EVERY branch (verified, legacy-no-sidecar, and even quarantined —
    // see quarantineSegment's call site), so the filename-derived chain is identical to what a
    // full content scan produced.
    const chain = this.scanSegmentChain();
    const seqGaps = [...chain.seqGaps];
    if (!hadActiveFile) {
      this.seq = chain.expectedNext !== null ? chain.expectedNext - 1 : 0;
      this.segmentFirstSeq = this.seq + 1;
    } else if (chain.expectedNext !== null && this.segmentFirstSeq !== chain.expectedNext) {
      // the active file exists but doesn't pick up where the sealed chain left off — a segment
      // between them is missing (quarantined elsewhere, pruned unexpectedly, or lost outright).
      seqGaps.push({ afterSeq: chain.expectedNext - 1, nextSeq: this.segmentFirstSeq });
    }
    // Pruning now runs BEFORE verification rather than after it (it used to be the other way
    // round). The only observable difference: a corrupt segment that was already past the
    // retention bound is deleted outright instead of being quarantined first — it was being
    // deleted either way, so nothing recoverable is lost, and verification never wastes a full
    // read on a segment that is about to disappear.
    this.pruneOldSegments();   // in case maxSegments was lowered, or segments outlived a config change
    // ONE recovery report and ONE event_log_recovery event per boot, both owned by the
    // verification pass — the filename-derived seqGaps are handed to it rather than emitted
    // here, so a deferred boot never publishes a half-finished report that a later quarantine
    // then contradicts.
    this.verifiedPromise = this.startVerification(opts?.integrityScan ?? "deferred", seqGaps);
  }

  // BOOT-LATENCY-EVENTLOG: resolves once every sealed segment has been content-verified (and
  // any corrupt one quarantined + reported). Callers that must observe a COMPLETE
  // recoveryReport() — tests, an operator-facing integrity command — await this; the daemon
  // does not, which is the entire point.
  verified(): Promise<void> {
    return this.verifiedPromise;
  }

  private newAppendLog(): DurableAppendLog {
    return new DurableAppendLog(this.file, {
      mode: this.durability.mode,
      groupCommitMs: this.durability.groupCommitMs,
      groupCommitMaxBatch: this.durability.groupCommitMaxBatch,
      deps: this.ioDeps,
      setTimer: this.setTimerFn,
      clearTimer: this.clearTimerFn,
    });
  }

  // engineId "local" is the default; a caller-supplied engineId (future peer
  // ingestion, Phase 5) wins over it. seq is self-assigned only for
  // engineId="local" events; peer-origin events land in separate
  // events/<engineId>.jsonl files with origin-assigned seq.
  append(e: { agentId: string; kind: EventKind; data: Record<string, unknown>; raw?: unknown; engineId?: string }): NormalizedEvent {
    const full: NormalizedEvent = { ts: Date.now(), seq: ++this.seq, ...e, engineId: e.engineId ?? "local" };
    this.appendLog.append(JSON.stringify(full) + "\n");
    this.recent.push(full);
    for (const fn of this.listeners) fn(full);
    if (this.recent.length >= this.maxEventsPerSegment) this.rotate();
    return full;
  }

  // R2-DURABLE-LOG: forces any pending group-commit fsync now. Called by rotate() (below,
  // BEFORE sealing — the checksum sidecar must cover fsync-durable bytes) and by the daemon's
  // shutdown path (main.ts) so a clean shutdown never leaves a group-commit window unflushed.
  flushDurable(): void {
    this.appendLog.flush();
  }

  // BOOT-LATENCY-EVENTLOG: complete only once verified() has settled — under the default
  // "deferred" scan this is still empty for the first moments of a boot, by design. Anything
  // that must act on a COMPLETE report (an operator command, a test) awaits verified() first;
  // anything that just wants to surface findings when they land subscribes to the
  // event_log_recovery event, which is emitted exactly once per boot by the same pass.
  recoveryReport(): RecoveryReport {
    return { quarantined: [...this.recoveryReportValue.quarantined], seqGaps: [...this.recoveryReportValue.seqGaps] };
  }

  private rotate(): void {
    // Flushes the about-to-be-sealed content's fsync BEFORE rename — the file's data pages must
    // already be durable before we start trusting a checksum computed over them. A rename on the
    // SAME filesystem doesn't touch the file's data, only its directory entry, so there's no need
    // to fsync the (now-renamed) file's data a second time after — only the directory entry
    // change itself still needs its own fsync (below), which is what makes the rename durable.
    this.flushDurable();
    const firstSeq = this.segmentFirstSeq;
    const lastSeq = this.recent[this.recent.length - 1]!.seq;
    const sealed = join(this.eventsDir, `events.${firstSeq}-${lastSeq}.jsonl`);
    renameSync(this.file, sealed);          // atomic seal; appendLog recreates `events.jsonl` lazily on next append
    fsyncDirectory(this.eventsDir, this.ioDeps);   // fsync on rotate rename + dir
    // Checksum is computed from the in-memory `recent` window (exactly what was written, byte
    // for byte — JSON.stringify is deterministic per object) rather than re-reading the sealed
    // file from disk: avoids a full extra I/O pass per rotation on top of the fsyncs above.
    const raw = this.recent.map((ev) => JSON.stringify(ev) + "\n").join("");
    const checksum = createHash("sha256").update(raw).digest("hex");
    const meta: SegmentMeta = { checksum, count: this.recent.length, startSeq: firstSeq, endSeq: lastSeq };
    writeFileDurable(`${sealed}.meta`, JSON.stringify(meta), this.ioDeps);   // already fsyncs data + dir
    this.recent = [];
    this.segmentFirstSeq = lastSeq + 1;
    this.appendLog = this.newAppendLog();
    this.pruneOldSegments();
  }

  // R2-DURABLE-LOG: walks sealed segments ascending by startSeq, verifying each against its
  // `.meta` sidecar (checksum + record count + in-order seq walk). A segment with no sidecar
  // predates this feature — trusted as-is (backward compat with every already-deployed
  // segment), never quarantined. A mismatch of ANY kind (checksum, count, an unparseable line,
  // a seq that isn't the expected +1) quarantines the WHOLE segment — this is the fix for the
  // pre-existing bug where readSegment()'s per-line try/catch silently served the good lines
  // around a corrupt one. Returns `expectedNext` — the seq immediately after the last verified
  // (or legacy-trusted) segment, i.e. the sealed chain's watermark — so the constructor can (a)
  // detect a gap between that watermark and wherever the active segment picks up, and (b) recover
  // seq/segmentFirstSeq correctly on a restart where the active file doesn't exist on disk (an
  // exact-multiple-of-maxEventsPerSegment rotation with no further append before the crash/stop
  // — the active-file-only seq recovery above has nothing to read in that case).
  // The cheap half: seq continuity + the sealed chain's watermark, both read straight off the
  // `events.<start>-<end>.jsonl` filenames (one readdir, no file contents). Continuity
  // deliberately advances past EVERY segment — including one the verification pass will later
  // quarantine — using the FILENAME's claimed endSeq: directory-entry-level metadata is a
  // distinct and more trustworthy layer than a file's own possibly-corrupted content. Otherwise
  // a log whose only segment is corrupt could never re-establish a seq watermark, and the very
  // next freshly-assigned seq could collide with one that segment already used.
  private scanSegmentChain(): { seqGaps: SeqGapEntry[]; expectedNext: number | null } {
    const seqGaps: SeqGapEntry[] = [];
    let expectedNext: number | null = null;
    for (const seg of this.listSegments()) {
      if (expectedNext !== null && seg.startSeq !== expectedNext) {
        seqGaps.push({ afterSeq: expectedNext - 1, nextSeq: seg.startSeq });
      }
      expectedNext = seg.endSeq + 1;
    }
    return { seqGaps, expectedNext };
  }

  // The expensive half, scheduled per IntegrityScanMode. One segment per timer tick in
  // "deferred" mode so a multi-hundred-MB verification never occupies the event loop in a
  // single blocking slab — the daemon stays responsive to RPCs while it runs.
  //
  // Accepted window: between boot and this pass finishing, a replay()/tail() reaching back into
  // a not-yet-verified segment can still serve a corrupt line (which is exactly what happened
  // for the whole life of the process before the sync scan existed, and is anyway already true
  // of the active, never-checksummed segment). The pass still quarantines and still reports —
  // seconds later instead of before the socket binds.
  private startVerification(mode: IntegrityScanMode, seqGaps: SeqGapEntry[]): Promise<void> {
    const segs = this.listSegments();
    const quarantined: QuarantineEntry[] = [];
    const verifyOne = (seg: Segment): void => {
      const metaPath = `${seg.file}.meta`;
      // No sidecar ⇒ a segment predating checksums (or one rotated away underneath us) —
      // trusted as-is, never quarantined. Same backward-compat rule as before the split.
      if (!existsSync(metaPath) || this.verifySegment(seg, metaPath)) return;
      this.quarantineSegment(seg.file, metaPath);
      quarantined.push({ file: basename(seg.file), reason: "checksum/seq-continuity mismatch against sealed .meta" });
    };
    const finish = (): void => {
      if (quarantined.length === 0 && seqGaps.length === 0) return;
      this.recoveryReportValue = { quarantined, seqGaps };
      this.append({ agentId: "eventlog", kind: "event_log_recovery", data: { quarantined, seqGaps } });
    };
    if (mode === "sync") {
      for (const seg of segs) verifyOne(seg);
      finish();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const setTimer = this.setTimerFn ?? setTimeout;
      let i = 0;
      const step = (): void => {
        if (i >= segs.length) { finish(); resolve(); return; }
        verifyOne(segs[i++]!);
        schedule();
      };
      const schedule = (): void => {
        const handle = setTimer(step, 0);
        // Never hold the process open for an integrity sweep: a daemon shutting down mid-pass
        // must exit, not wait out the remaining segments.
        (handle as { unref?: () => void } | undefined)?.unref?.();
      };
      schedule();
    });
  }

  private verifySegment(seg: Segment, metaPath: string): boolean {
    let meta: SegmentMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as SegmentMeta;
    } catch {
      return false;   // sidecar itself unreadable/corrupt
    }
    if (meta.startSeq !== seg.startSeq || meta.endSeq !== seg.endSeq) return false;
    let raw: string;
    try {
      raw = readFileSync(seg.file, "utf8");
    } catch {
      return false;
    }
    if (createHash("sha256").update(raw).digest("hex") !== meta.checksum) return false;
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length !== meta.count) return false;
    // AGENT-FORGET: a gap is acceptable ONLY where the sidecar says one was made on purpose.
    // Every other gap is still the mid-segment corruption this scan exists to catch.
    const removed = new Set(meta.removedSeqs ?? []);
    let expected = meta.startSeq;
    const skipRemoved = (): void => { while (removed.has(expected)) expected++; };
    for (const line of lines) {
      let parsed: NormalizedEvent;
      try {
        parsed = JSON.parse(line) as NormalizedEvent;
      } catch {
        return false;   // an unparseable mid-segment line — the exact bug this scan exists to catch
      }
      skipRemoved();
      if (typeof parsed.seq !== "number" || parsed.seq !== expected) return false;
      expected++;
    }
    // A run of removals at the very END of the segment still has to account for endSeq.
    skipRemoved();
    return expected - 1 === meta.endSeq;
  }

  private quarantineSegment(file: string, metaPath: string): void {
    const qDir = join(this.eventsDir, "quarantine");
    mkdirSync(qDir, { recursive: true });
    try { renameSync(file, join(qDir, basename(file))); } catch { /* already gone */ }
    if (existsSync(metaPath)) {
      try { renameSync(metaPath, join(qDir, basename(metaPath))); } catch { /* already gone */ }
    }
  }

  private listSegments(): Segment[] {
    let names: string[];
    try { names = readdirSync(this.eventsDir); } catch { return []; }
    const re = /^events\.(\d+)-(\d+)\.jsonl$/;
    const out: Segment[] = [];
    for (const name of names) {
      const m = re.exec(name);
      if (!m) continue;
      out.push({ file: join(this.eventsDir, name), startSeq: Number(m[1]), endSeq: Number(m[2]) });
    }
    out.sort((a, b) => a.startSeq - b.startSeq);
    return out;
  }

  private pruneOldSegments(): void {
    const segs = this.listSegments();
    for (let i = 0; i < segs.length - this.maxSegments; i++) {
      try { unlinkSync(segs[i]!.file); } catch { /* already gone */ }
      try { unlinkSync(`${segs[i]!.file}.meta`); } catch { /* no sidecar (legacy segment) or already gone */ }
    }
  }

  private readSegment(file: string): NormalizedEvent[] {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { return []; }
    const out: NormalizedEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as NormalizedEvent); } catch { continue; }   // torn line tolerated
    }
    return out;
  }

  // Newest-first fill: start from the in-memory active-segment window (no disk read)
  // and only fall back to sealed segments, newest first, if that window doesn't have
  // `need` matches yet. The common case (recent data satisfies the request) never
  // touches disk.
  //
  // TRANSCRIPT-SEGMENT-INDEX: when a `toSeq` bound is given, a segment whose
  // startSeq > toSeq cannot contain a matching event — skip it via the filename
  // index without reading it, mirroring eventsFromSeq's forward-direction skip.
  // matchFn still re-checks toSeq (it's baked into withinBounds by callers), so
  // this is purely an I/O-avoidance fast path — content/order are unaffected.
  private newestMatching(matchFn: (e: NormalizedEvent) => boolean, need: number, toSeq?: number): NormalizedEvent[] {
    let out = this.recent.filter(matchFn);
    if (out.length >= need) return out;
    const segs = this.listSegments();
    for (let i = segs.length - 1; i >= 0 && out.length < need; i--) {
      const seg = segs[i]!;
      if (toSeq !== undefined && seg.startSeq > toSeq) continue;
      out = this.readSegment(seg.file).filter(matchFn).concat(out);
    }
    return out;
  }

  // SEGMENT-SCAN: newestMatching's twin, with the sealed-segment half moved OFF the event loop.
  //
  // The loop above is the daemon's worst blocking call. It stops at `need` matches, so a request
  // that can never be satisfied — an agent whose events have rotated away — reads EVERY segment
  // with readFileSync + JSON.parse before returning nothing. Measured: 60 segments, 575 MB, up to
  // 13 SECONDS of a completely frozen daemon, from one transcript click. Node is single-threaded,
  // so during it every other agent's events, every RPC and every timer simply waits.
  //
  // The split is drawn where mutability is: `recent` is the ACTIVE segment, in memory and still
  // being appended to, so it is filtered here on the thread that owns it. Sealed segments are
  // immutable once renamed, which is what lets a worker read them with no lock and no shared
  // state. Only paths cross to the worker; only matches come back.
  //
  // Used by the INTERACTIVE paths (events.replay / agent.tail). The synchronous twin above stays
  // for boot-time callers (reattach, replay projection), which run once, before there is any load
  // to block, and would gain nothing from an await.
  private async newestMatchingAsync(matchFn: (e: NormalizedEvent) => boolean, need: number, agentId: string | null, toSeq?: number): Promise<NormalizedEvent[]> {
    const out = this.recent.filter(matchFn);
    if (out.length >= need) return out;   // the common case never touches disk, exactly as before
    const segs = this.listSegments();
    const older = await scanSegments({
      segments: [...segs].reverse().map((s) => ({ file: s.file, startSeq: s.startSeq })),   // newest first
      agentId,
      ...(toSeq !== undefined ? { toSeq } : {}),
      need: need - out.length,
      // These two paths exist for a click: events.replay is the transcript the operator just
      // opened, agent.tail the agent they just selected. Anything speculative should ask for the
      // background queue instead, and wait behind them.
    }, SCAN_INTERACTIVE);
    // The worker applies agentId/toSeq itself; matchFn is re-applied so any caller-specific
    // predicate beyond those two still decides, and the two can never drift apart.
    return older.filter(matchFn).concat(out);
  }

  // Ascending-from-fromSeq fill for forward scrubbing: only sealed segments whose
  // filename range overlaps [fromSeq, ...) are opened — segments entirely before
  // fromSeq are skipped via the filename index, never read.
  private eventsFromSeq(fromSeq: number): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const seg of this.listSegments()) {
      if (seg.endSeq < fromSeq) continue;
      out.push(...this.readSegment(seg.file).filter((e) => e.seq >= fromSeq));
    }
    out.push(...this.recent.filter((e) => e.seq >= fromSeq));
    return out;
  }

  tail(agentId: string | null, n: number): NormalizedEvent[] {
    if (n <= 0) return [];   // slice(-0) === slice(0) returns everything; guard n<=0
    const matchFn = agentId ? (e: NormalizedEvent) => e.agentId === agentId : () => true;
    return this.newestMatching(matchFn, n).slice(-n);
  }

  /** Boot-only legacy session recovery. Scan segments once for the whole fleet,
   * newest first, retaining only one start event per requested agent. Unlike a
   * transcript tail this also finds starts buried under a long conversation. */
  latestAgentStarts(sinceByAgent: ReadonlyMap<string, number>, toSeq: number): Map<string, NormalizedEvent> {
    const found = new Map<string, NormalizedEvent>();
    const visit = (events: NormalizedEvent[]) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        const since = sinceByAgent.get(e.agentId);
        if (since === undefined || found.has(e.agentId) || e.kind !== "agent_started" || e.seq > toSeq || e.ts < since) continue;
        found.set(e.agentId, e);
      }
    };
    if (!sinceByAgent.size) return found;
    visit(this.recent);
    if (found.size === sinceByAgent.size) return found;
    const segments = this.listSegments();
    for (let i = segments.length - 1; i >= 0 && found.size < sinceByAgent.size; i--) {
      const segment = segments[i]!;
      if (segment.startSeq <= toSeq) visit(this.readSegment(segment.file));
    }
    return found;
  }

  // WD Stage 1 (coverage B7, replay bar): range-read the persisted jsonl. Semantics:
  //   * fromSeq/toSeq: inclusive seq bounds; either may be omitted.
  //   * agentId: optional per-agent filter (bare local ids — engine.ts's qualified-id
  //     router rejects engine-qualified ids for this method before it gets here).
  //   * limit: with fromSeq set, the FIRST `limit` events from that point (forward
  //     scrubbing — the replay bar walks a window forward); without fromSeq, the
  //     NEWEST `limit` (tail semantics for the bar's initial fill).
  // A torn/malformed line (crash mid-append) is SKIPPED, not thrown — replay must be
  // able to read a log whose final line is truncated.
  replay(opts: { fromSeq?: number; toSeq?: number; agentId?: string | null; limit: number }): NormalizedEvent[] {
    const withinBounds = (e: NormalizedEvent) =>
      typeof e.seq === "number" && Number.isFinite(e.seq) &&
      (opts.toSeq === undefined || e.seq <= opts.toSeq) && (!opts.agentId || e.agentId === opts.agentId);

    if (opts.fromSeq !== undefined) {
      const out = this.eventsFromSeq(opts.fromSeq).filter(withinBounds);
      out.sort((a, b) => a.seq - b.seq);   // file order is append order, but the contract is seq-ordered — sort defensively
      return out.slice(0, opts.limit);
    }
    const out = this.newestMatching(withinBounds, opts.limit, opts.toSeq);
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(-opts.limit);
  }

  /** SEGMENT-SCAN: replay() with the sealed-segment read off-thread. Same arguments, same result,
   *  same order — the RPC path (events.replay) awaits this so a transcript click can no longer
   *  freeze the daemon while it walks the log. */
  async replayAsync(opts: { fromSeq?: number; toSeq?: number; agentId?: string | null; limit: number }): Promise<NormalizedEvent[]> {
    // The forward branch is bounded by the filename index (segments entirely before fromSeq are
    // never opened) and is used by the replay bar's own paging, not by the transcript — left
    // synchronous so its behaviour stays byte-identical.
    if (opts.fromSeq !== undefined) return this.replay(opts);
    const withinBounds = (e: NormalizedEvent) =>
      typeof e.seq === "number" && Number.isFinite(e.seq) &&
      (opts.toSeq === undefined || e.seq <= opts.toSeq) && (!opts.agentId || e.agentId === opts.agentId);
    const out = await this.newestMatchingAsync(withinBounds, opts.limit, opts.agentId ?? null, opts.toSeq);
    out.sort((a, b) => a.seq - b.seq);
    return out.slice(-opts.limit);
  }

  /** SEGMENT-SCAN: tail() with the sealed-segment read off-thread. */
  async tailAsync(agentId: string | null, n: number): Promise<NormalizedEvent[]> {
    if (n <= 0) return [];   // slice(-0) === slice(0) returns everything; guard n<=0
    const matchFn = agentId ? (e: NormalizedEvent) => e.agentId === agentId : () => true;
    return (await this.newestMatchingAsync(matchFn, n, agentId)).slice(-n);
  }

  /** Sparse voice history must count voice messages, not intervening coding events. */
  async tailKindAsync(agentId: string, kind: EventKind, n: number): Promise<NormalizedEvent[]> {
    if (n <= 0) return [];
    const recent = this.recent.filter(e => e.agentId === agentId && e.kind === kind);
    if (recent.length >= n) return recent.slice(-n);
    const older = await scanSegments({
      segments: [...this.listSegments()].reverse().map(s => ({ file: s.file, startSeq: s.startSeq })),
      agentId, kind, need: n - recent.length,
    }, SCAN_BACKGROUND);
    return older.concat(recent).slice(-n);
  }

  /** SEARCH-OFF-THREAD: search() with the whole-log read moved to the worker pool.
   *
   *  search() walks EVERY sealed segment — the same 575 MB and the same seconds of frozen daemon
   *  that events.replay used to cost — and searchExport calls it in a LOOP to page, so one export
   *  re-read the entire log once per page. This is the same body, with the read and a coarse
   *  text prefilter done in a worker; only candidate events cross back, and the real scoring runs
   *  here unchanged so ranking cannot drift from a copy of itself.
   *
   *  Queued as BACKGROUND: a search is something the operator asked for, but it is a scan over
   *  everything and must never be in front of the transcript they are also waiting on. */
  async searchAsync(req: ChronicleSearchRequest): Promise<ChronicleSearchResponse> {
    const query = req.query.toLocaleLowerCase("en-US");
    const tokens = [...new Set(query.split(/\s+/).filter(Boolean))];
    const segs = this.listSegments();
    const sealed = tokens.length === 0 && query.length === 0
      ? []   // an empty query matches nothing to prefilter on; fall through with the active window
      : await scanSegments({
          segments: [...segs].reverse().map((sg) => ({ file: sg.file, startSeq: sg.startSeq })),
          agentId: null,
          need: Number.MAX_SAFE_INTEGER,   // a search wants every match, not the first page
          match: { phrase: query, tokens },
        }, SCAN_BACKGROUND);
    // The retained range comes from the filename index — the segments' own bounds — so reporting
    // it costs no read even though the prefilter dropped almost everything.
    const firstSeq = segs[0]?.startSeq ?? this.recent[0]?.seq ?? null;
    const lastSeq = this.recent[this.recent.length - 1]?.seq ?? segs[segs.length - 1]?.endSeq ?? null;
    return this.rankSearch(req, [...sealed, ...this.recent], firstSeq, lastSeq);
  }

  search(req: ChronicleSearchRequest): ChronicleSearchResponse {
    const all = this.eventsFromSeq(1);
    return this.rankSearch(req, all, all[0]?.seq ?? null, all[all.length - 1]?.seq ?? null);
  }

  /** The scoring half, shared by search() and searchAsync() so ranking has ONE definition. */
  private rankSearch(req: ChronicleSearchRequest, all: readonly NormalizedEvent[], firstSeq: number | null, lastSeq: number | null): ChronicleSearchResponse {
    const fingerprint = createHash("sha256").update(JSON.stringify({ query: req.query, scope: req.scope ?? {} })).digest("hex").slice(0, 16);
    let offset = 0;
    if (req.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(req.cursor, "base64url").toString("utf8")) as { f?: string; o?: number };
        if (parsed.f !== fingerprint || !Number.isInteger(parsed.o) || parsed.o! < 0) throw new Error("mismatch");
        offset = parsed.o!;
      } catch { throw new Error("invalid Chronicle search cursor"); }
    }
    const query = req.query.toLocaleLowerCase("en-US");
    const tokens = [...new Set(query.split(/\s+/).filter(Boolean))];
    const ranked: ChronicleSearchHit[] = [];
    for (const event of all) {
      if (!chronicleInScope(event, req.scope)) continue;
      const doc = chronicleDocument(event);
      const phrase = doc.text.includes(query);
      const matchedTokens = tokens.filter((token) => doc.text.includes(token));
      if (!phrase && matchedTokens.length !== tokens.length) continue;
      const fields = [...new Set(doc.parts.filter((p) => phrase ? p.text.includes(query) : tokens.some((t) => p.text.includes(t))).map((p) => p.field))];
      const boosts: Partial<Record<ChronicleMatchField, number>> = { transcript: 40, tool_name: 35, tool_result: 30, tool_input: 25, artifact: 25, task: 20, workflow: 20, gate: 15 };
      const fieldBoost = Math.max(0, ...fields.map((f) => boosts[f] ?? 5));
      const score = (phrase ? 100 : 50) + matchedTokens.length * 5 + fieldBoost;
      ranked.push({ engineId: event.engineId, seq: event.seq, ts: event.ts, agentId: event.agentId, kind: event.kind,
        score, fields, snippet: chronicleSnippet(doc.display, query, tokens), correlation: chronicleCorrelation(event) });
    }
    ranked.sort((a, b) => b.score - a.score || b.ts - a.ts || a.engineId.localeCompare(b.engineId) || a.seq - b.seq);
    const hits = ranked.slice(offset, offset + req.limit);
    const nextOffset = offset + hits.length;
    const nextCursor = nextOffset < ranked.length ? Buffer.from(JSON.stringify({ f: fingerprint, o: nextOffset })).toString("base64url") : null;
    return { hits, nextCursor, retained: { firstSeq, lastSeq } };
  }

  searchExport(req: ChronicleExportRequest): ChronicleExportResponse {
    const response = this.search({ query: req.query, scope: req.scope, limit: Math.min(100, req.maxResults) });
    let hits = [...response.hits];
    let cursor = response.nextCursor;
    while (cursor && hits.length < req.maxResults) {
      const page = this.search({ query: req.query, scope: req.scope, limit: Math.min(100, req.maxResults - hits.length), cursor });
      hits.push(...page.hits); cursor = page.nextCursor;
    }
    const lines = [`# Chimera Chronicle search`, ``, `Query: ${safeScalar(req.query)}`, `Retained sequence: ${response.retained.firstSeq ?? "empty"}–${response.retained.lastSeq ?? "empty"}`, ``];
    for (const hit of hits) lines.push(`- ${new Date(hit.ts).toISOString()} · ${hit.engineId}/${hit.agentId} · ${hit.kind} · seq ${hit.seq} · ${hit.snippet}`);
    return { filename: `chimera-chronicle-${Date.now()}.md`, content: lines.join("\n") + "\n" };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // FEATURE-4: the event-log position a durable snapshot is valid as of — persisted alongside
  // it (state.json's `lastSeq`) so a boot-time replay knows exactly which events to fold in
  // (seq > lastSeq) instead of guessing or re-reading everything.
  currentSeq(): number {
    return this.seq;
  }

  /** AGENT-FORGET: erase every event belonging to `agentIds`, from the sealed segments AND the
   *  active window. Returns how many were removed.
   *
   *  This is the destructive half of "clean up finished agents" — an operator saying they are done
   *  with an agent, not the log ageing out on its own. Memory records are untouched: those are
   *  knowledge somebody deliberately wrote, not a byproduct of a run.
   *
   *  WHY A REWRITE and not a renumber: seqs are referenced from outside this file — chronicle
   *  documents, transcript items, historyMinSeq, search jump targets, the snapshot watermark in
   *  state.json. Renumbering to close the gaps would silently repoint every one of them. The gaps
   *  are recorded in each segment's sidecar instead (see SegmentMeta.removedSeqs).
   *
   *  A segment is rewritten only if it actually contains one of these agents, so forgetting an
   *  agent that ran for five minutes does not rewrite 700 MB. */
  forgetAgent(agentIds: readonly string[]): { removed: number; segmentsRewritten: number } {
    const targets = new Set(agentIds.filter((id) => id.length > 0));
    if (targets.size === 0) return { removed: 0, segmentsRewritten: 0 };
    let removed = 0;
    let segmentsRewritten = 0;

    for (const seg of this.listSegments()) {
      let raw: string;
      try { raw = readFileSync(seg.file, "utf8"); } catch { continue; }
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const keep: string[] = [];
      const dropped: number[] = [];
      for (const line of lines) {
        let ev: NormalizedEvent;
        // A line that cannot be parsed is KEPT. It is not ours to judge here — the integrity scan
        // owns corrupt lines, and silently dropping one during an unrelated delete would destroy
        // the evidence that scan exists to surface.
        try { ev = JSON.parse(line) as NormalizedEvent; } catch { keep.push(line); continue; }
        if (targets.has(ev.agentId)) { dropped.push(ev.seq); continue; }
        keep.push(line);
      }
      if (dropped.length === 0) continue;

      const metaPath = `${seg.file}.meta`;
      let prior: SegmentMeta | null = null;
      try { prior = JSON.parse(readFileSync(metaPath, "utf8")) as SegmentMeta; } catch { prior = null; }
      const body = keep.length > 0 ? keep.join("\n") + "\n" : "";
      writeFileDurable(seg.file, body, this.ioDeps);
      // The sidecar is rewritten even when the segment had none: a rewritten segment with no
      // checksum would be "trusted as-is" forever, which is exactly the backward-compat hole the
      // no-sidecar rule leaves open for OLD files and should not be extended to one we just wrote.
      const meta: SegmentMeta = {
        checksum: createHash("sha256").update(body).digest("hex"),
        count: keep.length,
        startSeq: prior?.startSeq ?? seg.startSeq,
        endSeq: prior?.endSeq ?? seg.endSeq,
        removedSeqs: [...(prior?.removedSeqs ?? []), ...dropped].sort((a, b) => a - b),
      };
      writeFileDurable(metaPath, JSON.stringify(meta), this.ioDeps);
      removed += dropped.length;
      segmentsRewritten++;
    }

    // The ACTIVE window: in memory and in the unsealed file, which has no sidecar by design (it is
    // still being appended to). Rewritten from `recent` so the two cannot disagree.
    const beforeActive = this.recent.length;
    const keptRecent = this.recent.filter((e) => !targets.has(e.agentId));
    if (keptRecent.length !== beforeActive) {
      this.recent = keptRecent;
      removed += beforeActive - keptRecent.length;
      this.appendLog.close?.();
      writeFileDurable(this.file, keptRecent.map((ev) => JSON.stringify(ev) + "\n").join(""), this.ioDeps);
      this.appendLog = this.newAppendLog();
    }
    return { removed, segmentsRewritten };
  }

  /** The seq range this log can still produce RAW events for, derived from segment FILENAMES — no
   *  segment content is read. Chronicle search needs it to tell a hit whose raw event still exists
   *  from one that survives only as a distilled document; answering that by scanning would defeat
   *  the point of an index. */
  retainedRange(): { firstSeq: number; lastSeq: number } {
    const segs = this.listSegments();
    const firstSeq = segs[0]?.startSeq ?? this.segmentFirstSeq;
    return { firstSeq, lastSeq: this.seq };
  }
}

// Exported so the chronicle distiller redacts through the SAME rules rather than
// carrying its own copy: two divergent copies of a security-relevant pattern is a
// leak waiting for whichever one nobody updates.
export const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|cookie)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|tskey-[A-Za-z0-9_-]{8,})\b/gi;
/** Redaction ONLY — no length cap. Split out from safeScalar so a caller that owns its own length
 *  decision (the chronicle distiller keeps a value's head AND tail) doesn't have to choose between
 *  redacting and truncating at 500. */
export function redactSecrets(value: unknown): string {
  return String(value).replace(SECRET_VALUE, "[REDACTED]");
}
export function safeScalar(value: unknown): string {
  return redactSecrets(value).slice(0, 500);
}
function flatten(value: unknown, path = "data", out: Array<{ path: string; value: string }> = [], depth = 0): Array<{ path: string; value: string }> {
  if (out.length >= 100 || depth > 6) return out;
  if (value === null || value === undefined) return out;
  if (["string", "number", "boolean"].includes(typeof value)) { out.push({ path, value: SECRET_KEY.test(path) ? "[REDACTED]" : safeScalar(value) }); return out; }
  if (Array.isArray(value)) { for (let i = 0; i < Math.min(value.length, 30); i++) flatten(value[i], `${path}.${i}`, out, depth + 1); return out; }
  if (typeof value === "object") for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 50)) flatten(child, `${path}.${key}`, out, depth + 1);
  return out;
}
function fieldFor(event: NormalizedEvent, path: string): ChronicleMatchField {
  const p = path.toLowerCase();
  if (event.kind === "message_delta" || event.kind === "message_complete" || p.endsWith(".text")) return "transcript";
  if (event.kind === "tool_call") return p.includes("name") ? "tool_name" : "tool_input";
  if (event.kind === "tool_result") return "tool_result";
  if (p.includes("artifact") || event.kind === "artifact_added") return "artifact";
  if (p.includes("workflow")) return "workflow";
  if (p.includes("gate") || event.kind.includes("step_")) return "gate";
  if (p.includes("task") || event.agentId.startsWith("task:")) return "task";
  if (p.includes("evidence")) return "evidence";
  return "data";
}
function chronicleDocument(event: NormalizedEvent): { text: string; display: string; parts: Array<{ field: ChronicleMatchField; text: string }> } {
  const parts: Array<{ field: ChronicleMatchField; text: string }> = [
    { field: "kind", text: event.kind.toLowerCase() }, { field: "agent", text: event.agentId.toLowerCase() },
  ];
  const rows = [...flatten(event.data), ...flatten(event.raw, "raw")];
  for (const row of rows) parts.push({ field: fieldFor(event, row.path), text: `${row.path} ${row.value}`.toLocaleLowerCase("en-US") });
  const display = rows.map((r) => `${r.path.replace(/^(data|raw)\./, "")}: ${r.value}`).join(" · ").slice(0, 1200) || `${event.kind} ${event.agentId}`;
  return { parts, text: parts.map((p) => p.text).join(" "), display };
}
function chronicleSnippet(display: string, query: string, tokens: string[]): string {
  const lower = display.toLocaleLowerCase("en-US");
  let at = lower.indexOf(query);
  if (at < 0) at = Math.min(...tokens.map((t) => lower.indexOf(t)).filter((n) => n >= 0));
  if (!Number.isFinite(at)) at = 0;
  const start = Math.max(0, at - 100);
  return `${start > 0 ? "…" : ""}${display.slice(start, start + 500)}${start + 500 < display.length ? "…" : ""}`;
}
function str(data: Record<string, unknown>, ...keys: string[]): string | null { for (const key of keys) if (typeof data[key] === "string") return data[key] as string; return null; }
function chronicleCorrelation(event: NormalizedEvent): ChronicleSearchHit["correlation"] {
  const d = event.data;
  return { taskId: str(d, "taskId") ?? (event.agentId.startsWith("task:") ? event.agentId.slice(5) : null), workflow: str(d, "workflow", "workflowName"),
    stepId: str(d, "stepId"), toolId: str(d, "toolId", "toolUseId"), artifactId: str(d, "artifactId", "id"), traceId: str(d, "traceId", "trace_id"),
    spanId: str(d, "spanId", "span_id"), parentAgentId: str(d, "parentAgentId", "parentId") };
}
function chronicleInScope(event: NormalizedEvent, scope?: ChronicleSearchRequest["scope"]): boolean {
  if (!scope) return true;
  if (scope.agentIds && !scope.agentIds.includes(event.agentId)) return false;
  if (scope.engineIds && !scope.engineIds.includes(event.engineId)) return false;
  if (scope.kinds && !scope.kinds.includes(event.kind)) return false;
  if (scope.fromTs !== undefined && event.ts < scope.fromTs || scope.toTs !== undefined && event.ts > scope.toTs) return false;
  if (scope.fromSeq !== undefined && event.seq < scope.fromSeq || scope.toSeq !== undefined && event.seq > scope.toSeq) return false;
  const c = chronicleCorrelation(event);
  if (scope.taskIds && (!c.taskId || !scope.taskIds.includes(c.taskId))) return false;
  if (scope.workflowNames && (!c.workflow || !scope.workflowNames.includes(c.workflow))) return false;
  return true;
}
