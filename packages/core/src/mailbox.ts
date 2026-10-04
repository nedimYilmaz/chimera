import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventLogDurabilityConfigSchema, type EventLogDurabilityConfig } from "@chimera/protocol";
import { DurableAppendLog, realDurableWriteDeps, type ClearTimerFn, type DurableWriteDeps, type TimerFn } from "./durable-write.js";
import type { ContentBlock, Image } from "./backend.js";

// R2-DURABLE-LOG: same append-only-log durability need as EventLog (see events.ts) — one shared
// config knob, sourced the same way (schema default, not duplicated).
const DEFAULT_DURABILITY: EventLogDurabilityConfig = EventLogDurabilityConfigSchema.parse({});

export type MailboxMessage = {
  id: string; ts: number; from: string;
  // AGENT-FAILURE-REACHES-CONDUCTOR: "child_failed" mirrors "child_result" — the deliverTo
  // notification for a child that ended in "failed" rather than "done" (see markFailed /
  // notifyChildFailed in supervisor.ts). A distinct kind, not a meta flag, so a conductor (or any
  // other consumer) can branch on it without string-sniffing `text`.
  kind: "child_result" | "child_failed" | "user_message" | "signal";
  text: string; meta?: Record<string, unknown>;
  // IMAGE.PASTE: additive, persisted JSONL inline (base64) -- acceptable bloat
  // for an occasional image attachment. Omitted entirely (not even an empty
  // array) when the message carries no images, mirroring `meta`'s convention.
  images?: Image[];
  // D9: additive ordered content blocks (text/image interleaved) — same
  // persisted-inline-JSONL convention as `images`, omitted entirely when absent.
  content?: ContentBlock[];
  // PARITY WS-B (agent-routed slash execution): when true this user_message is a
  // real SDK slash command and must reach the backend VERBATIM (leading "/"), so
  // deliverBatch skips the usual "[from …] " prefix. Rides the mailbox envelope
  // (never a side-channel) so it preserves FIFO/outbox order like `images`/`meta`;
  // omitted entirely for ordinary messages (the overwhelmingly common case).
  slash?: boolean;
  // Only explicit force-send may interrupt a working backend.
  force?: boolean;
  // origin engine; "local" for messages minted here. Cross-engine messages
  // (Phase 5) are untrusted input to local agents and must carry provenance.
  engineId: string;
};

export type MailboxStoreOptions = {
  // R2-DURABLE-LOG: absent ⇒ EventLogDurabilityConfigSchema's own defaults (group-commit).
  // ioDeps/setTimer/clearTimer are test seams (absent ⇒ real fs/timers), same convention as
  // EventLogOptions.
  durability?: EventLogDurabilityConfig;
  ioDeps?: DurableWriteDeps;
  setTimer?: TimerFn;
  clearTimer?: ClearTimerFn;
};

export class MailboxStore {
  private dir: string;
  private durability: EventLogDurabilityConfig;
  private ioDeps: DurableWriteDeps;
  private setTimerFn?: TimerFn;
  private clearTimerFn?: ClearTimerFn;
  // R2-DURABLE-LOG: one DurableAppendLog per agent mailbox file, created lazily on first
  // enqueue() — mirrors the one-file-per-stream shape EventLog uses for its own active segment.
  private appendLogs = new Map<string, DurableAppendLog>();

  constructor(baseDir: string, opts?: MailboxStoreOptions) {
    this.dir = join(baseDir, "mailboxes");
    mkdirSync(this.dir, { recursive: true });
    this.durability = opts?.durability ?? DEFAULT_DURABILITY;
    this.ioDeps = opts?.ioDeps ?? realDurableWriteDeps;
    this.setTimerFn = opts?.setTimer;
    this.clearTimerFn = opts?.clearTimer;
  }
  // encodeURIComponent leaves UUIDs untouched (zero behavior change) and
  // permanently removes the "/"-in-id path-traversal/subdirectory hazard.
  private file(agentId: string) { return join(this.dir, encodeURIComponent(agentId) + ".jsonl"); }
  private ackFile(agentId: string) { return join(this.dir, encodeURIComponent(agentId) + ".ack"); }

  private appendLogFor(agentId: string): DurableAppendLog {
    let log = this.appendLogs.get(agentId);
    if (!log) {
      log = new DurableAppendLog(this.file(agentId), {
        mode: this.durability.mode,
        groupCommitMs: this.durability.groupCommitMs,
        groupCommitMaxBatch: this.durability.groupCommitMaxBatch,
        deps: this.ioDeps,
        setTimer: this.setTimerFn,
        clearTimer: this.clearTimerFn,
      });
      this.appendLogs.set(agentId, log);
    }
    return log;
  }

  // id/ts/engineId default here, but a caller-supplied value wins — Phase 5's
  // mailbox.forward preserves sender-assigned ids for idempotent delivery.
  enqueue(agentId: string, msg: Omit<MailboxMessage, "id" | "ts" | "engineId"> & Partial<Pick<MailboxMessage, "id" | "ts" | "engineId">>): MailboxMessage {
    // TOKEN-OPT-NO-DOUBLE-BASE64: `content` and `images` are two encodings of the SAME paste —
    // the app's compose splitter returns both and sends both — but the delivery path uses
    // `content` when it is present and ignores `images` entirely (backends/claude.ts's
    // userMessage; codex/generic take neither, kimi rejects both). So the second copy was never
    // read and only ever written: measured on a real mailbox, one message held 1.58MB in each
    // field, 3.15MB on disk to deliver 225 bytes of text — and that same pair is re-serialized
    // into the delivery event and every state snapshot after it.
    // Dropped HERE, at the one door every producer goes through, rather than in each client.
    const deduped = msg.content && msg.content.length > 0 && msg.images && msg.images.length > 0
      ? (({ images: _images, ...rest }) => rest)(msg)
      : msg;
    const full: MailboxMessage = { ...deduped, id: msg.id ?? randomUUID(), ts: msg.ts ?? Date.now(), engineId: msg.engineId ?? "local" };
    this.appendLogFor(agentId).append(JSON.stringify(full) + "\n");
    return full;
  }

  // R2-DURABLE-LOG: forces any pending group-commit fsync now, across every open per-agent
  // mailbox log — called from the daemon's shutdown path (main.ts) alongside EventLog's own
  // flushDurable(), so a clean shutdown never leaves a group-commit window unflushed.
  flushDurable(): void {
    for (const log of this.appendLogs.values()) log.flush();
  }

  // PURGE-TERMINAL-SESSIONS: drop one agent's mailbox entirely — the log, its ack marker and
  // any open append handle. This is where the disk actually is (a real home: 185MB of mailboxes
  // against 12MB of archived records), so a cleanup that skipped it would reclaim almost nothing.
  // Undelivered mail for the purged agent goes with it, which is the point: the agent is
  // terminal and being forgotten, so there is nobody left to deliver it to.
  remove(agentId: string): void {
    this.appendLogs.get(agentId)?.flush();
    this.appendLogs.delete(agentId);
    for (const p of [this.file(agentId), this.ackFile(agentId)]) {
      try { rmSync(p, { force: true }); } catch { /* already gone */ }
    }
  }

  history(agentId: string): MailboxMessage[] {
    if (!existsSync(this.file(agentId))) return [];
    const all: MailboxMessage[] = [];
    for (const l of readFileSync(this.file(agentId), "utf8").trim().split("\n")) {
      if (!l) continue;
      try {
        all.push(JSON.parse(l) as MailboxMessage);
      } catch {
        // torn/partial line from a crash mid-appendFileSync (the restart scenario
        // this store is built to survive): the message was never durably written,
        // so skip it and keep every well-formed message before it (mirrors EventLog).
      }
    }
    return all;
  }

  pending(agentId: string): MailboxMessage[] {
    const all = this.history(agentId);
    const ack = existsSync(this.ackFile(agentId)) ? readFileSync(this.ackFile(agentId), "utf8").trim() : "";
    if (!ack) return all;
    const idx = all.findIndex((m) => m.id === ack);
    return idx === -1 ? all : all.slice(idx + 1);
  }

  /** Dedup probe for cross-engine forwards: checks the FULL JSONL, including
   * already-drained messages (dedup must hold past the ack watermark — §3.4).
   * Per-line defensive parse (mirrors pending()): a torn/partial line from a
   * crash mid-appendFileSync must never crash this probe. */
  hasMessage(agentId: string, id: string): boolean {
    if (!existsSync(this.file(agentId))) return false;
    for (const l of readFileSync(this.file(agentId), "utf8").split("\n").filter(Boolean)) {
      try {
        if ((JSON.parse(l) as MailboxMessage).id === id) return true;
      } catch {
        // torn/partial line — skip, keep scanning (mirrors pending()'s try/catch)
      }
    }
    return false;
  }

  drain(agentId: string): MailboxMessage[] {
    const msgs = this.pending(agentId);
    const last = msgs[msgs.length - 1];
    if (last) {
      // atomic write-then-rename: a crash mid-write can't leave an empty/half-written
      // .ack that would replay an already-drained batch on the next restart.
      const tmp = this.ackFile(agentId) + ".tmp";
      writeFileSync(tmp, last.id);
      renameSync(tmp, this.ackFile(agentId));
    }
    return msgs;
  }
}
