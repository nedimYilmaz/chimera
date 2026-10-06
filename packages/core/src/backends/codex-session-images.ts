import { constants } from "node:fs";
import { lstat, opendir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS } from "@chimera/protocol";
import type { CodexThreadEvent } from "./codex.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCodexRolloutSessionId = (id: string): boolean => UUID.test(id);
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = TOOL_OUTPUT_IMAGE_MAX_BASE64_CHARS + 128 * 1024;
export const CODEX_IMAGE_ROLLOUT_LIMITS = {
  maxDiscoveryEntries: 16_384, maxDiscoveryDirectories: 1024, maxDiscoveryMs: 100,
  maxReadBytes: 16 * 1024 * 1024, maxTotalReadBytes: 128 * 1024 * 1024,
  maxReadMs: 200, maxTotalReadMs: 2000,
};
type ReaderOptions = { limits?: Partial<typeof CODEX_IMAGE_ROLLOUT_LIMITS>; now?: () => number };
type ReadBudget = { started: number; bytes: number };

// Exec 0.160 omits native image extensions from stdout. Read only this session's
// original result, never a model-authored savedPath. One reader owns one invocation.
// Work deadlines are cooperative checks between fs calls/parses, NOT syscall timeouts.
export class CodexSessionImages {
  private path?: string;
  private offset = 0;
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private dropping = false;
  private owner = false;
  private turn?: string;
  private seen = new Set<string>();
  private scanned = 0;
  private stopped = false;
  private warning?: string;
  private reportedWarnings = new Set<string>();
  private fileIdentity?: string;
  private discoveryEntries = 0;
  private discoveryDirectories = 0;
  private discoveryMs = 0;
  private readMs = 0;
  private limits: typeof CODEX_IMAGE_ROLLOUT_LIMITS;
  private now: () => number;

  constructor(private home: string, private id: string, private since: number, options: ReaderOptions = {}) {
    this.limits = { ...CODEX_IMAGE_ROLLOUT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => performance.now());
  }

  private stop(reason: string): void {
    this.stopped = true; this.warning ??= reason;
    this.parts = []; this.lineBytes = 0;
  }
  private finish(events: CodexThreadEvent[] = []): CodexThreadEvent[] {
    if (this.warning) { events.push({ type: "image_output.warning", reason: this.warning }); this.warning = undefined; }
    return events.filter(event => {
      if (event.type !== "image_output.warning") return true;
      const reason = String(event.reason);
      if (this.reportedWarnings.has(reason)) return false;
      this.reportedWarnings.add(reason); return true;
    });
  }

  private async locate(): Promise<string | undefined> {
    if (!isCodexRolloutSessionId(this.id)) { this.stop("invalid-session-id"); return; }
    if (this.path) return this.path;
    const began = this.now();
    const paths: string[] = [];
    const withinBudget = () => {
      if (this.discoveryEntries >= this.limits.maxDiscoveryEntries || this.discoveryDirectories >= this.limits.maxDiscoveryDirectories
        || this.discoveryMs + this.now() - began >= this.limits.maxDiscoveryMs) { this.stop("discovery-limit"); return false; }
      return !this.stopped;
    };
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (!withinBudget()) return;
      this.discoveryDirectories++;
      try {
        const dir = await opendir(directory, { bufferSize: 1 });
        if (!withinBudget()) { await dir.close(); return; }
        for await (const entry of dir) {
          if (!withinBudget()) break;
          this.discoveryEntries++;
          if (depth < 3) {
            if (entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) await visit(join(directory, entry.name), depth + 1);
          } else if (entry.name.endsWith(`${this.id}.jsonl`)) {
            paths.push(join(directory, entry.name));
            if (paths.length > 1) { this.stop("ambiguous-session"); break; }
          }
          if (!withinBudget()) break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    try { await visit(join(this.home, "sessions"), 0); }
    finally { this.discoveryMs += this.now() - began; }
    if (this.discoveryMs >= this.limits.maxDiscoveryMs) this.stop("discovery-limit");
    if (!this.stopped) return this.path = paths[0];
  }

  private workBudget(budget: ReadBudget): boolean {
    const elapsed = this.now() - budget.started;
    if (elapsed >= this.limits.maxReadMs || this.readMs + elapsed >= this.limits.maxTotalReadMs) this.stop("read-work-limit");
    return !this.stopped;
  }
  private async readBytes(file: FileHandle, buffer: Buffer, length: number, position: number, budget: ReadBudget): Promise<number> {
    if (!length) return 0;
    if (!this.workBudget(budget)) return 0;
    const remaining = Math.min(length, this.limits.maxReadBytes - budget.bytes, this.limits.maxTotalReadBytes - this.scanned);
    if (remaining <= 0) { this.stop(this.scanned >= this.limits.maxTotalReadBytes ? "scan-limit" : "read-limit"); return 0; }
    const { bytesRead } = await file.read(buffer, 0, remaining, position);
    budget.bytes += bytesRead; this.scanned += bytesRead;
    if (remaining < length && bytesRead === remaining) this.stop(this.scanned >= this.limits.maxTotalReadBytes ? "scan-limit" : "read-limit");
    return this.workBudget(budget) ? bytesRead : 0;
  }

  private async regularFile(path: string, budget: ReadBudget): Promise<{ file: FileHandle; size: number } | undefined> {
    // O_NONBLOCK also prevents a raced-in FIFO from blocking before fstat can
    // reject it. Metadata checks precede every read, including the session header.
    const before = await lstat(path);
    if (!this.workBudget(budget)) return;
    if (!before.isFile()) { this.stop("nonregular-rollout"); return; }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!this.workBudget(budget)) { await file.close(); return; }
      const stat = await file.stat();
      if (!this.workBudget(budget)) { await file.close(); return; }
      const identity = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile()) { this.stop("nonregular-rollout"); await file.close(); return; }
      if (before.dev !== stat.dev || before.ino !== stat.ino || this.fileIdentity && this.fileIdentity !== identity || stat.size < this.offset) {
        this.stop("rollout-replaced"); await file.close(); return;
      }
      this.fileIdentity = identity;
      return { file, size: stat.size };
    } catch (error) { await file.close(); throw error; }
  }

  private async owned(file: FileHandle, size: number, budget: ReadBudget): Promise<boolean> {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const bytesRead = await this.readBytes(file, buffer, Math.min(buffer.length, size), 0, budget);
    if (this.stopped) return false;
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) {
      if (size >= CHUNK_BYTES) this.stop("session-header-too-large");
      return false;
    }
    try {
      const meta = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      if (meta.type === "session_meta" && meta.payload?.id === this.id) return true;
    } catch { /* A complete malformed header cannot prove session ownership. */ }
    this.stop("invalid-session-identity"); return false;
  }

  // An existing invocation must skip all prior bytes, even with equal timestamps.
  async prime(): Promise<CodexThreadEvent[]> {
    const budget = { started: this.now(), bytes: 0 };
    try {
      const path = await this.locate();
      if (path && this.workBudget(budget)) {
        const opened = await this.regularFile(path, budget);
        if (opened) {
          const { file, size } = opened;
          try {
            this.owner = await this.owned(file, size, budget);
            if (!this.owner && !this.stopped) this.stop("missing-session-identity");
            if (!this.stopped) {
              this.offset = size;
              if (size) {
                const last = Buffer.alloc(1);
                await this.readBytes(file, last, 1, size - 1, budget);
                this.dropping = last[0] !== 10;
              }
            }
          } finally { await file.close(); }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.stop("rollout-unreadable"); }
    finally { this.readMs += this.now() - budget.started; }
    return this.finish();
  }

  private record(line: string): CodexThreadEvent | undefined {
    if (!line.includes('"task_started"') && !line.includes('"image_gen.generation"')) return;
    try {
      const row = JSON.parse(line);
      if (row.type !== "event_msg" || !this.owner) return;
      const payload = row.payload;
      const timestamp = Date.parse(row.timestamp);
      if (payload?.type === "task_started") {
        if (this.turn && payload.turn_id !== this.turn) { this.stop("ambiguous-turn"); return; }
        if (!Number.isFinite(timestamp) || timestamp < this.since) return;
        if (!UUID.test(payload.turn_id)) { this.stop("invalid-turn-identity"); return; }
        this.turn ??= payload.turn_id; return;
      }
      if (!Number.isFinite(timestamp) || timestamp < this.since) return;
      const item = payload?.item;
      if (payload?.type !== "item_completed" || item?.type !== "Extension" || item.kind !== "image_gen.generation") return;
      if (!this.turn) { this.stop("missing-turn-identity"); return; }
      if (payload.thread_id !== this.id || payload.turn_id !== this.turn) { this.stop("wrong-image-owner"); return; }
      if (typeof item.id !== "string" || !item.id || item.id.length > 256 || !["completed", "failed"].includes(item.status)) {
        this.stop("invalid-image-record"); return;
      }
      if (this.seen.has(item.id)) return;
      if (this.seen.size >= 64) { this.stop("too-many-records"); return; }
      this.seen.add(item.id);
      return { type: "item.completed", item: { type: "imageGeneration", id: item.id,
        status: item.status, result: item.result, failure: item.failure ? true : null } };
    } catch { return; }
  }

  async read(final = false): Promise<CodexThreadEvent[]> {
    const events: CodexThreadEvent[] = [];
    if (this.stopped) return this.finish();
    const budget: ReadBudget = { started: this.now(), bytes: 0 };
    try {
      const path = await this.locate();
      if (!path && final && !this.stopped) this.stop("missing-rollout");
      if (path && this.workBudget(budget)) {
        const opened = await this.regularFile(path, budget);
        if (opened) {
          const { file, size } = opened;
          try {
            if (!this.owner) this.owner = await this.owned(file, size, budget);
            if (!this.owner && final && !this.stopped) this.stop("missing-session-identity");
            if (this.owner && !this.stopped) {
              const buffer = Buffer.alloc(CHUNK_BYTES);
              while (this.offset < size && this.workBudget(budget)) {
                const bytesRead = await this.readBytes(file, buffer, Math.min(buffer.length, size - this.offset), this.offset, budget);
                if (!bytesRead) break;
                this.offset += bytesRead;
                let start = 0;
                while (start < bytesRead && !this.stopped) {
                  const newline = buffer.subarray(0, bytesRead).indexOf(10, start);
                  const end = newline < 0 ? bytesRead : newline;
                  if (!this.dropping) {
                    this.lineBytes += end - start;
                    if (this.lineBytes > MAX_LINE_BYTES) {
                      this.parts = []; this.dropping = true;
                      events.push({ type: "image_output.warning", reason: "record-too-large" });
                    } else this.parts.push(Buffer.from(buffer.subarray(start, end)));
                  }
                  if (newline < 0) break;
                  if (!this.dropping) {
                    const event = this.record(Buffer.concat(this.parts).toString("utf8"));
                    if (event) events.push(event);
                  }
                  this.parts = []; this.lineBytes = 0; this.dropping = false;
                  start = end + 1;
                }
              }
              if (final && !this.stopped && this.lineBytes) this.stop("incomplete-record");
              if (final && !this.stopped && !this.turn) this.stop("missing-turn-identity");
            }
          } finally { await file.close(); }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || final) this.stop(final ? "rollout-unavailable" : "rollout-unreadable");
    } finally { this.readMs += this.now() - budget.started; }
    return this.finish(events);
  }
}
